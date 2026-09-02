/**
 * streamSimple adapter — runs one agy turn per pi request and translates the
 * reduced outcome into pi AssistantMessageEvents.
 *
 * agy streams response text — the visible answer only — as text_delta
 * continuation chunks on agent_response steps; these stream live into pi's
 * text channel. Thought text is never exposed by agy's print-mode
 * stream-json protocol (thinking_tokens counts in usage are the only
 * reasoning trace), so each answer is preceded by a synthesized summary
 * thinking block. Only authenticated pi-bridge calls become Pi tool cards.
 * Any agy-native or foreign-MCP tool activity aborts the process and clears
 * its resumable conversation before an unsafe fallback can occur.
 */

import {
  calculateCost,
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type SimpleStreamOptions,
  type ThinkingLevel,
} from "@earendil-works/pi-ai";
import type { AgyEffort } from "../lib/agy-client.ts";
import { type AgyPiBridge, resolveBridgeResultsFromContext } from "../lib/bridge.ts";
import { resolveAgyModelEffort, type AgyModelInfo } from "../lib/models.ts";
import { readAgyProcessProfile, type AgyProcessProfile } from "../lib/agy-profile.ts";
import type { AgyActivity, AgyUsage } from "../lib/reducer.ts";
import type { AgySecurityEvent } from "../lib/security-events.ts";
import { piHarnessBootstrap, restoredPiContextPrompt } from "../lib/prompt.ts";
import {
  AntigravityRuntime,
  createAntigravityRuntime,
  type AntigravityRuntimeInstance,
  type AntigravityRuntimeShape,
} from "./runtime.ts";

interface TextPart {
  type: "text";
  text: string;
}

interface ImagePart {
  type: "image";
  [k: string]: unknown;
}

/** Extract the latest user message text (plus an image-omitted note). */
export function latestUserPrompt(context: Context): { prompt: string; images: number } {
  let images = 0;
  for (let i = context.messages.length - 1; i >= 0; i--) {
    const message = context.messages[i] as { role?: string; content?: unknown };
    if (message.role !== "user") continue;
    const parts = Array.isArray(message.content) ? message.content : [];
    let text = "";
    for (const part of parts as (TextPart | ImagePart)[]) {
      if (part && typeof part === "object" && part.type === "text") {
        text += (text ? "\n" : "") + part.text;
      } else if (part && typeof part === "object" && part.type === "image") {
        images += 1;
      }
    }
    if (images > 0) {
      text += `\n(${images} image(s) omitted — the agy print interface is text-only)`;
    }
    return { prompt: text, images };
  }
  return { prompt: "", images: 0 };
}

// A fresh fallback conversation can safely receive roughly 60k transcript
// tokens while leaving agy's ~185k working window room for system/tools and
// the next response. Normal reloads resume the persisted native conversation;
// this larger tail is for forks, stale/missing conversations, and branch moves.
const MAX_RESTORED_HISTORY_CHARS = 240_000;

/** Serialize the active pi branch before its latest user request. */
export function piHistoryBootstrap(context: Context): string | undefined {
  let latestUser = -1;
  for (let i = context.messages.length - 1; i >= 0; i--) {
    if ((context.messages[i] as { role?: string }).role === "user") {
      latestUser = i;
      break;
    }
  }
  if (latestUser <= 0) return undefined;

  const entries: string[] = [];
  for (const raw of context.messages.slice(0, latestUser)) {
    const message = raw as {
      role?: string;
      toolName?: string;
      content?: unknown;
    };
    const parts = Array.isArray(message.content) ? message.content : [];
    const rendered: string[] = [];
    for (const part of parts as Array<Record<string, unknown>>) {
      if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) {
        rendered.push(part.text);
      } else if (part?.type === "toolCall" && typeof part.name === "string") {
        const args = JSON.stringify(part.arguments ?? {});
        rendered.push(`[tool call: ${part.name}${args === "{}" ? "" : ` ${args}`}]`);
      }
    }
    if (rendered.length === 0) continue;
    const role =
      message.role === "toolResult"
        ? `tool ${message.toolName ?? "result"}`
        : (message.role ?? "message");
    entries.push(`${role}:\n${rendered.join("\n")}`);
  }
  if (entries.length === 0) return undefined;
  const transcript = entries.join("\n\n");
  const bounded =
    transcript.length <= MAX_RESTORED_HISTORY_CHARS
      ? transcript
      : `[Earlier history omitted]\n${transcript.slice(-MAX_RESTORED_HISTORY_CHARS)}`;
  return restoredPiContextPrompt(bounded);
}

/** Map agy usage fields to pi usage fields. */
export function mapUsage(u: AgyUsage | undefined): AssistantMessage["usage"] {
  return {
    input: u?.input_tokens ?? 0,
    output: u?.output_tokens ?? 0,
    // agy never streams thought text (print mode exposes counts only);
    // report thinking_tokens as the reasoning subset of output regardless.
    reasoning: u?.thinking_tokens,
    cacheRead: u?.cache_read_tokens ?? 0,
    cacheWrite: 0,
    totalTokens: u?.total_tokens ?? 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * pi's compaction and branch summarization arrive as standalone requests
 * whose only user message is `<conversation>\n…</conversation>\n\n` plus
 * instructions. They run in disposable agy conversations so internal summary
 * prompts never become fake user input in the real conversation. Their cached
 * transcript re-reads also produce fictional per-token costs (agy is
 * subscription-billed), so these requests report no usage.
 */
export function isSummarizationRequest(prompt: string): boolean {
  return prompt.startsWith("<conversation>\n");
}

const OVERFLOW_PATTERN = /context (length|window|size).*(exceed|limit)|exceeds.*context/i;

/**
 * agy's own recovery notice: its stream broke mid-turn, agy retried, and the
 * response was still delivered. Only this error may downgrade an ERROR result
 * to success (and only with response text present) — any other ERROR stays a
 * failure so truncated or empty answers never pass silently.
 */
const RECOVERED_INTERRUPTION_PATTERN = /stream was interrupted/i;

/** Map an explicit pi thinking level to agy's `--effort` (low|medium|high). */
export function mapThinkingToEffort(level: ThinkingLevel | undefined): AgyEffort | undefined {
  if (level === undefined) return undefined;
  if (level === "low" || level === "minimal") return "low";
  if (level === "medium") return "medium";
  return "high"; // high, xhigh, and max
}

/**
 * True for agy `call_mcp_tool` steps that target our own bridge server.
 * Those calls surface as synthetic bridge_call activities (emitted as the
 * real pi tool), so the raw call_mcp_tool step must not render a duplicate
 * display-only card. MCP calls against OTHER servers render normally.
 */
function isBridgedMcpStep(
  activity: {
    name: string;
    args: Record<string, unknown>;
  },
  serverName: string,
): boolean {
  return activity.name === "call_mcp_tool" && activity.args?.ServerName === serverName;
}

/** Build the streamSimple implementation bound to the runtime service. */
export function streamAntigravity(
  runtime: AntigravityRuntimeInstance,
  service: AntigravityRuntimeShape,
  /** Pi-tool bridge; pass a detached AgyPiBridge when the bridge is off. */
  bridge: AgyPiBridge,
  /** Called when a turn fully settles (stop or error) — the moment an agy
   * background task may have been created. */
  onSettled?: () => void,
  /** Live activity side channel for task/artifact UI that must not wait for
   * the provider message to settle. */
  onActivity?: (activity: AgyActivity) => void,
  /** Test seam for disposable compaction/branch-summary conversations. */
  createIsolatedRuntime: () => AntigravityRuntimeInstance = createAntigravityRuntime,
  /** Current discovery metadata used to resolve a valid required effort. */
  getModelInfo: (modelId: string) => AgyModelInfo | undefined = () => undefined,
  /** Validated process profile; read per turn so env changes recycle safely. */
  getProcessProfile: () => AgyProcessProfile = readAgyProcessProfile,
  /** Combined bridge registration/catalog revision. */
  getBridgeRevision: () => string | undefined = () => undefined,
  /** Provider-owned process paths. Production must supply both values. */
  getProcessIsolation: () => {
    geminiDir?: string;
    brokerCwd?: string;
    sandbox?: { required: boolean; geminiDir: string; brokerCwd: string };
  } = () => ({}),
  /** Metadata-only audit sink. Failure must not affect the security abort. */
  onSecurityViolation?: (event: AgySecurityEvent) => Promise<void> | void,
) {
  return (
    model: Model<string>,
    context: Context,
    options?: SimpleStreamOptions,
  ): AssistantMessageEventStream => {
    const stream = createAssistantMessageEventStream();

    (async () => {
      const output: AssistantMessage = {
        role: "assistant",
        content: [],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: mapUsage(undefined),
        stopReason: "pending",
        timestamp: Date.now(),
      };

      let turnRuntime = runtime;
      let turnService = service;
      let isolatedRuntime: AntigravityRuntimeInstance | undefined;
      let turnCleared = false;

      const clearTurn = () => {
        if (turnCleared) return;
        turnCleared = true;
        const finished = turnRuntime.runPromise(turnService.finishTurn).catch(() => {});
        if (!isolatedRuntime) {
          onSettled?.();
          return;
        }
        // A summarizer has no continuity to preserve. Abort any unfinished
        // child, then dispose its private Effect runtime without touching the
        // user's real agy conversation.
        void finished
          .then(() => turnRuntime.runPromise(turnService.close).catch(() => {}))
          .finally(() => isolatedRuntime?.dispose().catch(() => {}));
      };

      const fail = (message: string) => {
        output.stopReason = options?.signal?.aborted ? "aborted" : "error";
        output.errorMessage = message;
        clearTurn();
        stream.push({ type: "error", reason: output.stopReason, error: output });
        stream.end();
      };

      try {
        stream.push({ type: "start", partial: output });

        const { prompt } = latestUserPrompt(context);
        if (!prompt) {
          throw new Error("antigravity: no user text found in the request context.");
        }
        const summaryRequest = isSummarizationRequest(prompt);

        if (summaryRequest) {
          // Pi invokes compaction and branch summarization as provider calls.
          // Resuming the user's agy conversation would record the serialized
          // transcript as a fake USER_INPUT. Run that internal request in a
          // disposable conversation so `agy --conversation <id>` shows only
          // messages the user actually sent.
          const snapshot = await runtime.runPromise(service.snapshot);
          isolatedRuntime = createIsolatedRuntime();
          turnRuntime = isolatedRuntime;
          turnService = isolatedRuntime.runSync(AntigravityRuntime);
          await turnRuntime.runPromise(
            turnService.setSession(snapshot.cwd ?? process.cwd(), model.id, false),
          );
        }

        let bridgeRevision: string | undefined;
        let processProfile: AgyProcessProfile = {};
        if (!summaryRequest) {
          // Refresh and resolve before the driver fingerprint is evaluated.
          // Re-entry into a pending bridge turn returns the existing controller,
          // so a changed revision is deferred safely to the next user turn.
          bridge.refreshTools();
          resolveBridgeResultsFromContext(bridge, context.messages);
          bridgeRevision = getBridgeRevision();
          processProfile = getProcessProfile();
        }
        const requestedEffort = mapThinkingToEffort(options?.reasoning);
        const effort = resolveAgyModelEffort(getModelInfo(model.id), requestedEffort);
        const processIsolation = getProcessIsolation();

        const controller = await turnRuntime.runPromise(
          turnService.beginStreamTurn({
            prompt,
            bootstrapPrefix: summaryRequest ? undefined : piHarnessBootstrap(context.systemPrompt),
            historyBootstrap: summaryRequest ? undefined : piHistoryBootstrap(context),
            modelId: model.id,
            effort,
            agent: processProfile.agent,
            mode: processProfile.mode,
            bridgeRevision,
            processCwd: processIsolation.brokerCwd,
            geminiDir: processIsolation.geminiDir,
            sandbox: processIsolation.sandbox,
            signal: options?.signal,
          }),
        );

        let usage: AgyUsage | undefined;
        let textIndex: number | null = null;
        let textBuffer = "";
        /**
         * Thinking slot reserved ahead of the current text run, still awaiting
         * its token count. `contentIndex` is announced once and never moves:
         * pi's delta-only consumers (`--mode json`, streamProxy, extensions
         * reading `assistantMessageEvent`) rebuild content from indices alone,
         * so a block can never be spliced in after the fact.
         */
        let thoughtIndex: number | null = null;
        /**
         * Close a reserved thinking slot that never received a token count
         * (non-thinking models report `thinking_tokens: 0`). The empty block
         * stays in `content` because announced indices are immutable; pi's
         * renderer trims and skips blank thinking blocks, so it shows nothing.
         */
        const closeUnfilledThought = () => {
          if (thoughtIndex === null) return;
          stream.push({
            type: "thinking_end",
            contentIndex: thoughtIndex,
            content: "",
            partial: output,
          });
          thoughtIndex = null;
        };

        const closeText = () => {
          closeUnfilledThought();
          if (textIndex === null) return;
          stream.push({
            type: "text_end",
            contentIndex: textIndex,
            content: textBuffer,
            partial: output,
          });
          textIndex = null;
          textBuffer = "";
        };

        const attachUsage = (u: AgyUsage | undefined, final: boolean) => {
          if (summaryRequest) return; // summarization turns carry no billable usage
          output.usage = mapUsage(controller.claimUsage(u, final));
          calculateCost(model, output.usage);
        };

        const endWithToolUse = () => {
          closeText();
          attachUsage(usage, false);
          output.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message: output });
          stream.end();
        };

        const abortNativeTool = async (activity: {
          name: string;
          args: Record<string, unknown>;
        }): Promise<never> => {
          const mcpServer =
            activity.name === "call_mcp_tool" && typeof activity.args?.ServerName === "string"
              ? activity.args.ServerName
              : undefined;
          await Promise.resolve(
            onSecurityViolation?.({
              occurredAt: new Date().toISOString(),
              kind: mcpServer ? "foreign-mcp-request" : "native-tool-request",
              modelId: model.id,
              nativeTool: activity.name,
              ...(mcpServer ? { mcpServer } : {}),
              ...(bridgeRevision ? { bridgeRevision } : {}),
            }),
          ).catch(() => {});
          await turnRuntime.runPromise(turnService.abortSecurityViolation);
          const target = mcpServer ? ` MCP server "${mcpServer}"` : "";
          throw new Error(
            `antigravity security violation: native tool "${activity.name}"${target} was requested; the isolated agy process was terminated.`,
          );
        };

        const abortIncompleteNativeTool = async (): Promise<void> => {
          const activity = controller
            .takeIncompleteTools()
            .find((candidate) => !isBridgedMcpStep(candidate, bridge.serverName));
          if (activity) await abortNativeTool(activity);
        };

        /**
         * Reserve the thinking slot that precedes a text run, returning its
         * index.
         *
         * agy only reports `thinking_tokens` on the response step's DONE event
         * — after that step's text deltas — so the summary cannot be emitted in
         * document order. Claiming the index up front keeps the marker above
         * the answer it introduces (like agy's own collapsed line) while the
         * event stream stays append-only.
         */
        const reserveThought = (): number => {
          if (thoughtIndex !== null) return thoughtIndex;
          output.content.push({ type: "thinking", thinking: "" });
          thoughtIndex = output.content.length - 1;
          stream.push({ type: "thinking_start", contentIndex: thoughtIndex, partial: output });
          return thoughtIndex;
        };

        /**
         * agy's interactive TUI collapses hidden reasoning into one line
         * ("Thought for 3s, 289 tokens"). Print mode never streams thought
         * text, so synthesize the same summary into the reserved slot once the
         * response step reports its token count. The step duration covers
         * thinking plus writing — the closest signal agy exposes to its own
         * thought timer. Only the first substantive response step in a logical
         * agy turn gets a marker, avoiding a repeated row before every tool
         * phase. A thought-only segment has no reservation, so it appends one.
         */
        const emitThoughtMarker = (activity: Extract<AgyActivity, { type: "thought" }>): void => {
          const seconds =
            activity.durationSeconds === undefined
              ? undefined
              : Math.max(1, Math.round(activity.durationSeconds));
          const summary =
            seconds === undefined
              ? `Thought ${activity.tokens} tokens`
              : `Thought for ${seconds}s, ${activity.tokens} tokens`;
          const index = reserveThought();
          const block = output.content[index];
          if (block.type === "thinking") block.thinking = summary;
          stream.push({
            type: "thinking_delta",
            contentIndex: index,
            delta: summary,
            partial: output,
          });
          stream.push({
            type: "thinking_end",
            contentIndex: index,
            content: summary,
            partial: output,
          });
          thoughtIndex = null;
        };

        /**
         * Render a runtime stall/retry as a collapsed thinking line so the
         * user sees why a turn restarted instead of a silent multi-minute
         * spinner. Uses the same reserved-slot mechanism as thought markers
         * so the event stream stays delta-replay legal.
         */
        const emitStallMarker = (activity: Extract<AgyActivity, { type: "stall" }>): void => {
          closeText();
          const seconds = Math.max(1, Math.round(activity.stalledMs / 1000));
          const summary =
            `agy stream stalled for ${seconds}s with no events` +
            `${activity.toolActive ? " while a tool step was active" : ""}` +
            ` — restarting the turn (retry ${activity.retry} of ${activity.maxRetries})`;
          const index = reserveThought();
          const block = output.content[index];
          if (block.type === "thinking") block.thinking = summary;
          stream.push({
            type: "thinking_delta",
            contentIndex: index,
            delta: summary,
            partial: output,
          });
          stream.push({
            type: "thinking_end",
            contentIndex: index,
            content: summary,
            partial: output,
          });
          thoughtIndex = null;
        };

        while (true) {
          const activity = await controller.next();
          if (activity === null) {
            await abortIncompleteNativeTool();
            throw new Error("agy turn ended without a result event.");
          }

          try {
            if (!summaryRequest) onActivity?.(activity);
          } catch {
            // UI side channels are best-effort and must never fail the turn.
          }
          switch (activity.type) {
            case "conversation_fallback": {
              // Runtime/index side channel only; no assistant content.
              break;
            }
            case "usage": {
              usage = activity.usage;
              break;
            }
            case "thought": {
              if (controller.claimThought()) emitThoughtMarker(activity);
              break;
            }
            case "stall": {
              emitStallMarker(activity);
              break;
            }
            case "tool_start": {
              if (isBridgedMcpStep(activity, bridge.serverName)) break;
              await abortNativeTool(activity);
              break;
            }
            case "tool_done": {
              if (isBridgedMcpStep(activity, bridge.serverName)) break;
              await abortNativeTool(activity);
              break;
            }
            case "tool_error": {
              if (isBridgedMcpStep(activity, bridge.serverName)) break;
              await abortNativeTool(activity);
              break;
            }
            case "bridge_call": {
              // agy invoked a pi tool through the bridge: end this message
              // with a toolUse for the REAL pi tool so pi executes it with
              // full ownership (hooks, permissions, rendering, abort).
              closeText();
              const toolCall = {
                type: "toolCall" as const,
                id: activity.id,
                name: activity.name,
                arguments: activity.args,
              };
              output.content.push(toolCall);
              const index = output.content.length - 1;
              stream.push({ type: "toolcall_start", contentIndex: index, partial: output });
              stream.push({
                type: "toolcall_end",
                contentIndex: index,
                toolCall,
                partial: output,
              });
              endWithToolUse();
              return;
            }
            case "text": {
              if (textIndex === null) {
                // Reserve the thought slot BEFORE the text block so the
                // summary can still land above the answer at DONE.
                reserveThought();
                output.content.push({ type: "text", text: "" });
                textIndex = output.content.length - 1;
                textBuffer = "";
                stream.push({ type: "text_start", contentIndex: textIndex, partial: output });
              }
              textBuffer += activity.delta;
              const block = output.content[textIndex];
              if (block.type === "text") block.text = textBuffer;
              stream.push({
                type: "text_delta",
                contentIndex: textIndex,
                delta: activity.delta,
                partial: output,
              });
              break;
            }
            case "result": {
              await abortIncompleteNativeTool();
              // A result carries conversation-cumulative counters, which can
              // represent millions of tokens across agy's internal agent loop.
              // Pi interprets one assistant message's usage as live context and
              // would auto-compact after nearly every user turn. Prefer the
              // latest response step — the actual model call represented by
              // this message — and use the cumulative result only when agy did
              // not expose a response-step usage event.
              if (usage) attachUsage(usage, false);
              else attachUsage(activity.usage, true);

              if (activity.response) {
                if (textIndex !== null) {
                  // Deltas already streamed this block. agy's authoritative
                  // response is normally the concatenation of those deltas, so
                  // drift means a dropped tail: emit the missing suffix as a
                  // real delta, keeping delta-only consumers in sync with
                  // `partial` rather than silently rewriting the block.
                  if (textBuffer !== activity.response) {
                    const block = output.content[textIndex];
                    if (activity.response.startsWith(textBuffer)) {
                      const suffix = activity.response.slice(textBuffer.length);
                      if (block.type === "text") block.text = activity.response;
                      textBuffer = activity.response;
                      stream.push({
                        type: "text_delta",
                        contentIndex: textIndex,
                        delta: suffix,
                        partial: output,
                      });
                    } else {
                      // True divergence (never observed): streamed text cannot
                      // be retracted through deltas, so keep what consumers
                      // already saw and let text_end confirm it.
                      if (block.type === "text") block.text = textBuffer;
                    }
                  }
                  closeText();
                } else {
                  closeUnfilledThought();
                  output.content.push({ type: "text", text: activity.response });
                  const idx = output.content.length - 1;
                  stream.push({ type: "text_start", contentIndex: idx, partial: output });
                  stream.push({
                    type: "text_delta",
                    contentIndex: idx,
                    delta: activity.response,
                    partial: output,
                  });
                  stream.push({
                    type: "text_end",
                    contentIndex: idx,
                    content: activity.response,
                    partial: output,
                  });
                }
              } else {
                closeText();
              }

              const hasResponse =
                Boolean(activity.response?.trim()) ||
                output.content.some((c) => c.type === "text" && Boolean(c.text.trim()));

              // agy flags auto-recovered stream interruptions as ERROR even
              // though the full response was delivered; pi aborts the run on
              // stopReason "error", so complete those turns normally instead.
              const recovered =
                hasResponse && RECOVERED_INTERRUPTION_PATTERN.test(activity.error ?? "");

              if (activity.status === "ERROR" && !recovered) {
                const message = activity.error || "agy reported an error for this turn.";
                output.stopReason = "error";
                output.errorMessage = OVERFLOW_PATTERN.test(message)
                  ? `context_length_exceeded: ${message}`
                  : message;
                stream.push({ type: "error", reason: "error", error: output });
              } else {
                output.stopReason = "stop";
                stream.push({ type: "done", reason: "stop", message: output });
              }
              clearTurn();
              stream.end();
              return;
            }
          }
        }
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    })();

    return stream;
  };
}

// antigravity — use Google Antigravity (agy) models inside the pi coding
// agent via the agy stream-json RPC. pi stays the UI: model picker, portable
// sessions, permissions, tools, and rendering; agy owns only native model context.
// The agy process runs from an empty broker workspace with a strict isolated
// profile and can reach the real project only through Pi's authenticated bridge.
//
// Commands:
//   /agy            show agy conversation and persistent-driver status
//   /agy reset      drop the current agy conversation (next turn starts fresh)
//   /agy models     re-discover models from `agy models` and re-register
//   /agy agents     list configured custom agents
//   /agy doctor     diagnose binary, models, driver, bridge, and local state
//   /agy-usage      show Antigravity model quotas (weekly and 5-hour limits)

import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionUIContext,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, truncateToWidth } from "@earendil-works/pi-tui";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { piConfigDir, readJson, writeJson } from "./lib/config.ts";
import { installAgyDeathHooks, killAllAgyTrees } from "./lib/agy-children.ts";
import { checkAgyBinary, MIN_AGY_VERSION, runAgyCommand } from "./lib/agy-diagnostics.ts";
import { parseAgyAgents, readAgyProcessProfile } from "./lib/agy-profile.ts";
import { AgyPiBridge, selectBridgedTools, type PiToolInfo } from "./lib/bridge.ts";
import { createBridgeLifecycleManager } from "./lib/bridge-lifecycle.ts";
import {
  ACTIVATE_SKILL_TOOL_NAME,
  activateSkillDescription,
  activateSkillParameters,
  handleActivateSkill,
  usableSkillCatalog,
  type SkillLite,
} from "./lib/skills.ts";
import {
  prepareAgySecurityProfile,
  recoverStaleBridgeLock,
  registerSessionBridge,
  resolveAgySecurityProfile,
  SECURE_BRIDGE_SERVER_NAME,
  SECURE_BRIDGE_TOOL_PREFIX,
  sessionBroker,
  unregisterSessionBridge,
  type AgySessionBroker,
} from "./lib/security-profile.ts";
import {
  capabilitiesForModel,
  FALLBACK_MODELS,
  mergeAgyModels,
  modelCacheTtlMs,
  parseAgyModels,
  pricingForModel,
  resolveAgyModelEffort,
  type AgyModelInfo,
} from "./lib/models.ts";
import type { AgyActivity } from "./lib/reducer.ts";
import {
  AGY_COMPACTION_ENTRY,
  agyContextTokens,
  detectAgyCompaction,
  formatAgyContextTokens,
  type AgyCompactionMarker,
} from "./lib/agy-compaction.ts";
import {
  AGY_CONVERSATION_STATE_ENTRY,
  agyConversationExists,
  restorableAgyConversation,
  type PersistedAgyConversation,
  type PersistedAgyReset,
} from "./lib/conversation-state.ts";
import { readAgyConversationMetadata } from "./lib/conversation-metadata.ts";
import { findAgyTask, listAgyTasks, stopAgyTask } from "./lib/tasks.ts";
import { findAgyArtifact, listAgyArtifacts } from "./lib/artifacts.ts";
import { fetchAgyUsage } from "./lib/usage.ts";
import { appendAgySecurityEvent } from "./lib/security-events.ts";
import { openAgyTasksPicker } from "./src/tasks-ui.ts";
import { openArtifact, openAgyArtifactsPicker } from "./src/artifacts-ui.ts";
import { openAgyUsagePicker } from "./src/usage-ui.ts";
import { mapThinkingToEffort, streamAntigravity } from "./src/provider.ts";
import {
  AntigravityRuntime,
  createAntigravityRuntime,
  runAntigravity,
  type AntigravityStateSnapshot,
} from "./src/runtime.ts";

const MODEL_CACHE_FILE = path.join(piConfigDir("antigravity"), "model-list.json");
const DISCOVERY_TIMEOUT_MS = 15_000;
const SECURITY_PROFILE = resolveAgySecurityProfile();
const AGY_BRAIN_DIR = path.join(SECURITY_PROFILE.appDataDir, "brain");
const AGY_METADATA_FILE = path.join(
  SECURITY_PROFILE.appDataDir,
  "cache",
  "conversation_metadata.json",
);

function statusOneLine(value: string, maxLength = 160): string {
  return stripTerminalSequences(value)
    .replace(/[\x00-\x1f\x7f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

// --- Pi-tool bridge ---------------------------------------------------------

const BRIDGE_ENABLED = process.env.PI_ANTIGRAVITY_PI_TOOL_BRIDGE !== "0";

async function execAgy(args: string[], timeoutMs = DISCOVERY_TIMEOUT_MS): Promise<string> {
  await prepareAgySecurityProfile(SECURITY_PROFILE);
  return (
    await runAgyCommand([`--gemini_dir=${SECURITY_PROFILE.geminiDir}`, ...args], {
      timeoutMs,
      cwd: SECURITY_PROFILE.brokerRoot,
      sandbox: {
        required: true,
        geminiDir: SECURITY_PROFILE.geminiDir,
        brokerCwd: SECURITY_PROFILE.brokerRoot,
      },
    })
  ).stdout;
}

interface ModelCache {
  fetchedAt?: number;
  source?: "live" | "fallback";
  models: AgyModelInfo[];
}

/**
 * Default rates (USD per Mtok) feed pi's native cost calculation. Per-model
 * overrides belong in pi's own ~/.pi/agent/models.json under
 * providers.antigravity.modelOverrides — pi applies them over registered models.
 */
function toProviderModel(model: AgyModelInfo): ProviderModelConfig {
  const capabilities = capabilitiesForModel(model.id);
  return {
    id: model.id,
    name: model.name,
    reasoning: true,
    input: ["text"],
    cost: pricingForModel(model.id),
    contextWindow: capabilities.contextWindow,
    maxTokens: capabilities.maxTokens,
  };
}

/** Collapse effort variants and dedupe (also heals pre-0.2.0 caches). */
function normalizeModels(models: AgyModelInfo[]): AgyModelInfo[] {
  return mergeAgyModels(models).map((model) => {
    if (model.supportedEfforts.length > 0) return model;
    const fallback = FALLBACK_MODELS.find((candidate) => candidate.id === model.id);
    return fallback?.supportedEfforts.length
      ? {
          ...model,
          supportedEfforts: [...fallback.supportedEfforts],
          defaultEffort: fallback.defaultEffort,
        }
      : model;
  });
}

async function listAgyModels(): Promise<AgyModelInfo[]> {
  try {
    return parseAgyModels(await execAgy(["models"]));
  } catch {
    return [];
  }
}

function getInitialModelCache(): ModelCache {
  const cached = readJson<ModelCache | null>(MODEL_CACHE_FILE, null);
  if (cached?.models?.length) {
    return { ...cached, models: normalizeModels(cached.models) };
  }
  return {
    fetchedAt: 0,
    source: "fallback",
    models: FALLBACK_MODELS,
  };
}

async function discoverModels(refresh = false): Promise<ModelCache> {
  if (!refresh) {
    const cached = readJson<ModelCache | null>(MODEL_CACHE_FILE, null);
    if (
      cached?.models?.length &&
      cached.fetchedAt &&
      Date.now() - cached.fetchedAt < modelCacheTtlMs(cached.source)
    ) {
      return { ...cached, models: normalizeModels(cached.models) };
    }
  }
  const live = await listAgyModels();
  const cache: ModelCache = live.length
    ? { fetchedAt: Date.now(), source: "live", models: normalizeModels(live) }
    : { fetchedAt: Date.now(), source: "fallback", models: FALLBACK_MODELS };
  try {
    writeJson(MODEL_CACHE_FILE, cache);
  } catch {
    // Cache is best-effort; discovery still returns.
  }
  return cache;
}

export default function antigravityExtension(pi: ExtensionAPI): void {
  installAgyDeathHooks();
  const runtime = createAntigravityRuntime();
  const service = runtime.runSync(AntigravityRuntime);
  let currentCache = getInitialModelCache();
  let observedContextTokens: number | undefined;
  let persistedConversationKey: string | undefined;
  let selectedModelKey: string | undefined;
  let activeBroker: AgySessionBroker | undefined;
  let activePiSessionId: string | undefined;

  pi.registerEntryRenderer(AGY_COMPACTION_ENTRY, (entry, _options, theme) => {
    const marker = entry.data as AgyCompactionMarker;
    const text =
      theme.fg("dim", "── ") +
      theme.fg("accent", "agy compacted context") +
      theme.fg(
        "dim",
        ` · ~${formatAgyContextTokens(marker.beforeTokens)} → ~${formatAgyContextTokens(marker.afterTokens)} ──`,
      );
    return {
      render: (width: number) => [truncateToWidth(text, width, "")],
      invalidate: () => {},
    };
  });

  const conversationStateKey = (state: {
    conversationId: string;
    modelId: string;
    turns: number;
  }): string => `${state.conversationId}:${state.modelId}:${state.turns}`;

  async function persistConversationState(ctx: ExtensionContext, force = false): Promise<void> {
    if (ctx.model?.provider !== "antigravity") return;
    const snapshot = await runAntigravity(runtime, service.snapshot);
    if (!snapshot.conversationId || !snapshot.model || snapshot.cwd !== ctx.cwd) return;
    const state: PersistedAgyConversation = {
      version: 1,
      kind: "conversation",
      sessionId: ctx.sessionManager.getSessionId(),
      conversationId: snapshot.conversationId,
      cwd: ctx.cwd,
      modelId: snapshot.model,
      turns: snapshot.turns,
      usage: snapshot.conversationUsage,
      contextTokens: observedContextTokens,
    };
    const key = conversationStateKey(state);
    if (!force && key === persistedConversationKey) return;
    pi.appendEntry(AGY_CONVERSATION_STATE_ENTRY, state);
    persistedConversationKey = key;
  }

  function appendConversationReset(ctx: ExtensionContext): void {
    const reset: PersistedAgyReset = {
      version: 1,
      kind: "reset",
      sessionId: ctx.sessionManager.getSessionId(),
      cwd: ctx.cwd,
    };
    pi.appendEntry(AGY_CONVERSATION_STATE_ENTRY, reset);
    observedContextTokens = undefined;
    persistedConversationKey = undefined;
  }

  // --- Pi-tool bridge setup -------------------------------------------------

  const bridge = new AgyPiBridge(SECURE_BRIDGE_SERVER_NAME);
  const bridgeToken = randomUUID();
  bridge.requireToken(bridgeToken);
  bridge.setToolPrefix(SECURE_BRIDGE_TOOL_PREFIX);
  bridge.setOnCall((call) => service.pushBridgeCall(call));

  const bridgeManager = createBridgeLifecycleManager({
    bridge,
    bridgeToken,
    enabled: BRIDGE_ENABLED,
    addMcpServer: async (_serverName, url, token) => {
      if (!activeBroker) throw new Error("no Pi session broker is active.");
      await registerSessionBridge(SECURITY_PROFILE, activeBroker, url, token);
    },
    removeMcpServer: async () => {
      if (activeBroker) await unregisterSessionBridge(SECURITY_PROFILE, activeBroker);
    },
    evictMcpCache: async () => {},
  });

  /**
   * Register the pi-tool bridge with agy. Idempotent: no-op when disabled or
   * already registered. Registration must precede the first agy spawn of the
   * session — agy eagerly connects to MCP servers at startup (verified
   * 2026-08-21) — so this runs as soon as an Antigravity model is selected.
   */
  async function ensureBridgeRegistered(ui?: ExtensionUIContext): Promise<void> {
    const registered = await bridgeManager.ensureRegistered((warning) =>
      ui?.notify(warning, "warning"),
    );
    if (!registered) {
      throw new Error("antigravity: secure Pi bridge registration failed; refusing to start agy.");
    }
  }

  /**
   * Deregister the pi-tool bridge and evict its manifest cache. No-op when
   * the bridge is not registered or running. Runs when the session leaves
   * Antigravity models and on shutdown.
   */
  async function teardownBridge(): Promise<void> {
    await bridgeManager.teardown();
  }

  // --- Skill passing (Phase 2) ----------------------------------------------
  // pi's loaded skills, refreshed per turn via before_agent_start so /reload
  // is respected. Model-invocation-disabled skills are excluded.
  let loadedSkills: SkillLite[] = [];

  function captureSkills(skills: unknown): void {
    if (!Array.isArray(skills)) return;
    loadedSkills = skills
      .map((skill) => skill as Partial<SkillLite> & { disableModelInvocation?: boolean })
      .filter(
        (skill) => skill.disableModelInvocation !== true && typeof skill.filePath === "string",
      )
      .map((skill) => ({
        name: String(skill.name),
        description: String(skill.description ?? ""),
        filePath: String(skill.filePath),
        baseDir: String(skill.baseDir ?? path.dirname(String(skill.filePath))),
      }));
  }

  const bridgedSkills = () => usableSkillCatalog(loadedSkills);

  /** Publish one `pi__activate_skill` tool for Pi-discovered skills. */
  function refreshSkillTools(): void {
    if (!BRIDGE_ENABLED) return;
    const skills = bridgedSkills();
    if (skills.length === 0) {
      bridge.setDynamicTools([]);
      return;
    }
    bridge.setDynamicTools([
      {
        name: ACTIVATE_SKILL_TOOL_NAME,
        description: activateSkillDescription(skills),
        parameters: activateSkillParameters(skills),
        handler: (args) => handleActivateSkill(skills, args),
      },
    ]);
  }

  bridge.setToolSource(() => {
    if (!BRIDGE_ENABLED) return [];
    let activeNames: string[] = [];
    let allTools: PiToolInfo[] = [];
    try {
      activeNames = pi.getActiveTools();
      allTools = pi.getAllTools() as PiToolInfo[];
    } catch {
      return []; // API unavailable (print/RPC edge) — expose nothing.
    }
    return selectBridgedTools(allTools, activeNames);
  });

  // Per-skill tools are gone; one activate_skill tool is published on every
  // skills capture via refreshSkillTools().

  // --- Status-bar hint for live agy background tasks -----------------------

  const AGY_TASKS_WIDGET_KEY = "agy-tasks";
  const AGY_ARTIFACTS_WIDGET_KEY = "agy-artifacts";
  let tasksUi: ExtensionUIContext | undefined;
  let tasksSessionCwd: string | undefined;
  let widgetLiveCount = -1;
  let widgetArtifactCount = -1;
  let widgetScanInFlight = false;
  let widgetScanQueued = false;
  let agyAgentActive = false;
  let widgetPollTimer: ReturnType<typeof setInterval> | undefined;
  const WIDGET_POLL_MS = 2_000;

  function setAgyTasksWidget(live: number): void {
    if (!tasksUi || live === widgetLiveCount) return;
    widgetLiveCount = live;
    try {
      if (live === 0) {
        tasksUi.setWidget(AGY_TASKS_WIDGET_KEY, undefined);
        return;
      }
      tasksUi.setWidget(AGY_TASKS_WIDGET_KEY, (_tui, theme) => {
        const line =
          theme.fg("warning", "■ ") +
          theme.fg("text", `${live} agy background task${live === 1 ? "" : "s"}`) +
          theme.fg("dim", " • ") +
          theme.fg("accent", "/agy-tasks") +
          theme.fg("dim", " to view");
        return {
          render: (width: number) => [truncateToWidth(line, width, "")],
          invalidate: () => {},
        };
      });
    } catch {
      // UI may be unavailable (print/RPC modes or teardown).
    }
  }

  function setAgyArtifactsWidget(count: number): void {
    if (!tasksUi || count === widgetArtifactCount) return;
    widgetArtifactCount = count;
    try {
      if (count === 0) {
        tasksUi.setWidget(AGY_ARTIFACTS_WIDGET_KEY, undefined);
        return;
      }
      tasksUi.setWidget(AGY_ARTIFACTS_WIDGET_KEY, (_tui, theme) => {
        const line =
          theme.fg("success", "◆ ") +
          theme.fg("text", `${count} agy artifact${count === 1 ? "" : "s"}`) +
          theme.fg("dim", " • ") +
          theme.fg("accent", "/agy-artifacts") +
          theme.fg("dim", " to view");
        return {
          render: (width: number) => [truncateToWidth(line, width, "")],
          invalidate: () => {},
        };
      });
    } catch {
      // UI may be unavailable (print/RPC modes or teardown).
    }
  }

  function reconcileWidgetPolling(): void {
    const shouldPoll = Boolean(tasksUi && (agyAgentActive || widgetLiveCount > 0));
    if (shouldPoll && !widgetPollTimer) {
      widgetPollTimer = setInterval(updateAgyTasksWidget, WIDGET_POLL_MS);
      widgetPollTimer.unref?.();
    } else if (!shouldPoll && widgetPollTimer) {
      clearInterval(widgetPollTimer);
      widgetPollTimer = undefined;
    }
  }

  /** Rescan task state independently from agy's provider stream. */
  function updateAgyTasksWidget(): void {
    if (!tasksUi) return;
    if (widgetScanInFlight) {
      widgetScanQueued = true;
      return;
    }
    widgetScanInFlight = true;
    void (async () => {
      try {
        const snapshot = await runAntigravity(runtime, service.snapshot);
        if (!snapshot.conversationId) {
          setAgyTasksWidget(0);
          setAgyArtifactsWidget(0);
          return;
        }
        const [tasks, artifacts] = await Promise.all([
          listAgyTasks(snapshot.conversationId, {
            brainDir: AGY_BRAIN_DIR,
            sessionCwd: tasksSessionCwd,
          }),
          listAgyArtifacts(snapshot.conversationId, { brainDir: AGY_BRAIN_DIR }),
        ]);
        setAgyTasksWidget(
          tasks.filter((task) => task.pids.length > 0 || task.orphans.length > 0).length,
        );
        setAgyArtifactsWidget(artifacts.length);
      } catch {
        // Runtime closed or scan failed; leave the widget as-is.
      } finally {
        widgetScanInFlight = false;
        if (widgetScanQueued) {
          widgetScanQueued = false;
          queueMicrotask(updateAgyTasksWidget);
        } else {
          reconcileWidgetPolling();
        }
      }
    })();
  }

  function handleAgyActivity(activity: AgyActivity): void {
    if (activity.type === "conversation_fallback") {
      observedContextTokens = undefined;
      persistedConversationKey = undefined;
      return;
    }
    if (activity.type === "usage") {
      const nextContextTokens = agyContextTokens(activity.usage);
      const compaction = detectAgyCompaction(observedContextTokens, nextContextTokens);
      if (compaction) {
        const marker: AgyCompactionMarker = {
          version: 1,
          ...compaction,
          detectedAt: new Date().toISOString(),
        };
        pi.appendEntry(AGY_COMPACTION_ENTRY, marker);
      }
      observedContextTokens = nextContextTokens;
      return;
    }
    if (
      (activity.type === "tool_start" ||
        activity.type === "tool_done" ||
        activity.type === "tool_error") &&
      (activity.name === "run_command" || activity.name === "schedule")
    ) {
      // ACTIVE arrives before a sleeping command completes. Start the
      // independent filesystem scan now instead of waiting for onSettled,
      // then retry once in case the task log and holder fd are still racing.
      updateAgyTasksWidget();
      if (activity.type === "tool_start") {
        const retry = setTimeout(updateAgyTasksWidget, 500);
        retry.unref?.();
      }
    }
  }

  const registerAntigravityProvider = (models: AgyModelInfo[]) => {
    pi.registerProvider("antigravity", {
      name: "Google Antigravity (agy)",
      baseUrl: "agy://local-stream-json",
      apiKey: "agy-local-session",
      api: "antigravity-stream-json",
      models: models.map(toProviderModel),
      streamSimple: streamAntigravity(
        runtime,
        service,
        bridge,
        updateAgyTasksWidget,
        handleAgyActivity,
        createAntigravityRuntime,
        (modelId) => currentCache.models.find((candidate) => candidate.id === modelId),
        readAgyProcessProfile,
        bridgeManager.processRevision,
        () => {
          if (!activeBroker || !bridgeManager.isRegistered() || !bridgeManager.isRunning()) {
            throw new Error("antigravity: secure Pi bridge is unavailable; refusing to start agy.");
          }
          return {
            geminiDir: SECURITY_PROFILE.geminiDir,
            brokerCwd: activeBroker.cwd,
            sandbox: {
              required: true,
              geminiDir: SECURITY_PROFILE.geminiDir,
              brokerCwd: activeBroker.cwd,
            },
          };
        },
        async (event) => {
          await appendAgySecurityEvent({
            ...event,
            ...(activePiSessionId ? { piSessionId: activePiSessionId } : {}),
          });
        },
      ),
    });
  };

  registerAntigravityProvider(currentCache.models);

  async function refreshStaleModelsWhenSelected(): Promise<void> {
    if (
      currentCache.fetchedAt &&
      Date.now() - currentCache.fetchedAt < modelCacheTtlMs(currentCache.source)
    ) {
      return;
    }
    const fresh = await discoverModels(true);
    currentCache = fresh;
    registerAntigravityProvider(fresh.models);
  }

  pi.on("before_agent_start", (event) => {
    captureSkills(event.systemPromptOptions?.skills);
    refreshSkillTools();
  });

  // The agy stream reports tool starts immediately, but its DONE event can be
  // delayed by a sleeping command. Poll the independent filesystem task
  // source while the agent or any discovered task is live, then stop when
  // both are idle. This keeps the widget current without a permanent timer.
  pi.on("agent_start", (_event, ctx) => {
    if (ctx.model?.provider !== "antigravity") return;
    agyAgentActive = true;
    updateAgyTasksWidget();
    reconcileWidgetPolling();
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (ctx.model?.provider !== "antigravity" && !agyAgentActive) return;
    agyAgentActive = false;
    updateAgyTasksWidget();
  });

  pi.on("session_start", async (event, ctx: ExtensionContext) => {
    activePiSessionId = ctx.sessionManager.getSessionId();
    const nextBroker = sessionBroker(SECURITY_PROFILE, ctx.sessionManager.getSessionId());
    if (activeBroker && activeBroker.sessionKey !== nextBroker.sessionKey) {
      await teardownBridge();
    }
    activeBroker = nextBroker;
    selectedModelKey = ctx.model ? `${ctx.model.provider}:${ctx.model.id}` : undefined;
    const restored =
      event.reason !== "fork" && ctx.model?.provider === "antigravity"
        ? restorableAgyConversation(
            ctx.sessionManager.getBranch(),
            ctx.sessionManager.getSessionId(),
            ctx.cwd,
          )
        : undefined;
    const compatibleRestore =
      restored &&
      restored.modelId === ctx.model?.id &&
      (await agyConversationExists(restored.conversationId, SECURITY_PROFILE.geminiDir))
        ? restored
        : undefined;
    await runAntigravity(
      runtime,
      service.setSession(ctx.cwd, undefined, !compatibleRestore && event.reason !== "new"),
    );
    if (compatibleRestore) {
      await runAntigravity(
        runtime,
        service.restoreConversation({
          conversationId: compatibleRestore.conversationId,
          modelId: compatibleRestore.modelId,
          cwd: compatibleRestore.cwd,
          turns: compatibleRestore.turns,
          usage: compatibleRestore.usage,
        }),
      );
      observedContextTokens = compatibleRestore.contextTokens;
      persistedConversationKey = conversationStateKey(compatibleRestore);
    } else {
      observedContextTokens = undefined;
      persistedConversationKey = undefined;
    }
    if (ctx.hasUI) tasksUi = ctx.ui;
    tasksSessionCwd = ctx.cwd;
    updateAgyTasksWidget();
    // The pi-tool bridge is only useful while an Antigravity model is
    // selected: register lazily here (session resumed on an agy model) and on
    // model_select; non-agy sessions never touch agy at all.
    if (ctx.model?.provider === "antigravity") {
      await ensureBridgeRegistered(ctx.ui);
      await refreshStaleModelsWhenSelected();
    }
  });

  pi.on("model_select", async (event, ctx) => {
    const nextModelKey = event.model ? `${event.model.provider}:${event.model.id}` : undefined;
    if (selectedModelKey?.startsWith("antigravity:") && selectedModelKey !== nextModelKey) {
      // Another provider/model can add context that the mutable agy
      // conversation never saw. Force a branch bootstrap when agy is selected
      // again instead of silently resuming stale native history.
      await runAntigravity(runtime, service.setSession(ctx.cwd, undefined, true));
      observedContextTokens = undefined;
      persistedConversationKey = undefined;
    }
    selectedModelKey = nextModelKey;
    // The bridge exists only while an Antigravity model is selected.
    if (event.model?.provider === "antigravity") {
      // In non-interactive print mode Pi can emit the initial model_select
      // before session_start has established the session broker. session_start
      // performs the same registration after assigning activeBroker, so defer
      // here instead of turning a harmless startup ordering difference into a
      // fail-closed extension error.
      if (!activeBroker) return;
      await ensureBridgeRegistered(ctx?.ui);
      await refreshStaleModelsWhenSelected();
    } else {
      await teardownBridge();
    }
  });

  pi.on("session_tree", async (_event, ctx: ExtensionContext) => {
    // An agy conversation cannot be rewound to match a different pi branch.
    // Restart it and bootstrap the selected branch on the next provider call.
    await runAntigravity(runtime, service.setSession(ctx.cwd, undefined, true));
    appendConversationReset(ctx);
    setAgyTasksWidget(0);
    setAgyArtifactsWidget(0);
  });

  pi.on("agent_settled", async (_event, ctx: ExtensionContext) => {
    await persistConversationState(ctx);
  });

  pi.on("session_compact", async (_event, ctx: ExtensionContext) => {
    // Pi manual/overflow compaction changes the session branch but not agy's
    // native conversation. Re-anchor the same owner after the compaction entry.
    await persistConversationState(ctx, true);
  });

  pi.on("session_shutdown", async () => {
    agyAgentActive = false;
    if (widgetPollTimer) clearInterval(widgetPollTimer);
    widgetPollTimer = undefined;
    widgetScanQueued = false;
    // Stop any live agy background tasks so closing pi leaves nothing
    // running silently. Only processes holding the task log open are certain
    // enough to stop automatically; heuristic orphan matches stay visible in
    // /agy-tasks but require an explicit user stop to avoid false positives.
    try {
      const snapshot = await runAntigravity(runtime, service.snapshot);
      if (snapshot.conversationId) {
        const tasks = await listAgyTasks(snapshot.conversationId, {
          brainDir: AGY_BRAIN_DIR,
          sessionCwd: tasksSessionCwd,
        });
        const live = tasks.filter((task) => task.pids.length > 0);
        await Promise.all(live.map((task) => stopAgyTask(task, { includeOrphans: false })));
      }
    } catch {
      // Runtime closed or scan failed; nothing to stop.
    }
    // Close the runtime: aborts any in-flight agy child process, then tear
    // down the Effect runtime.
    try {
      await runAntigravity(runtime, service.close);
    } catch {
      // Already closed.
    }
    if (bridgeManager.isRegistered() || bridgeManager.isRunning()) {
      await teardownBridge();
    }
    try {
      tasksUi?.setWidget(AGY_TASKS_WIDGET_KEY, undefined);
      tasksUi?.setWidget(AGY_ARTIFACTS_WIDGET_KEY, undefined);
    } catch {
      // UI may already be gone.
    }
    tasksUi = undefined;
    widgetLiveCount = -1;
    widgetArtifactCount = -1;
    widgetScanInFlight = false;
    try {
      await runtime.dispose();
    } catch {
      // Disposed gracefully
    }
    // Sweep any remaining tracked agy process trees (including earlier turns
    // that finished logically while grandchildren held stdio open).
    killAllAgyTrees();
  });

  pi.registerCommand("agy", {
    description: "Manage the agy backend: status | reset | models | agents | doctor | unlock",
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "reset") {
        await runAntigravity(runtime, service.reset);
        appendConversationReset(ctx);
        ctx.ui.notify("antigravity: conversation reset; next turn starts fresh.", "info");
        return;
      }
      if (sub === "models") {
        const refreshed = await discoverModels(true);
        currentCache = refreshed;
        registerAntigravityProvider(refreshed.models);
        ctx.ui.notify(
          `antigravity: ${refreshed.models.length} models registered (${refreshed.source}).`,
          "info",
        );
        return;
      }
      if (sub === "agents") {
        try {
          const agents = parseAgyAgents(await execAgy(["agents"]));
          ctx.ui.notify(
            agents.length > 0
              ? `antigravity custom agents:\n${agents.map((agent) => `• ${agent}`).join("\n")}`
              : "antigravity: no custom agents configured.",
            "info",
          );
        } catch (error) {
          ctx.ui.notify(
            `antigravity: failed to list agents (${error instanceof Error ? error.message : String(error)}).`,
            "error",
          );
        }
        return;
      }
      if (sub === "unlock") {
        try {
          const result = await recoverStaleBridgeLock(SECURITY_PROFILE);
          ctx.ui.notify(
            result === "recovered"
              ? "antigravity: stale bridge lock and global endpoint cleared."
              : "antigravity: bridge profile is not locked.",
            "info",
          );
        } catch (error) {
          ctx.ui.notify(
            `antigravity: lock recovery refused (${error instanceof Error ? error.message : String(error)}).`,
            "error",
          );
        }
        return;
      }
      if (sub === "doctor") {
        const lines = ["antigravity doctor"];
        await prepareAgySecurityProfile(SECURITY_PROFILE);
        const binary = await checkAgyBinary({
          refresh: true,
          sandbox: {
            required: true,
            geminiDir: SECURITY_PROFILE.geminiDir,
            brokerCwd: activeBroker?.cwd ?? SECURITY_PROFILE.brokerRoot,
          },
        });
        if (binary.ok) {
          lines.push(
            `binary: ${binary.binary} (${binary.version}, ${binary.source})`,
            `binary selection: ${binary.selectionReason ?? "compatible candidate"}`,
            `minimum: ${MIN_AGY_VERSION}`,
          );
        } else {
          lines.push(
            `binary: ERROR [${binary.category}] ${binary.message}`,
            `minimum: ${MIN_AGY_VERSION}`,
          );
        }
        for (const candidate of binary.candidates ?? []) {
          const selected =
            binary.ok && candidate.binary === binary.binary ? "selected" : "candidate";
          lines.push(
            `binary ${selected}: ${candidate.source} ${candidate.binary} · ${
              candidate.ok
                ? candidate.development
                  ? (candidate.version ?? "development")
                  : (candidate.version ?? "unknown")
                : `ERROR [${candidate.category ?? "unknown"}]`
            }`,
          );
        }

        try {
          const discovered = parseAgyModels(await execAgy(["models"]));
          if (discovered.length === 0) throw new Error("no valid model rows returned");
          currentCache = { fetchedAt: Date.now(), source: "live", models: discovered };
          registerAntigravityProvider(discovered);
          lines.push(`models: ${discovered.length} (live)`);
        } catch (error) {
          lines.push(
            `models: ERROR ${error instanceof Error ? error.message : String(error)}; ${currentCache.models.length} cached (${currentCache.source})`,
          );
        }

        let snapshot: AntigravityStateSnapshot | undefined;
        try {
          snapshot = await runAntigravity(runtime, service.snapshot);
          const executor = snapshot.executor;
          const config = executor.config;
          lines.push(
            `driver: ${executor.mode} · ${executor.state}${executor.pid ? ` · pid ${executor.pid}` : ""}`,
            `driver binary: ${config?.binary ?? "none"}${config?.binaryVersion ? ` · ${config.binaryVersion}` : ""}`,
            `driver config: model=${config?.model ?? "none"} effort=${config?.effort ?? "none"} agent=${config?.agent ?? "none"} mode=${config?.mode ?? "default"}`,
          );
          if (executor.stats) {
            const stats = executor.stats;
            const reasons = Object.entries(stats.recycleReasons)
              .map(([reason, count]) => `${reason}=${count}`)
              .join(", ");
            lines.push(
              executor.mode === "persistent"
                ? `driver stats: spawns=${stats.spawnCount} respawns=${Math.max(0, stats.spawnCount - 1)} turns=${stats.submittedTurns} reused=${stats.reusedTurns} recycles=${stats.recycleCount} current=${stats.currentProcessTurns}`
                : `driver stats: one-shot launches=${stats.spawnCount} turns=${stats.submittedTurns}`,
              `driver recycle reasons: ${reasons || "none"}`,
            );
          }
        } catch (error) {
          lines.push(`driver: ERROR ${error instanceof Error ? error.message : String(error)}`);
        }

        const selected = currentCache.models.find((model) => model.id === ctx.model?.id);
        let profile = "agent=none mode=default";
        try {
          const configured = readAgyProcessProfile();
          profile = `agent=${configured.agent ?? "none"} mode=${configured.mode ?? "default"}`;
          lines.push(
            `selection: ${ctx.model?.id ?? "none"} · effort ${
              resolveAgyModelEffort(
                selected,
                ctx.thinkingLevel === "off"
                  ? undefined
                  : mapThinkingToEffort(
                      ctx.thinkingLevel as Exclude<typeof ctx.thinkingLevel, "off">,
                    ),
              ) ?? "none"
            }`,
          );
        } catch (error) {
          lines.push(`profile: ERROR ${error instanceof Error ? error.message : String(error)}`);
        }
        lines.push(`profile: ${profile}`);
        lines.push(
          `bridge: enabled=${BRIDGE_ENABLED} running=${bridgeManager.isRunning()} registered=${bridgeManager.isRegistered()} revision=${bridgeManager.processRevision()}`,
        );

        const conversationId = snapshot?.conversationId;
        if (conversationId) {
          const [exists, metadata] = await Promise.all([
            agyConversationExists(conversationId, SECURITY_PROFILE.geminiDir),
            readAgyConversationMetadata(conversationId, { file: AGY_METADATA_FILE }),
          ]);
          lines.push(
            `conversation: ${conversationId} · db ${exists ? "readable" : "missing/unreadable"}`,
            `metadata: ${metadata.status}`,
          );
        } else {
          lines.push("conversation: none", "metadata: not applicable");
        }
        ctx.ui.notify(lines.join("\n"), binary.ok ? "info" : "error");
        return;
      }
      if (sub) {
        ctx.ui.notify(
          `antigravity: unknown argument "${sub}". Use reset | models | agents | doctor | unlock.`,
          "error",
        );
        return;
      }
      const snapshot = await runAntigravity(runtime, service.snapshot);
      const id = snapshot.conversationId;
      const metadata = id
        ? await readAgyConversationMetadata(id, { file: AGY_METADATA_FILE })
        : undefined;
      const metadataTitle = metadata?.metadata?.title
        ? statusOneLine(metadata.metadata.title)
        : undefined;
      const title = metadataTitle || (id ? id.slice(0, 12) : "none — next turn starts fresh");
      const updated = metadata?.metadata?.updatedAt
        ? new Date(metadata.metadata.updatedAt).toLocaleString()
        : undefined;
      const details = [
        `model: ${snapshot.model ?? "unselected"}`,
        `turns: ${snapshot.turns}`,
        `driver: ${snapshot.executor.mode}/${snapshot.executor.state}${snapshot.executor.pid ? ` pid=${snapshot.executor.pid}` : ""}`,
        observedContextTokens === undefined
          ? undefined
          : `native context: ~${formatAgyContextTokens(observedContextTokens)}/185k`,
        metadata?.metadata?.numSteps === undefined
          ? undefined
          : `native steps: ${metadata.metadata.numSteps}`,
        updated ? `updated: ${updated}` : undefined,
      ].filter((part): part is string => part !== undefined);
      let profile = "agent: none · mode: default";
      try {
        const configured = readAgyProcessProfile();
        profile = `agent: ${configured.agent ?? "none"} · mode: ${configured.mode ?? "default"}`;
      } catch (error) {
        profile = `profile error: ${error instanceof Error ? error.message : String(error)}`;
      }
      ctx.ui.notify(
        `antigravity: ${title}\nconversation: ${id ?? "none"}\n${details.join(" · ")}\n${profile}`,
        "info",
      );
    },
  });

  pi.registerCommand("agy-tasks", {
    description: "List agy background tasks; `stop <task-id>|stop all` to terminate",
    handler: async (args, ctx) => {
      const arg = args.trim().toLowerCase();
      const snapshot = await runAntigravity(runtime, service.snapshot);
      const conversationId = snapshot.conversationId;
      if (!conversationId) {
        ctx.ui.notify("agy-tasks: no agy conversation in this session yet.", "error");
        return;
      }
      const rescan = () =>
        listAgyTasks(conversationId, { brainDir: AGY_BRAIN_DIR, sessionCwd: ctx.cwd });

      // No arguments: interactive dashboard overlay (x stops, r rescans).
      if (!arg) {
        await openAgyTasksPicker(ctx, rescan);
        updateAgyTasksWidget();
        return;
      }

      const tasks = await rescan();
      const stopMatch = arg.match(/^stop\s+(.+)$/);
      if (!stopMatch) {
        ctx.ui.notify('agy-tasks: usage "/agy-tasks" or "/agy-tasks stop <task-id>|all".', "error");
        return;
      }
      const target = stopMatch[1].trim();
      const selected =
        target === "all"
          ? tasks.filter((task) => task.pids.length > 0 || task.orphans.length > 0)
          : [findAgyTask(tasks, target)].filter(
              (task): task is NonNullable<typeof task> => task !== undefined,
            );
      if (selected.length === 0) {
        ctx.ui.notify(`agy-tasks: no running task "${target}" in this conversation.`, "error");
        return;
      }
      const results = await Promise.all(selected.map((task) => stopAgyTask(task)));
      const stopped = selected.map((task) => task.id).join(", ");
      ctx.ui.notify(
        `agy-tasks: sent SIGTERM to ${stopped} (${results.reduce((sum, count) => sum + count, 0)} process(es)).`,
        "info",
      );
      updateAgyTasksWidget();
    },
  });

  pi.registerCommand("agy-artifacts", {
    description: "List the agy conversation's artifacts (agent-created files, uploads)",
    handler: async (args, ctx) => {
      const snapshot = await runAntigravity(runtime, service.snapshot);
      const conversationId = snapshot.conversationId;
      if (!conversationId) {
        ctx.ui.notify("agy-artifacts: no agy conversation in this session yet.", "error");
        return;
      }
      const rescan = () => listAgyArtifacts(conversationId, { brainDir: AGY_BRAIN_DIR });
      const arg = args.trim();

      // `open <name>`: non-interactive open by exact name or unique prefix.
      const openMatch = arg.match(/^open\s+(.+)$/);
      if (openMatch) {
        const artifacts = await rescan();
        const artifact = findAgyArtifact(artifacts, openMatch[1]);
        if (!artifact) {
          ctx.ui.notify(`agy-artifacts: no artifact matching "${openMatch[1]}".`, "error");
          return;
        }
        try {
          await openArtifact(artifact.absolutePath);
          ctx.ui.notify(`agy-artifacts: opened ${artifact.name}`, "info");
        } catch (error) {
          ctx.ui.notify(
            `agy-artifacts: failed to open ${artifact.name} (${error instanceof Error ? error.message : error}).`,
            "error",
          );
        }
        return;
      }
      if (arg) {
        ctx.ui.notify(
          'agy-artifacts: usage "/agy-artifacts" or "/agy-artifacts open <name>".',
          "error",
        );
        return;
      }

      await openAgyArtifactsPicker(ctx, rescan);
    },
  });

  pi.registerCommand("agy-usage", {
    description: "Show Antigravity model quotas (weekly and 5-hour limits)",
    handler: async (args, ctx) => {
      if (args.trim()) {
        ctx.ui.notify('agy-usage: usage "/agy-usage".', "error");
        return;
      }
      await openAgyUsagePicker(ctx, (signal) =>
        fetchAgyUsage({
          signal,
          geminiDir: SECURITY_PROFILE.geminiDir,
          sandbox: {
            required: true,
            geminiDir: SECURITY_PROFILE.geminiDir,
            brokerCwd: activeBroker?.cwd ?? SECURITY_PROFILE.brokerRoot,
          },
        }),
      );
    },
  });
}

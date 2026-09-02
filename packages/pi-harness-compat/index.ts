import type {
  ExtensionAPI,
  ExtensionContext,
  ToolCallEvent,
  ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";
import {
  getAgentDir,
  ProjectTrustStore,
  createBashToolDefinition,
  createLocalBashOperations,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import {
  evaluateClaudePermission,
  loadClaudePermissionPolicy,
  type PermissionEvaluation,
} from "./lib/claude-permissions.ts";
import { evaluateBashPermission } from "./lib/bash.ts";
import {
  applyCodexEnvironmentPolicy,
  checkCodexPathAccess,
  loadCodexSandboxPolicy,
  type CodexSandboxPolicy,
} from "./lib/codex-policy.ts";
import { notifyPermissionRequest } from "./lib/hooks.ts";
import { buildPiSeatbeltPolicy, wrapCommandWithSeatbelt } from "./lib/seatbelt.ts";

const FILE_READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const FILE_WRITE_TOOLS = new Set(["write", "edit"]);
const MCP_APPROVAL_EVENT = "pi-mcp-adapter:tool-approval-request";

interface McpApprovalRequest {
  serverName: string;
  originalToolName: string;
  prefixedToolName: string;
  args: Record<string, unknown>;
  claim: (decision: () => Promise<"allow_once" | "allow_for_session" | "deny" | "abstain">) => void;
}

function toolPath(event: ToolCallEvent): string | undefined {
  if (
    event.toolName === "read" ||
    event.toolName === "write" ||
    event.toolName === "edit" ||
    event.toolName === "grep" ||
    event.toolName === "find" ||
    event.toolName === "ls"
  ) {
    const value = event.input.path;
    return typeof value === "string" && value ? value : ".";
  }
  return undefined;
}

function formatPermissionPrompt(
  event: ToolCallEvent,
  evaluation: PermissionEvaluation,
  canonicalPath?: string,
): string {
  const details =
    event.toolName === "bash"
      ? String(event.input.command ?? "")
      : (canonicalPath ?? JSON.stringify(event.input));
  const matched = evaluation.matchedRule ? `\nRule: ${evaluation.matchedRule}` : "";
  return `${event.toolName}: ${details}\n${evaluation.reason}${matched}`;
}

function block(reason: string): ToolCallEventResult {
  return { block: true, reason, terminate: false };
}

async function hardPathCheck(
  event: ToolCallEvent,
  ctx: ExtensionContext,
  codex: CodexSandboxPolicy,
  additionalDirectories: readonly string[],
): Promise<{ allowed: boolean; canonicalPath?: string; reason?: string }> {
  const requestedPath = toolPath(event);
  if (!requestedPath) return { allowed: true };
  const operation = FILE_WRITE_TOOLS.has(event.toolName) ? "write" : "read";
  if (!FILE_READ_TOOLS.has(event.toolName) && !FILE_WRITE_TOOLS.has(event.toolName)) {
    return { allowed: true };
  }
  const checked = await checkCodexPathAccess(
    codex,
    requestedPath,
    ctx.cwd,
    operation,
    additionalDirectories,
  );
  return {
    allowed: checked.allowed,
    canonicalPath: checked.canonicalPath,
    reason: checked.reason,
  };
}

export default function harnessCompat(pi: ExtensionAPI): void {
  let activeContext: ExtensionContext | undefined;
  let activeProjectCwd = process.cwd();
  let activeProjectTrusted = false;
  const projectSettingsTrusted = (ctx: ExtensionContext): boolean => {
    if (typeof ctx.isProjectTrusted !== "function") return false;
    try {
      if (!ctx.isProjectTrusted()) return false;
      return new ProjectTrustStore(getAgentDir()).get(ctx.cwd) === true;
    } catch {
      return false;
    }
  };
  const loadClaude = (cwd: string, trusted = activeProjectTrusted && cwd === activeProjectCwd) =>
    loadClaudePermissionPolicy(cwd, { includeProject: trusted });
  const localBash = createLocalBashOperations();
  const sandboxedBash: BashOperations = {
    exec: async (command, cwd, options) => {
      // Reload immediately before execution. A missing/invalid config throws;
      // no unsandboxed fallback command is ever submitted to the local backend.
      const [claude, codex] = await Promise.all([loadClaude(cwd), loadCodexSandboxPolicy()]);
      const wrapped = wrapCommandWithSeatbelt(
        command,
        buildPiSeatbeltPolicy(codex, cwd, claude.trustedAdditionalDirectories, claude.deny),
      );
      return localBash.exec(wrapped, cwd, {
        ...options,
        env: applyCodexEnvironmentPolicy(codex, options.env ?? process.env),
      });
    },
  };
  const registerSandboxedBash = (cwd: string) => {
    pi.registerTool(createBashToolDefinition(cwd, { operations: sandboxedBash }));
  };
  registerSandboxedBash(process.cwd());
  pi.on("session_start", (_event, ctx) => {
    activeContext = ctx;
    activeProjectCwd = ctx.cwd;
    activeProjectTrusted = projectSettingsTrusted(ctx);
    registerSandboxedBash(ctx.cwd);
  });

  pi.events.on(MCP_APPROVAL_EVENT, (rawRequest: unknown) => {
    const request = rawRequest as McpApprovalRequest;
    if (
      !request ||
      typeof request.claim !== "function" ||
      typeof request.serverName !== "string" ||
      typeof request.originalToolName !== "string"
    ) {
      return;
    }
    // Claim synchronously, as required by pi-mcp-adapter. The decision itself
    // remains async so an interactive Claude-style ask can use Pi's dialog.
    request.claim(async () => {
      const ctx = activeContext;
      if (!ctx) return "deny";
      try {
        const [claude, codex] = await Promise.all([
          loadClaude(ctx.cwd, projectSettingsTrusted(ctx)),
          loadCodexSandboxPolicy(),
        ]);
        if (!codex.networkEnabled) return "deny";
        const toolName = `mcp__${request.serverName}__${request.originalToolName}`;
        const evaluation = evaluateClaudePermission(claude, {
          toolName,
          input: request.args,
          cwd: ctx.cwd,
        });
        if (evaluation.decision === "deny") return "deny";
        if (evaluation.decision === "allow") return "allow_once";
        if (!ctx.hasUI) return "deny";
        notifyPermissionRequest(claude.permissionRequestCommands, {
          hook_event_name: "PermissionRequest",
          cwd: ctx.cwd,
          tool_name: toolName,
          tool_input: request.args,
        });
        const approved = await ctx.ui.confirm(
          "MCP permission required",
          `${toolName}\n${evaluation.reason}${evaluation.matchedRule ? `\nRule: ${evaluation.matchedRule}` : ""}`,
        );
        return approved ? "allow_once" : "deny";
      } catch {
        return "deny";
      }
    });
  });

  pi.on("tool_call", async (event, ctx): Promise<ToolCallEventResult | void> => {
    try {
      const [claude, codex] = await Promise.all([
        loadClaude(ctx.cwd, projectSettingsTrusted(ctx)),
        loadCodexSandboxPolicy(),
      ]);
      const hardPath = await hardPathCheck(event, ctx, codex, claude.trustedAdditionalDirectories);
      if (!hardPath.allowed) {
        return block(`Blocked by Codex hard filesystem boundary: ${hardPath.reason ?? "denied"}`);
      }

      if (
        !codex.networkEnabled &&
        (event.toolName === "webfetch" ||
          event.toolName === "websearch" ||
          event.toolName === "mcp" ||
          event.toolName === "mcpScript" ||
          event.toolName.startsWith("mcp__"))
      ) {
        return block("Blocked by Codex hard network boundary.");
      }

      const request = {
        toolName: event.toolName,
        input: event.input,
        cwd: ctx.cwd,
        canonicalPath: hardPath.canonicalPath,
      };
      const evaluation: PermissionEvaluation =
        event.toolName === "mcpScript" ||
        (event.toolName === "mcp" && event.input.action === undefined)
          ? {
              decision: "allow",
              reason: "MCP orchestration wrapper allowed; every real MCP call is gated separately.",
            }
          : event.toolName === "bash"
            ? evaluateBashPermission(claude, request)
            : evaluateClaudePermission(claude, request);
      if (evaluation.decision === "deny") {
        return block(
          `Blocked by Claude permission rule${evaluation.matchedRule ? ` ${evaluation.matchedRule}` : ""}.`,
        );
      }

      if (evaluation.decision === "ask") {
        if (!ctx.hasUI) {
          return block(
            `Permission required but no interactive UI is available: ${evaluation.reason}`,
          );
        }
        notifyPermissionRequest(claude.permissionRequestCommands, {
          hook_event_name: "PermissionRequest",
          cwd: ctx.cwd,
          tool_name: event.toolName,
          tool_input: event.input,
        });
        const approved = await ctx.ui.confirm(
          "Permission required",
          formatPermissionPrompt(event, evaluation, hardPath.canonicalPath),
        );
        if (!approved) return block("User denied permission.");
      }

      if (event.toolName === "powershell") {
        return block("PowerShell execution is unsupported by the macOS sandbox policy.");
      }
    } catch (error) {
      return block(
        `Harness permission initialization failed closed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  pi.registerCommand("harness-permissions", {
    description: "Show the active Claude permission and Codex sandbox sources",
    handler: async (_args, ctx) => {
      try {
        const [claude, codex] = await Promise.all([
          loadClaude(ctx.cwd, projectSettingsTrusted(ctx)),
          loadCodexSandboxPolicy(),
        ]);
        ctx.ui.notify(
          [
            "harness permissions: active",
            `Claude sources: ${claude.sources.join(", ") || "none"}`,
            `Claude rules: allow=${claude.allow.length} ask=${claude.ask.length} deny=${claude.deny.length}`,
            `Claude defaultMode: ${claude.defaultMode ?? "unset"} (${claude.defaultMode === "auto" ? "unmatched allows; deny and explicit ask still apply" : "unmatched always asks"})`,
            `Codex profile: ${codex.profile} (${codex.source})`,
            `Codex network: ${codex.networkEnabled ? "enabled" : "denied"}`,
          ].join("\n"),
          "info",
        );
      } catch (error) {
        ctx.ui.notify(
          `harness permissions: FAILED CLOSED (${error instanceof Error ? error.message : String(error)})`,
          "error",
        );
      }
    },
  });
}

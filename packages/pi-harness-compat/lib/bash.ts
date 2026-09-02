import type {
  ClaudePermissionPolicy,
  PermissionEvaluation,
  PermissionRequest,
} from "./claude-permissions.ts";
import { evaluateClaudePermission } from "./claude-permissions.ts";

export interface ParsedShellCommand {
  leaves: string[];
  complex: boolean;
}

/**
 * Split ordinary top-level shell lists without interpreting expansions.
 * Any construct that can hide another command is marked complex and therefore
 * cannot be silently allowed, even when its outer command matches an allow rule.
 */
export function parseShellCommand(command: string): ParsedShellCommand {
  const leaves: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let complex = false;

  const push = () => {
    const value = current.trim();
    if (value) leaves.push(value);
    current = "";
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    const next = command[index + 1];
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === "\\" && quote !== "'") {
      current += char;
      escaped = true;
      continue;
    }
    if (quote) {
      current += char;
      if (char === quote) quote = undefined;
      if (quote !== "'" && char === "`") complex = true;
      if (quote !== "'" && char === "$" && next === "(") complex = true;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }
    if (
      char === "`" ||
      (char === "$" && next === "(") ||
      ((char === "<" || char === ">") && next === "(")
    ) {
      complex = true;
      current += char;
      continue;
    }
    if (char === "\n" || char === ";" || char === "|" || char === "&") {
      push();
      if ((char === "|" || char === "&") && next === char) index += 1;
      continue;
    }
    current += char;
  }
  push();
  if (quote || escaped) complex = true;
  if (/[{}]/.test(command) || /<<<?/.test(command)) complex = true;
  return { leaves, complex };
}

const INDIRECT_EXECUTORS = new Set([
  "bash",
  "sh",
  "zsh",
  "eval",
  "exec",
  "xargs",
  "env",
  "command",
  "doas",
  "nice",
  "nohup",
  "osascript",
  "parallel",
  "flock",
  "ionice",
  "setsid",
  "stdbuf",
  "sudo",
  "time",
  "timeout",
  "watch",
]);

function shellCommand(leaf: string): { word?: string; basename?: string; normalized: string } {
  const normalized = leaf.trim().replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=[^\s]+\s+)*/, "");
  const word = normalized.match(/^([^\s]+)/)?.[1]?.replace(/^['"]|['"]$/g, "");
  const basename = word?.split("/").at(-1);
  return { word, basename, normalized };
}

function leafNeedsManualReview(leaf: string): boolean {
  const { word, basename, normalized } = shellCommand(leaf);
  if (!word || !basename || word.startsWith("$") || INDIRECT_EXECUTORS.has(basename)) return true;
  if (
    basename === "find" &&
    (/\s-exec(?:dir)?(?:\s|$)/.test(normalized) || /(?:^|\s)-delete(?:\s|$)/.test(normalized))
  ) {
    return true;
  }
  if (
    /^(?:python(?:\d+(?:\.\d+)*)?|node|php|ruby|perl)$/.test(basename) &&
    /\s+-(?:c|e|r)(?:\s|$)/.test(normalized)
  ) {
    return true;
  }
  return false;
}

export function evaluateBashPermission(
  policy: ClaudePermissionPolicy,
  request: PermissionRequest,
): PermissionEvaluation {
  const command = typeof request.input.command === "string" ? request.input.command : "";
  const parsed = parseShellCommand(command);
  if (!command.trim() || parsed.leaves.length === 0) {
    return { decision: "deny", reason: "Empty or unparsable shell command." };
  }
  const evaluations = parsed.leaves.map((leaf) =>
    evaluateClaudePermission(policy, {
      ...request,
      toolName: "bash",
      input: { ...request.input, command: leaf },
    }),
  );
  const denied = evaluations.find((result) => result.decision === "deny");
  if (denied) return denied;
  if (
    policy.defaultMode !== "auto" &&
    (parsed.complex || parsed.leaves.some(leafNeedsManualReview))
  ) {
    return {
      decision: "ask",
      reason: "Shell command contains indirection or complex syntax and cannot be auto-approved.",
    };
  }
  const asked = evaluations.find((result) => result.decision === "ask");
  return asked ?? { decision: "allow", reason: "Every shell leaf matched a Claude allow rule." };
}

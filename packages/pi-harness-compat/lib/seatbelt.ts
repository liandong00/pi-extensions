import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ClaudePermissionRule } from "./claude-permissions.ts";
import type { CodexSandboxPolicy } from "./codex-policy.ts";

function seatbeltString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function regexEscape(value: string): string {
  return value.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function globRegex(pattern: string): string {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char !== "*") {
      source += regexEscape(char);
      continue;
    }
    if (pattern[index + 1] === "*") {
      index += 1;
      if (pattern[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
        continue;
      }
    }
    source += ".*";
  }
  return source;
}

function seatbeltRegex(value: string): string {
  // `#"..."` is Seatbelt's regex literal: regex backslashes must remain
  // single. Only escape the delimiter so a settings pattern cannot inject a
  // new policy form.
  return value.replace(/"/g, '\\"');
}

function claudePathExpressions(rule: ClaudePermissionRule, workspace: string): string[] {
  const { pattern } = rule;
  if (pattern === "*") return [".*"];
  if (pattern.startsWith("//")) return [globRegex(path.resolve("/", pattern.slice(2)))];
  const expanded =
    pattern === "~"
      ? os.homedir()
      : pattern.startsWith("~/")
        ? path.join(os.homedir(), pattern.slice(2))
        : pattern;
  if (pattern === "~" || pattern.startsWith("~/")) return [globRegex(expanded)];
  if (pattern.startsWith("/")) {
    return [`${regexEscape(workspace)}${globRegex(pattern)}`, globRegex(pattern)];
  }
  if (expanded.startsWith("**/")) return [globRegex(expanded)];
  return [`${regexEscape(`${workspace}${path.sep}`)}${globRegex(expanded)}`];
}

function uniqueAbsolute(values: readonly string[]): string[] {
  return [
    ...new Set(
      values
        .filter(path.isAbsolute)
        .map((value) => path.resolve(value))
        .map((value) => {
          try {
            return realpathSync.native(value);
          } catch {
            return value;
          }
        }),
    ),
  ];
}

/** Build a deny-by-default Seatbelt policy for Pi shell commands. */
export function buildPiSeatbeltPolicy(
  policy: CodexSandboxPolicy,
  cwd: string,
  additionalWriteDirectories: readonly string[] = [],
  claudeDenyRules: readonly ClaudePermissionRule[] = [],
): string {
  const workspace = uniqueAbsolute([cwd])[0] ?? path.resolve(cwd);
  const explicitWrites = policy.filesystem
    .filter(
      (rule) => rule.base === "absolute" && rule.access === "write" && !rule.path.includes("*"),
    )
    .map((rule) => rule.path);
  const writeRoots = uniqueAbsolute([
    ...(policy.extendsWorkspace ? [workspace] : []),
    ...explicitWrites,
    ...additionalWriteDirectories.map((directory) => path.resolve(cwd, directory)),
  ]);
  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow ipc-posix*)",
    "(allow file-read*)",
    '(allow file-write* (literal "/dev/null"))',
  ];
  if (writeRoots.length > 0) {
    lines.push(
      `(allow file-write* ${writeRoots.map((root) => `(subpath ${seatbeltString(root)})`).join(" ")})`,
    );
  }
  if (policy.networkEnabled) lines.push("(allow network*)");

  for (const rule of policy.filesystem.filter((candidate) => candidate.access === "deny")) {
    const expression =
      rule.base === "workspace"
        ? `${regexEscape(`${workspace}${path.sep}`)}${globRegex(rule.path)}`
        : globRegex(rule.path);
    const escaped = seatbeltRegex(expression);
    lines.push(`(deny file-read* (regex #"^${escaped}$"))`);
    lines.push(`(deny file-write* (regex #"^${escaped}$"))`);
  }
  for (const rule of claudeDenyRules) {
    if (rule.tool !== "read" && rule.tool !== "write" && rule.tool !== "edit") continue;
    for (const rawExpression of claudePathExpressions(rule, workspace)) {
      const expression = seatbeltRegex(rawExpression);
      if (rule.tool === "read") lines.push(`(deny file-read* (regex #"^${expression}$"))`);
      else lines.push(`(deny file-write* (regex #"^${expression}$"))`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

export function wrapCommandWithSeatbelt(command: string, profile: string): string {
  return `/usr/bin/sandbox-exec -p ${shellQuote(profile)} /bin/bash -c ${shellQuote(command)}`;
}

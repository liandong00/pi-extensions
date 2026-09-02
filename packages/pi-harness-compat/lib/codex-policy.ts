import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "toml";
import { matchPermissionPattern } from "./glob.ts";

const MAX_CONFIG_BYTES = 4 * 1024 * 1024;

export interface CodexFilesystemRule {
  base: "workspace" | "absolute";
  path: string;
  access: "read" | "write" | "deny";
}

export interface CodexSandboxPolicy {
  profile: string;
  extendsWorkspace: boolean;
  networkEnabled: boolean;
  filesystem: CodexFilesystemRule[];
  environment: {
    inherit?: "all" | "core" | "none";
    ignoreDefaultExcludes: boolean;
    exclude: string[];
    includeOnly?: string[];
    set: Record<string, string>;
  };
  source: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function access(value: unknown): CodexFilesystemRule["access"] | undefined {
  return value === "read" || value === "write" || value === "deny" ? value : undefined;
}

export async function loadCodexSandboxPolicy(
  options: { configFile?: string; homeDirectory?: string } = {},
): Promise<CodexSandboxPolicy> {
  const source =
    options.configFile ??
    process.env.PI_HARNESS_CODEX_CONFIG ??
    path.join(options.homeDirectory ?? os.homedir(), ".codex", "config.toml");
  const stat = await fs.lstat(source);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) {
    throw new Error(`unsafe or oversized Codex config file: ${source}`);
  }
  const root = asRecord(parseToml(await fs.readFile(source, "utf8"))) ?? {};
  const profileName = root.default_permissions;
  if (typeof profileName !== "string" || !profileName) {
    throw new Error("Codex default_permissions is missing; refusing to infer a sandbox.");
  }
  const profile = asRecord(asRecord(root.permissions)?.[profileName]);
  if (!profile) throw new Error(`Codex permissions profile "${profileName}" is missing.`);
  const filesystem = asRecord(profile.filesystem) ?? {};
  const shellEnvironment = asRecord(root.shell_environment_policy) ?? {};
  const rules: CodexFilesystemRule[] = [];
  for (const [key, value] of Object.entries(filesystem)) {
    if (key === ":workspace_roots") {
      const nested = asRecord(value) ?? {};
      for (const [pattern, rawAccess] of Object.entries(nested)) {
        const parsedAccess = access(rawAccess);
        if (parsedAccess) rules.push({ base: "workspace", path: pattern, access: parsedAccess });
      }
      continue;
    }
    const parsedAccess = access(value);
    if (!parsedAccess || !path.isAbsolute(key)) continue;
    const resolved = path.resolve(key);
    const canonical = key.includes("*")
      ? resolved
      : await fs.realpath(resolved).catch(() => resolved);
    rules.push({ base: "absolute", path: canonical, access: parsedAccess });
  }
  return {
    profile: profileName,
    extendsWorkspace: profile.extends === ":workspace",
    networkEnabled: asRecord(profile.network)?.enabled === true,
    filesystem: rules,
    environment: {
      inherit:
        shellEnvironment.inherit === "all" ||
        shellEnvironment.inherit === "core" ||
        shellEnvironment.inherit === "none"
          ? shellEnvironment.inherit
          : undefined,
      ignoreDefaultExcludes: shellEnvironment.ignore_default_excludes === true,
      exclude: Array.isArray(shellEnvironment.exclude)
        ? shellEnvironment.exclude.filter((entry): entry is string => typeof entry === "string")
        : [],
      includeOnly: Array.isArray(shellEnvironment.include_only)
        ? shellEnvironment.include_only.filter(
            (entry): entry is string => typeof entry === "string",
          )
        : undefined,
      set: Object.fromEntries(
        Object.entries(asRecord(shellEnvironment.set) ?? {}).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      ),
    },
    source,
  };
}

const DEFAULT_SENSITIVE_ENV =
  /(?:^|_)(?:API_?KEY|AUTH|BEARER|COOKIE|CREDENTIALS?|PASS(?:WORD|WD)?|PRIVATE_?KEY|SECRET|SESSION|TOKEN)(?:_|$)/i;
const HARD_UNSAFE_ENV =
  /^(?:BASH_ENV|ENV|ZDOTDIR|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|PROMPT_COMMAND|PS4|BASH_FUNC_.*|DYLD_.*|LD_.*|NODE_OPTIONS|PYTHONSTARTUP|PYTHONPATH|PERL5OPT|RUBYOPT|PHP_INI_SCAN_DIR|GIT_CONFIG.*|GIT_SSH.*|GIT_EXTERNAL_DIFF)$/;
const CORE_ENV = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER",
  "__CF_USER_TEXT_ENCODING",
]);

function envNameMatches(pattern: string, name: string): boolean {
  return matchPermissionPattern(pattern, name);
}

/** Apply the selected Codex shell-environment policy without exposing secret-like defaults. */
export function applyCodexEnvironmentPolicy(
  policy: CodexSandboxPolicy,
  source: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  const includeOnly = policy.environment.includeOnly;
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    // These variables can execute code before or around the visible command.
    // They are never inherited, even when Codex explicitly disables its
    // ordinary secret-name exclusions.
    if (HARD_UNSAFE_ENV.test(name)) continue;
    if (policy.environment.inherit === "none") continue;
    if (policy.environment.inherit === "core" && !CORE_ENV.has(name)) continue;
    if (includeOnly && !includeOnly.some((pattern) => envNameMatches(pattern, name))) continue;
    if (!policy.environment.ignoreDefaultExcludes && DEFAULT_SENSITIVE_ENV.test(name)) {
      continue;
    }
    if (policy.environment.exclude.some((pattern) => envNameMatches(pattern, name))) continue;
    result[name] = value;
  }
  for (const [name, value] of Object.entries(policy.environment.set)) {
    if (!HARD_UNSAFE_ENV.test(name)) result[name] = value;
  }
  return result;
}

function contained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export async function canonicalAccessPath(requestedPath: string, cwd: string): Promise<string> {
  const expanded =
    requestedPath === "~"
      ? os.homedir()
      : requestedPath.startsWith("~/")
        ? path.join(os.homedir(), requestedPath.slice(2))
        : requestedPath;
  const lexical = path.resolve(cwd, expanded);
  try {
    return await fs.realpath(lexical);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const missing: string[] = [];
  let current = lexical;
  for (;;) {
    try {
      const canonical = await fs.realpath(current);
      return path.join(canonical, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

function matchesWorkspaceRule(
  rule: CodexFilesystemRule,
  candidate: string,
  workspace: string,
): boolean {
  if (rule.base !== "workspace" || !contained(workspace, candidate)) return false;
  const relative = path.relative(workspace, candidate).split(path.sep).join("/");
  return matchPermissionPattern(rule.path, relative);
}

function matchesAbsoluteRule(rule: CodexFilesystemRule, candidate: string): boolean {
  if (rule.base !== "absolute") return false;
  if (rule.path.includes("*")) return matchPermissionPattern(rule.path, candidate);
  return contained(rule.path, candidate);
}

export async function checkCodexPathAccess(
  policy: CodexSandboxPolicy,
  requestedPath: string,
  cwd: string,
  operation: "read" | "write",
  additionalWriteDirectories: readonly string[] = [],
): Promise<{ allowed: boolean; canonicalPath: string; reason?: string }> {
  const workspace = await canonicalAccessPath(cwd, cwd);
  const candidate = await canonicalAccessPath(requestedPath, cwd);
  const matching = policy.filesystem.filter(
    (rule) =>
      matchesWorkspaceRule(rule, candidate, workspace) || matchesAbsoluteRule(rule, candidate),
  );
  if (matching.some((rule) => rule.access === "deny")) {
    return { allowed: false, canonicalPath: candidate, reason: "Denied by Codex filesystem rule." };
  }
  if (operation === "read") {
    const allowed =
      policy.extendsWorkspace ||
      matching.some((rule) => rule.access === "read" || rule.access === "write");
    return {
      allowed,
      canonicalPath: candidate,
      reason: allowed ? undefined : "Codex profile does not grant read access.",
    };
  }
  const additional = await Promise.all(
    additionalWriteDirectories.map((directory) => canonicalAccessPath(directory, cwd)),
  );
  const allowed =
    (policy.extendsWorkspace && contained(workspace, candidate)) ||
    matching.some((rule) => rule.access === "write") ||
    additional.some((directory) => contained(directory, candidate));
  return {
    allowed,
    canonicalPath: candidate,
    reason: allowed ? undefined : "Outside Codex/Claude writable roots.",
  };
}

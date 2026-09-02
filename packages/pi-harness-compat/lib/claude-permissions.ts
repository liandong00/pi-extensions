import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { matchFilePermissionPattern, matchPermissionPattern } from "./glob.ts";

const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;
const MAX_RULES = 10_000;
const MAX_RULE_LENGTH = 16_384;

export type PermissionDecision = "allow" | "ask" | "deny";

export interface ClaudePermissionRule {
  tool: string;
  pattern: string;
  raw: string;
}

export interface ClaudePermissionPolicy {
  allow: ClaudePermissionRule[];
  ask: ClaudePermissionRule[];
  deny: ClaudePermissionRule[];
  additionalDirectories: string[];
  /** Only user-owned settings may expand the Codex-derived hard boundary. */
  trustedAdditionalDirectories: string[];
  defaultMode?: string;
  sources: string[];
  permissionRequestCommands: string[];
  projectRoot?: string;
}

export interface PermissionRequest {
  toolName: string;
  input: Record<string, unknown>;
  cwd: string;
  canonicalPath?: string;
}

export interface PermissionEvaluation {
  decision: PermissionDecision;
  reason: string;
  matchedRule?: string;
}

interface ParsedSettings {
  allow: ClaudePermissionRule[];
  ask: ClaudePermissionRule[];
  deny: ClaudePermissionRule[];
  additionalDirectories: string[];
  trustedAdditionalDirectories: string[];
  defaultMode?: string;
  permissionRequestCommands: string[];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function mapClaudeTool(tool: string): string {
  const mappings: Record<string, string> = {
    Bash: "bash",
    Read: "read",
    Edit: "edit",
    Write: "write",
    Glob: "find",
    Grep: "grep",
    WebFetch: "webfetch",
    WebSearch: "websearch",
    Agent: "subagent",
  };
  return mappings[tool] ?? tool;
}

export function parseClaudeRule(raw: string): ClaudePermissionRule | undefined {
  if (!raw || raw.length > MAX_RULE_LENGTH || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(raw)) {
    return undefined;
  }
  const open = raw.indexOf("(");
  if (open === -1) return { tool: mapClaudeTool(raw), pattern: "*", raw };
  if (!raw.endsWith(")") || open === 0) return undefined;
  return {
    tool: mapClaudeTool(raw.slice(0, open)),
    pattern: raw.slice(open + 1, -1),
    raw,
  };
}

function parseRuleArray(value: unknown): ClaudePermissionRule[] {
  if (!Array.isArray(value) || value.length > MAX_RULES) return [];
  return value
    .filter((entry): entry is string => typeof entry === "string")
    .map(parseClaudeRule)
    .filter((rule): rule is ClaudePermissionRule => rule !== undefined);
}

function parsePermissionHookCommands(root: Record<string, unknown>): string[] {
  const hooks = asRecord(root.hooks);
  const permissionHooks = hooks?.PermissionRequest;
  if (!Array.isArray(permissionHooks)) return [];
  const commands: string[] = [];
  for (const group of permissionHooks.slice(0, 100)) {
    const entries = asRecord(group)?.hooks;
    if (!Array.isArray(entries)) continue;
    for (const entry of entries.slice(0, 100)) {
      const record = asRecord(entry);
      if (
        record?.type === "command" &&
        typeof record.command === "string" &&
        record.command.length > 0 &&
        record.command.length <= MAX_RULE_LENGTH &&
        !record.command.includes("\0")
      ) {
        commands.push(record.command);
      }
    }
  }
  return commands;
}

export function parseClaudeSettings(value: unknown, includeHooks = false): ParsedSettings {
  const root = asRecord(value) ?? {};
  const permissions = asRecord(root.permissions) ?? {};
  const directories = Array.isArray(permissions.additionalDirectories)
    ? permissions.additionalDirectories.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.length > 0 && entry.length <= MAX_RULE_LENGTH,
      )
    : [];
  return {
    allow: parseRuleArray(permissions.allow),
    ask: parseRuleArray(permissions.ask),
    deny: parseRuleArray(permissions.deny),
    additionalDirectories: directories,
    trustedAdditionalDirectories: directories,
    defaultMode: typeof permissions.defaultMode === "string" ? permissions.defaultMode : undefined,
    permissionRequestCommands: includeHooks ? parsePermissionHookCommands(root) : [],
  };
}

async function readSettings(
  file: string,
  includeHooks = false,
): Promise<ParsedSettings | undefined> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_SETTINGS_BYTES) {
    throw new Error(`unsafe or oversized Claude settings file: ${file}`);
  }
  return parseClaudeSettings(JSON.parse(await fs.readFile(file, "utf8")) as unknown, includeHooks);
}

async function nearestClaudeProjectRoot(cwd: string): Promise<string> {
  let current = path.resolve(cwd);
  for (;;) {
    const claude = path.join(current, ".claude");
    const found = await Promise.all(
      ["settings.json", "settings.local.json"].map((name) =>
        fs.access(path.join(claude, name)).then(
          () => true,
          () => false,
        ),
      ),
    );
    if (found.some(Boolean)) return current;
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(cwd);
    current = parent;
  }
}

export async function loadClaudePermissionPolicy(
  cwd: string,
  options: {
    homeDirectory?: string;
    globalSettingsFile?: string;
    includeProject?: boolean;
  } = {},
): Promise<ClaudePermissionPolicy> {
  const homeDirectory = options.homeDirectory ?? os.homedir();
  const globalFile =
    options.globalSettingsFile ??
    process.env.PI_HARNESS_CLAUDE_SETTINGS ??
    path.join(homeDirectory, ".claude", "settings.json");
  const projectRoot = await nearestClaudeProjectRoot(cwd);
  const files = [
    { file: globalFile, hooks: true, trustedDirectories: true },
    ...(options.includeProject === false
      ? []
      : [
          {
            file: path.join(projectRoot, ".claude", "settings.json"),
            hooks: false,
            trustedDirectories: false,
          },
          {
            file: path.join(projectRoot, ".claude", "settings.local.json"),
            hooks: false,
            trustedDirectories: true,
          },
        ]),
  ];
  const merged: ClaudePermissionPolicy = {
    allow: [],
    ask: [],
    deny: [],
    additionalDirectories: [],
    trustedAdditionalDirectories: [],
    sources: [],
    permissionRequestCommands: [],
  };
  for (const candidate of files) {
    const parsed = await readSettings(candidate.file, candidate.hooks);
    if (!parsed) continue;
    merged.sources.push(candidate.file);
    merged.allow.push(...parsed.allow);
    merged.ask.push(...parsed.ask);
    merged.deny.push(...parsed.deny);
    merged.additionalDirectories.push(...parsed.additionalDirectories);
    if (candidate.trustedDirectories) {
      merged.trustedAdditionalDirectories.push(...parsed.additionalDirectories);
    }
    merged.permissionRequestCommands.push(...parsed.permissionRequestCommands);
    if (parsed.defaultMode !== undefined) merged.defaultMode = parsed.defaultMode;
  }
  merged.additionalDirectories = [...new Set(merged.additionalDirectories)];
  merged.trustedAdditionalDirectories = [...new Set(merged.trustedAdditionalDirectories)];
  merged.permissionRequestCommands = [...new Set(merged.permissionRequestCommands)];
  merged.projectRoot = projectRoot;
  return merged;
}

const FILE_READERS = new Set(["read", "grep", "find", "ls"]);
const FILE_WRITERS = new Set(["edit", "write"]);

function mcpRuleMatches(rule: ClaudePermissionRule, toolName: string): boolean {
  if (!rule.tool.startsWith("mcp__") || !toolName.startsWith("mcp__")) return false;
  return matchPermissionPattern(rule.tool, toolName);
}

function absoluteRequestedPath(file: string, cwd: string): string {
  const expanded =
    file === "~"
      ? os.homedir()
      : file.startsWith("~/")
        ? path.join(os.homedir(), file.slice(2))
        : file;
  return path.resolve(cwd, expanded);
}

function fileRulePatterns(
  pattern: string,
  request: PermissionRequest,
  projectRoot: string,
): string[] {
  if (pattern.startsWith("//")) return [path.resolve("/", pattern.slice(2))];
  if (pattern === "~") return [os.homedir()];
  if (pattern.startsWith("~/")) return [path.join(os.homedir(), pattern.slice(2))];
  if (pattern.startsWith("/")) {
    // Current Claude semantics: project-root relative. Also retain the user's
    // legacy single-slash absolute rules as a stricter compatibility match.
    return [path.join(projectRoot, pattern.slice(1)), path.resolve(pattern)];
  }
  return [path.resolve(request.cwd, pattern)];
}

function fileRuleMatches(
  rule: ClaudePermissionRule,
  request: PermissionRequest,
  decision: PermissionDecision,
  projectRoot: string,
): boolean {
  if (rule.pattern === "*") return true;
  const file = typeof request.input.path === "string" ? request.input.path : ".";
  const lexical = absoluteRequestedPath(file, request.cwd).split(path.sep).join("/");
  const canonical = request.canonicalPath?.split(path.sep).join("/");
  const rawPatterns = fileRulePatterns(rule.pattern, request, projectRoot);
  if (decision !== "allow" && rule.pattern.startsWith("**/")) {
    rawPatterns.push(path.resolve("/", rule.pattern));
  }
  const patterns = rawPatterns.map((pattern) => pattern.split(path.sep).join("/"));
  const matches = (candidate: string) =>
    patterns.some((pattern) => matchFilePermissionPattern(pattern, candidate));
  if (!matches(lexical) && !(canonical && matches(canonical))) return false;
  return decision !== "allow" || !canonical || canonical === lexical || matches(canonical);
}

function argumentCandidates(request: PermissionRequest, rule: ClaudePermissionRule): string[] {
  const { toolName, input } = request;
  if (toolName === "bash" || toolName === "powershell") {
    return typeof input.command === "string" ? [input.command.trim()] : [""];
  }
  if (toolName === "ls") {
    const target = typeof input.path === "string" ? input.path : ".";
    return rule.tool === "bash" ? [`ls${target === "." ? "" : ` ${target}`}`] : [target];
  }
  if (toolName === "find") {
    const target = typeof input.path === "string" ? input.path : ".";
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    return rule.tool === "bash" ? [`find ${target}${pattern ? ` ${pattern}` : ""}`] : [target];
  }
  if (toolName === "grep") {
    const pattern = typeof input.pattern === "string" ? input.pattern : "";
    const target = typeof input.path === "string" ? input.path : "";
    return rule.tool === "bash"
      ? [`grep${pattern ? ` ${pattern}` : ""}${target ? ` ${target}` : ""}`]
      : [target || "."];
  }
  if (toolName === "webfetch") return typeof input.url === "string" ? [input.url] : [""];
  return [""];
}

function ruleMatches(
  rule: ClaudePermissionRule,
  request: PermissionRequest,
  decision: PermissionDecision,
  projectRoot: string,
): boolean {
  if (mcpRuleMatches(rule, request.toolName)) return true;
  const fileTool = FILE_READERS.has(request.toolName) || FILE_WRITERS.has(request.toolName);
  const fileCategoryMatch =
    (rule.tool === "read" && FILE_READERS.has(request.toolName)) ||
    (rule.tool === "edit" && FILE_WRITERS.has(request.toolName));
  const exactToolMatch =
    rule.tool === request.toolName || (rule.tool === "bash" && request.toolName === "powershell");
  if (!exactToolMatch && !fileCategoryMatch) {
    // Claude Bash rules also govern Pi's ls/find equivalents.
    if (!(rule.tool === "bash" && (request.toolName === "ls" || request.toolName === "find"))) {
      return false;
    }
  }
  if (fileTool && rule.tool !== "bash") {
    return fileRuleMatches(rule, request, decision, projectRoot);
  }
  return argumentCandidates(request, rule).some((candidate) =>
    matchPermissionPattern(rule.pattern, candidate),
  );
}

function firstMatch(
  rules: ClaudePermissionRule[],
  request: PermissionRequest,
  decision: PermissionDecision,
  projectRoot: string,
): ClaudePermissionRule | undefined {
  return rules.find((rule) => ruleMatches(rule, request, decision, projectRoot));
}

export function evaluateClaudePermission(
  policy: ClaudePermissionPolicy,
  request: PermissionRequest,
): PermissionEvaluation {
  const projectRoot = policy.projectRoot ?? request.cwd;
  const deny = firstMatch(policy.deny, request, "deny", projectRoot);
  if (deny) return { decision: "deny", reason: "Matched Claude deny rule.", matchedRule: deny.raw };
  const ask = firstMatch(policy.ask, request, "ask", projectRoot);
  if (ask) return { decision: "ask", reason: "Matched Claude ask rule.", matchedRule: ask.raw };
  const allow = firstMatch(policy.allow, request, "allow", projectRoot);
  if (allow)
    return { decision: "allow", reason: "Matched Claude allow rule.", matchedRule: allow.raw };
  return {
    decision: "ask",
    reason:
      policy.defaultMode === "auto"
        ? "Claude auto-mode classification is intentionally not replicated."
        : "No Claude permission rule matched.",
  };
}

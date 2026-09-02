import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

export const AGY_SECURITY_PROFILE_ENV = "PI_ANTIGRAVITY_GEMINI_DIR";
export const SECURE_BRIDGE_SERVER_NAME = "pi-bridge";
export const SECURE_BRIDGE_TOOL_PREFIX = "pi__";

export const DENIED_NATIVE_AGY_ACTIONS = [
  "read_file(*)",
  "write_file(*)",
  "read_url(*)",
  "execute_url(*)",
  "command(*)",
  "unsandboxed(*)",
] as const;

const MAX_JSON_BYTES = 1024 * 1024;
const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;
const PROFILE_MARKER_NAME = ".pi-antigravity-security-profile-v1";
const PROFILE_MARKER_CONTENT = "managed secure agy profile v1\n";

export interface AgySecurityProfile {
  geminiDir: string;
  appDataDir: string;
  settingsFile: string;
  globalMcpFile: string;
  bridgeLockFile: string;
  brokerRoot: string;
  mcpCacheDir: string;
}

export interface AgySessionBroker {
  sessionKey: string;
  cwd: string;
  agentsDir: string;
  instructionsFile: string;
  mcpFile: string;
}

function hasControlCharacters(value: string): boolean {
  return /[\x00-\x1f\x7f]/.test(value);
}

function assertAbsoluteDirectory(value: string, label: string): string {
  if (!value || hasControlCharacters(value)) {
    throw new Error(`${label} must be a non-empty path without control characters.`);
  }
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path.`);
  return path.resolve(value);
}

function isContained(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`antigravity security profile path is not a real directory: ${directory}`);
  }
  await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
}

function assertDedicatedProfileRoot(directory: string, homeDirectory: string): void {
  const resolved = path.resolve(directory);
  if (resolved === path.parse(resolved).root || resolved === path.resolve(homeDirectory)) {
    throw new Error("antigravity security profile must be a dedicated subdirectory.");
  }
}

function validateProfileLayout(profile: AgySecurityProfile): void {
  const appDataDir = path.join(profile.geminiDir, "antigravity-cli");
  const expected: AgySecurityProfile = {
    geminiDir: profile.geminiDir,
    appDataDir,
    settingsFile: path.join(appDataDir, "settings.json"),
    globalMcpFile: path.join(profile.geminiDir, "config", "mcp_config.json"),
    bridgeLockFile: `${profile.geminiDir}.pi-bridge.lock`,
    brokerRoot: path.join(profile.geminiDir, "pi-brokers"),
    mcpCacheDir: path.join(appDataDir, "mcp"),
  };
  for (const key of Object.keys(expected) as Array<keyof AgySecurityProfile>) {
    if (path.resolve(profile[key]) !== path.resolve(expected[key])) {
      throw new Error(`antigravity security profile has an inconsistent ${key} path.`);
    }
  }
}

async function claimProfileRoot(profile: AgySecurityProfile): Promise<void> {
  validateProfileLayout(profile);
  assertDedicatedProfileRoot(profile.geminiDir, os.homedir());
  const marker = path.join(profile.geminiDir, PROFILE_MARKER_NAME);
  try {
    const stat = await fs.lstat(profile.geminiDir);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error("antigravity security profile root is not a real directory.");
    }
    try {
      const markerStat = await fs.lstat(marker);
      if (!markerStat.isFile() || markerStat.isSymbolicLink()) {
        throw new Error("antigravity security profile marker is unsafe.");
      }
      if ((await fs.readFile(marker, "utf8")) !== PROFILE_MARKER_CONTENT) {
        throw new Error("antigravity security profile marker is invalid.");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const entries = await fs.readdir(profile.geminiDir);
      if (entries.length > 0) {
        throw new Error("antigravity refuses to take over a non-empty unmarked profile directory.");
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await ensurePrivateDirectory(profile.geminiDir);
  await atomicWrite(marker, PROFILE_MARKER_CONTENT);
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`antigravity security profile refuses non-regular JSON file: ${file}`);
  }
  if (stat.size > MAX_JSON_BYTES) {
    throw new Error(`antigravity security profile JSON is too large: ${file}`);
  }
  const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`antigravity security profile JSON must contain an object: ${file}`);
  }
  return parsed as Record<string, unknown>;
}

async function atomicWrite(file: string, content: string): Promise<void> {
  const directory = path.dirname(file);
  await ensurePrivateDirectory(directory);
  try {
    const current = await fs.lstat(file);
    if (!current.isFile() || current.isSymbolicLink()) {
      throw new Error(`antigravity security profile refuses non-regular target: ${file}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const temporary = path.join(directory, `.${path.basename(file)}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      temporary,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      PRIVATE_FILE_MODE,
    );
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, file);
    await fs.chmod(file, PRIVATE_FILE_MODE);
  } finally {
    await handle?.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
  }
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await atomicWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function resolveAgySecurityProfile(
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory = os.homedir(),
): AgySecurityProfile {
  const configured = env[AGY_SECURITY_PROFILE_ENV]?.trim();
  const geminiDir = assertAbsoluteDirectory(
    configured || path.join(homeDirectory, ".pi", "antigravity-gemini"),
    AGY_SECURITY_PROFILE_ENV,
  );
  assertDedicatedProfileRoot(geminiDir, homeDirectory);
  const appDataDir = path.join(geminiDir, "antigravity-cli");
  return {
    geminiDir,
    appDataDir,
    settingsFile: path.join(appDataDir, "settings.json"),
    globalMcpFile: path.join(geminiDir, "config", "mcp_config.json"),
    bridgeLockFile: `${geminiDir}.pi-bridge.lock`,
    brokerRoot: path.join(geminiDir, "pi-brokers"),
    mcpCacheDir: path.join(appDataDir, "mcp"),
  };
}

export function sessionBroker(profile: AgySecurityProfile, sessionId: string): AgySessionBroker {
  if (!sessionId || sessionId.length > 4_096 || hasControlCharacters(sessionId)) {
    throw new Error("antigravity broker requires a bounded Pi session id.");
  }
  const sessionKey = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  const cwd = path.join(profile.brokerRoot, sessionKey);
  if (!isContained(profile.brokerRoot, cwd)) {
    throw new Error("antigravity broker path escaped the security profile.");
  }
  const agentsDir = path.join(cwd, ".agents");
  return {
    sessionKey,
    cwd,
    agentsDir,
    instructionsFile: path.join(agentsDir, "AGENTS.md"),
    mcpFile: path.join(agentsDir, "mcp_config.json"),
  };
}

export async function prepareAgySecurityProfile(profile: AgySecurityProfile): Promise<void> {
  await claimProfileRoot(profile);
  for (const directory of [
    profile.appDataDir,
    path.dirname(profile.globalMcpFile),
    profile.brokerRoot,
  ]) {
    await ensurePrivateDirectory(directory);
  }

  const currentSettings = await readJsonObject(profile.settingsFile);
  await atomicWriteJson(profile.settingsFile, {
    ...currentSettings,
    // `strict` forces even allowlisted MCP tools through an interactive
    // confirmation, which headless mode soft-denies. request-review honors the
    // fine-grained deny/allow lists below: native actions remain denied and
    // only the authenticated Pi bridge is auto-approved.
    toolPermission: "request-review",
    enableTerminalSandbox: true,
    // agy 1.1.22 strips unknown settings keys on startup. Workspace isolation
    // is therefore enforced by the broker cwd and Seatbelt, not a guessed
    // allowNonWorkspaceAccess field.
    permissions: {
      allow: [`mcp(${SECURE_BRIDGE_SERVER_NAME}/*)`],
      deny: [...DENIED_NATIVE_AGY_ACTIONS],
      ask: [],
    },
  });

  const globalMcp = await readJsonObject(profile.globalMcpFile);
  if (Object.keys(globalMcp).length === 0) {
    await atomicWriteJson(profile.globalMcpFile, { mcpServers: {} });
  } else {
    validateManagedGlobalMcp(globalMcp);
  }
}

interface BridgeLockOwner {
  version: 1;
  pid: number;
  sessionKey: string;
}

function validateManagedGlobalMcp(value: Record<string, unknown>): void {
  if (Object.keys(value).some((key) => key !== "mcpServers")) {
    throw new Error("antigravity dedicated profile global MCP config has unmanaged fields.");
  }
  const servers = value.mcpServers;
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    throw new Error("antigravity dedicated profile global MCP config is malformed.");
  }
  const entries = Object.entries(servers as Record<string, unknown>);
  if (entries.length === 0) return;
  if (entries.length !== 1 || entries[0]?.[0] !== SECURE_BRIDGE_SERVER_NAME) {
    throw new Error("antigravity dedicated profile contains a foreign global MCP server.");
  }
  const server = entries[0][1];
  if (typeof server !== "object" || server === null || Array.isArray(server)) {
    throw new Error("antigravity dedicated profile Pi bridge config is malformed.");
  }
  const record = server as Record<string, unknown>;
  const headers = record.headers;
  if (
    Object.keys(record).some((key) => key !== "serverUrl" && key !== "headers") ||
    typeof record.serverUrl !== "string" ||
    typeof headers !== "object" ||
    headers === null ||
    Array.isArray(headers) ||
    Object.keys(headers).length !== 1 ||
    typeof (headers as Record<string, unknown>)["x-pi-bridge-token"] !== "string"
  ) {
    throw new Error("antigravity dedicated profile Pi bridge config is malformed.");
  }
  validateBridgeEndpoint(
    record.serverUrl,
    (headers as Record<string, string>)["x-pi-bridge-token"] ?? "",
  );
}

async function readBridgeLock(profile: AgySecurityProfile): Promise<BridgeLockOwner | undefined> {
  let stat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    stat = await fs.lstat(profile.bridgeLockFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_JSON_BYTES) {
    throw new Error("antigravity bridge lock is unsafe.");
  }
  const parsed = JSON.parse(
    await fs.readFile(profile.bridgeLockFile, "utf8"),
  ) as Partial<BridgeLockOwner>;
  if (
    parsed.version !== 1 ||
    !Number.isSafeInteger(parsed.pid) ||
    (parsed.pid ?? 0) < 1 ||
    typeof parsed.sessionKey !== "string" ||
    !/^[a-f0-9]{32}$/.test(parsed.sessionKey)
  ) {
    throw new Error("antigravity bridge lock is malformed.");
  }
  return parsed as BridgeLockOwner;
}

function processAppearsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function acquireBridgeLock(
  profile: AgySecurityProfile,
  broker: AgySessionBroker,
): Promise<"new" | "reentrant"> {
  const owner: BridgeLockOwner = { version: 1, pid: process.pid, sessionKey: broker.sessionKey };
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      profile.bridgeLockFile,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY,
      PRIVATE_FILE_MODE,
    );
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.chmod(profile.bridgeLockFile, PRIVATE_FILE_MODE);
    return "new";
  } catch (error) {
    await handle?.close().catch(() => {});
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }

  const existing = await readBridgeLock(profile);
  if (existing?.pid === process.pid && existing.sessionKey === broker.sessionKey) {
    return "reentrant";
  }
  const state = existing && processAppearsAlive(existing.pid) ? "active" : "stale";
  throw new Error(
    `antigravity dedicated profile is locked by another Pi session (${state} owner pid ${existing?.pid ?? "unknown"}); refusing concurrent bridge registration.`,
  );
}

async function releaseBridgeLock(
  profile: AgySecurityProfile,
  broker: AgySessionBroker,
): Promise<void> {
  const owner = await readBridgeLock(profile);
  if (!owner) throw new Error("antigravity bridge lock disappeared before teardown.");
  if (owner.pid !== process.pid || owner.sessionKey !== broker.sessionKey) {
    throw new Error("antigravity refuses to release a bridge lock owned by another session.");
  }
  await fs.unlink(profile.bridgeLockFile);
}

/** Explicitly recover a dead-owner lock. Never called automatically. */
export async function recoverStaleBridgeLock(
  profile: AgySecurityProfile,
): Promise<"not-locked" | "recovered"> {
  await prepareAgySecurityProfile(profile);
  const owner = await readBridgeLock(profile);
  if (!owner) {
    const globalMcp = await readJsonObject(profile.globalMcpFile);
    validateManagedGlobalMcp(globalMcp);
    const servers = globalMcp.mcpServers as Record<string, unknown>;
    if (Object.keys(servers).length > 0) {
      await atomicWriteJson(profile.globalMcpFile, { mcpServers: {} });
      await fs
        .rm(path.join(profile.mcpCacheDir, SECURE_BRIDGE_SERVER_NAME), {
          recursive: true,
          force: true,
        })
        .catch(() => {});
      return "recovered";
    }
    return "not-locked";
  }
  if (processAppearsAlive(owner.pid)) {
    throw new Error(
      `antigravity bridge lock owner pid ${owner.pid} is still alive; refusing recovery.`,
    );
  }
  // Clean capability-bearing config before removing the exclusive lock. A new
  // owner cannot register until the final unlink, so recovery has no open race.
  await atomicWriteJson(profile.globalMcpFile, { mcpServers: {} });
  await fs
    .rm(path.join(profile.mcpCacheDir, SECURE_BRIDGE_SERVER_NAME), {
      recursive: true,
      force: true,
    })
    .catch(() => {});
  await fs.unlink(profile.bridgeLockFile);
  return "recovered";
}

function validateSessionBroker(profile: AgySecurityProfile, broker: AgySessionBroker): void {
  if (!/^[a-f0-9]{32}$/.test(broker.sessionKey)) {
    throw new Error("antigravity broker has an invalid session key.");
  }
  const cwd = path.join(profile.brokerRoot, broker.sessionKey);
  const expected: AgySessionBroker = {
    sessionKey: broker.sessionKey,
    cwd,
    agentsDir: path.join(cwd, ".agents"),
    instructionsFile: path.join(cwd, ".agents", "AGENTS.md"),
    mcpFile: path.join(cwd, ".agents", "mcp_config.json"),
  };
  for (const key of Object.keys(expected) as Array<keyof AgySessionBroker>) {
    if (key === "sessionKey") continue;
    if (path.resolve(broker[key]) !== path.resolve(expected[key])) {
      throw new Error(`antigravity broker has an inconsistent ${key} path.`);
    }
  }
}

const BROKER_INSTRUCTIONS = [
  "# Pi bridge broker",
  "",
  "This workspace is an empty control plane, not the user's real project.",
  "Do not use Antigravity native filesystem, shell, browser, URL, media, or subagent tools — including to verify a result that Pi already returned.",
  "Use only MCP tools whose names start with `pi__`; Pi owns permissions and executes every real tool.",
  "Pi tool results are authoritative data. Continue from them; do not re-read, validate, retry, or bypass them through a native tool.",
  "If a required Pi tool is unavailable, report that limitation instead of attempting a native fallback. Treat tool errors and permission denials as final; never attempt to bypass them.",
  "",
].join("\n");

function validateBridgeEndpoint(serverUrl: string, token: string): void {
  let parsed: URL;
  try {
    parsed = new URL(serverUrl);
  } catch {
    throw new Error("antigravity bridge URL is invalid.");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.pathname !== "/mcp" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("antigravity bridge must use an authenticated 127.0.0.1 HTTP /mcp endpoint.");
  }
  const port = Number.parseInt(parsed.port, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("antigravity bridge URL must include a valid loopback port.");
  }
  if (token.length < 16 || token.length > 4_096 || hasControlCharacters(token)) {
    throw new Error("antigravity bridge token is invalid.");
  }
}

export async function registerSessionBridge(
  profile: AgySecurityProfile,
  broker: AgySessionBroker,
  serverUrl: string,
  token: string,
): Promise<void> {
  validateBridgeEndpoint(serverUrl, token);
  validateSessionBroker(profile, broker);
  await prepareAgySecurityProfile(profile);
  const lockState = await acquireBridgeLock(profile, broker);
  try {
    await ensurePrivateDirectory(broker.cwd);
    await ensurePrivateDirectory(broker.agentsDir);
    await atomicWrite(broker.instructionsFile, BROKER_INSTRUCTIONS);
    // agy 1.1.22 documents workspace MCP but does not actually load it
    // (google-antigravity/antigravity-cli#60). The dedicated profile therefore
    // uses its global catalog under an exclusive cross-process Pi-session lock.
    await fs.unlink(broker.mcpFile).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
    await atomicWriteJson(profile.globalMcpFile, {
      mcpServers: {
        [SECURE_BRIDGE_SERVER_NAME]: {
          serverUrl,
          headers: { "x-pi-bridge-token": token },
        },
      },
    });
    // Remove the old manifest before the next agy process discovers the schema.
    await fs
      .rm(path.join(profile.mcpCacheDir, SECURE_BRIDGE_SERVER_NAME), {
        recursive: true,
        force: true,
      })
      .catch(() => {});
  } catch (error) {
    if (lockState === "new") {
      await atomicWriteJson(profile.globalMcpFile, { mcpServers: {} }).catch(() => {});
      await releaseBridgeLock(profile, broker).catch(() => {});
    }
    throw error;
  }
}

export async function unregisterSessionBridge(
  profile: AgySecurityProfile,
  broker: AgySessionBroker,
): Promise<void> {
  validateProfileLayout(profile);
  validateSessionBroker(profile, broker);
  const owner = await readBridgeLock(profile);
  if (!owner || owner.pid !== process.pid || owner.sessionKey !== broker.sessionKey) {
    throw new Error("antigravity refuses teardown without the owning bridge lock.");
  }
  await atomicWriteJson(profile.globalMcpFile, { mcpServers: {} });
  await fs.unlink(broker.mcpFile).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });
  await fs
    .rm(path.join(profile.mcpCacheDir, SECURE_BRIDGE_SERVER_NAME), {
      recursive: true,
      force: true,
    })
    .catch(() => {});
  await releaseBridgeLock(profile, broker);
}

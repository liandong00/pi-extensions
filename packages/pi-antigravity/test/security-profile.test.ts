import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  AGY_SECURITY_PROFILE_ENV,
  DENIED_NATIVE_AGY_ACTIONS,
  prepareAgySecurityProfile,
  recoverStaleBridgeLock,
  registerSessionBridge,
  resolveAgySecurityProfile,
  SECURE_BRIDGE_SERVER_NAME,
  sessionBroker,
  unregisterSessionBridge,
} from "../lib/security-profile.ts";

async function fixture(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "pi-antigravity-security-"));
}

test("resolves a dedicated absolute Gemini directory", () => {
  const profile = resolveAgySecurityProfile({}, "/home/example");
  assert.equal(profile.geminiDir, path.resolve("/home/example/.pi/antigravity-gemini"));
  assert.equal(profile.settingsFile, path.join(profile.geminiDir, "antigravity-cli/settings.json"));
  assert.throws(
    () => resolveAgySecurityProfile({ [AGY_SECURITY_PROFILE_ENV]: "relative/profile" }),
    /absolute path/,
  );
});

test("session broker paths are stable, bounded, and do not expose the session id", async () => {
  const root = await fixture();
  try {
    const profile = resolveAgySecurityProfile({ [AGY_SECURITY_PROFILE_ENV]: root });
    const first = sessionBroker(profile, "private/session/id");
    const repeated = sessionBroker(profile, "private/session/id");
    const other = sessionBroker(profile, "another-session");
    assert.equal(first.cwd, repeated.cwd);
    assert.notEqual(first.cwd, other.cwd);
    assert.ok(!first.cwd.includes("private/session/id"));
    assert.equal(path.dirname(first.cwd), profile.brokerRoot);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("prepares a fine-grained fail-closed profile while preserving unrelated settings", async () => {
  const root = await fixture();
  try {
    const profile = resolveAgySecurityProfile({ [AGY_SECURITY_PROFILE_ENV]: root });
    await prepareAgySecurityProfile(profile);
    await fs.mkdir(path.dirname(profile.settingsFile), { recursive: true });
    await fs.writeFile(
      profile.settingsFile,
      JSON.stringify({ theme: "dark", toolPermission: "always-proceed" }),
    );
    await prepareAgySecurityProfile(profile);

    const settings = JSON.parse(await fs.readFile(profile.settingsFile, "utf8"));
    assert.equal(settings.theme, "dark");
    assert.equal(settings.toolPermission, "request-review");
    assert.equal(settings.enableTerminalSandbox, true);
    assert.deepEqual(settings.permissions.allow, [`mcp(${SECURE_BRIDGE_SERVER_NAME}/*)`]);
    assert.deepEqual(settings.permissions.deny, [...DENIED_NATIVE_AGY_ACTIONS]);
    assert.deepEqual(settings.permissions.ask, []);
    assert.deepEqual(JSON.parse(await fs.readFile(profile.globalMcpFile, "utf8")), {
      mcpServers: {},
    });
    if (process.platform !== "win32") {
      assert.equal((await fs.stat(profile.settingsFile)).mode & 0o777, 0o600);
      assert.equal((await fs.stat(profile.geminiDir)).mode & 0o777, 0o700);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("registers one authenticated loopback MCP server in the exclusively locked profile", async () => {
  const root = await fixture();
  try {
    const profile = resolveAgySecurityProfile({ [AGY_SECURITY_PROFILE_ENV]: root });
    const broker = sessionBroker(profile, "session-1");
    await registerSessionBridge(
      profile,
      broker,
      "http://127.0.0.1:43210/mcp",
      "0123456789abcdef0123456789abcdef",
    );
    const mcp = JSON.parse(await fs.readFile(profile.globalMcpFile, "utf8"));
    assert.deepEqual(mcp, {
      mcpServers: {
        [SECURE_BRIDGE_SERVER_NAME]: {
          serverUrl: "http://127.0.0.1:43210/mcp",
          headers: { "x-pi-bridge-token": "0123456789abcdef0123456789abcdef" },
        },
      },
    });
    await assert.rejects(fs.access(broker.mcpFile));
    const lock = JSON.parse(await fs.readFile(profile.bridgeLockFile, "utf8"));
    assert.equal(lock.pid, process.pid);
    assert.equal(lock.sessionKey, broker.sessionKey);
    const instructions = await fs.readFile(broker.instructionsFile, "utf8");
    assert.match(instructions, /Use only MCP tools/);
    assert.match(instructions, /never attempt to bypass/);
    await unregisterSessionBridge(profile, broker);
    assert.deepEqual(JSON.parse(await fs.readFile(profile.globalMcpFile, "utf8")), {
      mcpServers: {},
    });
    await assert.rejects(fs.access(profile.bridgeLockFile));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("bridge lock rejects another live or stale Pi session without unsafe auto-recovery", async () => {
  const root = await fixture();
  const profile = resolveAgySecurityProfile({ [AGY_SECURITY_PROFILE_ENV]: root });
  const first = sessionBroker(profile, "session-owner");
  const other = sessionBroker(profile, "session-other");
  try {
    await registerSessionBridge(
      profile,
      first,
      "http://127.0.0.1:43210/mcp",
      "0123456789abcdef0123456789abcdef",
    );
    await assert.rejects(
      registerSessionBridge(
        profile,
        other,
        "http://127.0.0.1:43211/mcp",
        "fedcba9876543210fedcba9876543210",
      ),
      /active owner pid/,
    );
    await assert.rejects(recoverStaleBridgeLock(profile), /still alive/);
    await unregisterSessionBridge(profile, first);

    await fs.writeFile(
      profile.bridgeLockFile,
      `${JSON.stringify({ version: 1, pid: 2147483647, sessionKey: first.sessionKey })}\n`,
      { mode: 0o600 },
    );
    await assert.rejects(
      registerSessionBridge(
        profile,
        other,
        "http://127.0.0.1:43211/mcp",
        "fedcba9876543210fedcba9876543210",
      ),
      /stale owner pid 2147483647/,
    );
    assert.equal(await recoverStaleBridgeLock(profile), "recovered");
    await assert.rejects(fs.access(profile.bridgeLockFile));
    assert.deepEqual(JSON.parse(await fs.readFile(profile.globalMcpFile, "utf8")), {
      mcpServers: {},
    });
  } finally {
    await fs.unlink(profile.bridgeLockFile).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("dedicated profile refuses foreign global MCP servers", async () => {
  const root = await fixture();
  try {
    const profile = resolveAgySecurityProfile({ [AGY_SECURITY_PROFILE_ENV]: root });
    await prepareAgySecurityProfile(profile);
    await fs.writeFile(
      profile.globalMcpFile,
      JSON.stringify({
        mcpServers: {
          foreign: { serverUrl: "http://127.0.0.1:1234/mcp" },
        },
      }),
    );
    await assert.rejects(prepareAgySecurityProfile(profile), /foreign global MCP server/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects non-loopback bridges and unsafe tokens", async () => {
  const root = await fixture();
  try {
    const profile = resolveAgySecurityProfile({ [AGY_SECURITY_PROFILE_ENV]: root });
    const broker = sessionBroker(profile, "session-2");
    await assert.rejects(
      registerSessionBridge(profile, broker, "https://example.com/mcp", "0123456789abcdef"),
      /127\.0\.0\.1/,
    );
    await assert.rejects(
      registerSessionBridge(profile, broker, "http://127.0.0.1:1234/mcp", "short"),
      /token is invalid/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("refuses to replace a symlinked security settings file", async () => {
  const root = await fixture();
  const outside = path.join(os.tmpdir(), `pi-antigravity-outside-${Date.now()}.json`);
  try {
    const profile = resolveAgySecurityProfile({ [AGY_SECURITY_PROFILE_ENV]: root });
    await prepareAgySecurityProfile(profile);
    await fs.unlink(profile.settingsFile);
    await fs.writeFile(outside, '{"untouched":true}\n');
    await fs.symlink(outside, profile.settingsFile);
    await assert.rejects(prepareAgySecurityProfile(profile), /non-regular JSON file/);
    assert.equal(await fs.readFile(outside, "utf8"), '{"untouched":true}\n');
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.unlink(outside).catch(() => {});
  }
});

test("refuses to take over a non-empty unmarked profile directory", async () => {
  const root = await fixture();
  try {
    await fs.writeFile(path.join(root, "unrelated.txt"), "keep me");
    const profile = resolveAgySecurityProfile({ [AGY_SECURITY_PROFILE_ENV]: root });
    await assert.rejects(prepareAgySecurityProfile(profile), /non-empty unmarked/);
    assert.equal(await fs.readFile(path.join(root, "unrelated.txt"), "utf8"), "keep me");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("rejects a broker whose paths do not match its profile", async () => {
  const root = await fixture();
  try {
    const profile = resolveAgySecurityProfile({ [AGY_SECURITY_PROFILE_ENV]: root });
    const broker = sessionBroker(profile, "session-layout");
    await assert.rejects(
      registerSessionBridge(
        profile,
        { ...broker, mcpFile: path.join(root, "outside-mcp.json") },
        "http://127.0.0.1:43210/mcp",
        "0123456789abcdef0123456789abcdef",
      ),
      /inconsistent mcpFile/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

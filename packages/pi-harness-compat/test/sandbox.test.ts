import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import {
  applyCodexEnvironmentPolicy,
  checkCodexPathAccess,
  loadCodexSandboxPolicy,
} from "../lib/codex-policy.ts";
import { buildPiSeatbeltPolicy } from "../lib/seatbelt.ts";

const execFileAsync = promisify(execFile);

test("Codex locked profile grants workspace writes, extra roots, and denies matching files", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-codex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const extra = join(root, "extra");
  const outside = join(root, "outside");
  await Promise.all([mkdir(workspace), mkdir(extra), mkdir(outside)]);
  const config = join(root, "config.toml");
  await writeFile(
    config,
    [
      'default_permissions = "locked"',
      "[permissions.locked]",
      'extends = ":workspace"',
      "[permissions.locked.filesystem]",
      '":workspace_roots"."**/dbhub.prod.toml" = "deny"',
      `"${extra}" = "write"`,
      "[permissions.locked.network]",
      "enabled = true",
      "",
    ].join("\n"),
  );
  const policy = await loadCodexSandboxPolicy({ configFile: config });
  assert.equal((await checkCodexPathAccess(policy, "a.txt", workspace, "write")).allowed, true);
  assert.equal(
    (await checkCodexPathAccess(policy, join(extra, "a.txt"), workspace, "write")).allowed,
    true,
  );
  assert.equal(
    (await checkCodexPathAccess(policy, join(outside, "a.txt"), workspace, "write")).allowed,
    false,
  );
  assert.equal(
    (await checkCodexPathAccess(policy, "nested/dbhub.prod.toml", workspace, "read")).allowed,
    false,
  );
});

test("canonical path guard rejects a symlink escape", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-link-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  await import("node:fs/promises").then(({ symlink }) =>
    symlink(outside, join(workspace, "escape")),
  );
  const policy = {
    profile: "locked",
    extendsWorkspace: true,
    networkEnabled: false,
    filesystem: [],
    environment: {
      ignoreDefaultExcludes: false,
      exclude: [],
      set: {},
    },
    source: "fixture",
  };
  const checked = await checkCodexPathAccess(policy, "escape/new.txt", workspace, "write");
  assert.equal(checked.allowed, false);
  assert.equal(checked.canonicalPath, join(await realpath(outside), "new.txt"));
});

test("macOS Seatbelt permits workspace writes and rejects outside writes plus denied reads", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-seatbelt-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  await writeFile(join(workspace, "dbhub.prod.toml"), "secret");
  await writeFile(join(workspace, "private.pem"), "secret key");
  const policy = {
    profile: "locked",
    extendsWorkspace: true,
    networkEnabled: false,
    filesystem: [
      {
        base: "workspace" as const,
        path: "**/dbhub.prod.toml",
        access: "deny" as const,
      },
    ],
    environment: {
      ignoreDefaultExcludes: false,
      exclude: [],
      set: {},
    },
    source: "fixture",
  };
  const seatbelt = buildPiSeatbeltPolicy(
    policy,
    workspace,
    [],
    [{ tool: "read", pattern: "**/*.pem", raw: "Read(**/*.pem)" }],
  );

  await execFileAsync("/usr/bin/sandbox-exec", [
    "-p",
    seatbelt,
    "/bin/bash",
    "-c",
    `printf ok > "${join(workspace, "inside.txt")}"`,
  ]);
  await assert.rejects(() =>
    execFileAsync("/usr/bin/sandbox-exec", [
      "-p",
      seatbelt,
      "/bin/bash",
      "-c",
      `printf no > "${join(outside, "outside.txt")}"`,
    ]),
  );
  await assert.rejects(() =>
    execFileAsync("/usr/bin/sandbox-exec", [
      "-p",
      seatbelt,
      "/bin/cat",
      join(workspace, "dbhub.prod.toml"),
    ]),
  );
  await assert.rejects(() =>
    execFileAsync("/usr/bin/sandbox-exec", [
      "-p",
      seatbelt,
      "/bin/cat",
      join(workspace, "private.pem"),
    ]),
  );
});

test("Codex environment policy strips secret-like variables and applies explicit set values", () => {
  const policy = {
    profile: "locked",
    extendsWorkspace: true,
    networkEnabled: false,
    filesystem: [],
    environment: {
      inherit: "all" as const,
      ignoreDefaultExcludes: false,
      exclude: ["DROP_*"],
      set: { SAFE_OVERRIDE: "configured", BASH_ENV: "/tmp/injected-from-config" },
    },
    source: "fixture",
  };
  assert.deepEqual(
    applyCodexEnvironmentPolicy(policy, {
      PATH: "/usr/bin",
      OPENAI_API_KEY: "secret",
      SOME_TOKEN: "secret",
      DROP_THIS: "no",
      BASH_ENV: "/tmp/injected",
      DYLD_INSERT_LIBRARIES: "/tmp/injected.dylib",
      NODE_OPTIONS: "--require=/tmp/injected.js",
      SAFE_OVERRIDE: "old",
    }),
    { PATH: "/usr/bin", SAFE_OVERRIDE: "configured" },
  );
});

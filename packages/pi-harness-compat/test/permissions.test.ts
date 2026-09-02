import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  evaluateClaudePermission,
  loadClaudePermissionPolicy,
  parseClaudeRule,
  parseClaudeSettings,
} from "../lib/claude-permissions.ts";
import { evaluateBashPermission, parseShellCommand } from "../lib/bash.ts";
import { matchFilePermissionPattern, matchPermissionPattern } from "../lib/glob.ts";

test("Claude wildcard matching preserves optional command suffixes and recursive paths", () => {
  assert.equal(matchPermissionPattern("git status *", "git status"), true);
  assert.equal(matchPermissionPattern("git status *", "git status --short"), true);
  assert.equal(matchPermissionPattern("git status:*", "git status --short"), true);
  assert.equal(matchPermissionPattern("git status:*", "git status"), true);
  assert.equal(matchPermissionPattern("**/.env", ".env"), true);
  assert.equal(matchPermissionPattern("**/.env", "api/.env"), true);
  assert.equal(matchPermissionPattern("domain:*.example.com", "https://api.example.com/x"), true);
  assert.equal(matchPermissionPattern("domain:*.example.com", "https://example.com/x"), false);
  assert.equal(matchFilePermissionPattern("/repo/src/*.ts", "/repo/src/a.ts"), true);
  assert.equal(matchFilePermissionPattern("/repo/src/*.ts", "/repo/src/nested/a.ts"), false);
});

test("Claude rules parse tool mappings", () => {
  assert.deepEqual(parseClaudeRule("Bash(git status *)"), {
    tool: "bash",
    pattern: "git status *",
    raw: "Bash(git status *)",
  });
  assert.equal(parseClaudeRule("Edit(**/.env)")?.tool, "edit");
  assert.equal(parseClaudeRule("Write(**/.env)")?.tool, "write");
  assert.equal(parseClaudeRule("Glob(**/*.ts)")?.tool, "find");
  assert.equal(parseClaudeRule("mcp__github__create_issue")?.tool, "mcp__github__create_issue");
});

test("settings chain merges global, project and local permissions without executing project hooks", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-harness-claude-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const home = join(root, "home");
  const project = join(root, "project");
  await mkdir(join(home, ".claude"), { recursive: true });
  await mkdir(join(project, ".claude"), { recursive: true });
  await mkdir(join(project, "subdir"));
  await writeFile(
    join(home, ".claude", "settings.json"),
    JSON.stringify({
      permissions: {
        allow: ["Read(*)"],
        deny: ["Read(**/.secret)"],
        defaultMode: "auto",
        additionalDirectories: ["../shared"],
      },
      hooks: {
        PermissionRequest: [{ hooks: [{ type: "command", command: "/bin/echo notify" }] }],
      },
    }),
  );
  await writeFile(
    join(project, ".claude", "settings.json"),
    JSON.stringify({
      permissions: {
        ask: ["Bash(git push *)"],
        additionalDirectories: ["/untrusted-project-expansion"],
      },
      hooks: { PermissionRequest: [{ hooks: [{ type: "command", command: "malicious" }] }] },
    }),
  );
  await writeFile(
    join(project, ".claude", "settings.local.json"),
    JSON.stringify({
      permissions: {
        allow: ["Bash(git status *)"],
        additionalDirectories: ["../local-user-root"],
      },
    }),
  );

  const policy = await loadClaudePermissionPolicy(join(project, "subdir"), {
    homeDirectory: home,
  });
  assert.equal(policy.sources.length, 3);
  assert.equal(policy.allow.length, 2);
  assert.equal(policy.ask.length, 1);
  assert.equal(policy.deny.length, 1);
  assert.equal(policy.defaultMode, "auto");
  assert.deepEqual(policy.permissionRequestCommands, ["/bin/echo notify"]);
  assert.deepEqual(policy.additionalDirectories, [
    "../shared",
    "/untrusted-project-expansion",
    "../local-user-root",
  ]);
  assert.deepEqual(policy.trustedAdditionalDirectories, ["../shared", "../local-user-root"]);

  const untrusted = await loadClaudePermissionPolicy(join(project, "subdir"), {
    homeDirectory: home,
    includeProject: false,
  });
  assert.equal(untrusted.sources.length, 1);
  assert.equal(untrusted.allow.length, 1);
  assert.equal(untrusted.ask.length, 0);
  assert.deepEqual(untrusted.additionalDirectories, ["../shared"]);
});

test("deny wins over ask and allow; unmatched auto mode still asks", () => {
  const parsed = parseClaudeSettings({
    permissions: {
      allow: ["Read(*)", "Bash(git *)"],
      ask: ["Read(**/.env)", "Bash(git push *)"],
      deny: ["Read(**/.env)", "Bash(git push --force*)"],
      defaultMode: "auto",
    },
  });
  const policy = { ...parsed, sources: [], permissionRequestCommands: [] };
  assert.equal(
    evaluateClaudePermission(policy, {
      toolName: "read",
      input: { path: "/repo/.env" },
      cwd: "/repo",
    }).decision,
    "deny",
  );
  assert.equal(
    evaluateClaudePermission(policy, {
      toolName: "edit",
      input: { path: "src/a.ts" },
      cwd: "/repo",
    }).decision,
    "ask",
  );
  const filePolicy = {
    ...parseClaudeSettings({
      permissions: {
        allow: ["Read(src/*.ts)"],
        deny: ["Edit(**/.env)"],
      },
    }),
    sources: [],
    permissionRequestCommands: [],
    projectRoot: "/repo",
  };
  assert.equal(
    evaluateClaudePermission(filePolicy, {
      toolName: "write",
      input: { path: ".env" },
      cwd: "/repo",
      canonicalPath: "/repo/.env",
    }).decision,
    "deny",
    "Edit deny rules also govern Write",
  );
  assert.equal(
    evaluateClaudePermission(filePolicy, {
      toolName: "read",
      input: { path: "src/a.ts" },
      cwd: "/repo",
      canonicalPath: "/repo/src/a.ts",
    }).decision,
    "allow",
  );
  assert.equal(
    evaluateClaudePermission(filePolicy, {
      toolName: "read",
      input: { path: "src/nested/a.ts" },
      cwd: "/repo",
      canonicalPath: "/repo/src/nested/a.ts",
    }).decision,
    "ask",
    "single-star file globs do not cross directories",
  );
  assert.equal(
    evaluateClaudePermission(filePolicy, {
      toolName: "read",
      input: { path: "src/link.ts" },
      cwd: "/repo",
      canonicalPath: "/outside/a.ts",
    }).decision,
    "ask",
    "an allow rule must match both a symlink path and its canonical target",
  );
});

test("shell parsing checks every simple leaf and asks on hidden execution", () => {
  const parsed = parseClaudeSettings({
    permissions: {
      allow: ["Bash(git status *)", "Bash(echo *)"],
      deny: ["Bash(rm -rf *)"],
    },
  });
  const policy = { ...parsed, sources: [], permissionRequestCommands: [] };
  assert.deepEqual(parseShellCommand("echo 'a;b' && git status --short").leaves, [
    "echo 'a;b'",
    "git status --short",
  ]);
  assert.equal(
    evaluateBashPermission(policy, {
      toolName: "bash",
      input: { command: "git status && rm -rf ./build" },
      cwd: "/repo",
    }).decision,
    "deny",
  );
  assert.equal(
    evaluateBashPermission(policy, {
      toolName: "bash",
      input: { command: "echo $(rm -rf ./build)" },
      cwd: "/repo",
    }).decision,
    "ask",
  );
  assert.equal(
    evaluateBashPermission(policy, {
      toolName: "bash",
      input: { command: "xargs echo" },
      cwd: "/repo",
    }).decision,
    "ask",
  );
  const broad = parseClaudeSettings({ permissions: { allow: ["Bash(*)"] } });
  const broadPolicy = { ...broad, sources: [], permissionRequestCommands: [] };
  for (const command of [
    "/bin/bash -c 'touch hidden'",
    "/usr/bin/env sh -c 'touch hidden'",
    "/usr/bin/find . -exec touch hidden ;",
  ]) {
    const result = evaluateBashPermission(broadPolicy, {
      toolName: "bash",
      input: { command },
      cwd: "/repo",
    });
    assert.equal(result.decision, "ask");
    assert.match(result.reason, /indirection or complex syntax/);
  }
});

test("MCP rules match the exact Claude-style tool name", () => {
  const parsed = parseClaudeSettings({
    permissions: {
      allow: ["mcp__github__get_issue"],
      deny: ["mcp__github__delete_issue"],
    },
  });
  const policy = { ...parsed, sources: [], permissionRequestCommands: [] };
  assert.equal(
    evaluateClaudePermission(policy, {
      toolName: "mcp__github__get_issue",
      input: {},
      cwd: "/repo",
    }).decision,
    "allow",
  );
  assert.equal(
    evaluateClaudePermission(policy, {
      toolName: "mcp__github__delete_issue",
      input: {},
      cwd: "/repo",
    }).decision,
    "deny",
  );
  assert.equal(
    evaluateClaudePermission(policy, {
      toolName: "mcp__github__create_issue",
      input: {},
      cwd: "/repo",
    }).decision,
    "ask",
  );
});

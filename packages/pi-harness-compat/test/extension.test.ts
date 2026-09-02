import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import harnessCompat from "../index.ts";

test("extension gates tool calls and executes its replacement bash only inside Seatbelt", async (t) => {
  if (process.platform !== "darwin") return t.skip("macOS Seatbelt test");
  const root = await mkdtemp(join(tmpdir(), "pi-harness-extension-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  const outside = join(root, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  const claudeSettings = join(root, "claude-settings.json");
  const codexConfig = join(root, "codex-config.toml");
  await writeFile(
    claudeSettings,
    JSON.stringify({
      permissions: {
        allow: ["Bash(git status *)", "mcp__mysql__mysql_query"],
        deny: ["Read(**/dbhub.prod.toml)", "mcp__mysql__execute_sql"],
      },
    }),
  );
  await writeFile(
    codexConfig,
    [
      'default_permissions = "locked"',
      "[permissions.locked]",
      'extends = ":workspace"',
      "[permissions.locked.filesystem]",
      '":workspace_roots"."**/dbhub.prod.toml" = "deny"',
      "[permissions.locked.network]",
      "enabled = true",
      "",
    ].join("\n"),
  );

  const previousCwd = process.cwd();
  const previousClaude = process.env.PI_HARNESS_CLAUDE_SETTINGS;
  const previousCodex = process.env.PI_HARNESS_CODEX_CONFIG;
  process.chdir(workspace);
  process.env.PI_HARNESS_CLAUDE_SETTINGS = claudeSettings;
  process.env.PI_HARNESS_CODEX_CONFIG = codexConfig;
  t.after(() => {
    process.chdir(previousCwd);
    if (previousClaude === undefined) delete process.env.PI_HARNESS_CLAUDE_SETTINGS;
    else process.env.PI_HARNESS_CLAUDE_SETTINGS = previousClaude;
    if (previousCodex === undefined) delete process.env.PI_HARNESS_CODEX_CONFIG;
    else process.env.PI_HARNESS_CODEX_CONFIG = previousCodex;
  });

  const handlers = new Map<string, Array<(event: any, ctx: any) => Promise<any> | any>>();
  const busHandlers = new Map<string, (event: any) => void>();
  const tools = new Map<string, any>();
  const pi = {
    on: (name: string, handler: (event: any, ctx: any) => Promise<any> | any) => {
      const values = handlers.get(name) ?? [];
      values.push(handler);
      handlers.set(name, values);
    },
    registerTool: (tool: any) => tools.set(tool.name, tool),
    registerCommand: () => {},
    events: {
      on: (name: string, handler: (event: any) => void) => busHandlers.set(name, handler),
    },
  };
  harnessCompat(pi as never);
  const gate = handlers.get("tool_call")?.[0];
  assert.ok(gate);
  const ctx = { cwd: workspace, hasUI: false, ui: {} };
  for (const handler of handlers.get("session_start") ?? []) {
    await handler({}, ctx);
  }

  const mcpBroker = busHandlers.get("pi-mcp-adapter:tool-approval-request");
  assert.ok(mcpBroker);
  let claimed: (() => Promise<string>) | undefined;
  mcpBroker({
    serverName: "mysql",
    originalToolName: "mysql_query",
    prefixedToolName: "mysql_mysql_query",
    args: { sql: "select 1" },
    claim: (decision: () => Promise<string>) => {
      claimed = decision;
    },
  });
  assert.equal(await claimed?.(), "allow_once");
  mcpBroker({
    serverName: "mysql",
    originalToolName: "execute_sql",
    prefixedToolName: "mysql_execute_sql",
    args: { sql: "drop table x" },
    claim: (decision: () => Promise<string>) => {
      claimed = decision;
    },
  });
  assert.equal(await claimed?.(), "deny");

  assert.equal(
    await gate(
      {
        type: "tool_call",
        toolCallId: "1",
        toolName: "bash",
        input: { command: "git status --short" },
      },
      ctx,
    ),
    undefined,
  );
  const denied = await gate(
    {
      type: "tool_call",
      toolCallId: "2",
      toolName: "read",
      input: { path: "dbhub.prod.toml" },
    },
    ctx,
  );
  assert.equal(denied.block, true);
  const headlessAsk = await gate(
    { type: "tool_call", toolCallId: "3", toolName: "write", input: { path: "new.txt" } },
    ctx,
  );
  assert.equal(headlessAsk.block, true);
  assert.match(headlessAsk.reason, /no interactive UI/);

  const bash = tools.get("bash");
  assert.ok(bash);
  const inside = join(workspace, "inside.txt");
  await bash.execute("safe-write", { command: `printf ok > "${inside}"` }, undefined, undefined);
  await access(inside);
  await assert.rejects(() =>
    bash.execute(
      "blocked-write",
      { command: `printf no > "${join(outside, "outside.txt")}"` },
      undefined,
      undefined,
    ),
  );
  await assert.rejects(() => access(join(outside, "outside.txt")));
});

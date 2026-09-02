import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { appendAgySecurityEvent, securityEventLogFile } from "../lib/security-events.ts";

test("security event log is private and contains metadata only supplied by its caller", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-agy-events-"));
  try {
    const file = path.join(root, "agent", "antigravity-security-events.jsonl");
    await appendAgySecurityEvent(
      {
        occurredAt: "2026-09-02T00:00:00.000Z",
        kind: "native-tool-request",
        modelId: "gemini-3.7-flash",
        nativeTool: "view_file",
        bridgeRevision: "1:2",
        piSessionId: "session-1",
      },
      file,
    );
    const [line] = (await fs.readFile(file, "utf8")).trim().split("\n");
    assert.deepEqual(JSON.parse(line), {
      occurredAt: "2026-09-02T00:00:00.000Z",
      kind: "native-tool-request",
      modelId: "gemini-3.7-flash",
      nativeTool: "view_file",
      bridgeRevision: "1:2",
      piSessionId: "session-1",
    });
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("security event log location is under Pi agent state", () => {
  assert.equal(
    securityEventLogFile("/private/tmp/home"),
    "/private/tmp/home/.pi/agent/antigravity-security-events.jsonl",
  );
});

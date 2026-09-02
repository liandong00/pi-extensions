import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PRIVATE_DIRECTORY_MODE = 0o700;
const PRIVATE_FILE_MODE = 0o600;

/**
 * Durable, deliberately metadata-only audit trail for fail-closed agy
 * security aborts. Prompt text, tool arguments, filesystem paths and bridge
 * credentials must never enter this file.
 */
export interface AgySecurityEvent {
  occurredAt: string;
  kind: "native-tool-request" | "foreign-mcp-request";
  modelId: string;
  nativeTool: string;
  mcpServer?: string;
  bridgeRevision?: string;
  piSessionId?: string;
}

export function securityEventLogFile(homeDirectory = os.homedir()): string {
  return path.join(homeDirectory, ".pi", "agent", "antigravity-security-events.jsonl");
}

/** Best-effort audit write; observability must never relax fail-closed aborts. */
export async function appendAgySecurityEvent(
  event: AgySecurityEvent,
  file = securityEventLogFile(),
): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  await fs.chmod(directory, PRIVATE_DIRECTORY_MODE);
  const handle = await fs.open(
    file,
    fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW,
    PRIVATE_FILE_MODE,
  );
  try {
    await handle.writeFile(`${JSON.stringify(event)}\n`, "utf8");
    await handle.chmod(PRIVATE_FILE_MODE);
  } finally {
    await handle.close();
  }
}

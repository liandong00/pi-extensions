import { spawn } from "node:child_process";

const HOOK_TIMEOUT_MS = 5_000;

/** Run only commands sourced from the trusted user-level Claude settings file. */
export function notifyPermissionRequest(
  commands: readonly string[],
  payload: Record<string, unknown>,
): void {
  const body = JSON.stringify(payload);
  for (const command of commands) {
    try {
      const child = spawn("/bin/bash", ["-lc", command], {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
      });
      child.stdin?.end(body);
      const timer = setTimeout(() => child.kill("SIGTERM"), HOOK_TIMEOUT_MS);
      timer.unref?.();
      child.once("close", () => clearTimeout(timer));
      child.once("error", () => clearTimeout(timer));
    } catch {
      // Notifications are best-effort and never change the permission decision.
    }
  }
}

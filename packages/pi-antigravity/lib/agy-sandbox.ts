import {
  accessSync,
  constants as fsConstants,
  promises as fs,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";

export interface AgySandboxOptions {
  required: boolean;
  geminiDir: string;
  brokerCwd: string;
}

export interface AgySandboxLaunch {
  file: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  profile: string;
}

const SANDBOX_EXEC = "/usr/bin/sandbox-exec";
const AGY_ENV_ALLOWLIST = new Set([
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TERM",
  "TZ",
  "USER",
  "__CF_USER_TEXT_ENCODING",
]);

function canonicalDirectory(value: string, label: string): string {
  if (!path.isAbsolute(value)) throw new Error(`${label} must be absolute.`);
  const canonical = realpathSync.native(value);
  if (!statSync(canonical).isDirectory()) throw new Error(`${label} is not a directory.`);
  return canonical;
}

function canonicalFile(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("agy binary must resolve to an absolute path.");
  const canonical = realpathSync.native(value);
  if (!statSync(canonical).isFile()) throw new Error("agy binary is not a regular file.");
  return canonical;
}

function seatbeltString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function buildAgySeatbeltProfile(
  binary: string,
  geminiDir: string,
  brokerCwd: string,
): string {
  const executable = canonicalFile(binary);
  const executableParent = path.dirname(executable);
  const profileRoot = canonicalDirectory(geminiDir, "agy gemini directory");
  const broker = canonicalDirectory(brokerCwd, "agy broker workspace");
  const readable = [
    "/System",
    "/usr/lib",
    "/usr/share",
    "/private/etc",
    "/private/var/db/timezone",
    "/Library/Preferences",
    "/dev",
    executable,
    profileRoot,
    broker,
  ].filter((candidate) => {
    try {
      accessSync(candidate, fsConstants.R_OK);
      return true;
    } catch {
      return false;
    }
  });
  const readRules = readable.map((candidate) =>
    candidate === executable
      ? `(literal ${seatbeltString(candidate)})`
      : `(subpath ${seatbeltString(candidate)})`,
  );
  return [
    "(version 1)",
    "(deny default)",
    '(import "system.sb")',
    "(allow process*)",
    "(allow signal (target self))",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    // system.sb has a filtered trustd.agent rule that an unfiltered allow does
    // not override. Go's Security.framework TLS verifier needs this one exact
    // service; it does not require filesystem access to the user's Keychain.
    '(allow mach-lookup (global-name "com.apple.trustd.agent"))',
    "(allow ipc-posix*)",
    // Security.framework resolves the launching executable before Go TLS trust
    // evaluation. Parent-directory metadata is sufficient; never grant data
    // reads for the directory, which could expose/enable sibling executables.
    `(allow file-read-metadata (literal ${seatbeltString(executableParent)}))`,
    `(allow file-read* ${readRules.join(" ")})`,
    `(allow file-write* (subpath ${seatbeltString(profileRoot)}) (subpath ${seatbeltString(broker)}) (literal "/dev/null"))`,
    '(allow network-bind (local ip "*:*"))',
    '(allow network-inbound (local ip "*:*"))',
    "(allow network-outbound)",
    "",
  ].join("\n");
}

/** Resolve a mandatory macOS Seatbelt launch; never fall back to an unsandboxed agy process. */
export async function sandboxAgyLaunch(
  binary: string,
  args: readonly string[],
  options: AgySandboxOptions | undefined,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<AgySandboxLaunch | undefined> {
  if (!options?.required) return undefined;
  if (process.platform !== "darwin") {
    throw new Error("antigravity OS sandbox is required but only macOS Seatbelt is implemented.");
  }
  accessSync(SANDBOX_EXEC, fsConstants.X_OK);
  const temporary = path.join(options.geminiDir, "antigravity-cli", "tmp");
  await fs.mkdir(temporary, { recursive: true, mode: 0o700 });
  await fs.chmod(temporary, 0o700);
  const profile = buildAgySeatbeltProfile(binary, options.geminiDir, options.brokerCwd);
  const env: NodeJS.ProcessEnv = {
    HOME: options.geminiDir,
    TMPDIR: temporary,
  };
  for (const name of AGY_ENV_ALLOWLIST) {
    if (baseEnv[name] !== undefined) env[name] = baseEnv[name];
  }
  return {
    file: SANDBOX_EXEC,
    args: ["-p", profile, canonicalFile(binary), ...args],
    env,
    profile,
  };
}

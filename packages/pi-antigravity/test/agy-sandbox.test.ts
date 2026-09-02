import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { sandboxAgyLaunch } from "../lib/agy-sandbox.ts";

const execFileAsync = promisify(execFile);

test("mandatory agy Seatbelt writes only inside its profile/broker and blocks outside reads", {
  skip: process.platform !== "darwin",
}, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-antigravity-sandbox-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const geminiDir = join(root, "profile");
  const brokerCwd = join(root, "broker");
  const outside = join(root, "outside");
  await Promise.all([mkdir(geminiDir), mkdir(brokerCwd), mkdir(outside)]);
  const secret = join(outside, "secret.txt");
  await writeFile(secret, "secret");
  await symlink(outside, join(brokerCwd, "escape"));
  const options = { required: true, geminiDir, brokerCwd };

  const versionProbe = await sandboxAgyLaunch("/usr/bin/true", [], options, {
    PATH: process.env.PATH,
    LANG: "en_US.UTF-8",
    OPENAI_API_KEY: "must-not-cross-boundary",
    SOME_TOKEN: "must-not-cross-boundary",
  });
  assert.ok(versionProbe);
  assert.match(versionProbe.profile, /\(global-name "com\.apple\.trustd\.agent"\)/);
  assert.doesNotMatch(versionProbe.profile, /\/private\/var\/protected\/trustd/);
  assert.match(versionProbe.profile, /\(allow file-read-metadata \(literal "\/usr\/bin"\)\)/);
  assert.doesNotMatch(versionProbe.profile, /\(subpath "\/usr\/bin"\)/);
  assert.equal(versionProbe.env.OPENAI_API_KEY, undefined);
  assert.equal(versionProbe.env.SOME_TOKEN, undefined);
  assert.equal(versionProbe.env.HOME, geminiDir);
  await execFileAsync(versionProbe.file, versionProbe.args, { env: versionProbe.env });

  const inside = join(geminiDir, "inside.txt");
  const allowedWrite = await sandboxAgyLaunch("/usr/bin/touch", [inside], options);
  assert.ok(allowedWrite);
  await execFileAsync(allowedWrite.file, allowedWrite.args, { env: allowedWrite.env });
  await access(inside);

  const deniedWrite = await sandboxAgyLaunch(
    "/usr/bin/touch",
    [join(outside, "blocked.txt")],
    options,
  );
  assert.ok(deniedWrite);
  await assert.rejects(() =>
    execFileAsync(deniedWrite.file, deniedWrite.args, { env: deniedWrite.env }),
  );

  const deniedRead = await sandboxAgyLaunch("/bin/cat", [secret], options);
  assert.ok(deniedRead);
  await assert.rejects(() =>
    execFileAsync(deniedRead.file, deniedRead.args, { env: deniedRead.env }),
  );

  const symlinkEscape = await sandboxAgyLaunch(
    "/usr/bin/touch",
    [join(brokerCwd, "escape", "blocked-via-link.txt")],
    options,
  );
  assert.ok(symlinkEscape);
  await assert.rejects(() =>
    execFileAsync(symlinkEscape.file, symlinkEscape.args, { env: symlinkEscape.env }),
  );
});

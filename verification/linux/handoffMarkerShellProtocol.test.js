// Linux-only 协议夹具（r29）：用隔离的本地 POSIX /bin/sh 进程驱动真实生成的远端读取命令，
// 证明 M/R/U 哨兵与父链失败分支在真实 shell 语义下成立（可搜索父目录、symlink 跨项目、
// 普通文件父段、不可读 marker 等）。显式单独执行：
//   node --test verification/linux/handoffMarkerShellProtocol.test.js
// 不放入 test/ 目录，因此不进入 Windows 通用套件，也不依赖任何不存在的 sh；无 SSH、无网络。
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");
const { spawn, spawnSync } = require("node:child_process");

const source = fs.readFileSync(path.join(__dirname, "../../extension.js"), "utf8");
const defaultMarkerName = /const DEFAULT_HANDOFF_MARKER = "([^"]+)";/.exec(source)[1];
const managedSegmentsDeclaration = /const REMOTE_HANDOFF_MANAGED_SEGMENTS = [^\n]+;/.exec(source)[0];

function extract(name) {
  const asyncStart = source.indexOf(`async function ${name}(`);
  const start = asyncStart >= 0 ? asyncStart : source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `missing function ${name}`);
  const headerEnd = source.indexOf(") {", start);
  let depth = 0;
  for (let index = headerEnd + 2; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) return source.slice(start, index + 1);
  }
  throw new Error(`unterminated function ${name}`);
}

function posixSandbox() {
  const sandbox = { path, DEFAULT_HANDOFF_MARKER: defaultMarkerName, commands: [] };
  sandbox.runSsh = (sftp, command, timeout) => new Promise((resolve, reject) => {
    sandbox.commands.push({ command, timeout });
    const child = spawn("/bin/sh", ["-c", command], { timeout: 10000 });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve(stdout);
      else reject(Object.assign(new Error(stderr || `sh exited ${code}`), { exitCode: code }));
    });
  });
  sandbox.withFileResourceLease = (operation, project, paths, server, work) => work();
  vm.createContext(sandbox);
  vm.runInContext([
    managedSegmentsDeclaration,
    extract("shellQuote"),
    extract("requireRemoteRoot"),
    extract("safeHandoffMarkerName"),
    extract("getRemoteMarkerPath"),
    extract("legacyRemoteMarkerPath"),
    extract("createRemoteHandoffReadCommand"),
    extract("readRemoteHandoffMarker"),
    "this.api = { readRemoteHandoffMarker, getRemoteMarkerPath, legacyRemoteMarkerPath };",
  ].join("\n"), sandbox);
  return sandbox;
}

const MANAGED = ["simple_cluster", "state", "simple-sftp", "handoff"];
function markerDir(root) { return path.join(root, ...MANAGED); }
function markerFile(root, name = defaultMarkerName) { return path.join(markerDir(root), name); }
function writeMarkerAt(root, marker, name) {
  fs.mkdirSync(markerDir(root), { recursive: true, mode: 0o700 });
  fs.writeFileSync(markerFile(root, name), `${JSON.stringify(marker, null, 2)}\n`, "utf8");
}
const LEGACY = { schemaVersion: 1, action: "remoteToLocal", timestamp: "2026-01-02T03:04:05.000Z" };
const NEW = { schemaVersion: 1, action: "handoffReady", timestamp: "2026-10-25T10:00:00.000Z" };

function tempRoot(t, name) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), `handoff-sh-${name}-`));
  t.after(() => fs.chmodSync(dir, 0o755) || fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("a genuinely absent marker under a searchable (or absent) managed chain yields M and reads the exact legacy file once", async (t) => {
  const sandbox = posixSandbox();
  const root = tempRoot(t, "missing");
  fs.writeFileSync(path.join(root, defaultMarkerName), `${JSON.stringify(LEGACY, null, 2)}\n`, "utf8");
  const got = await sandbox.api.readRemoteHandoffMarker({ remotePath: root, host: "h", port: 22 }, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(got)), LEGACY);
  assert.equal(sandbox.commands.length, 2, "missing new file → exactly one legacy follow-up read");
  const legacyPath = path.join(root, defaultMarkerName);
  assert.equal(sandbox.commands[1].command, `if [ -f '${legacyPath}' ]; then cat '${legacyPath}'; fi`);
  // Full chain present, only the marker file absent → same M branch.
  sandbox.commands.length = 0;
  fs.mkdirSync(markerDir(root), { recursive: true, mode: 0o700 });
  const again = await sandbox.api.readRemoteHandoffMarker({ remotePath: root, host: "h", port: 22 }, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(again)), LEGACY);
  assert.equal(sandbox.commands.length, 2);
});

test("a readable new marker wins end-to-end without touching the legacy file", async (t) => {
  const sandbox = posixSandbox();
  const root = tempRoot(t, "newwins");
  fs.writeFileSync(path.join(root, defaultMarkerName), `${JSON.stringify(LEGACY, null, 2)}\n`, "utf8");
  writeMarkerAt(root, NEW);
  const got = await sandbox.api.readRemoteHandoffMarker({ remotePath: root, host: "h", port: 22 }, undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(got)), NEW);
  assert.equal(sandbox.commands.length, 1);
});

test("a managed parent symlink into another project fails closed and never reads either marker or legacy", async (t) => {
  const sandbox = posixSandbox();
  const root = tempRoot(t, "linkroot");
  const other = tempRoot(t, "otherproj");
  writeMarkerAt(other, { ...NEW, action: "foreign-project" });
  fs.symlinkSync(other, path.join(root, "simple_cluster"), "dir");
  fs.writeFileSync(path.join(root, defaultMarkerName), `${JSON.stringify(LEGACY, null, 2)}\n`, "utf8");
  let surfaced = "";
  await assert.rejects(
    sandbox.api.readRemoteHandoffMarker({ remotePath: root, host: "h", port: 22 }, undefined),
    (error) => { surfaced = String(error.message); return /symlink/.test(surfaced); },
  );
  assert.ok(!surfaced.includes("foreign-project"), "the other project's marker content must never surface");
  assert.equal(sandbox.commands.length, 1, "no legacy read after a parent-chain failure");
});

test("a regular file in the managed parent chain fails closed with exit 63", async (t) => {
  const sandbox = posixSandbox();
  const root = tempRoot(t, "fileseg");
  fs.mkdirSync(path.join(root, "simple_cluster"), { mode: 0o700 });
  fs.writeFileSync(path.join(root, "simple_cluster", "state"), "not a directory", "utf8");
  await assert.rejects(
    sandbox.api.readRemoteHandoffMarker({ remotePath: root, host: "h", port: 22 }, undefined),
    /not a directory/,
  );
  assert.equal(sandbox.commands.length, 1);
});

test("an unsearchable managed parent fails closed with exit 64 instead of a false M (r29 boundary)", async (t) => {
  const sandbox = posixSandbox();
  const root = tempRoot(t, "nosearch");
  fs.writeFileSync(path.join(root, defaultMarkerName), `${JSON.stringify(LEGACY, null, 2)}\n`, "utf8");
  fs.mkdirSync(path.join(root, "simple_cluster", "state"), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.join(root, "simple_cluster", "state"), 0o000);
  try {
    await assert.rejects(
      sandbox.api.readRemoteHandoffMarker({ remotePath: root, host: "h", port: 22 }, undefined),
      /not searchable/,
    );
    assert.equal(sandbox.commands.length, 1, "a false M must not trigger a legacy read");
  } finally {
    fs.chmodSync(path.join(root, "simple_cluster", "state"), 0o755);
  }
});

test("an unsearchable project root fails closed with exit 61", async (t) => {
  const sandbox = posixSandbox();
  const root = tempRoot(t, "rootx");
  fs.chmodSync(root, 0o000);
  try {
    await assert.rejects(
      sandbox.api.readRemoteHandoffMarker({ remotePath: root, host: "h", port: 22 }, undefined),
      /root is not a searchable directory/,
    );
    assert.equal(sandbox.commands.length, 1);
  } finally {
    fs.chmodSync(root, 0o755);
  }
});

test("an existing but unreadable new marker fails in the R branch without any legacy fallback", async (t) => {
  const sandbox = posixSandbox();
  const root = tempRoot(t, "noread");
  fs.writeFileSync(path.join(root, defaultMarkerName), `${JSON.stringify(LEGACY, null, 2)}\n`, "utf8");
  writeMarkerAt(root, NEW);
  fs.chmodSync(markerFile(root), 0o000);
  try {
    await assert.rejects(
      sandbox.api.readRemoteHandoffMarker({ remotePath: root, host: "h", port: 22 }, undefined),
    );
    assert.equal(sandbox.commands.length, 1);
    assert.equal(fs.readFileSync(path.join(root, defaultMarkerName), "utf8"), `${JSON.stringify(LEGACY, null, 2)}\n`);
  } finally {
    fs.chmodSync(markerFile(root), 0o600);
  }
});

test("a FIFO marker reports U from the real shell instead of blocking cat (r30 ordinary-file contract)", async (t) => {
  assert.ok(fs.existsSync("/usr/bin/mkfifo") || process.env.PATH.split(":").some((d) => fs.existsSync(path.join(d, "mkfifo"))),
    "mkfifo must already exist on this host; the test never installs it");
  const sandbox = posixSandbox();
  const root = tempRoot(t, "fifo");
  fs.writeFileSync(path.join(root, defaultMarkerName), `${JSON.stringify(LEGACY, null, 2)}\n`, "utf8");
  fs.mkdirSync(markerDir(root), { recursive: true, mode: 0o700 });
  const fifo = markerFile(root);
  const made = spawnSync("mkfifo", [fifo], { encoding: "utf8" });
  assert.equal(made.status, 0, made.stderr || made.error);
  // The corrected -f branch answers U immediately; a bare -e build would block cat until the
  // 10s spawn timeout here, which is exactly the regression this pins (no old build is run).
  const started = Date.now();
  await assert.rejects(
    sandbox.api.readRemoteHandoffMarker({ remotePath: root, host: "h", port: 22 }, undefined),
    /符号链接|目录/,
  );
  assert.ok(Date.now() - started < 5000, "the U branch must answer immediately, not wait on a FIFO");
  assert.equal(sandbox.commands.length, 1, "no legacy read and no cat attempt on a non-regular marker");
});

test("a malformed new marker surfaces the parse failure after exactly one shell round trip", async (t) => {
  const sandbox = posixSandbox();
  const root = tempRoot(t, "broken");
  fs.mkdirSync(markerDir(root), { recursive: true, mode: 0o700 });
  fs.writeFileSync(markerFile(root), "{not-json", "utf8");
  await assert.rejects(
    sandbox.api.readRemoteHandoffMarker({ remotePath: root, host: "h", port: 22 }, undefined),
    /JSON|property name/,
  );
  assert.equal(sandbox.commands.length, 1);
});

test("a symlinked marker file reports U from the real shell, and relative roots never reach the transport", async (t) => {
  const sandbox = posixSandbox();
  const root = tempRoot(t, "marklink");
  fs.mkdirSync(markerDir(root), { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(root, "elsewhere.json"), "{}\n", "utf8");
  fs.symlinkSync(path.join(root, "elsewhere.json"), markerFile(root));
  await assert.rejects(
    sandbox.api.readRemoteHandoffMarker({ remotePath: root, host: "h", port: 22 }, undefined),
    /符号链接|目录/,
  );
  assert.equal(sandbox.commands.length, 1);
  await assert.rejects(
    sandbox.api.readRemoteHandoffMarker({ remotePath: "srv/rel", host: "h", port: 22 }, undefined),
    /远端项目根|POSIX/,
  );
  assert.equal(sandbox.commands.length, 1, "the relative root is rejected before any transport call");
});

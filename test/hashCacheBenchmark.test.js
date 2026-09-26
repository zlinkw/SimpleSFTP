const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { spawnSync } = require("node:child_process");

const originalLoad = Module._load;
Module._load = function (request, ...args) {
  return request === "vscode" ? {
    TreeItem: class {},
    ProgressLocation: { Notification: 1 },
    window: { withProgress: (_options, operation) => operation({ report: () => undefined }) },
    workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  } : originalLoad.call(this, request, ...args);
};
const { __test } = require("../extension.js");
Module._load = originalLoad;

const python = process.platform === "win32" ? "python" : "python3";
const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-hash-cache-"));

function runPython(script, args, env, stdin) {
  const file = path.join(fixtureRoot, `run-${process.hrtime.bigint().toString()}.py`);
  fs.writeFileSync(file, script, "utf8");
  const run = spawnSync(python, [file, ...args], {
    input: stdin,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  return JSON.parse(run.stdout);
}

function writeTree(root, count) {
  fs.mkdirSync(root, { recursive: true });
  const names = [];
  for (let index = 0; index < count; index += 1) {
    const rel = `batch/f${String(index).padStart(3, "0")}.bin`;
    fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    fs.writeFileSync(path.join(root, rel), `payload-${index}`);
    names.push(rel);
  }
  return names;
}

test("cold warm and one-change hashes share one five-field cache", () => {
  const root = path.join(fixtureRoot, "share");
  const cacheDir = path.join(fixtureRoot, "cache-share");
  const names = writeTree(root, 81);
  const env = { SIMPLE_SFTP_HASH_CACHE_DIR: cacheDir };
  const cold = runPython(__test.projectInventoryScript(), [root, ".", "1", "null"], env);
  assert.equal(cold.hashedFiles, 81, JSON.stringify(cold.unverifiedFiles));
  assert.equal(cold.reusedFiles, 0);
  const digests = Object.fromEntries(names.map((name) => [name, crypto.createHash("sha256").update(fs.readFileSync(path.join(root, name))).digest("hex")]));
  for (const name of names) assert.equal(cold.files[name].sha256, digests[name]);
  const warm = runPython(__test.projectInventoryScript(), [root, ".", "1", "null"], env);
  assert.equal(warm.reusedFiles, 81);
  for (const name of names) assert.equal(warm.files[name].sha256, digests[name]);
  const warmBatch = runPython(__test.batchFileHashScript(), [root, "2", "0.01"], env, Buffer.from(names.map((name) => `${name}\0`).join(""), "utf8"));
  assert.equal(warmBatch.digestReads, 0);
  assert.equal(warmBatch.cacheHits, 81);
  for (const name of names) assert.equal(warmBatch.files[name], digests[name]);
  const changed = names[7];
  const changedPath = path.join(root, changed);
  const preserved = fs.statSync(changedPath);
  fs.writeFileSync(changedPath, "payload-changed-same-length!");
  fs.utimesSync(changedPath, preserved.atime, preserved.mtime);
  const again = runPython(__test.projectInventoryScript(), [root, ".", "1", "null"], env);
  assert.equal(again.hashedFiles, 1);
  assert.equal(again.reusedFiles, 80);
  assert.equal(again.files[changed].sha256, crypto.createHash("sha256").update(fs.readFileSync(changedPath)).digest("hex"));
  assert.notEqual(again.files[changed].sha256, digests[changed]);
  const scope = runPython(__test.scopeInventoryScript(), [root, "batch", "1", "1", "2", "0.01"], env);
  assert.equal(scope.digestReads, 0);
  assert.equal(scope.files[changed].sha256, again.files[changed].sha256);
});

test("same-size restored mtime still rehashes when ctime changes and unsafe paths fail", () => {
  const root = path.join(fixtureRoot, "safety");
  const cacheDir = path.join(fixtureRoot, "cache-safety");
  fs.mkdirSync(path.join(root, "nested"), { recursive: true });
  fs.writeFileSync(path.join(root, "nested", "keep.bin"), "same-size-body");
  const env = { SIMPLE_SFTP_HASH_CACHE_DIR: cacheDir };
  const cold = runPython(__test.batchFileHashScript(), [root, "0.2", "0.01"], env, Buffer.from("nested/keep.bin\0missing.bin\0", "utf8"));
  assert.equal(cold.digestReads, 1);
  assert.equal(cold.files["missing.bin"], null);
  const warmed = crypto.createHash("sha256").update("same-size-body").digest("hex");
  assert.equal(cold.files["nested/keep.bin"], warmed);
  const target = path.join(root, "nested", "keep.bin");
  const stat = fs.statSync(target);
  fs.writeFileSync(target, "same-size-NEWb");
  const rewritten = fs.statSync(target);
  const identityUnchanged = rewritten.mtimeMs === stat.mtimeMs && rewritten.ctimeMs === stat.ctimeMs && rewritten.size === stat.size;
  if (identityUnchanged) {
    const dbPath = path.join(cacheDir, "project-inventory.sqlite3");
    const poisonFile = path.join(fixtureRoot, "poison-digest.py");
    fs.writeFileSync(poisonFile, "import sqlite3,sys\ndb=sqlite3.connect(sys.argv[1])\ndb.execute('UPDATE hashes SET sha256=?',('0'*64,))\ndb.commit()\n", "utf8");
    const poison = spawnSync(python, [poisonFile, dbPath], {
      encoding: "utf8", timeout: 10000, windowsHide: true,
    });
    assert.equal(poison.status, 0, poison.stderr);
  }
  const changed = runPython(__test.projectInventoryScript(), [root, ".", "1", "null"], env);
  assert.ok(changed.files["nested/keep.bin"], JSON.stringify(changed.unverifiedFiles));
  assert.equal(changed.files["nested/keep.bin"].sha256, crypto.createHash("sha256").update(fs.readFileSync(target)).digest("hex"));
  if (identityUnchanged) assert.equal(changed.reusedFiles, 1);
  else assert.equal(changed.hashedFiles, 1);
  assert.notEqual(changed.files["nested/keep.bin"].sha256, warmed);
  const link = path.join(root, "nested", "link.bin");
  try {
    fs.symlinkSync(target, link);
  } catch {
    return;
  }
  const batchFile = path.join(fixtureRoot, "batch-safety.py");
  fs.writeFileSync(batchFile, __test.batchFileHashScript(), "utf8");
  const linked = spawnSync(python, [batchFile, root, "0.2", "0.01"], {
    input: Buffer.from("nested/link.bin\0", "utf8"),
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  assert.notEqual(linked.status, 0);
  assert.match(`${linked.stderr}\n${linked.stdout}`, /symlink batch path/);
  const outside = spawnSync(python, [batchFile, root, "0.2", "0.01"], {
    input: Buffer.from("../outside.bin\0", "utf8"),
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  assert.notEqual(outside.status, 0);
  assert.match(`${outside.stderr}\n${outside.stdout}`, /unsafe batch path/);
});

test("signed sqlite integers keep all five identity fields compatible", () => {
  const root = path.join(fixtureRoot, "overflow");
  const cacheDir = path.join(fixtureRoot, "cache-overflow");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "wide.bin"), "wide");
  const env = { SIMPLE_SFTP_HASH_CACHE_DIR: cacheDir };
  const widened = [
    "import os",
    "real=os.stat",
    "class Wide:",
    " def __init__(self,value): self.value=value",
    " def __getattr__(self,name):",
    "  if name in ('st_dev','st_ino','st_ctime_ns'): return (1<<63)+7",
    "  return getattr(self.value,name)",
    "real_fstat=os.fstat",
    "os.stat=lambda *a,**k: Wide(real(*a,**k))",
    "os.lstat=os.stat",
    "os.fstat=lambda fd: Wide(real_fstat(fd))",
    __test.projectInventoryScript(),
  ].join("\n");
  const first = runPython(widened, [root, ".", "1", "null"], env);
  assert.equal(first.hashedFiles, 1);
  const second = runPython(widened, [root, ".", "1", "null"], env);
  assert.equal(second.reusedFiles, 1);
  assert.equal(second.files["wide.bin"].sha256, first.files["wide.bin"].sha256);
  const readFile = path.join(fixtureRoot, "read-identity.py");
  fs.writeFileSync(readFile, "import sqlite3,sys\nrow=sqlite3.connect(sys.argv[1]).execute('SELECT dev,ino,size,mtime_ns,ctime_ns FROM hashes').fetchone()\nprint(','.join(str(item) for item in row))\n", "utf8");
  const stored = spawnSync(python, [readFile, path.join(cacheDir, "project-inventory.sqlite3")], {
    encoding: "utf8", timeout: 10000, windowsHide: true,
  });
  assert.equal(stored.status, 0, stored.stderr);
  const parts = stored.stdout.trim().split(",").map((item) => BigInt(item));
  const signed = -((1n << 63n) - 7n);
  assert.equal(parts[0], signed);
  assert.equal(parts[1], signed);
  assert.equal(parts[4], signed);
  assert.equal(parts[2], 4n);
});

test("final lstat ctime-only change rejects a cached batch digest", () => {
  const root = path.join(fixtureRoot, "ctime-final");
  const cacheDir = path.join(fixtureRoot, "cache-ctime-final");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "keep.bin"), "cached-body");
  const env = { SIMPLE_SFTP_HASH_CACHE_DIR: cacheDir };
  const primed = runPython(__test.batchFileHashScript(), [root, "0.2", "0.01"], env, Buffer.from("keep.bin\0", "utf8"));
  assert.equal(primed.digestReads, 1);
  assert.equal(primed.files["keep.bin"], crypto.createHash("sha256").update("cached-body").digest("hex"));
  const shifted = [
    "import os",
    "real_lstat=os.lstat",
    "real_open=os.open",
    "opened={'n':0}",
    "class CtimeShift:",
    " def __init__(self,value): self.value=value",
    " def __getattr__(self,name):",
    "  if name=='st_ctime_ns': return self.value.st_ctime_ns+1",
    "  return getattr(self.value,name)",
    "def open_tracking(*args,**kwargs):",
    " opened['n']+=1",
    " return real_open(*args,**kwargs)",
    "def lstat_tracking(file,*args,**kwargs):",
    " value=real_lstat(file,*args,**kwargs)",
    " if opened['n'] and str(file).endswith('keep.bin'): return CtimeShift(value)",
    " return value",
    "os.open=open_tracking",
    "os.lstat=lstat_tracking",
    __test.batchFileHashScript(),
  ].join("\n");
  const checked = runPython(shifted, [root, "0.2", "0.01"], env, Buffer.from("keep.bin\0", "utf8"));
  assert.equal(checked.cacheHits, 0);
  assert.equal(checked.digestReads, 1);
  assert.equal(checked.files["keep.bin"], primed.files["keep.bin"]);
});

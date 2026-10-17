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
let lastStderr = "";

test("inventory publishes actual enumeration counts before hashing, including an empty directory", () => {
  const root = path.join(fixtureRoot, "scan-progress");
  const names = writeTree(root, 3);
  fs.mkdirSync(path.join(root, "empty"));
  const result = runPython(__test.projectInventoryScript(), [root, ".", "1", "null"], { SIMPLE_SFTP_HASH_CACHE_DIR: path.join(fixtureRoot,"cache-scan") });
  const reports = lastStderr.split('\n').filter(line => line.startsWith('SIMPLE_PROGRESS ')).map(line => JSON.parse(line.slice(16)));
  assert.equal(reports[0].phase, 'preparing');
  const scan = reports.filter(row => row.phase === 'preparing');
  assert.ok(scan.at(-1).processedFiles >= names.length + 2);
  assert.equal(scan.at(-1).processedBytes, undefined, 'directory enumeration is not a hash or network byte count');
  assert.equal(reports.at(-1).phase, 'hashing');
  assert.equal(Object.keys(result.files).length,names.length);
});

test('inventory directory and target metadata failures never masquerade as an empty file set',()=>{
 const root=path.join(fixtureRoot,'scan-error');writeTree(root,1);fs.mkdirSync(path.join(root,'hidden'));
 const injections=[
  ["def denied_walk(*args,**kwargs):", " kwargs.get('onerror',lambda error: None)(PermissionError('fixture enumeration denied'))", " return iter([])", "os.walk=denied_walk"],
  ["real_stat=os.stat", "def denied_stat(file,*args,**kwargs):", " if str(file).endswith('hidden'): raise PermissionError('fixture stat denied')", " return real_stat(file,*args,**kwargs)", "os.stat=denied_stat"]
 ];
 for(let i=0;i<injections.length;i++){
  const script='import os,json\n'+injections[i].join('\n')+'\ntry:\n'+__test.projectInventoryScript().split('\n').map(line=>' '+line).join('\n')+'\nexcept Exception as error:\n print(json.dumps({"error":str(error)}))\n';
  const result=runPython(script,[root,i?'hidden':'.','1','null'],{SIMPLE_SFTP_HASH_CACHE_DIR:path.join(fixtureRoot,'cache-scan-error-'+i)});
  assert.match(result.error,/fixture (enumeration|stat) denied/);assert.equal(result.files,undefined);
 }
});

test("interrupted inventory retains completed hash batches instead of starting cold again", () => {
  const root = path.join(fixtureRoot, "interrupted");
  const names = writeTree(root, 100);
  const cacheDir = path.join(fixtureRoot, "cache-interrupted");
  // Deterministic process interruption after 70 inspections, using completed Futures.
  const executor = [
    "from concurrent.futures import Future",
    "class InterruptedExecutor:",
    " def __init__(self,**kwargs): self.count=0",
    " def __enter__(self): return self",
    " def __exit__(self,*args): pass",
    " def invoke(self,fn,item):",
    "  self.count+=1",
    "  if self.count==70: os._exit(23)",
    "  return fn(item)",
    " def map(self,fn,items):",
    "  for item in items: yield self.invoke(fn,item)",
    " def submit(self,fn,item):",
    "  future=Future(); future.set_result(self.invoke(fn,item)); return future",
    "ThreadPoolExecutor=InterruptedExecutor",
  ].join("\n");
  const interrupted = __test.projectInventoryScript().replace("with ThreadPoolExecutor(max_workers=8) as pool:", `${executor}\nwith ThreadPoolExecutor(max_workers=8) as pool:`);
  const file = path.join(fixtureRoot, "interrupted.py");
  fs.writeFileSync(file, interrupted, "utf8");
  const run = spawnSync(python, ["-B", "-X", "utf8", file, root, ".", "1", "null"], {
    encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, SIMPLE_SFTP_HASH_CACHE_DIR: cacheDir },
  });
  assert.equal(run.status, 23, run.stderr);
  const resumed = runPython(__test.projectInventoryScript(), [root, ".", "1", "null"], { SIMPLE_SFTP_HASH_CACHE_DIR: cacheDir });
  assert.ok(resumed.reusedFiles >= 32 && resumed.reusedFiles < 70, `reused=${resumed.reusedFiles}, hashed=${resumed.hashedFiles}`);
  assert.equal(resumed.reusedFiles + resumed.hashedFiles, names.length);
  assert.equal(resumed.cacheStatus, "ready");
});

test("unavailable cache is observable while exact SHA256 remains available", () => {
  const root = path.join(fixtureRoot, "cache-unavailable");
  writeTree(root, 2);
  const blocker = path.join(fixtureRoot, "not-a-cache-directory");
  fs.writeFileSync(blocker, "keep", "utf8");
  const result = runPython(__test.projectInventoryScript(), [root, ".", "1", "null"], { SIMPLE_SFTP_HASH_CACHE_DIR: blocker });
  assert.equal(result.hashedFiles, 2); assert.equal(result.reusedFiles, 0);
  assert.equal(result.cacheStatus, "unavailable");
  const progress = lastStderr.split("\n").filter(line => line.startsWith("SIMPLE_PROGRESS ")).map(line => JSON.parse(line.slice(16)));
  assert.equal(progress.at(-1).cacheRehash, 2);
  assert.equal(progress.at(-1).cacheStatus, "unavailable");
});

test("interrupted exact-file verification also persists completed batches", () => {
  const root = path.join(fixtureRoot, "batch-interrupted");
  const names = writeTree(root, 100);
  const cacheDir = path.join(fixtureRoot, "cache-batch-interrupted");
  const script = __test.batchFileHashScript().replace("for raw in sys.stdin.buffer.read().split", [
    "original_remember=remember_hash",
    "def remember_hash(*args):",
    " original_remember(*args)",
    " if cache_rehash==70: os._exit(23)",
    "for raw in sys.stdin.buffer.read().split",
  ].join("\n"));
  const file = path.join(fixtureRoot, "batch-interrupted.py"); fs.writeFileSync(file, script, "utf8");
  const input = Buffer.from(names.map(name => `${name}\0`).join(""), "utf8");
  const run = spawnSync(python, ["-B", "-X", "utf8", file, root, "0.2", "0.01"], {
    input, encoding: "utf8", timeout: 10000, windowsHide: true, env: { ...process.env, SIMPLE_SFTP_HASH_CACHE_DIR: cacheDir },
  });
  assert.equal(run.status, 23, run.stderr);
  const resumed = runPython(__test.batchFileHashScript(), [root, "0.2", "0.01"], { SIMPLE_SFTP_HASH_CACHE_DIR: cacheDir }, input);
  assert.ok(resumed.cacheHits >= 64 && resumed.cacheHits < 70);
  assert.equal(resumed.cacheHits + resumed.cacheRehash, 100);
});

test("completed small files commit without waiting for the first slow weight", () => {
  const root = path.join(fixtureRoot, "unordered"); writeTree(root, 100);
  const script = ["import threading", "committed=threading.Event()", __test.projectInventoryScript()
    .replaceAll("db.commit()", "db.commit(); committed.set()")
    .replace("with ThreadPoolExecutor(max_workers=8) as pool:", [
      "original_inspect=inspect",
      "def inspect(item):",
      " if item[0].endswith('f000.bin'):",
      "  early=committed.wait(0.5)",
      "  sys.stderr.write('CACHE_WHILE_WEIGHT_PENDING '+str(early)+chr(10))",
      " return original_inspect(item)",
      "with ThreadPoolExecutor(max_workers=8) as pool:",
    ].join("\n"))].join("\n");
  const result = runPython(script, [root, ".", "1", "null"], { SIMPLE_SFTP_HASH_CACHE_DIR: path.join(fixtureRoot, "cache-unordered") });
  assert.equal(result.hashedFiles, 100); assert.match(lastStderr, /CACHE_WHILE_WEIGHT_PENDING True/);
});

test("failed cache writes are reported and do not change verified file hashes", () => {
  const root = path.join(fixtureRoot, "cache-write-failure"); writeTree(root, 40);
  const script = [
    "import sqlite3",
    "real_connect=sqlite3.connect",
    "class FailedWrites:",
    " def __init__(self,db): self.db=db",
    " def __getattr__(self,name): return getattr(self.db,name)",
    " def executemany(self,*args): raise sqlite3.OperationalError('disk full')",
    "sqlite3.connect=lambda *args,**kwargs: FailedWrites(real_connect(*args,**kwargs))",
    __test.projectInventoryScript(),
  ].join("\n");
  const result = runPython(script, [root, ".", "1", "null"], { SIMPLE_SFTP_HASH_CACHE_DIR: path.join(fixtureRoot, "cache-write-failure-db") });
  assert.equal(result.hashedFiles, 40); assert.equal(result.cacheStatus, 'write-failed');
  assert.equal(result.files['batch/f000.bin'].sha256, crypto.createHash('sha256').update('payload-0').digest('hex'));
});

function runPython(script, args, env, stdin) {
  const file = path.join(fixtureRoot, `run-${process.hrtime.bigint().toString()}.py`);
  fs.writeFileSync(file, script, "utf8");
  const run = spawnSync(python, ["-B", "-X", "utf8", file, ...args], {
    input: stdin,
    encoding: "utf8",
    timeout: 10000,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
  lastStderr = run.stderr;
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
  const telemetry = lastStderr.split("\n").filter(line => line.startsWith("SIMPLE_PROGRESS ")).map(line => JSON.parse(line.slice(16)));
  assert.ok(telemetry.length <= 4, "warm cache verification must not emit one event per file");
  assert.equal(telemetry.at(-1).processedFiles, 81);
  assert.equal(telemetry.at(-1).processedBytes, 0);
  for (const name of names) assert.equal(warmBatch.files[name].sha256, digests[name]);
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
  assert.equal(cold.files["nested/keep.bin"].sha256, warmed);
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

test("stdin scopes load only requested cached rows and preserve missing/empty scope semantics", () => {
  const root = path.join(fixtureRoot, "scope-stdin");
  const env = { SIMPLE_SFTP_HASH_CACHE_DIR: path.join(fixtureRoot, "cache-scope-stdin") };
  const names = writeTree(root, 120);
  runPython(__test.projectInventoryScript(), [root, ".", "1", "null"], env);
  const scoped = runPython(__test.projectInventoryScript(), [root, ".", "1", "@stdin"], env,
    Buffer.from([names[0], names[119], "batch/missing.bin"].join("\0") + "\0", "utf8"));
  assert.equal(scoped.cacheRows, 2);
  assert.equal(scoped.reusedFiles, 2);
  assert.equal(scoped.hashedFiles, 0);
  assert.deepEqual(Object.keys(scoped.files).sort(), [names[0], names[119]].sort());
  const empty = runPython(__test.projectInventoryScript(), [root, ".", "1", "@stdin"], env, Buffer.alloc(0));
  assert.deepEqual(empty.files, {});
  assert.equal(empty.cacheRows, 0);
});

test('exact inventory roots never enumerate unrelated ancestors, while directory scopes stay complete', () => {
  const root = path.join(fixtureRoot, 'direct-scopes');
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'one.py'), 'one', 'utf8');
  fs.writeFileSync(path.join(root, 'src', 'two.py'), 'two', 'utf8');
  fs.writeFileSync(path.join(root, 'results', 'keep.csv'), 'keep', 'utf8');
  const prefix = ["import os", "original_scandir=os.scandir", "def guarded_scan(target):",
    " if os.path.realpath(target)==os.path.realpath(os.sys.argv[1]): raise PermissionError('unrelated project root enumerated')",
    " return original_scandir(target)", "os.scandir=guarded_scan"].join('\n');
  const script = prefix + '\n' + __test.projectInventoryScript();
  const env = { SIMPLE_SFTP_HASH_CACHE_DIR: path.join(fixtureRoot, 'cache-direct-scopes') };
  const files = runPython(script, [root, '.', '1', '@stdin'], env, Buffer.from('src/one.py\0src/two.py\0src/missing.py\0'));
  assert.deepEqual(Object.keys(files.files).sort(), ['src/one.py', 'src/two.py']);
  assert.equal(files.unverifiedFiles && Object.keys(files.unverifiedFiles).length, 0);
  assert.equal(files.files['src/one.py'].sha256, crypto.createHash('sha256').update('one').digest('hex'));
  const directories = runPython(script, [root, '.', '1', '@stdin'], env, Buffer.from('src\0src/one.py\0results\0'));
  assert.deepEqual(Object.keys(directories.files).sort(), ['results/keep.csv', 'src/one.py', 'src/two.py']);
  const empty = runPython(script, [root, '.', '1', '@stdin'], env, Buffer.alloc(0));
  assert.deepEqual(empty.files, {});
});

test("final lstat ctime-only change rejects a cached batch digest", () => {
  const root = path.join(fixtureRoot, "ctime-final");
  const cacheDir = path.join(fixtureRoot, "cache-ctime-final");
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "keep.bin"), "cached-body");
  const env = { SIMPLE_SFTP_HASH_CACHE_DIR: cacheDir };
  const primed = runPython(__test.batchFileHashScript(), [root, "0.2", "0.01"], env, Buffer.from("keep.bin\0", "utf8"));
  assert.equal(primed.digestReads, 1);
  assert.equal(primed.files["keep.bin"].sha256, crypto.createHash("sha256").update("cached-body").digest("hex"));
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
  assert.deepEqual(checked.files["keep.bin"], primed.files["keep.bin"]);
});

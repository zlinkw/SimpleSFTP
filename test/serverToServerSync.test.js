const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  return request === "vscode" ? { TreeItem: class {} } : originalLoad.call(this, request, ...args);
};
const { __test } = require("../extension.js");
Module._load = originalLoad;

test("direct rsync scopes delete to one Plan directory", () => {
  const source = __test.directSyncTarget({ host: "nwpu2", user: "research", port: 2222, remotePath: "/projects/demo" }, "来源");
  const destination = __test.directSyncTarget({ host: "nwpu3", user: "research", port: 22, remotePath: "/projects/demo" }, "目标");
  const command = __test.directSyncCommand(source, destination, __test.directSyncRelativePath("work_dirs/corim"), true);
  assert.match(command, /rsync -a -c -s --delete-missing-args --delete/);
  assert.match(command, /rsync -n -i -a -c -s --delete-missing-args --delete/);
  assert.match(command, /内容校验不一致/);
  assert.match(command, /'\/projects\/demo\/work_dirs\/corim\/'/);
  assert.match(command, /'research@nwpu3:\/projects\/demo\/work_dirs\/corim\/'/);
  assert.doesNotMatch(command, /simple_cluster\/worker_mirrors/);
  assert.match(command, /realpath -m/);
  assert.match(command, /StrictHostKeyChecking=accept-new/);
  const deleteCommand = __test.directSyncCommand(source, destination, "work_dirs/old_run", true, true);
  assert.match(deleteCommand, /rm -rf --/);
  assert.match(deleteCommand, /cd --/);
  assert.match(deleteCommand, /\.\/old_run/);
  assert.doesNotMatch(deleteCommand, /rm -rf -- '\/projects\/demo\/work_dirs\/old_run'/);
  assert.match(deleteCommand, /test ! -e/);
  assert.doesNotMatch(deleteCommand, /rsync -a/);
});

test("single-endpoint delete is confined, requires two confirmations and exact path", async () => {
  const methods = __test.createLocalApiMethods();
  const target = { host: "worker", user: "research", remotePath: "/projects/demo" };
  assert.equal(typeof methods["sync.deletePath"], "function");
  await assert.rejects(methods["sync.deletePath"]({ target, relativePath: "results/a.bin" }),
    (error) => error.apiCode === 2001);
  await assert.rejects(methods["sync.deletePath"]({ target, relativePath: "results/a.bin", confirm: true, pathConfirmed: true,
    secondConfirmation: true, confirmedAbsolutePath: "/projects/demo/results/b.bin" }), (error) => error.apiCode === 2001);
  const command = __test.guardedRemoteDeleteCommand(__test.directSyncTarget(target, "目标"), "results/a.bin");
  assert.match(command, /cd -- "\$parent"/);
  assert.match(command, /PARENT_CD_FAILED/);
  assert.match(command, /rm -rf -- '\.\/a\.bin'/);
  assert.throws(() => __test.guardedRemoteDeleteCommand(__test.directSyncTarget(target, "目标"), "simple_cluster"), /机器状态/);
});

test("direct rsync rejects remote root escape", () => {
  assert.throws(() => __test.directSyncRelativePath("../other"));
  assert.throws(() => __test.directSyncTarget({ host: "nwpu2;true", user: "u", remotePath: "/project" }, "来源"));
  assert.throws(() => __test.directSyncTarget({ host: "nwpu2", user: "u", remotePath: "/" }, "来源"));
});

test("API requires both confirmations before starting a direct transfer", async () => {
  const method = __test.createLocalApiMethods()["sync.serverToServer"];
  await assert.rejects(method({
    source: { host: "nwpu2", user: "research", remotePath: "/projects/demo" },
    destination: { host: "nwpu3", user: "research", remotePath: "/projects/demo" },
    relativePath: "work_dirs/corim", directory: true,
  }), (error) => error.apiCode === 2001 && error.message === "CONFIRM_REQUIRED");
});

test("Plan log inventory includes scheduler and every job log without unrelated paths", () => {
  const paths = __test.planLogPathsFromState({
    plan: "experiments/plans/demo.yaml",
    scheduler_log: "simple_cluster/tmp/cluster_scheduler/run-1.log",
    completed_experiments: [{ log_path: "simple_cluster/tmp/cluster_scheduler/logs/job-1.log" }],
    failed_experiments: [{ log_path: "tmp/tmux_logs/job-2.log" }],
  }, "experiments/plans/demo.yaml");
  assert.deepEqual(paths, [
    "simple_cluster/tmp/cluster_scheduler/logs/job-1.log",
    "simple_cluster/tmp/cluster_scheduler/run-1.log",
    "tmp/tmux_logs/job-2.log",
  ]);
  assert.throws(() => __test.planLogPathsFromState({ plan: "other.yaml" }, "experiments/plans/demo.yaml"), /不匹配/);
  assert.throws(() => __test.planLogPathsFromState({ plan: "experiments/plans/demo.yaml", scheduler_log: "../../private" }, "experiments/plans/demo.yaml"), /不安全/);
});

test("project batch transfer validates exact paths and requires confirmation", async () => {
  const methods = __test.createLocalApiMethods();
  const destination = __test.directSyncTarget({ host: "nwpu3", user: "research", remotePath: "/projects/demo" }, "目标");
  assert.match(__test.batchDestinationGuardCommand(destination), /^ssh -n /);
  const params = {
    source: { host: "source", user: "research", remotePath: "/projects/demo" },
    destination: { host: "target", user: "research", remotePath: "/projects/demo" },
    relativePaths: ["datasets/a.bin"],
  };
  assert.equal(typeof methods["sync.projectInventory"], "function");
  await assert.rejects(methods["sync.serverToServerBatch"](params), (error) => error.apiCode === 2001);
  await assert.rejects(methods["sync.serverToServerBatch"]({ ...params, relativePaths: ["../outside"] }), /不安全/);
});

test("Worker scope tree lists every file type while excluding machine state", () => {
  const methods = __test.createLocalApiMethods();
  assert.equal(typeof methods["sync.projectTree"], "function");
  assert.equal(__test.projectTreePathAllowed("datasets/raw/image.dcm"), true);
  assert.equal(__test.projectTreePathAllowed("work_dirs/p/weight.safetensors"), true);
  assert.equal(__test.projectTreePathAllowed("simple_cluster/results/p/log.txt"), true);
  assert.equal(__test.projectTreePathAllowed("simple_cluster/tmp/cluster_scheduler/queue_state.json"), false);
  assert.equal(__test.projectTreePathAllowed("simple_cluster/results/project_mirror_state.json"), false);
  assert.equal(__test.projectTreePathAllowed(".venv/lib/module.py"), false);
  assert.equal(__test.projectTreePathAllowed(".runtime/state.json"), false);
  assert.equal(__test.projectTreePathAllowed("clean_dir/archive.bin"), false);
  assert.equal(__test.projectTreePathAllowed("tmp/live.log"), false);
  assert.equal(__test.projectTreePathAllowed("experiments/results/formal/final.csv.lock"), false);
  assert.equal(__test.projectTreePathAllowed("work_dirs/corim/.tb_mean.lock"), false);
  assert.equal(__test.projectTreePathAllowed("poetry.lock"), true);
});

test("inventory keeps stable hashes when another file changes during hashing", () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), "simple-sftp-inventory-"));
  try {
    const root = path.join(parent, "project");
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, "steady.bin"), "stable");
    fs.writeFileSync(path.join(root, "volatile.bin"), "changing");
    fs.mkdirSync(path.join(root, "code"));
    fs.writeFileSync(path.join(root, "code", "nested.py"), "nested");
    const prefix = [
      "import os,sqlite3",
      "real_stat=os.stat",
      "class ChangedStat:",
      " def __init__(self,value): self.value=value",
      " def __getattr__(self,name):",
      "  if name=='st_ctime_ns': return self.value.st_ctime_ns+1",
      "  return getattr(self.value,name)",
      "def changing_stat(file,*args,**kwargs):",
      " value=real_stat(file,*args,**kwargs)",
      " return ChangedStat(value) if str(file).endswith('volatile.bin') and kwargs.get('follow_symlinks') is False else value",
      "os.stat=changing_stat",
      "def no_cache(*args,**kwargs): raise sqlite3.OperationalError('test cache disabled')",
      "sqlite3.connect=no_cache",
    ].join("\n");
    const script = path.join(parent, "inventory.py");
    fs.writeFileSync(script, prefix + "\n" + __test.projectInventoryScript(), "utf8");
    const python = process.platform === "win32" ? "python" : "python3";
    const run = spawnSync(python, [script, root, ".", "1"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.files["steady.bin"].sha256.length, 64);
    assert.equal(result.files["volatile.bin"], undefined);
    assert.match(result.unverifiedFiles["volatile.bin"], /变化/);
    const shallow = spawnSync(python, [script, root, ".", "0"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(shallow.status, 0, shallow.stderr);
    const shallowResult = JSON.parse(shallow.stdout);
    assert.equal(shallowResult.files["steady.bin"].sha256.length, 64);
    assert.equal(shallowResult.files["code"], undefined);
    assert.equal(shallowResult.unverifiedFiles["code"], undefined);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

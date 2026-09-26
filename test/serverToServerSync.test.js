const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  return request === "vscode" ? {
    TreeItem: class {},
    ProgressLocation: { Notification: 1 },
    window: { withProgress: (_options, operation) => operation({ report: () => undefined }) },
  } : originalLoad.call(this, request, ...args);
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
  assert.match(command, /'research@nwpu3:\.\/corim\/'/);
  assert.match(command, /--rsync-path=.*cd -- "\$parent"/);
  assert.doesNotMatch(command, /simple_cluster\/worker_mirrors/);
  assert.match(command, /realpath -m/);
  assert.match(command, /StrictHostKeyChecking=accept-new/);
  const deleteCommand = __test.guardedRemoteDeleteCommand(destination, "work_dirs/old_run");
  assert.match(deleteCommand, /rsync -r --delete -- "\$empty\/" '\.\/old_run\/'/);
  assert.match(deleteCommand, /rmdir -- '\.\/old_run'/);
  assert.match(deleteCommand, /rm -f -- '\.\/old_run'/);
  assert.match(deleteCommand, /mktemp -d -- '\.\/\.simple-sftp-empty\.XXXXXXXX'/);
  assert.match(deleteCommand, /trap 'rmdir -- "\$empty"/);
  assert.match(deleteCommand, /cd --/);
  assert.match(deleteCommand, /\.\/old_run/);
  assert.doesNotMatch(deleteCommand, /rm -rf --/);
  assert.doesNotMatch(deleteCommand, /(?:rm|rmdir) -[rf]+ -- '\/projects\//);
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
  assert.match(command, /rsync -r --delete/);
  assert.match(command, /rm -f -- '\.\/a\.bin'/);
  assert.throws(() => __test.guardedRemoteDeleteCommand(__test.directSyncTarget(target, "目标"), "simple_cluster"), /机器状态/);
});

test("local staging cleanup rejects paths outside its verified temporary root", () => {
  assert.throws(() => __test.removeLocalStagingDirectory(process.cwd()), /暂存根目录/);
  const source = fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8");
  const section = source.slice(source.indexOf("function removeLocalStagingDirectory("), source.indexOf("async function deleteProjectPath("));
  assert.match(section, /Set-Location -LiteralPath/);
  assert.match(section, /Remove-Item -LiteralPath/);
  assert.match(section, /rm -rf -- "\.\/\$3"/);
  assert.doesNotMatch(section, /fs\.rmSync/);
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

test("partitioned packed transfer groups small files and blocks unconfirmed writes", async () => {
  const one = __test.partitionTransferPaths(["runs/1.log"]);
  const thirtyThree = __test.partitionTransferPaths(Array.from({ length: 33 }, (_, i) => `runs/${i}.log`));
  const threeFiftyFive = __test.partitionTransferPaths(Array.from({ length: 355 }, (_, i) => `runs/${i}.log`));
  const twoThousand = __test.partitionTransferPaths(Array.from({ length: 2001 }, (_, i) => `runs/${i}.log`));
  assert.deepEqual(one.map((group) => group.length), [1]);
  assert.deepEqual(thirtyThree.map((group) => group.length), [33]);
  assert.deepEqual(threeFiftyFive.map((group) => group.length), [89, 89, 89, 88]);
  assert.deepEqual(twoThousand.map((group) => group.length), [501, 501, 501, 498]);
  assert.equal(twoThousand.reduce((sum, group) => sum + group.length, 0), 2001);
  assert.equal(twoThousand.some((group) => !group.length), false);
  const direct = __test.directTarBatchCommand(
    __test.directSyncTarget({ host: "source", user: "research", remotePath: "/projects/demo" }, "来源"),
    __test.directSyncTarget({ host: "target", user: "research", remotePath: "/projects/demo" }, "目标"),
  );
  assert.match(direct, /bash -o pipefail -c/);
  assert.match(direct, /tar --null -T - -cf -/);
  assert.match(direct, /tar -xf -/);
  assert.doesNotMatch(direct, /--delete|rm -/);
  const method = __test.createLocalApiMethods()["sync.serverToServerFpsync"];
  const params = {
    source: { host: "source", user: "research", remotePath: "/projects/demo" },
    destination: { host: "target", user: "research", remotePath: "/projects/demo" },
    relativePaths: ["runs/1.log", "runs/2.log"],
  };
  assert.equal(typeof method, "function");
  await assert.rejects(method(params), (error) => error.apiCode === 2001);
  await assert.rejects(method({ ...params, relativePaths: ["../outside"] }), /不安全/);
});

test("Worker sync notification names the task and falls back to exact file context", () => {
  const title = __test.fpsyncProgressTitle({
    taskLabel: "Plan 产物同步 · plans/drf.yaml · nwpu2 → nwpu3 · 批次 2/3",
  });
  assert.match(title, /plans\/drf\.yaml/);
  assert.match(title, /nwpu2 → nwpu3/);
  assert.match(title, /批次 2\/3/);
  assert.equal(title.includes("Worker 间分批打包同步"), false);
  const fallback = __test.fpsyncProgressTitle({
    source: { id: "nwpu2" }, destination: { id: "nwpu3" }, relativePaths: ["results/drf.csv"],
  });
  assert.match(fallback, /nwpu2 → nwpu3/);
  assert.match(fallback, /results\/drf\.csv/);
  const hidden = __test.fpsyncProgressTitle({ taskLabel: "token=abc Bearer secret" });
  assert.doesNotMatch(hidden, /abc|secret$/);
  const source = fs.readFileSync(path.join(__dirname, "../extension.js"), "utf8");
  const body = source.slice(source.indexOf("async function syncServerToServerFpsyncCore("), source.indexOf("async function syncFromRemoteCore("));
  assert.match(body, /清单：比对.*哈希/);
  assert.match(body, /正在流处理（打包、传输与解包）/);
  assert.match(body, /校验目标 Worker/);
  assert.match(body, /SHA256 校验通过/);
  assert.match(body, /清单 \$\{timing\.inventoryMs\} ms/);
  assert.match(body, /流处理 \$\{timing\.streamMs\} ms/);
  assert.match(body, /校验 \$\{timing\.verifyMs\} ms/);
  assert.doesNotMatch(body, /准备打包/);
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
      "seen={}",
      "def changing_stat(file,*args,**kwargs):",
      " value=real_stat(file,*args,**kwargs)",
      " key=str(file)",
      " if key.endswith('volatile.bin') and kwargs.get('follow_symlinks') is False:",
      "  seen[key]=seen.get(key,0)+1",
      "  if seen[key]==1: return ChangedStat(value)",
      " return value",
      "os.stat=changing_stat",
      "os.lstat=lambda file,*args,**kwargs: changing_stat(file,follow_symlinks=False)",
      "def no_cache(*args,**kwargs): raise sqlite3.OperationalError('test cache disabled')",
      "sqlite3.connect=no_cache",
    ].join("\n");
    const script = path.join(parent, "inventory.py");
    fs.writeFileSync(script, prefix + "\n" + __test.projectInventoryScript(), "utf8");
    const python = process.platform === "win32" ? "python" : "python3";
    const run = spawnSync(python, [script, root, ".", "1"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout);
    assert.equal(result.files["steady.bin"] && result.files["steady.bin"].sha256.length, 64, JSON.stringify(result));
    assert.equal(result.files["volatile.bin"], undefined);
    assert.match(result.unverifiedFiles["volatile.bin"], /变化/);
    const shallow = spawnSync(python, [script, root, ".", "0"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(shallow.status, 0, shallow.stderr);
    const shallowResult = JSON.parse(shallow.stdout);
    assert.equal(shallowResult.files["steady.bin"].sha256.length, 64);
    assert.equal(shallowResult.files["code"], undefined);
    assert.equal(shallowResult.unverifiedFiles["code"], undefined);
    const exact = spawnSync(python, [script, root, "steady.bin", "0"], { encoding: "utf8", timeout: 10000, windowsHide: true });
    assert.equal(exact.status, 0, exact.stderr);
    assert.deepEqual(Object.keys(JSON.parse(exact.stdout).files), ["steady.bin"]);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

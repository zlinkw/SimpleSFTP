const assert = require("node:assert/strict");
const test = require("node:test");
const Module = require("node:module");
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
  assert.match(deleteCommand, /test ! -e/);
  assert.doesNotMatch(deleteCommand, /rsync -a/);
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
});

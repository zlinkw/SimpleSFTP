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
  assert.match(command, /rsync -a -s --delete-missing-args --delete/);
  assert.match(command, /'\/projects\/demo\/work_dirs\/corim\/'/);
  assert.match(command, /'research@nwpu3:\/projects\/demo\/work_dirs\/corim\/'/);
  assert.doesNotMatch(command, /simple_cluster\/worker_mirrors/);
  assert.match(command, /realpath -m/);
  const deleteCommand = __test.directSyncCommand(source, destination, "work_dirs/old_run", true, true);
  assert.match(deleteCommand, /rm -rf --/);
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

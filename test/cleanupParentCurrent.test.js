"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");
const { CleanupFileApi } = require("../cleanup-file-api.js");

test("missing targets keep their type and empty-parent review checks current facts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-parent-current-"));
  const result = spawnSync("python", ["-B", "-X", "utf8", path.join(__dirname, "cleanupVerifyAbsent.fixture.py"), root],
    { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).targets, [{ relativePath: "missing", type: "file", status: "gone" }]);
});

test("parent execution binds its receipt to the preview operation", async () => {
  const row = { token: "t", operationId: "op", digest: "d", confirmations: 2, node: { root: "/project" },
    rootIdentity: { root: "/project" }, targets: [{ relativePath: "parent" }], destinations: [], states: ["pending"], expiresAt: Date.now() + 60000 };
  const api = new CleanupFileApi({ storageRoot: "unused", activity: async () => ({}), lease: async (_node, _targets, run) => run(),
    transport: async request => {
      assert.equal(request.operationId, "op");
      return { ok: true, state: "completed", rootIdentity: row.rootIdentity, receipt: { operationId: request.operationId, action: "prune-isolation-parents", phase: "completed" } };
    } });
  api.save = async () => {};
  const result = await api.executeIsolationParents(row, { index: 0, digest: "d" });
  assert.equal(result.receipt.operationId, "op");
});

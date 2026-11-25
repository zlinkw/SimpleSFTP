"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
const { spawnSync } = require("node:child_process");

test("missing targets keep their type and empty-parent review checks current facts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cleanup-parent-current-"));
  const result = spawnSync("python", ["-B", "-X", "utf8", path.join(__dirname, "cleanupVerifyAbsent.fixture.py"), root],
    { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout).targets, [{ relativePath: "missing", type: "file", status: "gone" }]);
});

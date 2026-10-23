const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const zlib = require("node:zlib");
const { spawnSync } = require("node:child_process");

const identity = "11".repeat(32);
const generation = "c3".repeat(32);

test("staged slots keep two generations end to end: preview, fail-closed third, confirmed executor, landing", () => {
  const nativeFiles = [path.join(__dirname, "stagedSlotLifecycle.fixture.py"),
    path.resolve(__dirname, "../staged-tar-receive.py"), path.resolve(__dirname, "../cleanup-files.py")];
  const distro = process.env.SIMPLE_TEST_WSL_DISTRO || "Ubuntu-Codex";
  const files = process.platform === "win32" ? nativeFiles.map(file => {
    const resolved = spawnSync("wsl.exe", ["--distribution", distro, "--exec", "wslpath", "-a", file],
      { encoding: "utf8", timeout: 5000, windowsHide: true });
    assert.equal(resolved.status, 0, resolved.stderr || resolved.error?.message);
    return resolved.stdout.trim();
  }) : nativeFiles;
  const argv = ["-B", "-X", "utf8", ...files];
  const run = process.platform === "win32"
    ? spawnSync("wsl.exe", ["--distribution", distro, "--exec", "python3", ...argv],
      { encoding: "utf8", timeout: 10000, windowsHide: true })
    : spawnSync("python3", argv, { encoding: "utf8", timeout: 10000, windowsHide: true });
  assert.equal(run.status, 0, (run.stderr || run.stdout || "").slice(-3000));
  assert.deepEqual(JSON.parse(run.stdout.trim().split("\n").pop()),
    { ok: true, pendingBlocked: true, leaving: "simple_cluster/.simple-sftp-staging/d-" + "1".repeat(24) + "/0", thirdGenerationLanded: true });
});

// The extension-side production request builder must encode the SAME read-only protocol the
// receiver just executed: inventory omits generation; admission carries the incoming one.
const Module = require("node:module");
const originalLoad = Module._load;
Module._load = function (request, ...args) {
  return request === "vscode" ? {
    TreeItem: class {},
    ProgressLocation: { Notification: 1 },
    window: { withProgress: (_options, operation) => operation({ report: () => undefined }), showErrorMessage: () => undefined },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
  } : originalLoad.call(this, request, ...args);
};
const { __test } = require("../extension.js");
Module._load = originalLoad;

function requestPayload(command) {
  const quoted = /'([A-Za-z0-9+/=]+)'$/.exec(command);
  assert.ok(quoted, command.slice(-200));
  return JSON.parse(zlib.inflateRawSync(Buffer.from(quoted[1], "base64")).toString("utf8"));
}

test("staged slot stale-report commands carry stable logicalKey and only the incoming generation", () => {
  const target = { remotePath: "/srv/project" };
  const inventory = requestPayload(__test.stagedSlotStaleReportCommand(target, identity));
  assert.deepEqual(inventory, { mode: "staleReport", root: "/srv/project", identity });
  const admission = requestPayload(__test.stagedSlotStaleReportCommand(target, identity, generation));
  assert.deepEqual(admission, { mode: "staleReport", root: "/srv/project", identity, generation });
});

test("production archive builder keeps the scope across changed selections and run retries", () => {
  const target = { remotePath: "/srv/project" };
  const files = { "out/a": { sha256: "a".repeat(64), size: 1 },
    "out/b": { sha256: "b".repeat(64), size: 1 } };
  const build = (key, run, paths, extra = {}) => requestPayload(__test.stagedTarUnpackingCommand(
    target, "none", { retentionKey: key, generation: run, ...extra }, files, paths));
  const first = build("plans/a.yaml|task-0", "run-1", ["out/a"]);
  const retry = build("plans/a.yaml|task-0", "run-1", ["out/b"]);
  const next = build("plans/a.yaml|task-0", "run-2", ["out/a", "out/b"]);
  const other = build("plans/b.yaml|task-0", "run-1", ["out/a"]);
  assert.equal(first.identity, retry.identity);
  assert.equal(first.identity, next.identity);
  assert.equal(first.generation, retry.generation);
  assert.notEqual(first.generation, next.generation);
  assert.notEqual(first.identity, other.identity);
  assert.notEqual(first.identity, build("plans/a.yaml|task-0", "run-1", ["out/a"], { stagingLane: 1 }).identity);
  // The two lanes are fixed; arbitrarily many archive partitions never open additional pools.
  assert.equal(first.identity, build("plans/a.yaml|task-0", "run-1", ["out/b"], { stagingLane: 99 }).identity);
});

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  HOST_OPERATION_LEASE_SCHEMA_VERSION,
  HostOperationLeaseConflictError,
  HostOperationLeaseManager,
  defaultHostOperationLeasePath,
  parseHostOperationLeaseRecord,
} = require("../host-operation-lease.js");

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "simple-host-lease-sftp-"));
  const leasePath = path.join(root, "host-operation-lease.json");
  const manager = (windowId, options = {}) => new HostOperationLeaseManager({ leasePath, windowId, ttlMs: 160, heartbeatMs: 30, ...options });
  const input = (pluginId = "simple-local.simple-sftp", actionType = "upload-workspace") => ({
    pluginId,
    workspaceUri: "vscode-remote://dev-container/workspaces/MCP/demo",
    hostProjectPath: "D:\\GitRepo\\MCP\\demo",
    actionType,
    actionLabel: actionType,
  });
  return { root, leasePath, manager, input, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

test("SimpleSFTP uses the shared SimpleExperiment lease path and schema", () => {
  assert.equal(HOST_OPERATION_LEASE_SCHEMA_VERSION, 1);
  assert.equal(defaultHostOperationLeasePath("C:\\Users\\demo\\AppData\\Local"), "C:\\Users\\demo\\AppData\\Local\\SimpleExperiment\\host-operation-lease.json");
});

test("two windows cannot create the same lease", async () => {
  const f = fixture();
  try {
    const [first, second] = await Promise.allSettled([
      f.manager("window-a").acquire(f.input()),
      f.manager("window-b").acquire(f.input("simple-local.simple-experiment", "run-plan")),
    ]);
    const ok = [first, second].filter((item) => item.status === "fulfilled");
    const failed = [first, second].filter((item) => item.status === "rejected");
    assert.equal(ok.length, 1);
    assert.equal(failed.length, 1);
    assert.ok(failed[0].reason instanceof HostOperationLeaseConflictError);
    assert.match(failed[0].reason.message, /持有窗口：window-[ab]/);
    await ok[0].value.release();
  } finally {
    f.cleanup();
  }
});

test("heartbeat keeps the shared lease alive", async () => {
  const f = fixture();
  try {
    const holder = await f.manager("window-a", { ttlMs: 120, heartbeatMs: 20 }).acquire(f.input());
    await new Promise((resolve) => setTimeout(resolve, 190));
    const record = parseHostOperationLeaseRecord(fs.readFileSync(f.leasePath, "utf8"));
    assert.ok(Date.parse(record.expiresAt) > Date.now());
    await assert.rejects(f.manager("window-b", { ttlMs: 120 }).acquire(f.input()), HostOperationLeaseConflictError);
    await holder.release();
  } finally {
    f.cleanup();
  }
});

test("heartbeat renewal never exposes partial lease JSON", async () => {
  const f = fixture();
  try {
    const holder = await f.manager("window-a", { ttlMs: 120, heartbeatMs: 5 }).acquire(f.input());
    for (let index = 0; index < 40; index += 1) {
      const record = parseHostOperationLeaseRecord(fs.readFileSync(f.leasePath, "utf8"));
      assert.ok(record, `invalid lease record at iteration ${index}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await holder.release();
  } finally {
    f.cleanup();
  }
});

test("expired lease can be taken over after a crashed window", async () => {
  const f = fixture();
  try {
    await f.manager("crashed-window", { ttlMs: 100, heartbeatMs: 0 }).acquire(f.input());
    await new Promise((resolve) => setTimeout(resolve, 130));
    const replacement = await f.manager("replacement-window").acquire(f.input("simple-local.simple-experiment", "run-plan"));
    assert.equal(replacement.record.windowId, "replacement-window");
    await replacement.release();
  } finally {
    f.cleanup();
  }
});

test("same window allows nested SimpleExperiment and SimpleSFTP operations", async () => {
  const f = fixture();
  try {
    const outer = await f.manager("shared-window").acquire(f.input());
    const inner = await f.manager("shared-window").acquire(f.input("simple-local.simple-experiment", "run-plan"));
    assert.equal(inner.record.leaseId, outer.record.leaseId);
    await outer.release();
    await assert.rejects(f.manager("other-window").acquire(f.input()), HostOperationLeaseConflictError);
    await inner.release();
    const next = await f.manager("other-window").acquire(f.input());
    await next.release();
  } finally {
    f.cleanup();
  }
});

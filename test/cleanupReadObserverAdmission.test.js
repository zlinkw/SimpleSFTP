const test = require("node:test"), assert = require("node:assert/strict"), path = require("node:path"), Module = require("node:module");
// 真实 B 注册/进度封装 → 真实守卫投影 → 真实 API 封套：只读观测不得互相对撞，真实写入继续互斥。
const loadStub = () => { const original = Module._load; Module._load = function (name, ...rest) {
  if (name === "vscode") return { TreeItem: class {}, ProgressLocation: { Notification: 1 },
    workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_k, d) => d }), onDidChangeWorkspaceFolders: () => ({ dispose() {} }) },
    window: { showInformationMessage: async () => undefined, showWarningMessage: async () => undefined, showErrorMessage: async () => undefined,
      createStatusBarItem: () => ({ command: "", tooltip: "", text: "", show() {}, hide() {}, dispose() {}, setDecoration() {} }),
      withProgress: async (_o, work) => work({ report() {} }, { onDidRequestCancel: () => ({ dispose() {} }) }),
      activeTextEditor: undefined, onDidChangeActiveTextEditor: () => ({ dispose() {} }) },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: async () => undefined }, env: { openExternal: async () => true },
    Uri: { file: p => ({ fsPath: p }), parse: s => ({ toString: () => s }) },
    EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} },
    Disposable: class { static from() { return { dispose() {} } } dispose() {} },
    languages: { createDiagnosticCollection: () => ({ set() {}, clear() {}, dispose() {} }) },
    Range: class {}, Position: class {}, ThemeIcon: class {}, StatusBarAlignment: { Left: 1, Right: 2 }, ViewColumn: { One: 1 }, ExtensionMode: { Development: 2, Production: 1 } };
  return original.call(this, name, ...rest); }; return () => { Module._load = original; }; };
const restore = loadStub();
const { __test } = require("../extension.js");
restore();
const { fail, busyEvidence, transferBusySnapshot } = require("../cleanup-file-api.js");

const settle = () => new Promise(resolve => setImmediate(resolve));
const harness = (cleanupApi = {}) => {
  __test.setTransferSettlementTestContext({ cleanupApi, globalState: { get: (_k, d) => d, update: async () => {} }, instanceId: "read-observer-test" });
  return __test.createLocalApiMethods();
};
// 观测统一走只读 transfers.list 路由：它与清理守卫共用同一份投影（本文件最后一项断言证明这点），
// 因此断言的值就是守卫当场会看到的值，同时不依赖仅测试可用的导出。
const busyNow = async () => await __test.createLocalApiMethods()["transfers.list"]().then(value => value.busy);
const flags = snap => snap.activeTransfers.map(row => row.operation + ":" + (row.readOnlyObserver ? "read" : "write"));

test("单条只读清理预览不再把自己算成忙（真实路由注册 + 真实守卫投影）", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const methods = harness({ preview: async () => { await gate; return { ok: true }; } });
  const running = methods["files.cleanup.preview"]({ localPath: "/fixture/root", targets: [{ path: "a" }] });
  await settle();
  const snap = await busyNow();
  assert.equal(snap.busy, false, "清理预览不得因为自己正在跑而拒绝自己");
  assert.equal(snap.activeTransferCount, 1, "预览本身确实注册在途");
  assert.equal(snap.observerTransferCount, 1);
  assert.equal(snap.blockingTransferCount, 0);
  release(); await running;
});

test("巡检与预览彼此在途时不得互相拒绝（复刻 09:04 生产快照的 inspect+preview 组合）", async () => {
  let releaseInspect;
  const inspectGate = new Promise(resolve => { releaseInspect = resolve; });
  const methods = harness({
    inspect: async () => { await inspectGate; return { ok: true }; },
    preview: async () => { const snap = await busyNow(); return { busy: snap.busy, blocking: snap.blockingTransferCount, observer: snap.observerTransferCount, rows: flags(snap) }; },
  });
  const inspecting = methods["files.cleanup.inspect"]({ localPath: "/fixture/a", host: "node-a", node: { host: "node-a", port: 22 } });
  await settle();
  const observed = await methods["files.cleanup.preview"]({ localPath: "/fixture/b", host: "node-b", node: { host: "node-b", port: 22 } });
  releaseInspect(); await inspecting;
  assert.equal(observed.busy, false, "只读巡检不得把只读预览挡在门外");
  assert.equal(observed.blocking, 0, "没有任何写入时阻断数必须为 0");
  assert.equal(observed.observer, 2, "巡检与预览两条只读观测都要留在证据里");
  assert.deepEqual(observed.rows, ["files.cleanup.inspect:read", "files.cleanup.preview:read"]);
});

test("真实代码清单读取（sync.projectInventory）是只读观测，不阻断清理准入", async () => {
  let release;
  const parked = new Promise(resolve => { release = () => resolve(JSON.stringify({ files: {} })); });
  __test.setRemoteBatchTransport(async () => parked);
  const methods = harness({});
  const running = methods["sync.projectInventory"]({ source: { host: "inventory.invalid", username: "u", remotePath: "/fixture" }, scopePaths: ["work_dirs"], inventoryPurpose: "code-sync" });
  await settle();
  const snap = await busyNow();
  assert.deepEqual(flags(snap), ["sync.projectInventory:read"]);
  assert.equal(snap.busy, false, "只读代码清单不得把清理挡在门外");
  release(); await running;
  __test.setRemoteBatchTransport(null);
});

test("真实写入仍然互斥：上传、清理 execute、未证明身份的传输一律计忙", async () => {
  harness({});
  const upload = __test.createTransferController({ id: "upload.workspace#1", operation: "upload.workspace", localPath: "/f", remotePath: "/r", host: "h", remoteMutation: true });
  assert.equal((await busyNow()).busy, true, "上传写入必须计忙");
  assert.deepEqual(flags(await busyNow()), ["upload.workspace:write"]);
  upload.finish && upload.finish("completed");
  __test.setTransferSettlementTestContext({ cleanupApi: {}, globalState: { get: (_k, d) => d, update: async () => {} }, instanceId: "read-observer-test" });
  const exec = __test.createTransferController({ id: "files.cleanup.execute#1", operation: "files.cleanup.execute", localPath: "/f", remotePath: "/r", host: "h" });
  assert.equal((await busyNow()).busy, true, "清理执行会删文件，绝不能按名字放行");
  exec.finish && exec.finish("completed");
  __test.setTransferSettlementTestContext({ cleanupApi: {}, globalState: { get: (_k, d) => d, update: async () => {} }, instanceId: "read-observer-test" });
  const lying = __test.createTransferController({ id: "upload.files#2", operation: "upload.files", localPath: "/f", remotePath: "/r", host: "h", readObserver: true, remoteMutation: true });
  assert.equal((await busyNow()).busy, true, "远端变更不得自称只读");
  lying.finish && lying.finish("completed");
});

test("缺只读标记、null 行与异常标记一律按写入处理（fail closed）", () => {
  const snapshot = transferBusySnapshot({ transfers: [null, { id: "x", status: "running" }, { id: "y", status: "running", readObserver: new Boolean(true), remoteMutation: false },
    { id: "z", status: "running", readObserver: true, remoteMutation: undefined }, { id: "ok", status: "running", readObserver: true, remoteMutation: false }], uploadOperations: [], uploadQueueKeys: [] }, {});
  assert.equal(snapshot.activeTransferCount, 5);
  assert.equal(snapshot.observerTransferCount, 1, "只有布尔 true 且明确非远端变更才算只读观测");
  assert.equal(snapshot.blockingTransferCount, 4);
  assert.equal(snapshot.busy, true);
  const onlyObservers = transferBusySnapshot({ transfers: [{ id: "ok", status: "running", readObserver: true, remoteMutation: false }], uploadOperations: [], uploadQueueKeys: [] }, {});
  assert.equal(onlyObservers.busy, false);
  const terminal = transferBusySnapshot({ transfers: [{ id: "done", status: "completed", readObserver: true, remoteMutation: false }], uploadOperations: [], uploadQueueKeys: [] }, {});
  assert.equal(terminal.busy, false, "终态行不计数（与 0.2.102 一致）");
});

test("拒绝瞬间的封套携带只读标记与阻断计数，schemaVersion 不符不得进入封套", async () => {
  harness({});
  __test.createTransferController({ id: "upload.files#3", operation: "upload.files", localPath: "/f", remotePath: "/r", host: "h", remoteMutation: true });
  const projection = await busyNow();
  const error = (() => { try { fail("ACTIVE_TRANSFER", "ACTIVE_TRANSFER", { busy: projection }); } catch (reason) { return reason; } })();
  assert.equal(error.code, "ACTIVE_TRANSFER");
  assert.equal(error.apiData.busy.blockingTransferCount, 1);
  assert.equal(error.apiData.busy.activeTransfers[0].readOnlyObserver, false);
  const forged = (() => { try { fail("SOME_CODE", "SOME_CODE", { busy: { schemaVersion: 1, activeTransfers: [{ id: "t", status: "running", secret: "D:/x", readOnlyObserver: "yes" }] } }); } catch (reason) { return reason; } })();
  assert.deepEqual(forged.apiData.busy.activeTransfers, [{ id: "t", status: "running", readOnlyObserver: false, selfAttempt: false }], "外部对象不得借字段名塞入路径，只读标记只认真布尔");
  assert.equal(busyEvidence({ schemaVersion: 2, busy: true }), undefined);
});

test("只读 transfers.list 与守卫共用同一份只读/写入判定", async () => {
  harness({});
  __test.createTransferController({ id: "obs#1", operation: "files.cleanup.preview", localPath: "/f", remotePath: "/r", host: "h", readObserver: true, remoteMutation: false });
  __test.createTransferController({ id: "wr#1", operation: "download.workspace", localPath: "/f", remotePath: "/r", host: "h" });
  const listed = await __test.createLocalApiMethods()["transfers.list"]();
  assert.equal(listed.busy.busy, true, "有真实写入时仍然忙");
  assert.equal(listed.busy.observerTransferCount, 1);
  assert.equal(listed.busy.blockingTransferCount, 1);
  assert.deepEqual(listed.busy.activeTransfers.map(row => row.readOnlyObserver), [true, false]);
});

test("只读身份不能由客户端参数伪造：自称只读的删除执行仍然阻断", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const methods = harness({ execute: async () => { await gate; return { ok: true }; } });
  const running = methods["files.cleanup.execute"]({ localPath: "/fixture/root", targets: ["./a"], readOnly: true, readObserver: true, remoteMutation: false, memoryOnly: true });
  await settle();
  const snap = await busyNow();
  assert.deepEqual(flags(snap), ["files.cleanup.execute:write"], "客户端传入的只读标记一律无效，删除执行仍按写入计");
  assert.equal(snap.busy, true);
  release(); await running;
});

test("只读方法的身份也不随对抗参数下降：参数里写 remoteMutation 仍是只读观测", async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const methods = harness({ preview: async () => { await gate; return { ok: true }; } });
  const running = methods["files.cleanup.preview"]({ localPath: "/fixture/root", targets: ["./a"], readObserver: false, remoteMutation: true, memoryOnly: true });
  await settle();
  const snap = await busyNow();
  assert.deepEqual(flags(snap), ["files.cleanup.preview:read"], "只读身份只由路由与能力表决定，不由请求参数决定");
  assert.equal(snap.busy, false);
  release(); await running;
});

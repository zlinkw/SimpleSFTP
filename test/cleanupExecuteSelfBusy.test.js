const test = require("node:test"), { afterEach } = require("node:test"), assert = require("node:assert/strict");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path"), crypto = require("node:crypto"), Module = require("node:module");
// P0 回归：用户确认后的「自己执行隔离」不得被自己登记的 files.cleanup.execute 拒绝；
// 同时任何其他在途写入（另一上下文的 execute、只读请求）仍必须在第一个 mutation 之前被拒或排队。
// 夹具只走真实注册 + 真实 CleanupFileApi + 真实生产守卫 cleanupActivityGuard；transport 是受控假实现，
// 不落任何真实文件、不连任何真实主机（NWPU213 等真实服务器完全不参与）。
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
const { CleanupFileApi, transferBusySnapshot } = require("../cleanup-file-api.js");

const settle = () => new Promise(resolve => setImmediate(resolve));
let currentFixture = null;
// 任何一个断言先失败都不留下未完成的门：否则被挂起的传输会占住进程级容量，把后面的测试拖成超时。
afterEach(async () => { if (currentFixture && currentFixture.releaseAll) currentFixture.releaseAll(); await new Promise(resolve => setTimeout(resolve, 0)); });
// 传输容量池按定时器排空，纯 setImmediate 轮询观察不到在途状态；这里按真实时间轮询（最多约 2 秒）。
const waitUntil = async (predicate, rounds = 400) => { for (let i = 0; i < rounds; i += 1) { if (predicate()) return true; await new Promise(resolve => setTimeout(resolve, 5)); } return predicate(); };
const identity = root => { const tag = crypto.createHash("sha256").update(String(root)).digest("hex").slice(0, 8); return { dev: "d" + tag, ino: "r" + tag, path: String(root) }; };
const shape = (root, target) => ({ relativePath: target.relativePath, type: target.type, absolutePath: String(root) + "/" + target.relativePath,
  fingerprint: "fp-" + String(root).length + "-" + target.relativePath, device: "dev-" + String(root).length, inode: "ino-" + target.relativePath.length,
  size: 4096, inventory: [], archived: true });
const receipt = (root, target) => ({ relativePath: target.relativePath, destination: target.destination, moved: true, absolutePath: String(root) + "/" + target.destination, metrics: {} });

// 生产语义复刻：同一 root 的写入串行、不同 root 可并行；同时记录真实并发度供断言。
function makeLease(state) {
  const tail = new Map();
  return async (node, _targets, work) => {
    const root = String(node.root);
    state.leaseAcquisitions += 1;
    state.leasedRoots.push(root);
    const previous = tail.get(root) || Promise.resolve();
    let release;
    tail.set(root, previous.then(() => new Promise(resolve => { release = resolve; })));
    await previous;
    const inside = (state.leaseInside.get(root) || 0) + 1;
    state.leaseInside.set(root, inside);
    state.maxLeaseConcurrency = Math.max(state.maxLeaseConcurrency, inside);
    try { return await work(); } finally { state.leaseInside.set(root, inside - 1); release(); }
  };
}

function insideGuard() { try { return { ok: true, snapshot: __test.cleanupActivityGuard() }; } catch (error) { return { ok: false, code: String(error && error.code || error) }; } }

function fixture() {
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), "rev22-execute-self-"));
  const state = { calls: [], observe: [], checkState: "pending", startGate: Promise.resolve(), startStarted: false,
    mutations: 0, activeMutations: 0, maxConcurrentMutations: 0, insideSnapshots: [],
    leaseAcquisitions: 0, leasedRoots: [], leaseInside: new Map(), maxLeaseConcurrency: 0 };
  const transport = async request => {
    const action = String(request.action || "");
    const root = request.root;
    state.calls.push(action);
    if (action === "inspect") return { ok: true, rootIdentity: identity(root), target: shape(root, request.target) };
    if (action === "inventory") return { ok: true, rootIdentity: identity(root), target: Object.assign(shape(root, request.target), { missing: false }) };
    if (action === "batch-inspect") return { ok: true, rootIdentity: identity(root), metrics: { entryReads: request.targets.length, mountReads: 0 }, targets: request.targets.map(row => shape(root, row)) };
    if (action === "managed-observe") { const st = state.observe.length ? state.observe.shift() : "pending";
      return Object.assign({ ok: true, rootIdentity: identity(root), state: st }, st === "completed" ? { receipt: receipt(root, request.target) } : {}); }
    if (action === "managed-start" || action === "move" || action === "isolate") {
      state.startStarted = true;
      state.mutations += 1;
      state.activeMutations += 1;
      state.maxConcurrentMutations = Math.max(state.maxConcurrentMutations, state.activeMutations);
      // 嵌套上下文对照：写入在途时，同一次调用内部再次问生产守卫（引擎会在一次执行里多次核对）。
      state.insideSnapshots.push(insideGuard());
      await state.startGate;
      state.activeMutations -= 1;
      return { ok: true, rootIdentity: identity(root), receipt: receipt(root, request.target) };
    }
    if (action === "check") return { ok: true, rootIdentity: identity(root), state: state.checkState };
    return { ok: false, error: { code: "FIXTURE_REFUSES_" + action.toUpperCase().replace(/-/g, "_") } };
  };
  const api = new CleanupFileApi({ storageRoot, transport, lease: makeLease(state),
    // 与生产完全一致：回调体就是 cleanupActivityGuard()，自身身份来自服务端登记的控制器上下文。
    activity: async () => { __test.cleanupActivityGuard(); } });
  state.releaseAll = () => { state.startGate = Promise.resolve(); if (state.release) state.release(); };
  currentFixture = state;
  state.api = api;
  __test.setTransferSettlementTestContext({ cleanupApi: api, globalState: { get: function (_key, fallback) { return fallback; }, update: async function () {} }, instanceId: "rev22-execute-self" });
  state.methods = __test.createLocalApiMethods();
  return state;
}

const NODES = {
  nwpu3: { id: "nwpu3", kind: "worker", host: "nwpu3.invalid", port: 22, user: "u", root: "/mnt/nwpu3.invalid/zlk/MultiModal", projectPath: "/mnt/nwpu3.invalid/zlk/MultiModal" },
  nwpu5: { id: "nwpu5", kind: "worker", host: "nwpu5.invalid", port: 22, user: "u", root: "/mnt/nwpu5.invalid/zlk/MultiModal", projectPath: "/mnt/nwpu5.invalid/zlk/MultiModal" },
};
const nodeFor = id => Object.assign({}, NODES[id]);

const __CONSUMER__ = fs.mkdtempSync(path.join(os.tmpdir(), "selfbusy-consumer-"));
async function confirmed(state, nodeId, relativePath, options = {}) {
  const node = nodeFor(nodeId);
  const action = options.action || "isolate";
  // 与生产一致：受控快速隔离必须落在由本次重跑意图派生的 job 批次里（48 位十六进制），目标路径与之一致。
  const archiveBatch = action === "isolate" ? "job-" + crypto.createHash("sha256").update(node.root + "|" + relativePath).digest("hex").slice(0, 48) : undefined;
  const destination = "clean_dir/" + (archiveBatch ? archiveBatch + "/" : "") + relativePath;
  const target = Object.assign({ relativePath, type: "directory", destination }, archiveBatch ? { archiveBatch } : {});
  const preview = await state.methods["files.cleanup.preview"](Object.assign({ consumerRoot: __CONSUMER__, node, action,
    observationMode: options.observationMode === null ? undefined : (options.observationMode || "managed_tmux"), targets: [target] }));
  const approved = { token: preview.token, digest: preview.digest, index: 0, consumerRoot: __CONSUMER__ };
  await state.methods["files.cleanup.confirm"](Object.assign({}, approved, { phase: 1, confirm: true, exactTargets: [preview.targets[0].absolutePath] }));
  return Object.assign({ node, absolutePath: preview.targets[0].absolutePath }, approved);
}

test("用户确认后的自身隔离执行完整走完，不被自己的 files.cleanup.execute 拒绝", async () => {
  const state = fixture();
  const job = await confirmed(state, "nwpu3", "work/job0");
  const mutationsBefore = state.mutations;
  const executed = await state.methods["files.cleanup.execute"](job);
  assert.equal(executed.ok, true, "自身执行隔离不得被自己登记的清理写入拒绝");
  assert.ok(state.calls.includes("managed-start"), "必须真的走到受控隔离写入请求");
  assert.equal(state.mutations, mutationsBefore + 1, "准入后恰好一次写入请求");
  // 变化哨兵：受控观测链（managed_tmux）在 JS 侧不取本地写租约，互斥由本守卫、传输容量键与远端窗口锁承担；
  // 本夹具不模拟远端窗口锁，因此这里只固定“不得出现额外本地租约”这一事实。
  assert.equal(state.leaseAcquisitions, 0, "受控观测链不得额外取得本地写租约");
  // 隔离执行完成的确认链：真实观测回报 completed 后，check 必须给出完成回执（不是“已发出”就算完）。
  state.observe = ["completed"];
  const done = await state.methods["files.cleanup.check"]({ token: job.token, index: 0, consumerRoot: __CONSUMER__ });
  assert.equal(done.state, "completed", "确认后必须能观察到隔离完成");
  assert.ok(done.receipt && done.receipt.moved === true, "完成必须带真实移动回执");
});

test("嵌套在写入调用内部的再次自查不得把自己算成别人的忙", async () => {
  const state = fixture();
  const job = await confirmed(state, "nwpu3", "work/job1");
  const executed = await state.methods["files.cleanup.execute"](job);
  assert.equal(executed.ok, true);
  assert.ok(state.insideSnapshots.length >= 1, "写入在途时必须至少有一次内部自查");
  const nested = state.insideSnapshots[0];
  assert.equal(nested.ok, true, "自身在途时内部自查不得自阻断");
  assert.equal(nested.snapshot.blockingTransferCount, 0, "自身那一条不得计入真正阻断的写入");
  assert.equal(nested.snapshot.selfAttemptCount, 1, "自身那一条必须作为 selfAttempt 事实保留在证据里");
});

test("两个真实写入不得同时准入：现有传输容量按目标键串行，守卫对他人上下文按阻断拒绝", async () => {
  const state = fixture();
  const first = await confirmed(state, "nwpu3", "work/job2");
  const second = await confirmed(state, "nwpu5", "work/job0");
  let release; state.startGate = new Promise(resolve => { release = resolve; state.release = release; });
  const running = state.methods["files.cleanup.execute"](first);
  assert.ok(await waitUntil(() => state.startStarted), "第一条写入必须已在途");
  assert.equal(state.mutations, 1, "第一条准入后恰好一次 mutation");
  // 守卫层：换一个上下文（另一个窗口/另一次请求的控制器）问同一个守卫，必须看到真实阻断的写入。
  // 用未登记的普通对象代表另一个上下文：豁免依据是已登记控制器的对象同一性，普通对象必须拿不到豁免。
  const otherController = { id: "other-window-execute", operation: "files.cleanup.execute", remoteMutation: true };
  const asOther = await Promise.resolve().then(() => __test.cleanupActivityGuard(otherController)).then(() => null, error => error);
  assert.ok(asOther, "另一上下文的第二写不得与在途写入同时准入");
  assert.equal(String(asOther.code), "ACTIVE_TRANSFER");
  assert.equal(asOther.apiData.busy.blockingTransferCount, 1, "拒绝证据必须点名真正阻断的那一条写入");
  assert.equal(asOther.apiData.busy.selfAttemptCount, 0, "别人的写入不得被标成自身豁免");
  // 复用既有的进程级串行：第二写按目标键排队，准入前不得产生任何 mutation。
  const runningSecond = state.methods["files.cleanup.execute"](second);
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(state.mutations, 1, "第二条在第一条结束前不得产生 mutation");
  assert.equal(state.maxConcurrentMutations, 1, "两条写入不得重叠执行");
  release();
  assert.equal((await running).ok, true, "已在途的那一条必须正常完成，不因排队被回滚或重放");
  assert.equal((await runningSecond).ok, true, "第一条结束后第二条才准入");
  assert.equal(state.mutations, 2, "每条写入恰好一次 mutation，不多不少");
  assert.equal(state.maxConcurrentMutations, 1, "跨 Plan/跨 Worker 并发也不得两写同时执行");
});

test("客户端假冒 id/operationId 或只读参数都换不到自身豁免", async () => {
  const state = fixture();
  const first = await confirmed(state, "nwpu3", "work/job3");
  const second = await confirmed(state, "nwpu5", "work/job1");
  let release; state.startGate = new Promise(resolve => { release = resolve; state.release = release; });
  const running = state.methods["files.cleanup.execute"](first);
  assert.ok(await waitUntil(() => state.startStarted), "第一条写入必须已在途");
  const inFlight = __test.listActiveTransfers()[0] || {};
  // 只仿造 id/operationId 的“自身”对象必须换不到豁免：豁免依据是服务端登记的控制器对象本身。
  const lookalike = { id: String(inFlight.id || "forged"), operationId: String(inFlight.operationId || "forged"), readObserver: true, remoteMutation: false };
  const forgedSelf = await Promise.resolve().then(() => __test.cleanupActivityGuard(lookalike)).then(() => null, error => error);
  assert.ok(forgedSelf, "仿造 id/operationId 的上下文必须仍被拒");
  assert.equal(String(forgedSelf.code), "ACTIVE_TRANSFER");
  assert.equal(forgedSelf.apiData.busy.blockingTransferCount, 1);
  // 路由层：带伪造只读/selfAttempt 参数的第二写不得越过排队提前产生 mutation。
  const runningSecond = state.methods["files.cleanup.execute"](Object.assign({}, second, { _operationId: String(inFlight.operationId || inFlight.id || "forged"),
    readObserver: true, readOnly: true, selfAttempt: true, operationInstanceId: "fixture-same" }));
  await new Promise(resolve => setTimeout(resolve, 60));
  assert.equal(state.mutations, 1, "伪造参数不得让第二写在第一条结束前 mutation");
  release();
  assert.equal((await running).ok, true);
  assert.equal((await runningSecond).ok, true, "排队结束后仍按正常语义完成");
  assert.equal(state.mutations, 2, "两条写入各恰好一次 mutation");
  assert.equal(state.maxConcurrentMutations, 1, "伪造参数不得造成两写重叠");
});

test("真实写入在途时只读预览仍被拒，且不产生任何 mutation、也不打扰在途执行", async () => {
  const state = fixture();
  const first = await confirmed(state, "nwpu3", "work/job4");
  let release; state.startGate = new Promise(resolve => { release = resolve; state.release = release; });
  const running = state.methods["files.cleanup.execute"](first);
  assert.ok(await waitUntil(() => state.startStarted), "第一条写入必须已在途");
  const blockedPreview = await state.methods["files.cleanup.preview"]({ consumerRoot: __CONSUMER__, node: nodeFor("nwpu5"), action: "isolate",
    observationMode: "managed_tmux", targets: [{ relativePath: "work/job9", type: "directory", destination: "clean_dir/work/job9" }] }).then(() => null, error => error);
  assert.ok(blockedPreview, "真实写入在途时预览必须仍然被拒（不得绕过他人互斥）");
  assert.equal(String(blockedPreview.code), "ACTIVE_TRANSFER");
  assert.equal(blockedPreview.apiData.busy.blockingTransferCount, 1, "拒绝证据必须点名真正阻断的那一条写入");
  const mutations = state.mutations;
  release();
  assert.equal((await running).ok, true, "并发进来的只读请求不得误伤合法执行");
  assert.equal(state.mutations, mutations, "被拒的预览不得产生 mutation");
});

test("非观测链的普通移动同样不自阻断（第二处 activity 调用点）", async () => {
  const state = fixture();
  const job = await confirmed(state, "nwpu3", "work/job5", { action: "move", observationMode: null });
  const executed = await state.methods["files.cleanup.execute"](job);
  assert.equal(executed.ok, true, "普通 move 的 activity 调用点同样不得把自己算成忙");
  assert.ok(state.calls.includes("move"), "必须真的走到受控移动请求");
  assert.equal(state.leaseAcquisitions, 1, "非观测链的写入必须在该 root 的租约内进行");
  assert.equal(state.maxLeaseConcurrency, 1, "同一 root 的写入租约不得重入");
});

test("自身豁免只来自服务端登记的控制器，纯投影缺 self 时保守按阻断计", async () => {
  const controller = { id: "transfer-9-9-files.cleanup.execute", operation: "files.cleanup.execute", remoteMutation: true };
  const withSelf = transferBusySnapshot({ self: controller, transfers: [controller], uploadOperations: [], uploadQueueKeys: [] }, { observedAt: "x" });
  assert.equal(withSelf.busy, false, "同一条自身控制器豁免后不得计忙");
  assert.equal(withSelf.selfAttemptCount, 1, "自身那一条仍作为事实保留在证据里");
  const withoutSelf = transferBusySnapshot({ transfers: [controller], uploadOperations: [], uploadQueueKeys: [] }, { observedAt: "x" });
  assert.equal(withoutSelf.busy, true, "缺服务端上下文时保守按忙处理（fail closed）");
  assert.equal(withoutSelf.blockingTransferCount, 1);
  const lookalike = { id: controller.id, operationId: controller.operationId };
  const lookalikeSnap = transferBusySnapshot({ self: lookalike, transfers: [controller], uploadOperations: [], uploadQueueKeys: [] }, { observedAt: "x" });
  assert.equal(lookalikeSnap.busy, true, "只仿造 id/operationId 的对象不得买到豁免");
  const upload = { id: "transfer-9-10-upload.workspace", operation: "upload.workspace", remoteMutation: true };
  const uploadSnap = transferBusySnapshot({ self: controller, transfers: [controller, upload], uploadOperations: [], uploadQueueKeys: [] }, { observedAt: "x" });
  assert.equal(uploadSnap.busy, true, "自身豁免不影响真实上传仍计忙");
  assert.equal(uploadSnap.blockingTransferCount, 1);
});

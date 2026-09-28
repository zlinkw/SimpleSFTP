"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.ResourceOperationLeaseManager = void 0;
exports.normalizeResourceTarget = normalizeResourceTarget;
exports.resourceTargetsConflict = resourceTargetsConflict;
const fs = __importStar(require("fs/promises"));
const path = __importStar(require("path"));
const crypto = __importStar(require("crypto"));
const async_hooks_1 = require("async_hooks");
const poolKey = Symbol.for("simple-local.resource-leases.v2");
const contextKey = Symbol.for("simple-local.resource-lease-context.v2");
const globals = globalThis;
const contexts = globals[contextKey] ||= new async_hooks_1.AsyncLocalStorage();
const pools = globals[poolKey] ||= new Map();
function normalizedPath(value) {
    if (!value || value.split(/[\\/]/).includes(".."))
        throw new Error("资源锁目标必须是明确路径，不能包含 ..。");
    if (/^[a-z]:[\\/]|^\\\\/i.test(value)) {
        const normalized = path.win32.normalize(value).replace(/\\/g, "/").toLowerCase();
        return /^[a-z]:\/$/.test(normalized) ? normalized : normalized.replace(/\/$/, "");
    }
    if (!path.posix.isAbsolute(value))
        throw new Error("资源锁需要绝对项目和目标路径。");
    return path.posix.normalize(value).replace(/\/$/, "") || "/";
}
function within(parent, child) { return parent === child || child.startsWith(parent.endsWith("/") ? parent : parent + "/"); }
function normalizeResourceTarget(value) {
    const server = String(value.server || "local").trim().toLowerCase();
    const project = normalizedPath(value.project), target = normalizedPath(value.target || value.project);
    if (!within(project, target))
        throw new Error("资源锁目标不在对应项目内。");
    return { server, project, target };
}
function resourceTargetsConflict(a, b) {
    return a.some(x => b.some(y => x.server === y.server && (within(x.target, y.target) || within(y.target, x.target))));
}
async function canonicalResourceTarget(value) {
    const normalized = normalizeResourceTarget(value);
    if (normalized.server !== "local")
        return normalized;
    async function physical(input) {
        if (process.platform !== "win32" && /^[a-z]:/i.test(input))
            return input;
        const segments = [];
        let current = input;
        for (;;) {
            try {
                return normalizedPath(path.resolve(await fs.realpath(current), ...segments.reverse()));
            }
            catch (error) {
                if (!["ENOENT", "ENOTDIR"].includes(error.code))
                    throw error;
                const parent = path.dirname(current);
                if (parent === current)
                    return input;
                segments.push(path.basename(current));
                current = parent;
            }
        }
    }
    return normalizeResourceTarget({ server: "local", project: await physical(normalized.project), target: await physical(normalized.target) });
}
/** Per-window bakery admission protects only registry writes, never business operations.
 * Registry release and crash recovery are logical: no filesystem cleanup is required.
 */
class ResourceOperationLeaseManager {
    options;
    leasePath;
    ttlMs;
    heartbeatMs;
    windowId;
    processId;
    now;
    directory;
    file;
    state;
    constructor(options) {
        this.options = options;
        this.leasePath = options.leasePath;
        this.ttlMs = Math.max(100, options.ttlMs ?? 30_000);
        this.heartbeatMs = options.heartbeatMs ?? 5_000;
        this.windowId = options.windowId;
        this.processId = options.processId ?? process.pid;
        this.now = options.now || Date.now;
        this.directory = this.leasePath + ".resources-v2";
        this.file = path.join(this.directory, crypto.createHash("sha256").update(this.windowId).digest("hex") + ".json");
        const key = this.file.toLowerCase();
        if (!pools.has(key))
            pools.set(key, { queue: Promise.resolve(), registry: { schemaVersion: 2, windowId: this.windowId, ticket: 0, choosing: false, admissionExpiresAt: 0, leases: [] } });
        this.state = pools.get(key);
    }
    exclusive(operation) {
        const work = this.state.queue.catch(() => undefined).then(operation);
        this.state.queue = work.catch(() => undefined);
        return work;
    }
    async write() {
        await fs.mkdir(this.directory, { recursive: true });
        const temporary = this.file + ".writing-" + crypto.randomUUID();
        await fs.writeFile(temporary, JSON.stringify(this.state.registry), "utf8");
        // Windows readers or antivirus may briefly deny replacement. Keep the prior
        // atomic record intact and retry only sharing violations, never publish a
        // partially written JSON file or leave a choosing ticket stranded.
        const started = Date.now();
        for (;;) {
            try {
                await fs.rename(temporary, this.file);
                break;
            }
            catch (error) {
                if (!["EPERM", "EACCES", "EBUSY"].includes(error.code) || Date.now() - started >= 30_000)
                    throw error;
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
    }
    async rows() {
        await fs.mkdir(this.directory, { recursive: true });
        const names = (await fs.readdir(this.directory)).filter(name => /^[a-f0-9]{64}[.]json$/.test(name));
        return Promise.all(names.map(async (name) => {
            const row = JSON.parse(await fs.readFile(path.join(this.directory, name), "utf8"));
            if (row.schemaVersion !== 2 || !Array.isArray(row.leases) || !row.windowId)
                throw new Error("资源锁记录损坏，请重新加载持有窗口后重试。");
            return row;
        }));
    }
    async legacyGuard() {
        try {
            const text = await fs.readFile(this.leasePath, "utf8");
            let row;
            try {
                row = JSON.parse(text);
            }
            catch {
                row = {};
            }
            const expiry = Date.parse(row.expiresAt) || (await fs.stat(this.leasePath)).mtimeMs + 30_000;
            if (expiry > this.now())
                throw new Error(`旧版全局锁仍由窗口 ${row.windowId || "未知"} 持有。请重新加载该窗口以完成两款插件升级，然后重试；不能绕过活动旧锁。`);
        }
        catch (error) {
            if (error.code !== "ENOENT")
                throw error;
        }
    }
    async admission(operation, signal) {
        return this.exclusive(async () => {
            const own = this.state.registry;
            signal?.throwIfAborted();
            await this.legacyGuard();
            own.choosing = true;
            own.admissionExpiresAt = this.now() + 30_000;
            try {
                await this.write();
                const rows = await this.rows();
                own.ticket = 1 + Math.max(0, ...rows.filter(row => row.admissionExpiresAt > this.now()).map(row => row.ticket));
                own.choosing = false;
                await this.write();
                const started = Date.now();
                let renewed = started;
                for (;;) {
                    signal?.throwIfAborted();
                    const current = await this.rows();
                    const earlier = current.some(row => row.windowId !== own.windowId && row.admissionExpiresAt > this.now() &&
                        (row.choosing || row.ticket > 0 && (row.ticket < own.ticket || row.ticket === own.ticket && row.windowId < own.windowId)));
                    if (!earlier)
                        return await operation(current);
                    if (Date.now() - started >= 30_000)
                        throw new Error("资源锁协调 30 秒无有效响应，请重新加载持有窗口后重试。");
                    if (Date.now() - renewed >= Math.min(1000, this.ttlMs / 3)) {
                        for (const lease of own.leases) {
                            if (Date.parse(lease.expiresAt) > this.now()) {
                                lease.heartbeatAt = new Date(this.now()).toISOString();
                                lease.expiresAt = new Date(this.now() + this.ttlMs).toISOString();
                            }
                        }
                        await this.write();
                        renewed = Date.now();
                    }
                    await new Promise(resolve => setTimeout(resolve, 10));
                }
            }
            finally {
                own.ticket = 0;
                own.choosing = false;
                own.admissionExpiresAt = 0;
                await this.write();
            }
        });
    }
    async run(input, operation) {
        if (input.readOnly)
            return operation();
        const handle = await this.acquire(input);
        try {
            return await contexts.run([...(contexts.getStore() || []), handle.record], async () => {
                const result = await operation();
                await handle.assertHeld();
                return result;
            });
        }
        finally {
            await handle.release();
        }
    }
    async acquire(input) {
        const targets = await Promise.all((input.resources?.length ? input.resources : [{ server: "local", project: input.hostProjectPath }]).map(canonicalResourceTarget));
        for (const field of ["pluginId", "workspaceUri", "hostProjectPath", "actionType"])
            if (!String(input[field] || "").trim())
                throw new Error(`资源锁缺少 ${field}。`);
        const parents = contexts.getStore() || [];
        const parent = parents.find(row => row.windowId === this.windowId && row.resourceFile === this.file && targets.every((target) => row.resources.some((held) => held.server === target.server && within(held.target, target.target))));
        if (parent)
            return { record: parent, assertHeld: () => this.assertOwned(parent), release: async () => undefined };
        const time = this.now();
        const record = { ...input, schemaVersion: 1, leaseId: crypto.randomUUID(), windowId: this.windowId, processId: this.processId, resourceFile: this.file,
            resources: targets, actionLabel: input.actionLabel || input.actionType, createdAt: new Date(time).toISOString(), heartbeatAt: new Date(time).toISOString(), expiresAt: new Date(time + this.ttlMs).toISOString() };
        const waitStarted = Date.now();
        for (;;) {
            try {
                await this.admission(async (rows) => {
                    input.signal?.throwIfAborted();
                    for (const row of rows)
                        for (const lease of row.leases) {
                            if (Date.parse(lease.expiresAt) > this.now() && this.ownerAlive(lease) && resourceTargetsConflict(targets, lease.resources)) {
                                const conflict = this.options.conflictError?.(lease) || new Error(`目标正在由 ${lease.windowId} 的“${lease.actionLabel}”修改，请等待该操作完成后重试。`);
                                conflict.code = "RESOURCE_CONFLICT";
                                throw conflict;
                            }
                        }
                    this.state.registry.leases = this.state.registry.leases.filter(row => Date.parse(row.expiresAt) > this.now());
                    record.heartbeatAt = new Date(this.now()).toISOString();
                    record.expiresAt = new Date(this.now() + this.ttlMs).toISOString();
                    this.state.registry.leases.push(record);
                }, input.signal);
                break;
            }
            catch (error) {
                if (!input.waitForConflict || error.code !== "RESOURCE_CONFLICT" || Date.now() - waitStarted >= 30_000)
                    throw error;
                input.signal?.throwIfAborted();
                await new Promise(resolve => setTimeout(resolve, 10));
            }
        }
        let released = false, lost;
        const renew = async () => this.exclusive(async () => {
            await this.assertOwned(record);
            record.heartbeatAt = new Date(this.now()).toISOString();
            record.expiresAt = new Date(this.now() + this.ttlMs).toISOString();
            await this.write();
        });
        const timer = this.heartbeatMs > 0 ? setInterval(() => { if (!released)
            void renew().catch(error => { lost = error; }); }, this.heartbeatMs) : undefined;
        timer?.unref?.();
        return { record, assertHeld: async () => { if (lost)
                throw lost; await this.assertOwned(record); }, release: async () => {
                if (released)
                    return;
                released = true;
                clearInterval(timer);
                await this.exclusive(async () => { this.state.registry.leases = this.state.registry.leases.filter(row => row.leaseId !== record.leaseId); await this.write(); });
            } };
    }
    async assertOwned(record) {
        await this.legacyGuard();
        const own = JSON.parse(await fs.readFile(this.file, "utf8"));
        if (own.windowId !== this.windowId || !own.leases.some((row) => row.leaseId === record.leaseId && Date.parse(row.expiresAt) > this.now())) {
            throw this.options.lostError?.() || new Error("资源锁持有证明已失效，停止提交修改；请重新加载窗口后重试。");
        }
    }
    ownerAlive(record) {
        if (this.options.ownerAlive)
            return this.options.ownerAlive(record) !== false;
        // Only ESRCH proves disappearance; Windows permission/probe failures are not proof.
        try {
            process.kill(record.processId, 0);
            return true;
        }
        catch (error) {
            return error.code !== "ESRCH";
        }
    }
    async inspect() { return { records: (await this.rows()).flatMap(row => row.leases).filter(row => Date.parse(row.expiresAt) > this.now()) }; }
}
exports.ResourceOperationLeaseManager = ResourceOperationLeaseManager;

const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");

const HOST_OPERATION_LEASE_SCHEMA_VERSION = 1;
const HOST_OPERATION_LEASE_DIRECTORY = "SimpleExperiment";
const HOST_OPERATION_LEASE_FILENAME = "host-operation-lease.json";
const HOST_OPERATION_LEASE_TTL_MS = 30000;
const HOST_OPERATION_LEASE_HEARTBEAT_MS = 5000;
const WINDOW_ID_SYMBOL = Symbol.for("simple-local.host-operation-window-id.v1");
const SESSION_MAP_SYMBOL = Symbol.for("simple-local.host-operation-lease-sessions.v1");

class HostOperationLeaseConflictError extends Error {
  constructor(current) {
    super(formatHostOperationLeaseConflict(current));
    this.name = "HostOperationLeaseConflictError";
    this.current = current;
  }
}

class HostOperationLeaseLostError extends Error {
  constructor(message = "宿主操作租约已失效，当前窗口不能继续提交副作用操作。") {
    super(message);
    this.name = "HostOperationLeaseLostError";
  }
}

class HostOperationLeaseManager {
  constructor(options = {}) {
    this.leasePath = options.leasePath || defaultHostOperationLeasePath();
    this.ttlMs = Math.max(100, Number(options.ttlMs) || HOST_OPERATION_LEASE_TTL_MS);
    this.heartbeatMs = Math.max(0, Number(options.heartbeatMs == null ? HOST_OPERATION_LEASE_HEARTBEAT_MS : options.heartbeatMs) || 0);
    this.windowId = options.windowId || sharedWindowId();
    this.processId = Number(options.processId == null ? process.pid : options.processId);
    this.now = options.now || Date.now;
  }

  async run(input, operation) {
    const handle = await this.acquire(input);
    try {
      const result = await operation();
      await handle.assertHeld();
      return result;
    } finally {
      await handle.release();
    }
  }

  async acquire(input) {
    validateLeaseInput(input);
    await fs.promises.mkdir(path.dirname(this.leasePath), { recursive: true });
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const record = this.createRecord(input);
      try {
        await createExclusiveLeaseFile(this.leasePath, record);
        return this.attachNewSession(record);
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
      }

      const inspection = await this.inspect();
      if (inspection.record && inspection.record.windowId === this.windowId) {
        const session = sharedSessions().get(sessionKey(this.leasePath));
        if (session && session.leaseId === inspection.record.leaseId && session.windowId === this.windowId) {
          session.refs += 1;
          return this.createHandle(inspection.record, session);
        }
      }
      if (inspection.expiresAtMs > this.now()) {
        throw new HostOperationLeaseConflictError(inspection.record || malformedLeaseRecord(this.leasePath, inspection.expiresAtMs));
      }

      const movedPath = `${this.leasePath}.expired-${crypto.randomUUID()}`;
      try {
        await fs.promises.rename(this.leasePath, movedPath);
      } catch (error) {
        if (hasErrorCode(error, "ENOENT") || hasErrorCode(error, "EACCES") || hasErrorCode(error, "EPERM") || hasErrorCode(error, "EBUSY")) {
          await shortDelay();
          continue;
        }
        throw error;
      }
      try {
        await createExclusiveLeaseFile(this.leasePath, record);
        return this.attachNewSession(record);
      } catch (error) {
        if (!hasErrorCode(error, "EEXIST")) throw error;
      } finally {
        await fs.promises.unlink(movedPath).catch(() => undefined);
      }
      await shortDelay();
    }
    const current = await this.inspect();
    throw new HostOperationLeaseConflictError(current.record || malformedLeaseRecord(this.leasePath, current.expiresAtMs));
  }

  async inspect() {
    try {
      const record = parseHostOperationLeaseRecord(await fs.promises.readFile(this.leasePath, "utf8"));
      if (record) return { record, expiresAtMs: parseTimestamp(record.expiresAt), malformed: false };
      const stat = await fs.promises.stat(this.leasePath);
      return { expiresAtMs: stat.mtimeMs + this.ttlMs, malformed: true };
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) return { expiresAtMs: 0, malformed: false };
      throw error;
    }
  }

  createRecord(input) {
    const now = this.now();
    const timestamp = new Date(now).toISOString();
    return {
      schemaVersion: HOST_OPERATION_LEASE_SCHEMA_VERSION,
      leaseId: crypto.randomUUID(),
      pluginId: String(input.pluginId).trim(),
      windowId: this.windowId,
      processId: this.processId,
      workspaceUri: String(input.workspaceUri).trim(),
      hostProjectPath: path.win32.normalize(String(input.hostProjectPath).trim()),
      actionType: String(input.actionType).trim(),
      actionLabel: String(input.actionLabel || input.actionType).trim(),
      createdAt: timestamp,
      heartbeatAt: timestamp,
      expiresAt: new Date(now + this.ttlMs).toISOString(),
    };
  }

  attachNewSession(record) {
    const session = {
      leasePath: this.leasePath,
      leaseId: record.leaseId,
      windowId: record.windowId,
      refs: 1,
      renew: () => this.updateOwnedLease(record.leaseId, false),
      expire: () => this.updateOwnedLease(record.leaseId, true),
    };
    if (this.heartbeatMs > 0) {
      session.heartbeatTimer = setInterval(() => {
        void session.renew().catch((error) => {
          if (error instanceof HostOperationLeaseLostError) session.lostError = error;
        });
      }, this.heartbeatMs);
      session.heartbeatTimer.unref?.();
    }
    sharedSessions().set(sessionKey(this.leasePath), session);
    return this.createHandle(record, session);
  }

  createHandle(record, session) {
    let released = false;
    return {
      record,
      assertHeld: async () => {
        if (session.lostError) throw session.lostError;
        const inspection = await this.inspect();
        if (!inspection.record || inspection.record.leaseId !== session.leaseId || inspection.record.windowId !== session.windowId) {
          throw new HostOperationLeaseLostError();
        }
      },
      release: async () => {
        if (released) return;
        released = true;
        session.refs = Math.max(0, session.refs - 1);
        if (session.refs > 0) return;
        if (session.heartbeatTimer) clearInterval(session.heartbeatTimer);
        const key = sessionKey(session.leasePath);
        if (sharedSessions().get(key) === session) sharedSessions().delete(key);
        await session.expire().catch((error) => {
          if (!(error instanceof HostOperationLeaseLostError)) throw error;
        });
      },
    };
  }

  async updateOwnedLease(leaseId, release) {
    let handle;
    try {
      handle = await fs.promises.open(this.leasePath, "r+");
      const current = parseHostOperationLeaseRecord(await handle.readFile("utf8"));
      if (!current || current.leaseId !== leaseId || current.windowId !== this.windowId) throw new HostOperationLeaseLostError();
      const now = this.now();
      const next = {
        ...current,
        heartbeatAt: new Date(now).toISOString(),
        expiresAt: new Date(release ? now : now + this.ttlMs).toISOString(),
        ...(release ? { releasedAt: new Date(now).toISOString() } : {}),
      };
      await handle.truncate(0);
      await handle.write(`${JSON.stringify(next, null, 2)}\n`, 0, "utf8");
      await handle.sync();
    } catch (error) {
      if (hasErrorCode(error, "ENOENT")) throw new HostOperationLeaseLostError();
      throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }
}

function defaultHostOperationLeasePath(localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local")) {
  return path.join(localAppData, HOST_OPERATION_LEASE_DIRECTORY, HOST_OPERATION_LEASE_FILENAME);
}

function parseHostOperationLeaseRecord(text) {
  try {
    const value = JSON.parse(text);
    const required = ["leaseId", "pluginId", "windowId", "workspaceUri", "hostProjectPath", "actionType", "actionLabel", "createdAt", "heartbeatAt", "expiresAt"];
    if (value.schemaVersion !== HOST_OPERATION_LEASE_SCHEMA_VERSION || !Number.isInteger(value.processId) || required.some((key) => !String(value[key] || "").trim())) return undefined;
    if (!Number.isFinite(parseTimestamp(value.expiresAt))) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function formatHostOperationLeaseConflict(current) {
  return [
    "宿主副作用操作已被另一 VS Code 窗口阻止。",
    `持有插件：${current.pluginId}`,
    `持有窗口：${current.windowId}（PID ${current.processId}）`,
    `工作区：${current.workspaceUri}`,
    `宿主项目：${current.hostProjectPath}`,
    `当前动作：${current.actionLabel || current.actionType}`,
    `最近心跳：${current.heartbeatAt}`,
    `自动恢复：等待当前操作完成；若窗口已崩溃，请在 ${current.expiresAt} 后重试。不得删除活动租约文件。`,
  ].join("\n");
}

async function createExclusiveLeaseFile(leasePath, record) {
  const handle = await fs.promises.open(leasePath, "wx");
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function sharedWindowId() {
  const globals = globalThis;
  if (!globals[WINDOW_ID_SYMBOL]) globals[WINDOW_ID_SYMBOL] = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
  return String(globals[WINDOW_ID_SYMBOL]);
}

function sharedSessions() {
  const globals = globalThis;
  if (!(globals[SESSION_MAP_SYMBOL] instanceof Map)) globals[SESSION_MAP_SYMBOL] = new Map();
  return globals[SESSION_MAP_SYMBOL];
}

function sessionKey(leasePath) {
  return path.resolve(leasePath).toLowerCase();
}

function validateLeaseInput(input) {
  for (const key of ["pluginId", "workspaceUri", "hostProjectPath", "actionType"]) {
    if (!String(input && input[key] || "").trim()) throw new Error(`宿主操作租约缺少 ${key}。`);
  }
}

function malformedLeaseRecord(leasePath, expiresAtMs) {
  const timestamp = new Date(Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now() + HOST_OPERATION_LEASE_TTL_MS).toISOString();
  return {
    schemaVersion: HOST_OPERATION_LEASE_SCHEMA_VERSION,
    leaseId: "malformed",
    pluginId: "unknown",
    windowId: "unknown",
    processId: 0,
    workspaceUri: "unknown",
    hostProjectPath: leasePath,
    actionType: "malformed-lease",
    actionLabel: "无法解析的宿主操作租约",
    createdAt: timestamp,
    heartbeatAt: timestamp,
    expiresAt: timestamp,
  };
}

function parseTimestamp(value) {
  return Date.parse(value);
}

function hasErrorCode(error, code) {
  return Boolean(error && typeof error === "object" && error.code === code);
}

function shortDelay() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

module.exports = {
  HOST_OPERATION_LEASE_SCHEMA_VERSION,
  HOST_OPERATION_LEASE_DIRECTORY,
  HOST_OPERATION_LEASE_FILENAME,
  HOST_OPERATION_LEASE_TTL_MS,
  HOST_OPERATION_LEASE_HEARTBEAT_MS,
  HostOperationLeaseConflictError,
  HostOperationLeaseLostError,
  HostOperationLeaseManager,
  defaultHostOperationLeasePath,
  formatHostOperationLeaseConflict,
  parseHostOperationLeaseRecord,
};

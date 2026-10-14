"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { atomicWriteText } = require("./state-store");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const copy = value => JSON.parse(JSON.stringify(value));
function cleanupRemoteLoader(source) {
  const packed = require('node:zlib').deflateSync(Buffer.from(source,'utf8')).toString('base64');
  const command = 'import base64,zlib;exec(compile(zlib.decompress(base64.b64decode(' + JSON.stringify(packed) + ')),\'simple_sftp_cleanup\',\'exec\'))';
  if(command.length > 20000) fail('REMOTE_LOADER_TOO_LARGE');
  return command;
}
function fail(code, message = code) { const error = new Error(message); error.code = code; error.apiCode = code === "CONFIRM_REQUIRED" ? 2001 : 2010; error.apiData = { code }; throw error; }

/** A path capability authorizes one frozen batch, never a later or remembered path. */
class CleanupFileApi {
  constructor({ storageRoot, transport, activity, lease }) {
    this.storageRoot = storageRoot; this.transport = transport; this.activity = activity; this.lease = lease;
    this.previews = new Map(); this.busy = new Set(); this.localExecutions = new Map();
  }
  async checked(request) {
    const value = await this.transport(copy(request));
    if (!value?.ok) fail(value?.error?.code || "UNVERIFIED_RESPONSE", value?.error?.message);
    return value;
  }
  async read(token) {
    if (!/^[a-f0-9]{48}$/.test(String(token))) fail("INVALID_TOKEN");
    const memory = this.previews.get(token);
    if (memory) return copy(memory);
    try { return JSON.parse(await fs.readFile(path.join(this.storageRoot, token + ".json"), "utf8")); }
    catch { fail("PREVIEW_EXPIRED"); }
  }
  async save(row) { await atomicWriteText(path.join(this.storageRoot, row.token + ".json"), JSON.stringify(row)); this.previews.set(row.token, copy(row)); }
  async preview(params) {
    for (const [token, preview] of this.previews) if (Date.now() > preview.expiresAt) this.previews.delete(token);
    if (this.previews.size >= 4096) fail("CLEANUP_PREVIEW_CAPACITY_EXCEEDED");
    const { node, action = "move", targets } = params;
    if (params.authorizationMode !== undefined && params.authorizationMode !== "confirmed_paths") fail("INVALID_AUTHORIZATION_MODE");
    const pathOnly = params.authorizationMode === "confirmed_paths";
    if (pathOnly && action !== "delete") fail("INVALID_ACTION");
    const observationMode = params.observationMode === "managed_tmux" || pathOnly ? node?.kind === "local" ? "filesystem" : "tmux" : undefined;
    if (!node?.root || !["move", "delete", "restore"].includes(action) || !Array.isArray(targets) || !targets.length || targets.length > 500) fail("INVALID_REQUEST");
    if (!pathOnly) await this.activity(node);
    const rows = []; let identity;
    for (const original of targets) {
      const target = { ...original, ...(observationMode ? { activityEvidenceMode: "managed_tmux" } : {}) };
      if (pathOnly) { target.authorizationMode = "confirmed_paths"; delete target.expectedOwner; delete target.expectedSha256; }
      else if (target.authorizationMode !== undefined) fail("INVALID_AUTHORIZATION_MODE");
      if (!target || !["file", "directory"].includes(target.type)) fail("UNCERTAIN_TYPE");
      if (target.archiveBatch !== undefined && !/^job-[a-f0-9]{48}$/.test(target.archiveBatch)) fail("UNSAFE_ARCHIVE_BATCH");
      const archivePrefix = "clean_dir/" + (target.archiveBatch ? target.archiveBatch + "/" : "");
      if (action === "restore" ? !target.relativePath?.startsWith(archivePrefix) || target.destination !== target.relativePath.slice(archivePrefix.length)
        : target.destination !== archivePrefix + target.relativePath) fail("UNSAFE_DESTINATION");
      const result = await this.checked({ node, root: node.root, action: "inspect", archived: action === "restore", target });
      if (identity && hash(identity) !== hash(result.rootIdentity)) fail("ROOT_IDENTITY_CHANGED");
      identity = result.rootIdentity;
      rows.push({ ...copy(target), ...result.target, destination: target.destination });
    }
    const row = { token: crypto.randomBytes(24).toString("hex"), operationId: "cleanup-" + crypto.randomBytes(16).toString("hex"), node: copy(node), rootIdentity: identity,
      action, observationMode, authorizationMode: pathOnly ? "confirmed_paths" : undefined, targets: rows, safety: { gitRepositoryAncestors: true, readOnlyReceiptCheck: true, formalJobOwner: true, immutableArchiveBatch: true, batchPreviewCapacity: 4096, managedObservation: 1, confirmedPathDeletion: 1, handleScan: pathOnly ? "confirmed_paths" : observationMode ? "managed_tmux" : "visible_same_user_processes" }, expiresAt: Date.now() + 30 * 60 * 1000, confirmations: 0, states: rows.map(row => row.missing ? "absent" : "pending") };
    row.digest = hash({ node: row.node, rootIdentity: identity, action, targets: rows, safety: row.safety });
    this.previews.set(row.token, copy(row)); // Preview does not write a journal or a remote hash cache.
    return copy(row);
  }
  async inspect(params) {
    if (!params.node?.root || !["file", "directory"].includes(params.target?.type)) fail("INVALID_REQUEST");
    const result = await this.checked({ node: params.node, root: params.node.root, action: "inventory", target: params.target,
      manifestOnly: params.manifestOnly === true, presenceOnly: params.presenceOnly === true,
      allowMissing: params.allowMissing === true, observeExecutors: params.observeExecutors === true });
    if (params.observeExecutors === true && params.node.kind === "local") {
      result.executorsChecked = true; result.executors = [];
      for (const [key] of this.localExecutions) {
        const [token, index] = key.split(":"), row = this.previews.get(token), target = row?.targets[Number(index)];
        if (row && hash(row.rootIdentity) === hash(result.rootIdentity) && target?.relativePath === params.target.relativePath)
          result.executors.push({ kind: "active_local_transfer" });
      }
    }
    return result;
  }
  /** Read-only observation of a frozen receipt. Never settles audit state or starts a file operation. */
  async check(params) {
    const row = await this.read(params.token), index = params.index;
    if (!Number.isInteger(index) || !row.targets[index]) fail("INVALID_TARGET");
    if (row.observationMode) return this.observe(row, index);
    return this.checked({ node: row.node, root: row.node.root, rootIdentity: row.rootIdentity, target: row.targets[index],
      action: "check", deleted: row.action === "delete", receiptCompleted: row.states[index] === "completed" });
  }
  async confirm(params) {
    const row = await this.read(params.token);
    if (Date.now() > row.expiresAt) fail("PREVIEW_EXPIRED");
    if (params.confirm !== true || params.digest !== row.digest || hash(params.exactTargets) !== hash(row.targets.filter(t => !t.missing).map(t => t.absolutePath))) fail("CONFIRM_REQUIRED");
    if (params.phase !== row.confirmations + 1 || params.phase > (row.action === "delete" ? 2 : 1)) fail("CONFIRM_REQUIRED");
    row.confirmations = params.phase; await this.save(row);
    return { ok: true, token: row.token, digest: row.digest, confirmations: row.confirmations };
  }
  async execute(params) {
    const row = await this.read(params.token);
    if (params.digest !== row.digest || row.confirmations !== (row.action === "delete" ? 2 : 1)) fail("CONFIRM_REQUIRED");
    const index = params.index;
    if (!Number.isInteger(index) || !row.targets[index]) fail("INVALID_TARGET");
    if (row.states[index] === "absent") fail("NOT_AN_EXECUTABLE_TARGET");
    if (row.observationMode) {
      const key = row.token + ":" + index;
      if (row.observationMode === "filesystem" && this.localExecutions.has(key)) return { ok: true, state: "executing" };
      const proof = await this.observe(row, index);
      if (["completed", "executing"].includes(proof.state)) return proof;
      if (proof.state !== "pending") fail("CLEANUP_TARGET_CHANGED");
      if (row.authorizationMode !== "confirmed_paths") await this.activity(row.node);
      const request = { node: row.node, root: row.node.root, rootIdentity: row.rootIdentity,
        action: row.observationMode === "tmux" ? "managed-start" : row.action,
        cleanupAction: row.action, operationId: row.operationId, target: row.targets[index] };
      // A lost response cannot leave a local busy flag that blocks later observations.
      row.states[index] = "executing"; await this.save(row);
      if (row.observationMode === "filesystem") {
        if (this.localExecutions.has(key)) return { ok: true, state: "executing" };
        const execution = this.checked(request); this.localExecutions.set(key, execution);
        try { return await execution; } finally { if (this.localExecutions.get(key) === execution) this.localExecutions.delete(key); }
      }
      return this.checked(request);
    }
    if (this.busy.has(row.token)) fail("OPERATION_BUSY");
    this.busy.add(row.token);
    try {
      return await this.lease(row.node, row.targets, async () => {
        await this.activity(row.node);
        if (row.states[index] === "completed") return { ok: true, alreadyCompleted: true, receipt: row.receipts[index] };
        const request = { node: row.node, root: row.node.root, rootIdentity: row.rootIdentity, action: row.action,
          operationId: row.operationId, target: row.targets[index] };
        if (row.states[index] === "executing") {
          if (row.action === "delete") fail("DELETE_RECEIPT_UNCERTAIN");
          try {
            const settled = await this.checked({ ...request, action: "settle", settledAction: row.action });
            row.states[index] = "completed"; (row.receipts ||= {})[index] = settled.receipt; await this.save(row);
            return { ok: true, receipt: settled.receipt, settled: true };
          } catch (error) {
            if (error.code !== "SOURCE_RECREATED_OR_NOT_MOVED") throw error;
            // The remote lock must have settled; an unchanged source with absent destination can retry.
            const unchanged = await this.checked({ ...request, action: "inspect", archived: row.action === "restore" });
            if (unchanged.target.fingerprint !== request.target.fingerprint || hash(unchanged.rootIdentity) !== hash(row.rootIdentity)) fail("SOURCE_RECREATED_OR_CHANGED");
            row.states[index] = "pending"; await this.save(row);
          }
        }
        // Preflight the complete node batch again before the first mutation.
        for (let i = 0; i < row.targets.length; i++) {
          if (row.states[i] === "completed") continue;
          const result = await this.checked({ ...request, action: "inspect", archived: row.action === "restore", target: row.targets[i] });
          if (hash(result.rootIdentity) !== hash(row.rootIdentity) || Boolean(result.target.missing) !== Boolean(row.targets[i].missing)
            || result.target.fingerprint !== row.targets[i].fingerprint) fail("PREVIEW_CHANGED");
        }
        row.states[index] = "executing"; await this.save(row);
        const result = await this.checked(request);
        row.states[index] = "completed"; (row.receipts ||= {})[index] = result.receipt; await this.save(row);
        return result;
      });
    } finally { this.busy.delete(row.token); }
  }
  async observe(row, index) {
    if (row.observationMode === "filesystem" && this.localExecutions.has(row.token + ":" + index))
      return { ok: true, state: "executing", executor: { kind: "active_local_transfer" } };
    return this.checked({ node: row.node, root: row.node.root, rootIdentity: row.rootIdentity,
      action: "managed-observe", cleanupAction: row.action, localObservation: row.observationMode === "filesystem",
      operationId: row.operationId, target: row.targets[index] });
  }
  async status(params) {
    const row = await this.read(params.token);
    if (row.observationMode) {
      row.observations = [];
      for (let index = 0; index < row.targets.length; index++) {
        try {
          const proof = await this.observe(row, index);
          row.observations.push(proof); row.states[index] = proof.state;
        } catch(error) { row.observations.push({ state: "unknown", queryError: error.message }); row.states[index] = "unknown"; }
      }
    }
    return row;
  }
  /** Settle an already-authorized receipt before coordinator preflight. Never starts a new move. */
  async settle(params) {
    const row = await this.read(params.token), index = params.index, target = row.targets[index];
    if (params.digest !== row.digest || !Number.isInteger(index) || !target || row.confirmations !== (row.action === "delete" ? 2 : 1)) fail("CONFIRM_REQUIRED");
    if (row.observationMode) return this.observe(row, index);
    if (row.action === "delete") fail("DELETE_RECEIPT_UNCERTAIN");
    if (this.busy.has(row.token)) fail("OPERATION_BUSY");
    this.busy.add(row.token);
    try {
      return await this.lease(row.node, row.targets, async () => {
        await this.activity(row.node);
        if (row.states[index] === "completed") { await this.verify(params); return { ok: true, state: "completed", receipt: row.receipts[index] }; }
        if (!["pending", "executing"].includes(row.states[index])) fail("RECEIPT_UNVERIFIED");
        const request = { node: row.node, root: row.node.root, rootIdentity: row.rootIdentity, operationId: row.operationId, target };
        if (row.states[index] === "executing") {
          try {
            const settled = await this.checked({ ...request, action: "settle", settledAction: row.action });
            row.states[index] = "completed"; (row.receipts ||= {})[index] = settled.receipt; await this.save(row);
            return { ok: true, state: "completed", receipt: settled.receipt };
          } catch (error) { if (error.code !== "SOURCE_RECREATED_OR_NOT_MOVED") throw error; }
        }
        const unchanged = await this.checked({ ...request, action: "inspect", archived: row.action === "restore" });
        if (unchanged.target.fingerprint !== target.fingerprint || hash(unchanged.rootIdentity) !== hash(row.rootIdentity)) fail("SOURCE_RECREATED_OR_CHANGED");
        row.states[index] = "pending"; await this.save(row); return { ok: true, state: "pending" };
      });
    } finally { this.busy.delete(row.token); }
  }
  async verify(params) {
    const row = await this.read(params.token), target = row.targets[params.index];
    if (row.observationMode && target) {
      const proof = await this.observe(row, params.index);
      if (proof.state !== "completed") fail("CLEANUP_NOT_VERIFIED");
      return proof;
    }
    if (!target || row.states[params.index] !== "completed") fail("RECEIPT_UNVERIFIED");
    return this.checked({ node: row.node, root: row.node.root, rootIdentity: row.rootIdentity, target, action: "verify", deleted: row.action === "delete" });
  }
}
module.exports = { CleanupFileApi, fail, hash, cleanupRemoteLoader };

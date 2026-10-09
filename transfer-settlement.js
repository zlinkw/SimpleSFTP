"use strict";
const { createHash } = require("node:crypto");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");

// These protocols read project data; they never write or remove project outputs.
const READ_ONLY_SETTLEMENT_METHODS = ["sync.downloadMappedPaths", "sync.projectInventory", "sync.projectTree", "sync.projectFileStats"];

function identityOf(value) {
  if (!value || typeof value !== "object") return undefined;
  const result = {};
  for (const key of ["id", "name", "host", "hostname", "remotePath", "path", "port", "user", "username"])
    if (value[key] !== undefined && value[key] !== null) {
      if (!["string", "number"].includes(typeof value[key]) || String(value[key]).length > 4096) throw new Error("INVALID_TRANSFER_IDENTITY");
      result[key] = value[key];
    }
  return Object.keys(result).length ? result : undefined;
}

// Keep field order identical to the SimpleExperiment request-key protocol.
function retryIdentity(params) {
  const localPath = String(params.localPath || params.localBase || params.workspacePath || "").trim().replace(/[\\/]+/g, "/");
  const identity = {
    localPath: process.platform === "win32" ? localPath.toLowerCase() : localPath,
    remotePath: String(params.remotePath || "").trim(),
    targetId: params.targetId || params.serverId || "", host: params.host || "",
    server: identityOf(params.server), sftp: identityOf(params.sftp),
    source: identityOf(params.source), destination: identityOf(params.destination), target: identityOf(params.target),
  };
  if (JSON.stringify(identity).length > 16384) throw new Error("INVALID_TRANSFER_IDENTITY");
  return identity;
}
function clientRequestKey(method, params) {
  return createHash("sha256").update(JSON.stringify({ method, ...retryIdentity(params) })).digest("hex");
}

function assertLocalProcessesIdle(rows, oldPid, allowCurrentOwner, currentPid = process.pid, oldStartedAt) {
  if (!Array.isArray(rows) || rows.length > 8192 || rows.some(row => !Number.isSafeInteger(row?.ProcessId) || row.ProcessId < 0
    || !Number.isSafeInteger(row.ParentProcessId) || row.ParentProcessId < 0 || typeof row.Name !== "string" || !row.Name || row.Name.length > 260))
    throw new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE");
  const processes = new Map(rows.map(row => [row.ProcessId, row]));
  if (processes.size !== rows.length) throw new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE");
  const checked = new Set();
  for (const row of rows) {
    const chain = new Set();
    let cursor = row;
    while (cursor && cursor.ProcessId !== 0 && !checked.has(cursor.ProcessId)) {
      if (chain.has(cursor.ProcessId)) throw new Error("LOCAL_PROCESS_ANCESTRY_UNAVAILABLE");
      chain.add(cursor.ProcessId);
      cursor = cursor.ParentProcessId === 0 ? undefined : processes.get(cursor.ParentProcessId);
    }
    for (const id of chain) checked.add(id);
  }
  const owner = processes.get(oldPid), createdAt = row => typeof row?.CreationDate === "string" ? Date.parse(row.CreationDate) : NaN;
  const ownerReused = owner && Number.isFinite(oldStartedAt) && createdAt(owner) > oldStartedAt;
  if (owner && !ownerReused && !(allowCurrentOwner && oldPid === currentPid))
    throw new Error("LOCAL_TRANSFER_OR_OWNER_STILL_ACTIVE");
  let unrelatedTransports = 0;
  for (const transport of rows.filter(row => /^(ssh|scp|sftp|plink|rsync|tar|gzip|pigz|zstd)\.exe$/i.test(row.Name))) {
    let cursor = transport, birthChainVerified = true;
    const seen = new Set();
    while (true) {
      if (seen.has(cursor.ProcessId)) throw new Error("LOCAL_PROCESS_ANCESTRY_UNAVAILABLE");
      seen.add(cursor.ProcessId);
      if (cursor.ProcessId === oldPid || cursor.ParentProcessId === oldPid) {
        // A reused owner PID is a different process generation. A child born
        // before that replacement (or without birth evidence) remains guarded.
        if (ownerReused && createdAt(cursor) >= createdAt(owner)) break;
        throw new Error("LOCAL_TRANSFER_OR_OWNER_STILL_ACTIVE");
      }
      if (oldPid !== currentPid && cursor.ProcessId === currentPid) {
        // A transport born under this different, live producer cannot belong
        // to the abandoned producer. Do not require its exited Windows login
        // ancestors to remain alive; verify every child/parent generation.
        if (!birthChainVerified) throw new Error("LOCAL_PROCESS_ANCESTRY_UNAVAILABLE");
        break;
      }
      if (cursor.ProcessId === 0 || cursor.ParentProcessId === 0) break;
      const parent = processes.get(cursor.ParentProcessId);
      if (!parent || createdAt(parent) > createdAt(cursor)) throw new Error("LOCAL_PROCESS_ANCESTRY_UNAVAILABLE");
      birthChainVerified &&= Number.isFinite(createdAt(parent)) && Number.isFinite(createdAt(cursor));
      cursor = parent;
    }
    unrelatedTransports++;
  }
  // A complete census must contain this live producer. Empty or filtered
  // snapshots cannot prove the old owner/children absent.
  if (!processes.has(currentPid)) throw new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE");
  return { localOwnerExited: !owner || Boolean(ownerReused), localTransportCount: 0, unrelatedTransportCount: unrelatedTransports };
}

async function localTransferExitProof(instanceId, allowCurrentOwner = false) {
  // Census the original owner's process tree, not all transports on the PC.
  // Missing ancestry, a live original owner, and old descendants still deny
  // replay. Creation time distinguishes a reused PID from the old generation.
  const match = /^([1-9][0-9]{0,9}):(.+)$/.exec(String(instanceId));
  const oldStartedAt = match ? Date.parse(match[2]) : NaN;
  if (process.platform !== "win32" || !match || !Number.isFinite(oldStartedAt)) throw new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE");
  const oldPid = Number(match[1]);
  const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $items=@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CreationDate); if($items.Count -gt 8192){throw 'LOCAL_PROCESS_PROOF_UNAVAILABLE'}; ConvertTo-Json -Compress -InputObject @($items)`;
  const output = await new Promise((resolve, reject) => execFile("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", command],
    { windowsHide: true, timeout: 6000, maxBuffer: 1048576, encoding: "utf8" }, (error, stdout) => error ? reject(new Error("LOCAL_PROCESS_PROOF_UNAVAILABLE")) : resolve(stdout)));
  const rows = JSON.parse(String(output));
  return assertLocalProcessesIdle(rows, oldPid, allowCurrentOwner, process.pid, oldStartedAt);
}

function settlementProbeCommand(root, quote) {
  const source = fs.readFileSync(path.join(__dirname, "transfer-settlement-probe.py"), "utf8");
  const encoded = zlib.deflateSync(Buffer.from(source, "utf8")).toString("base64");
  const loader = "import base64,zlib,sys; code=zlib.decompress(base64.b64decode(sys.argv[1])); sys.argv=sys.argv[1:]; exec(compile(code,'simple_sftp_settlement_probe','exec'))";
  const receiverHash = require("node:crypto").createHash("sha256")
    .update(fs.readFileSync(path.join(__dirname, "staged-tar-receive.py"))).digest("hex");
  return `python3 -B -c ${quote(loader)} ${quote(encoded)} ${quote(root)} ${quote(receiverHash)} ${quote("staged-tar-v1")}`;
}

module.exports = { READ_ONLY_SETTLEMENT_METHODS, clientRequestKey, retryIdentity, assertLocalProcessesIdle, localTransferExitProof, settlementProbeCommand };

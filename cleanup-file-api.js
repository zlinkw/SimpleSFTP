"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const { atomicWriteText } = require("./state-store");
const hash = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
// Binary numbers avoid JavaScript/Python decimal and exponent formatting differences.
const canonical = value => typeof value === "number" ? "n" + (() => {
  if (!Number.isFinite(value)) fail("CLEANUP_INPUT_CHANGED");
  const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value === 0 ? 0 : value); return bytes.toString("hex");
})() : Array.isArray(value) ? "[" + value.map(row => canonical(row) ?? "null").join(",") + "]" : value && typeof value === "object"
  ? "{" + Object.keys(value).filter(key => value[key] !== undefined).sort((a,b) => Buffer.compare(Buffer.from(a),Buffer.from(b)))
    .map(key => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}" : JSON.stringify(value);
const targetHash = value => crypto.createHash("sha256").update(canonical(value)).digest("hex");
const copy = value => JSON.parse(JSON.stringify(value));
// The only remote deletion chain runs a content-addressed engine program that
// was pinned into the protected managed program area; requests never carry a
// copy of the source through argv. Commands stay far below the Windows argv
// quoting budget because only a fixed short invocation crosses the wire.
const REMOTE_COMMAND_BUDGET = 20000;
const RUNTIME_PROGRAM_DIR = "clean_dir/.operations/managed";
function runtimeProgramRelativePath(sha256) {
  if (!/^[a-f0-9]{64}$/.test(String(sha256))) fail("INVALID_REQUEST");
  return RUNTIME_PROGRAM_DIR + "/runtime-" + sha256 + ".py";
}
function runtimePrepareRequest({ root, source, rootIdentity }) {
  if (typeof source !== "string" || !source || Buffer.byteLength(source) > 262144) fail("INVALID_REQUEST");
  const sha256 = crypto.createHash("sha256").update(source).digest("hex");
  const request = { action: "runtime-prepare", root, runtimeSha256: sha256, runtimeSource: source };
  // The identity travels as the real {path,device,inode,machine,user} object
  // contract when one is already known; the engine and installer must observe
  // the very same verified root or the install is refused. A wrong shape is
  // an explicit error, never a silently dropped field.
  if (rootIdentity !== undefined && rootIdentity !== null) {
    if (typeof rootIdentity !== "object" || typeof rootIdentity.path !== "string" || !rootIdentity.path
      || typeof rootIdentity.device !== "string" || typeof rootIdentity.inode !== "string") fail("INVALID_REQUEST");
    request.rootIdentity = copy(rootIdentity);
  }
  return { sha256, programRelativePath: runtimeProgramRelativePath(sha256), request };
}
// The bounded short installer never creates before checking: every component
// of the managed program area is opened through a pinned O_NOFOLLOW directory
// fd chain (a missing level is only created after its parent fd is proven),
// mounts and reparse points are refused, the directory owner must be the
// executing user, and the program itself is created O_EXCL with a write loop
// until the last byte, fsync and full read-back. First installs bind and
// return the verified root identity; a supplied identity must match exactly.
const RUNTIME_PREPARE_BOOTSTRAP = [
  "import hashlib,json,os,socket,stat,sys",
  "def out(code,detail=''):",
  "    sys.stdout.write(json.dumps({'ok':False,'error':{'code':code,'message':detail}}));raise SystemExit(1)",
  "def done(state):",
  "    sys.stdout.write(json.dumps({'ok':True,'state':state,'runtimeSha256':sha,'programRelativePath':'" + RUNTIME_PROGRAM_DIR + "/runtime-'+sha+'.py','rootIdentity':identity}));raise SystemExit(0)",
  "try:",
  "    req=json.loads(sys.stdin.buffer.read(4194304).rstrip(b" + "\"\\x00\"" + ").decode('utf-8'))",
  "except Exception:",
  "    out('INVALID_REQUEST')",
  "if not isinstance(req,dict) or req.get('action')!='runtime-prepare':out('INVALID_REQUEST')",
  "src=req.get('runtimeSource');sha=req.get('runtimeSha256')",
  "if not isinstance(src,str) or not isinstance(sha,str):out('INVALID_REQUEST')",
  "code=src.encode('utf-8')",
  "if len(code)==0 or len(code)>262144 or len(sha)!=64 or hashlib.sha256(code).hexdigest()!=sha:out('RUNTIME_CODE_MISMATCH')",
  "root=req.get('root')",
  "if not isinstance(root,str) or not os.path.isabs(root) or chr(0) in root or '..' in root.replace(chr(92),'/').split('/'):out('UNSAFE_ROOT')",
  "if os.path.normpath(os.path.realpath(root))!=os.path.normpath(root) or not os.path.isdir(root):out('ROOT_IDENTITY_CHANGED')",
  "cursor=root",
  "while cursor!=os.path.dirname(cursor):",
  "    info=os.lstat(cursor)",
  "    if stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0)&1024:out('LINK_OR_REPARSE_POINT',cursor)",
  "    cursor=os.path.dirname(cursor)",
  "info=os.stat(root)",
  "identity={'path':root,'device':str(info.st_dev),'inode':str(info.st_ino),'machine':socket.gethostname(),'user':str(os.getuid()) if hasattr(os,'getuid') else os.environ.get('USERNAME','')}",
  "if req.get('rootIdentity') is not None and req['rootIdentity']!=identity:out('ROOT_IDENTITY_CHANGED')",
  "root_dev=info.st_dev",
  "import re as _re",
  "mounts=set()",
  "try:",
  "    if os.path.exists('/proc/self/mountinfo'):",
  "        with open('/proc/self/mountinfo','r',encoding='utf-8') as stream:",
  "            mounts={os.path.abspath(_re.sub(r'\\\\([0-7]{3})',lambda m:chr(int(m.group(1),8)),line.split()[4])) for line in stream if len(line.split())>4}",
  "except OSError:",
  "    pass",
  "DIRS=('clean_dir','.operations','managed')",
  "def fail_open(error,chain):",
  "    out('LINK_OR_REPARSE_POINT' if getattr(error,'errno',None) in (40,62) else 'RUNTIME_PROGRAM_PREPARE_FAILED',chain+':'+str(error))",
  "def pinned_chain():",
  "    flags=getattr(os,'O_DIRECTORY',0)|getattr(os,'O_NOFOLLOW',0)",
  "    fd=os.open(root,os.O_RDONLY|flags)",
  "    info=os.fstat(fd)",
  "    if not stat.S_ISDIR(info.st_mode) or info.st_dev!=root_dev:out('MOUNT_ESCAPE',root)",
  "    chain=root",
  "    for name in DIRS:",
  "        chain=chain+'/'+name",
  "        if os.path.ismount(chain) or chain in mounts:out('MOUNT_ESCAPE',chain)",
  "        try:",
  "            child=os.open(name,os.O_RDONLY|flags,dir_fd=fd)",
  "        except FileNotFoundError:",
  "            try:",
  "                os.mkdir(name,mode=0o700,dir_fd=fd)",
  "            except FileExistsError:",
  "                pass",
  "            except OSError as error:",
  "                out('RUNTIME_PROGRAM_PREPARE_FAILED',chain+':'+str(error))",
  "            try:",
  "                child=os.open(name,os.O_RDONLY|flags,dir_fd=fd)",
  "            except OSError as error:",
  "                fail_open(error,chain)",
  "        except OSError as error:",
  "            fail_open(error,chain)",
  "        info=os.fstat(child)",
  "        if not stat.S_ISDIR(info.st_mode) or info.st_dev!=root_dev:out('MOUNT_ESCAPE',chain)",
  "        if os.path.ismount(chain) or chain in mounts:out('MOUNT_ESCAPE',chain)",
  "        if hasattr(os,'getuid') and info.st_uid!=os.getuid():out('RUNTIME_PROGRAM_PREPARE_FAILED',chain+' 归属不符')",
  "        os.close(fd)",
  "        fd=child",
  "    return fd",
  "def plain_chain():",
  "    chain=root",
  "    for name in DIRS:",
  "        chain=chain+'/'+name",
  "        if os.path.lexists(chain):",
  "            info=os.lstat(chain)",
  "            if stat.S_ISLNK(info.st_mode) or getattr(info,'st_file_attributes',0)&1024 or not stat.S_ISDIR(info.st_mode):out('LINK_OR_REPARSE_POINT',chain)",
  "            if info.st_dev!=root_dev or os.path.ismount(chain) or chain in mounts:out('MOUNT_ESCAPE',chain)",
  "            if hasattr(os,'getuid') and info.st_uid!=os.getuid():out('RUNTIME_PROGRAM_PREPARE_FAILED',chain+' 归属不符')",
  "        else:",
  "            try:",
  "                os.mkdir(chain,mode=0o700)",
  "            except FileExistsError:",
  "                pass",
  "            except OSError as error:",
  "                out('RUNTIME_PROGRAM_PREPARE_FAILED',chain+':'+str(error))",
  "            if not stat.S_ISDIR(os.lstat(chain).st_mode):out('LINK_OR_REPARSE_POINT',chain)",
  "    return None",
  "try:",
  "    dirfd=pinned_chain()",
  "except (NotImplementedError,ValueError,AttributeError):",
  "    dirfd=plain_chain()",
  "progname='runtime-'+sha+'.py'",
  "prog=os.path.join(root,'clean_dir','.operations','managed',progname)",
  "def verify_existing():",
  "    if dirfd is None:",
  "        info=os.lstat(prog)",
  "        if os.path.islink(prog) or not os.path.isfile(prog) or info.st_nlink!=1 or info.st_size!=len(code):out('RUNTIME_PROGRAM_MISMATCH',prog)",
  "        handle=open(prog,'rb')",
  "    else:",
  "        try:",
  "            pfd=os.open(progname,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0),dir_fd=dirfd)",
  "        except OSError as error:",
  "            fail_open(error,prog)",
  "        info=os.fstat(pfd)",
  "        if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1 or info.st_size!=len(code):out('RUNTIME_PROGRAM_MISMATCH',prog)",
  "        handle=os.fdopen(pfd,'rb')",
  "    same=handle.read()==code",
  "    handle.close()",
  "    if not same:out('RUNTIME_PROGRAM_MISMATCH',prog)",
  "if dirfd is None:",
  "    if os.path.islink(prog):out('LINK_OR_REPARSE_POINT',prog)",
  "    if os.path.lexists(prog):",
  "        verify_existing();done('verified')",
  "else:",
  "    try:",
  "        _probe=os.open(progname,os.O_RDONLY|getattr(os,'O_NOFOLLOW',0),dir_fd=dirfd)",
  "        os.close(_probe)",
  "        verify_existing();done('verified')",
  "    except FileNotFoundError:",
  "        pass",
  "    except OSError as error:",
  "        fail_open(error,prog)",
  "try:",
  "    fd2=os.open(prog if dirfd is None else progname,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600) if dirfd is None else os.open(progname,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600,dir_fd=dirfd)",
  "except FileExistsError:",
  "    verify_existing();done('verified')",
  "except OSError as error:",
  "    fail_open(error,prog)",
  "view=memoryview(code);written=0",
  "while written<len(code):",
  "    written+=os.write(fd2,view[written:])",
  "os.fsync(fd2)",
  "info=os.fstat(fd2)",
  "if not stat.S_ISREG(info.st_mode) or info.st_nlink!=1:out('RUNTIME_PROGRAM_MISMATCH',prog)",
  "os.close(fd2)",
  "verify_existing()",
  "done('installed')",
].join("\n");
function remoteRuntimePrepareCommand(shellQuote) {
  const command = "python3 -B -c " + shellQuote(RUNTIME_PREPARE_BOOTSTRAP);
  if (command.length > REMOTE_COMMAND_BUDGET) fail("REMOTE_COMMAND_TOO_LARGE");
  return command;
}
function remoteRuntimeCommand(programPath, shellQuote) {
  if (typeof programPath !== "string" || !programPath.startsWith("/") || programPath.includes("\0")) fail("UNSAFE_ROOT");
  const command = "python3 -B -X utf8 " + shellQuote(programPath);
  if (command.length > REMOTE_COMMAND_BUDGET) fail("REMOTE_COMMAND_TOO_LARGE");
  return command;
}
function fail(code, message = code, details = {}) { const error = new Error(message); error.code = code; error.apiCode = code === "CONFIRM_REQUIRED" ? 2001 : 2010; error.apiData = { code };
  for (const key of ["blockingPath", "reason"]) if (typeof details[key] === "string" && details[key]) error.apiData[key] = details[key].slice(0, 4096);
  throw error; }

/** A path capability authorizes one frozen batch, never a later or remembered path. */
class CleanupFileApi {
  constructor({ storageRoot, transport, activity, lease }) {
    this.storageRoot = storageRoot; this.transport = transport; this.activity = activity; this.lease = lease;
    this.previews = new Map(); this.busy = new Set(); this.localExecutions = new Map();
  }
  async checked(request) {
    const value = await this.transport(copy(request));
    if (!value?.ok) fail(value?.error?.code || "UNVERIFIED_RESPONSE", value?.error?.message, value?.error || {});
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
    const tmuxSessionPrefix = String(params.tmuxSessionPrefix || "simple").trim();
    if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(tmuxSessionPrefix)) fail("INVALID_TMUX_SESSION_PREFIX");
    for (const [token, preview] of this.previews) if (Date.now() > preview.expiresAt) this.previews.delete(token);
    if (this.previews.size >= 4096) fail("CLEANUP_PREVIEW_CAPACITY_EXCEEDED");
    const { node, action = "move", targets } = params;
    if (params.authorizationMode !== undefined && params.authorizationMode !== "confirmed_paths") fail("INVALID_AUTHORIZATION_MODE");
    const pathOnly = params.authorizationMode === "confirmed_paths";
    if (pathOnly && action !== "delete") fail("INVALID_ACTION");
    const observationMode = params.observationMode === "managed_tmux" || pathOnly ? node?.kind === "local" ? "filesystem" : "tmux" : undefined;
    if (!node?.root || !["move", "delete", "restore", "isolate"].includes(action) || !Array.isArray(targets) || !targets.length || targets.length > 500) fail("INVALID_REQUEST");
    if (!pathOnly) await this.activity(node);
    const rows = []; let identity;
    for (const original of targets) {
      const target = { ...original, ...(observationMode ? { activityEvidenceMode: "managed_tmux" } : {}) };
      if (pathOnly) { target.authorizationMode = "confirmed_paths"; delete target.expectedOwner; delete target.expectedSha256; }
      else if (target.authorizationMode !== undefined) fail("INVALID_AUTHORIZATION_MODE");
      if (!target || !["file", "directory"].includes(target.type)) fail("UNCERTAIN_TYPE");
      if (target.archiveBatch !== undefined && !/^job-[a-f0-9]{48}$/.test(target.archiveBatch)) fail("UNSAFE_ARCHIVE_BATCH");
      // C1: a controlled fast isolation always lands in an explicit job batch
      // derived from this rerun intent; recovery of the same intent is stable.
      if (action === "isolate" && target.archiveBatch === undefined) fail("UNSAFE_ARCHIVE_BATCH");
      if (target.requiredInputs !== undefined && (!Array.isArray(target.requiredInputs) || target.requiredInputs.length > 200
        || target.requiredInputs.some(name => typeof name !== "string" || !name || name.length > 4096
          || /[\\\x00-\x1f:*?[\]{}]/.test(name) || name.startsWith("/")
          || name.split("/").some(part => part === "" || part === "." || part === "..")))) fail("INVALID_REQUEST");
      // C4: confirmed-path permanent deletion reaches only registered isolated
      // artifact subtrees; the clean_dir root, MANIFEST, locks and runtime stay out.
      const archivedDelete = pathOnly && /^clean_dir\/job-[a-f0-9]{48}\//.test(String(target.relativePath || ""));
      if (pathOnly && String(target.relativePath || "").startsWith("clean_dir/") && !archivedDelete) fail("UNSAFE_DESTINATION");
      const archivePrefix = "clean_dir/" + (target.archiveBatch ? target.archiveBatch + "/" : "");
      if (archivedDelete ? target.destination !== target.relativePath
        : action === "restore" ? !target.relativePath?.startsWith(archivePrefix) || target.destination !== target.relativePath.slice(archivePrefix.length)
        : target.destination !== archivePrefix + target.relativePath) fail("UNSAFE_DESTINATION");
      const result = await this.checked({ node, root: node.root, action: "inspect", archived: action === "restore",
        ...(action === "isolate" ? { isolate: true } : {}), target });
      if (identity && hash(identity) !== hash(result.rootIdentity)) fail("ROOT_IDENTITY_CHANGED");
      identity = result.rootIdentity;
      rows.push({ ...copy(target), ...result.target, destination: target.destination });
    }
    const row = { token: crypto.randomBytes(24).toString("hex"), operationId: "cleanup-" + crypto.randomBytes(16).toString("hex"), node: copy(node), rootIdentity: identity,
      action, observationMode, authorizationMode: pathOnly ? "confirmed_paths" : undefined, targets: rows, safety: { gitRepositoryAncestors: true, readOnlyReceiptCheck: true, formalJobOwner: true, immutableArchiveBatch: true, batchPreviewCapacity: 4096, managedObservation: 1, confirmedPathDeletion: 1, confirmedPathMetadata: 1, confirmedPathNestedRepositories: 1, isolateFast: action === "isolate" ? 1 : undefined, requiredInputGuard: action === "isolate" ? 1 : undefined, registeredIsolationDeletion: 1, subtreeSingleWriter: 1, serverWindowSelfClose: 1, chunkedFrozenManifest: 1, pinnedRuntimeProgram: 1, handleScan: pathOnly ? "confirmed_paths" : observationMode ? "managed_tmux" : "visible_same_user_processes" }, expiresAt: Date.now() + 30 * 60 * 1000, confirmations: 0, states: rows.map(row => row.missing ? "absent" : "pending") };
    row.tmuxSessionPrefix = tmuxSessionPrefix;
    row.targetDigests = rows.map(targetHash);
    row.digest = hash({ node: row.node, rootIdentity: identity, action, targets: rows, safety: row.safety, tmuxSessionPrefix });
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
        cleanupAction: row.action, operationId: row.operationId, target: row.targets[index],
        tmuxSessionPrefix: row.tmuxSessionPrefix || params.tmuxSessionPrefix || "simple" };
      // A lost response cannot leave a local busy flag that blocks later observations.
      row.states[index] = "executing"; await this.save(row);
      if (row.observationMode === "filesystem") {
        if (this.localExecutions.has(key)) return { ok: true, state: "executing" };
        const execution = this.checked(request); this.localExecutions.set(key, execution);
        try { return await execution; } finally { if (this.localExecutions.get(key) === execution) this.localExecutions.delete(key); }
      }
      try { return await this.checked(request); }
      catch (error) {
        // A live OS mutation lock refused admission before any window was
        // created. The client may retry this same confirmed request, while
        // lifecycle checks continue reading actual tmux/filesystem evidence.
        if (row.observationMode === "tmux" && error.code === "OPERATION_BUSY") {
          row.states[index] = "pending"; await this.save(row);
          return { ok: true, state: "waiting", reason: "CLEANUP_MUTATION_BUSY", notStarted: true };
        }
        throw error;
      }
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
            const unchanged = await this.checked({ ...request, action: "inspect", archived: row.action === "restore",
              ...(row.action === "isolate" ? { isolate: true } : {}) });
            if (unchanged.target.fingerprint !== request.target.fingerprint || hash(unchanged.rootIdentity) !== hash(row.rootIdentity)) fail("SOURCE_RECREATED_OR_CHANGED");
            row.states[index] = "pending"; await this.save(row);
          }
        }
        // Preflight the complete node batch again before the first mutation.
        for (let i = 0; i < row.targets.length; i++) {
          if (row.states[i] === "completed") continue;
          const result = await this.checked({ ...request, action: "inspect", archived: row.action === "restore",
            ...(row.action === "isolate" ? { isolate: true } : {}), target: row.targets[i] });
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
    const frozen = row.targets[index];
    const compact = row.observationMode === "tmux" && ["executing", "completed"].includes(row.states[index]);
    const target = compact ? Object.fromEntries(["relativePath", "destination", "type", "fingerprint", "contentFingerprint", "inode", "fingerprintMode", "authorizationMode", "chunked", "count"]
      .filter(key => frozen[key] !== undefined).map(key => [key, frozen[key]])) : frozen;
    return this.checked({ node: row.node, root: row.node.root, rootIdentity: row.rootIdentity,
      action: "managed-observe", cleanupAction: row.action, localObservation: row.observationMode === "filesystem",
      operationId: row.operationId, target,
      ...(compact ? { frozenTargetDigest: row.targetDigests?.[index] || targetHash(frozen) } : {}) });
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
        const unchanged = await this.checked({ ...request, action: "inspect", archived: row.action === "restore",
          ...(row.action === "isolate" ? { isolate: true } : {}) });
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
module.exports = { CleanupFileApi, fail, hash, runtimePrepareRequest, runtimeProgramRelativePath, RUNTIME_PREPARE_BOOTSTRAP, remoteRuntimePrepareCommand, remoteRuntimeCommand, REMOTE_COMMAND_BUDGET };

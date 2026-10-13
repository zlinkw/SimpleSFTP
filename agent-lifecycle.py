"""Restricted auxiliary Agent lifecycle protocol. Never signals process groups or tmux."""
import contextlib
import hashlib
import json
import os
import pathlib
import signal
import socket
import subprocess
import sys
import time
import urllib.request
import uuid


class AgentLifecycleError(RuntimeError):
    def __init__(self, code, detail=""):
        self.code = code
        super().__init__(code + (": " + str(detail) if detail else ""))


def lifecycle_json(path):
    if not os.path.exists(path):
        return {}
    if os.path.islink(path) or not os.path.isfile(path) or os.stat(path).st_size > 65536:
        raise AgentLifecycleError("AGENT_OWNER_INVALID", path)
    with open(path, encoding="utf-8") as stream:
        value = json.load(stream)
    if not isinstance(value, dict):
        raise AgentLifecycleError("AGENT_OWNER_INVALID", path)
    return value


def lifecycle_save(path, value):
    # Owner files are plugin metadata. O_NOFOLLOW prevents replacement through links.
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as stream:
        json.dump(value, stream, ensure_ascii=False)
        stream.flush()
        os.fsync(stream.fileno())


def lifecycle_canonical(raw, exists=True):
    p = pathlib.Path(str(raw))
    if not p.is_absolute() or ".." in p.parts or any(ch in str(p) for ch in "*?\n\r\0"):
        raise AgentLifecycleError("AGENT_PATH_INVALID", raw)
    for item in (p, *p.parents):
        if item.is_symlink():
            raise AgentLifecycleError("AGENT_PATH_LINK", raw)
    resolved = str(p.resolve(strict=exists))
    if resolved in ("/", os.path.expanduser("~")):
        raise AgentLifecycleError("AGENT_PATH_INVALID", raw)
    return resolved


def lifecycle_machine():
    def read(p):
        try:
            return pathlib.Path(p).read_text(encoding="utf-8").strip()
        except OSError:
            return ""
    values = [read("/etc/machine-id"), socket.gethostname(), os.readlink("/proc/self/ns/mnt"),
              os.readlink("/proc/self/ns/pid"), sorted(str(p) for p in pathlib.Path("/dev").glob("nvidia[0-9]*")),
              os.environ.get("CUDA_VISIBLE_DEVICES"), os.environ.get("NVIDIA_VISIBLE_DEVICES")]
    return hashlib.sha256(json.dumps(values, sort_keys=True).encode()).hexdigest()


def lifecycle_contract(params):
    root = lifecycle_canonical(params["projectDir"])
    install = lifecycle_canonical(params["installDir"], exists=False)
    namespace = os.path.basename(root) + "." + hashlib.sha256(root.encode()).hexdigest()[:16]
    state = lifecycle_canonical(os.path.join(install, "state", "projects", namespace), exists=False)
    mode = params.get("mode")
    worker = str(params.get("workerId") or "")
    if mode not in ("worker_telemetry", "hub_control") or (mode == "worker_telemetry" and not worker):
        raise AgentLifecycleError("AGENT_IDENTITY_REQUIRED")
    host = str(params.get("host") or "")
    if host not in ("localhost", "127.0.0.1", "::1"):
        import ipaddress
        try:
            if not ipaddress.ip_address(host).is_loopback:
                raise ValueError()
        except ValueError:
            raise AgentLifecycleError("AGENT_BIND_INVALID", host)
    port = int(params["port"])
    if not 1 <= port <= 65535:
        raise AgentLifecycleError("AGENT_BIND_INVALID")
    return {"schemaVersion": 1, "workerId": worker, "mode": mode, "projectDir": root,
            "installDir": install, "stateDir": state, "condaEnv": str(params.get("condaEnv") or ""),
            "machine": lifecycle_machine(), "uid": os.getuid(), "host": host, "port": port,
            "tokenConfigured": bool(params.get("agentToken"))}


def lifecycle_check_owner(contract):
    owner = lifecycle_json(os.path.join(contract["stateDir"], "agent.owner.json"))
    if owner:
        fields = [key for key in contract if owner.get(key) != contract[key]]
        if fields:
            raise AgentLifecycleError("AGENT_STATE_OWNER_CONFLICT", ",".join(fields))
    elif os.path.isdir(contract["stateDir"]) and set(os.listdir(contract["stateDir"])) - {"agent.owner.lock"}:
        # Legacy state has no machine proof. Explicit migration is required; never adopt it.
        raise AgentLifecycleError("AGENT_LEGACY_STATE_UNVERIFIED", contract["stateDir"])
    return owner


def lifecycle_process(pid):
    try:
        base = pathlib.Path("/proc") / str(int(pid))
        stat = (base / "stat").read_text(encoding="utf-8").split(") ", 1)[1].split()
        if stat[0] == "Z":
            return {}
        return {"pid": int(pid), "start": stat[19], "exe": os.path.realpath(base / "exe"),
                "argv": (base / "cmdline").read_bytes().decode("utf-8").split("\0")[:-1],
                "uid": base.stat().st_uid}
    except (OSError, ValueError, IndexError):
        return {}


def lifecycle_health(contract, token=""):
    host = contract["host"]
    address = "[" + host + "]" if ":" in host else host
    url = "http://" + address + ":" + str(contract["port"]) + "/api/health"
    try:
        # Ignore login shell proxy variables for the configured loopback endpoint.
        request = urllib.request.Request(url, headers={"X-Simple-Agent-Token": token} if token else {})
        response = urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request, timeout=1)
        data = response.read(65537)
        if len(data) > 65536:
            raise AgentLifecycleError("AGENT_HEALTH_INVALID")
        return json.loads(data)
    except (OSError, ValueError):
        return {}


def lifecycle_verify_running(contract, health, process):
    instance = health.get("agentIdentity") or {}
    differences = [key for key in contract if instance.get(key) != contract[key]]
    if health.get("agentLifecycleProtocol") != 1 or health.get("schemaVersion") != 1:
        differences.append("capabilities")
    actual = lifecycle_process(process.get("pid", 0))
    if not process or not actual or actual != process.get("process"):
        differences.append("processIdentity")
    if instance.get("pid") != process.get("pid") or instance.get("nonce") != process.get("nonce"):
        differences.append("instance")
    if differences:
        raise AgentLifecycleError("AGENT_PROCESS_UNVERIFIED", ",".join(differences))
    return actual


def lifecycle_python(contract):
    env = contract["condaEnv"]
    if env.startswith("/"):
        candidate = pathlib.Path(env) / "bin" / "python"
        if not candidate.is_file():
            raise AgentLifecycleError("AGENT_CONDA_UNAVAILABLE", env)
        return str(candidate)
    if not env:
        return sys.executable
    import shlex
    command = "conda run -n " + shlex.quote(env) + " python -c " + shlex.quote("import sys; print(sys.executable)")
    completed = subprocess.run(["bash", "-lc", command], capture_output=True, text=True, timeout=10)
    lines = completed.stdout.strip().splitlines()
    if completed.returncode or not lines or not os.path.isfile(lines[-1]):
        raise AgentLifecycleError("AGENT_CONDA_UNAVAILABLE", env)
    return lines[-1]


def lifecycle_files(contract, params):
    hashes = params.get("files") or {}
    runtime = os.path.join(contract["installDir"], "simple_cluster", "runtime")
    result = {}
    for name in ("cluster_agent.py", "cluster_scheduler.py"):
        p = lifecycle_canonical(os.path.join(runtime, name), exists=False)
        if not os.path.isfile(p):
            result[name] = ""
            continue
        if os.stat(p).st_size > 8 * 1024 * 1024:
            raise AgentLifecycleError("AGENT_RUNTIME_INVALID", name)
        with open(p, "rb") as stream:
            digest_state = hashlib.sha256()
            for chunk in iter(lambda: stream.read(65536), b""):
                digest_state.update(chunk)
            digest = digest_state.hexdigest()
        result[name] = digest
        if hashes.get(name) and hashes[name] != digest:
            raise AgentLifecycleError("AGENT_RUNTIME_HASH_MISMATCH", name)
    return result


def lifecycle_service_guard(args, version):
    import fcntl
    # Held for the entire Agent process, before its first task/cache/state mutation.
    params = {"projectDir": args.project_dir, "installDir": os.environ.get("SIMPLE_EXPERIMENT_AGENT_INSTALL_DIR") or os.path.dirname(os.path.dirname(os.path.dirname(__file__))),
              "mode": args.mode, "workerId": args.worker_id, "host": args.host, "port": args.port,
              "condaEnv": os.environ.get("SIMPLE_EXPERIMENT_CONDA_ENV", ""), "agentToken": getattr(args, "token", "") or os.environ.get("SIMPLE_EXPERIMENT_AGENT_TOKEN", "")}
    contract = lifecycle_contract(params)
    alternate_state = getattr(args, "state_dir", "") or os.environ.get("SIMPLE_EXPERIMENT_AGENT_STATE_DIR", "")
    if alternate_state and lifecycle_canonical(alternate_state, exists=False) != contract["stateDir"]:
        raise AgentLifecycleError("AGENT_STATE_DIR_UNMANAGED")
    lifecycle_check_owner(contract)
    os.makedirs(contract["stateDir"], exist_ok=True)
    lock = os.open(os.path.join(contract["stateDir"], "agent.owner.lock"), os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    try:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        lifecycle_check_owner(contract)
        lifecycle_save(os.path.join(contract["stateDir"], "agent.owner.json"), contract)
    except BaseException:
        os.close(lock)
        raise
    identity = dict(contract, pid=os.getpid(), nonce=os.environ.get("SIMPLE_EXPERIMENT_AGENT_NONCE") or uuid.uuid4().hex,
                    version=version, python=os.path.realpath(sys.executable), runtimeFiles=lifecycle_files(contract, {}))
    lifecycle_save(os.path.join(contract["stateDir"], "agent.process.json"),
                   {"pid": identity["pid"], "nonce": identity["nonce"], "process": lifecycle_process(identity["pid"])})
    return lock, identity


def lifecycle_inspect(params):
    contract = lifecycle_contract(params)
    try:
        lifecycle_check_owner(contract)
    except AgentLifecycleError as error:
        if error.code != "AGENT_LEGACY_STATE_UNVERIFIED":
            raise
        # Read-only, fixed small metadata evidence. Never adopt legacy state or
        # expose process commands, credentials, arbitrary files or entire configs.
        fields = {"agent.session.json": ("agentVersion", "startedAt", "agentInstallDir", "agentStateDir", "tokenConfigured"),
                  "worker_availability.json": ("schemaVersion", "workerId", "projectId", "projectRoot", "generatedAt", "agentVersion", "status"),
                  "gpu_snapshot.json": ("schemaVersion", "workerId", "projectId", "projectRoot", "generatedAt", "agentVersion")}
        metadata = []
        for name, allowed in fields.items():
            filename = os.path.join(contract["stateDir"], name)
            value = lifecycle_json(filename)
            if not os.path.exists(filename):
                continue
            with open(filename, "rb") as stream:
                raw = stream.read(65537)
            if len(raw) > 65536:
                raise AgentLifecycleError("AGENT_OWNER_INVALID", filename)
            metadata.append({"path": filename, "bytes": len(raw), "sha256": hashlib.sha256(raw).hexdigest(),
                             "values": {key: value[key] for key in allowed if key in value}})
        health = lifecycle_health(contract, params.get("agentToken") or "")
        return {"ok": False, "code": error.code, "error": str(error), "evidence": {
            "stateDir": contract["stateDir"], "metadata": metadata, "requiresExplicitMigration": True,
            "health": {key: health[key] for key in ("projectRoot", "agentStateDir", "agentInstallDir", "runtimeVersion", "mode", "startedAt") if key in health}}}
    files = lifecycle_files(contract, {**params, "files": {}})
    health = lifecycle_health(contract, params.get("agentToken") or "")
    record = lifecycle_json(os.path.join(contract["stateDir"], "agent.process.json"))
    actual = lifecycle_process(record.get("pid", 0))
    if health:
        lifecycle_verify_running(contract, health, record)
    elif actual:
        if actual != record.get("process"):
            raise AgentLifecycleError("AGENT_PROCESS_UNVERIFIED")
        raise AgentLifecycleError("AGENT_UNHEALTHY_OWNED_PROCESS", str(actual["pid"]))
    tasks = lifecycle_json(os.path.join(contract["stateDir"], "worker_task_snapshot.json")).get("tasks", [])
    tasks += lifecycle_json(os.path.join(contract["stateDir"], "distributed_plan_queue.json")).get("jobs", [])
    active = [str(row.get("commandId") or row.get("globalJobId") or "unknown") for row in tasks
              if row.get("status") not in ("completed", "failed", "cancelled", "unavailable")]
    return {"ok": True, "status": "running" if health else "absent", "contract": contract, "activeTasks": active,
            "identity": health.get("agentIdentity"), "runningVersion": health.get("runtimeVersion"), "files": files}


def lifecycle_control(params):
    import fcntl
    action = params.get("action", "inspect")
    if action == "inspect":
        return lifecycle_inspect(params)
    if action not in ("ensure", "stop", "restart"):
        raise AgentLifecycleError("AGENT_ACTION_INVALID")
    contract = lifecycle_contract(params)
    lifecycle_check_owner(contract)
    os.makedirs(contract["installDir"], exist_ok=True)
    lock_path = os.path.join(contract["installDir"], "agent-control.lock")
    lock_fd = os.open(lock_path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
    with os.fdopen(lock_fd, "a", encoding="utf-8") as lock:
        try:
            fcntl.flock(lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise AgentLifecycleError("AGENT_LIFECYCLE_BUSY")
        before = lifecycle_inspect(params)
        record_path = os.path.join(contract["stateDir"], "agent.process.json")
        record = lifecycle_json(record_path)
        version = str(params.get("expectedVersion") or "")
        if action != "stop":
            if before["status"] != "running" and before.get("activeTasks"):
                raise AgentLifecycleError("AGENT_ACTIVE_TASK", before["activeTasks"])
            proofs = lifecycle_files(contract, params)
            if not version or any(not proofs.get(name) or proofs[name] != (params.get("files") or {}).get(name) for name in proofs):
                raise AgentLifecycleError("AGENT_RUNTIME_PROOF_REQUIRED")
            lifecycle_python(contract)
        if before["status"] == "running":
            identity = before["identity"]
            if action == "ensure" and before["runningVersion"] == version and identity.get("python") == os.path.realpath(lifecycle_python(contract)):
                lifecycle_files(contract, params)
                if identity.get("runtimeFiles") != params.get("files"):
                    raise AgentLifecycleError("AGENT_RUNNING_HASH_MISMATCH")
                return dict(before, reused=True)
            if action == "ensure":
                raise AgentLifecycleError("AGENT_RUNNING_VERSION_MISMATCH", str(before["runningVersion"]))
            # Refuse restart while the Agent has outstanding accepted/queued jobs.
            tasks = lifecycle_json(os.path.join(contract["stateDir"], "worker_task_snapshot.json")).get("tasks", [])
            tasks += lifecycle_json(os.path.join(contract["stateDir"], "distributed_plan_queue.json")).get("jobs", [])
            for task in tasks:
                if task.get("status") not in ("completed", "failed", "cancelled", "unavailable"):
                    raise AgentLifecycleError("AGENT_ACTIVE_TASK", str(task.get("commandId") or "unknown"))
            actual = lifecycle_verify_running(contract, lifecycle_health(contract, params.get("agentToken") or ""), record)
            if actual["pid"] <= 1 or actual["pid"] == os.getpid():
                raise AgentLifecycleError("AGENT_PROCESS_UNVERIFIED")
            # A pidfd pins the verified process against PID reuse. Never kill descendants.
            if not hasattr(os, "pidfd_open") or not hasattr(signal, "pidfd_send_signal"):
                raise AgentLifecycleError("AGENT_PIDFD_REQUIRED")
            fd = os.pidfd_open(actual["pid"])
            try:
                if lifecycle_process(actual["pid"]) != actual:
                    raise AgentLifecycleError("AGENT_PROCESS_CHANGED")
                signal.pidfd_send_signal(fd, signal.SIGTERM)
                deadline = time.monotonic() + 5
                while lifecycle_process(actual["pid"]) and time.monotonic() < deadline:
                    time.sleep(0.1)
                if lifecycle_process(actual["pid"]):
                    raise AgentLifecycleError("AGENT_STOP_UNCONFIRMED")
            finally:
                os.close(fd)
        if action == "stop":
            return {"ok": True, "status": "stopped", "stoppedPid": record.get("pid"), "contract": contract}
        files = lifecycle_files(contract, params)
        if not version or any(not files.get(name) or files[name] != (params.get("files") or {}).get(name) for name in files):
            raise AgentLifecycleError("AGENT_RUNTIME_PROOF_REQUIRED")
        python = lifecycle_python(contract)
        script = os.path.join(contract["installDir"], "simple_cluster", "runtime", "cluster_agent.py")
        env = dict(os.environ)
        env.update(SIMPLE_EXPERIMENT_AGENT_INSTALL_DIR=contract["installDir"], SIMPLE_EXPERIMENT_CONDA_ENV=contract["condaEnv"],
                   SIMPLE_EXPERIMENT_AGENT_NONCE=uuid.uuid4().hex, SIMPLE_EXPERIMENT_REMOTE_TMUX_SESSION_PREFIX=str(params.get("sessionPrefix") or "simple"))
        env["SIMPLE_EXPERIMENT_AGENT_TOKEN"] = str(params.get("agentToken") or "")
        # No inherited alternate state directory or hidden uplink may redirect ownership.
        env.pop("SIMPLE_EXPERIMENT_AGENT_STATE_DIR", None)
        env.pop("SIMPLE_EXPERIMENT_HUB_UPLINK_URL", None)
        os.makedirs(os.path.join(contract["installDir"], "logs"), exist_ok=True)
        log = os.path.join(contract["installDir"], "logs", "agent-lifecycle.log")
        with open(log, "ab") as stream:
            child = subprocess.Popen([python, script, "serve", "--project-dir", contract["projectDir"], "--mode", contract["mode"],
                                     "--worker-id", contract["workerId"], "--host", contract["host"], "--port", str(contract["port"])],
                                     cwd=contract["projectDir"], env=env, stdin=subprocess.DEVNULL, stdout=stream, stderr=stream, start_new_session=True)
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            if child.poll() is not None:
                raise AgentLifecycleError("AGENT_START_FAILED", {"exitCode": child.returncode, "log": log})
            health = lifecycle_health(contract, params.get("agentToken") or "")
            if health:
                process = {"pid": child.pid, "nonce": env["SIMPLE_EXPERIMENT_AGENT_NONCE"], "process": lifecycle_process(child.pid)}
                lifecycle_verify_running(contract, health, process)
                if health.get("runtimeVersion") != version or health.get("agentIdentity", {}).get("version") != version:
                    raise AgentLifecycleError("AGENT_RUNNING_VERSION_MISMATCH", health.get("runtimeVersion"))
                lifecycle_save(record_path, process)
                return dict(lifecycle_inspect(params), reused=False)
            time.sleep(0.1)
        # Leave the single identified launch intact for explicit inspect/recovery; no retry.
        raise AgentLifecycleError("AGENT_START_UNCONFIRMED", {"pid": child.pid, "log": log})


def lifecycle_main(params=None):
    try:
        result = lifecycle_control(params if params is not None else json.load(sys.stdin))
    except Exception as error:
        result = {"ok": False, "code": getattr(error, "code", "AGENT_LIFECYCLE_FAILED"), "error": str(error)}
    print(json.dumps(result, ensure_ascii=False), flush=True)
    return 0 if result.get("ok") else 1


if __name__ == "__main__":
    sys.exit(lifecycle_main())

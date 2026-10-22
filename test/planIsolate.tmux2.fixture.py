"""C3/C2 current contract: managed isolation preserves its failed exact window
under a real subtree writer; a re-confirmed isolation then self-closes. The
retired managed confirmed-delete executor is refused before creating a window.
Fresh disposable temp root and its own TMUX_TMPDIR only."""
import hashlib, json, os, pathlib, subprocess, sys, tempfile, time

engine_path = pathlib.Path(sys.argv[1]).resolve()
source = engine_path.read_text(encoding="utf-8")
root = pathlib.Path(tempfile.mkdtemp(prefix="se-isolate-window2-"))
engine = root / "engine.py"
engine.write_text(source, encoding="utf-8")
os.environ["TMUX_TMPDIR"] = str(root)
BATCH = "job-" + "b" * 48

HELPER = """
import fcntl, hashlib, os, sys, time
streams = []
parts = sys.argv[2].split("/")
for index in range(1, len(parts) + 1):
    component = "/".join(parts[:index])
    path = os.path.join(sys.argv[1], "clean_dir/.operations/locks",
                        hashlib.sha256(("subtree:" + component).encode("utf-8")).hexdigest() + ".lock")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    stream = open(path, "a+b")
    fcntl.flock(stream.fileno(), fcntl.LOCK_EX if index == len(parts) else fcntl.LOCK_SH)
    streams.append(stream)
print("LOCKED", flush=True)
time.sleep(float(sys.argv[3]))
"""
helper = root / "lockhelper.py"
helper.write_text(HELPER, encoding="utf-8")

def run(request, timeout=6):
    proc = subprocess.run([sys.executable, "-B", str(engine)], input=json.dumps(request),
                          capture_output=True, text=True, timeout=timeout)
    assert proc.returncode == 0, (proc.stdout, proc.stderr)
    value = json.loads(proc.stdout)
    assert value.get("ok"), value
    return value

def panes():
    out = subprocess.run(["tmux", "list-panes", "-a", "-F",
                          "#{window_name}\t#{pane_dead}\t#{pane_dead_status}\t#{@sftp_cleanup}"],
                         capture_output=True, text=True, timeout=2, check=True).stdout
    return [line.split("\t") for line in out.splitlines() if line.strip()]

def live_bound():
    return [row for row in panes() if row[1] == "0" and len(row) > 3 and row[3]]

def wait_state(request, wanted, deadline_seconds=5):
    deadline = time.monotonic() + deadline_seconds
    last = None
    while time.monotonic() < deadline:
        last = run({**request, "action": "managed-observe"})
        if last["state"] == wanted:
            return last
        time.sleep(.05)
    raise AssertionError(("timeout", wanted, last))

prepared = run({"root": str(root), "action": "runtime-prepare",
                     "runtimeSha256": hashlib.sha256(source.encode("utf-8")).hexdigest(), "runtimeSource": source})
pinned = root / "clean_dir" / ".operations" / "managed" / ("runtime-" + prepared["runtimeSha256"] + ".py")

def run_pinned(request, timeout=6):
    proc = subprocess.run([sys.executable, "-B", str(pinned)], input=json.dumps(request),
                          capture_output=True, text=True, timeout=timeout)
    assert proc.returncode == 0, (proc.stdout, proc.stderr)
    value = json.loads(proc.stdout)
    assert value.get("ok"), value
    return value

def isolation_states():
    return [json.loads(p.read_text(encoding="utf-8"))
            for p in (root / "clean_dir" / ".operations" / "isolation").glob("*.json")]

try:
    # A registered isolated subtree is needed as the confirmed delete target.
    (root / "work_dirs/job-a").mkdir(parents=True)
    (root / "work_dirs/job-a/weight.bin").write_bytes(b"x" * 4096)
    iso_target = {"relativePath": "work_dirs/job-a", "destination": "clean_dir/" + BATCH + "/work_dirs/job-a",
                  "type": "directory", "archiveBatch": BATCH, "activityEvidenceMode": "managed_tmux"}
    inspected = run({"root": str(root), "action": "inspect", "isolate": True, "target": dict(iso_target)})
    isolate = {"root": str(root), "rootIdentity": inspected["rootIdentity"], "operationId": "iso-job-a",
               "cleanupAction": "isolate",
               "target": {**iso_target, **inspected["target"], "destination": iso_target["destination"]},
               "tmuxSessionPrefix": "iso"}
    assert run_pinned({**isolate, "action": "managed-start"})["state"] == "requested"
    wait_state(isolate, "completed")

    # The retired managed-delete chain must refuse before creating a window.
    archived = "clean_dir/" + BATCH + "/work_dirs/job-a"
    delete_target = {"relativePath": archived, "destination": archived, "type": "directory",
                     "authorizationMode": "confirmed_paths", "activityEvidenceMode": "managed_tmux"}
    deleted_preview = run({"root": str(root), "action": "inspect", "target": dict(delete_target)})
    before = panes()
    refused = subprocess.run([sys.executable, "-B", str(pinned)], input=json.dumps({"root": str(root),
        "rootIdentity": deleted_preview["rootIdentity"], "action": "managed-start", "operationId": "retired-delete",
        "cleanupAction": "delete", "target": {**delete_target, **deleted_preview["target"]}, "tmuxSessionPrefix": "iso"}),
        capture_output=True, text=True, timeout=6)
    assert refused.returncode == 0, (refused.stdout, refused.stderr)
    assert json.loads(refused.stdout)["error"]["code"] == "UPDATE_REQUIRED", refused.stdout
    assert panes() == before and (root / archived).is_dir()

    # A background writer blocks only job-b's source subtree. Isolation still
    # uses its own bound window; permanent deletion now uses delete-fast.
    busy_rel = "work_dirs/job-b"
    busy_archive = "clean_dir/" + BATCH + "/" + busy_rel
    (root / busy_rel).mkdir(parents=True)
    (root / busy_rel / "old.bin").write_bytes(b"old")
    holder = subprocess.Popen([sys.executable, "-B", str(helper), str(root), busy_rel, "20"], stdout=subprocess.PIPE, text=True)
    assert holder.stdout.readline().strip() == "LOCKED"
    busy_target = {"relativePath": busy_rel, "destination": busy_archive, "archiveBatch": BATCH,
                   "type": "directory", "activityEvidenceMode": "managed_tmux"}
    busy_preview = run({"root": str(root), "action": "inspect", "isolate": True, "target": dict(busy_target)})
    busy = {"root": str(root), "rootIdentity": busy_preview["rootIdentity"], "operationId": "iso-job-b", "cleanupAction": "isolate",
            "target": {**busy_target, **busy_preview["target"], "destination": busy_archive}, "tmuxSessionPrefix": "iso"}
    assert run_pinned({**busy, "action": "managed-start"})["state"] == "requested"
    deadline = time.monotonic() + 5
    failed = None
    while time.monotonic() < deadline:
        failed = [row for row in panes() if row[1] == "1" and len(row) > 3 and row[3]]
        if failed:
            break
        time.sleep(.05)
    assert failed and failed[0][2] != "0", failed
    observed = run({**busy, "action": "managed-observe"})
    assert observed["state"] == "pending" and observed["executor"] and observed["executor"]["dead"], observed
    assert (root / busy_rel / "old.bin").read_bytes() == b"old" and not (root / busy_archive).exists()
    assert (root / archived / "weight.bin").read_bytes() == b"x" * 4096
    # The external writer releases; the same confirmed intent is re-previewed
    # and completes, closing its own window without any client close call.
    holder.kill()
    holder.wait(timeout=5)
    second = run({"root": str(root), "action": "inspect", "isolate": True, "target": dict(busy_target)})
    retried = {**busy, "rootIdentity": second["rootIdentity"], "target": {**busy_target, **second["target"], "destination": busy_archive}}
    assert run_pinned({**retried, "action": "managed-start"})["state"] == "requested"
    completed = wait_state(retried, "completed")
    assert completed.get("verifiedBy") == "completion_receipt", completed
    assert not (root / busy_rel).exists() and (root / busy_archive / "old.bin").read_bytes() == b"old"
    assert any(state["state"] == "isolated" and state["destination"] == busy_archive for state in isolation_states()), isolation_states()
    deadline = time.monotonic() + 4
    while time.monotonic() < deadline and live_bound():
        time.sleep(.05)
    assert not live_bound(), panes()
    # A rebuilt name after completion is new data: replay never re-deletes.
    (root / busy_rel).mkdir(parents=True)
    (root / busy_rel / "fresh.bin").write_text("keep", encoding="utf-8")
    replay2 = run({**retried, "action": "managed-observe"})
    assert replay2["state"] == "completed" and (root / busy_rel / "fresh.bin").read_text() == "keep", replay2
    print(json.dumps({"ok": True, "failureWindowPreserved": True}))
finally:
    for session in subprocess.run(["tmux", "list-sessions", "-F", "#{session_name}"],
                                  capture_output=True, text=True, timeout=2).stdout.splitlines():
        if session.startswith("iso-"):
            subprocess.run(["tmux", "kill-session", "-t", session], capture_output=True, timeout=2)

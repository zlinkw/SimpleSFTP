"""C3 real-tmux contract: a managed isolation finalizes and releases exactly
its own bound window after a persisted completion identity; a failed window
stays visible with a non-zero exit for inspection; replays complete from the
receipt without re-deleting. Confined to fresh disposable temp roots."""
import json, os, pathlib, subprocess, sys, tempfile, time

engine_path = pathlib.Path(sys.argv[1])
source = engine_path.read_text(encoding="utf-8")
root = pathlib.Path(tempfile.mkdtemp(prefix="se-isolate-window-"))
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

def wait_state(request, wanted, deadline_seconds=6):
    deadline = time.monotonic() + deadline_seconds
    last = None
    while time.monotonic() < deadline:
        last = run({**request, "action": "managed-observe"})
        if last["state"] == wanted:
            return last
        time.sleep(.05)
    raise AssertionError(("timeout", wanted, last))

def isolation_states():
    return [json.loads(p.read_text(encoding="utf-8"))
            for p in (root / "clean_dir" / ".operations" / "isolation").glob("*.json")]

try:
    # 1) managed isolation: the window writes its receipt and closes itself.
    (root / "work_dirs/job-a").mkdir(parents=True)
    (root / "work_dirs/job-a/weight.bin").write_bytes(b"x" * 4096)
    target = {"relativePath": "work_dirs/job-a", "destination": "clean_dir/" + BATCH + "/work_dirs/job-a",
              "type": "directory", "archiveBatch": BATCH, "activityEvidenceMode": "managed_tmux"}
    inspected = run({"root": str(root), "action": "inspect", "isolate": True, "target": dict(target)})
    start = {"root": str(root), "rootIdentity": inspected["rootIdentity"], "operationId": "iso-job-a",
             "cleanupAction": "isolate",
             "target": {**target, **inspected["target"], "destination": target["destination"]},
             "runtimeSource": source, "tmuxSessionPrefix": "iso"}
    started = run({**start, "action": "managed-start"})
    assert started["state"] == "requested", started
    done = wait_state(start, "completed")
    assert done.get("verifiedBy") == "completion_receipt", done
    assert not live_bound(), panes()
    names = [row[0] for row in panes()]
    assert not [name for name in names if name.startswith("cleanup-")], names
    assert not (root / "work_dirs/job-a").exists()
    assert (root / "clean_dir" / BATCH / "work_dirs/job-a/weight.bin").read_bytes() == b"x" * 4096
    # A replay of the same confirmed intent completes from the receipt only.
    replay = run({**start, "action": "managed-start"})
    assert replay["state"] == "completed" and replay.get("verifiedBy") == "completion_receipt", replay
    assert isolation_states()[0]["state"] == "isolated"

    # 2) a real external writer (held subtree chain lock, like a background
    # deletion) makes the inner executor exit non-zero; the window must stay
    # preserved without any completion receipt.
    archived = "clean_dir/" + BATCH + "/work_dirs/job-a"
    holder = subprocess.Popen([sys.executable, "-B", str(helper), str(root), archived, "20"],
                              stdout=subprocess.PIPE, text=True)
    assert holder.stdout.readline().strip() == "LOCKED"
    delete_target = {"relativePath": archived, "destination": archived, "type": "directory",
                     "authorizationMode": "confirmed_paths", "activityEvidenceMode": "managed_tmux"}
    deleted_preview = run({"root": str(root), "action": "inspect", "target": dict(delete_target)})
    delete = {"root": str(root), "rootIdentity": deleted_preview["rootIdentity"], "operationId": "del-job-a",
              "cleanupAction": "delete",
              "target": {**delete_target, **deleted_preview["target"], "destination": archived},
              "runtimeSource": source, "tmuxSessionPrefix": "iso"}
    assert run({**delete, "action": "managed-start"})["state"] == "requested"
    deadline = time.monotonic() + 6
    failed = None
    while time.monotonic() < deadline:
        failed = [row for row in panes() if row[1] == "1" and len(row) > 3 and row[3]]
        if failed:
            break
        time.sleep(.05)
    assert failed and failed[0][2] != "0", failed
    observed = run({**delete, "action": "managed-observe"})
    assert observed["state"] == "pending" and observed["executor"] and observed["executor"]["dead"], observed
    assert (root / archived).is_dir()
    # The external writer releases; the same confirmed intent is re-previewed
    # and completes, closing its own window without any client close call.
    holder.kill()
    holder.wait(timeout=5)
    second = run({"root": str(root), "action": "inspect", "target": dict(delete_target)})
    delete2 = {**delete, "rootIdentity": second["rootIdentity"],
               "target": {**delete_target, **second["target"], "destination": archived}}
    assert run({**delete2, "action": "managed-start"})["state"] == "requested"
    deleted = wait_state(delete2, "completed")
    assert deleted.get("verifiedBy") == "completion_receipt" and deleted.get("irreversible") is True, deleted
    assert not (root / archived).exists()
    assert any(state["state"] == "deleted" for state in isolation_states()), isolation_states()
    assert not live_bound(), panes()
    # A rebuilt name after completion is new data: replay never re-deletes.
    (root / archived).mkdir(parents=True)
    (root / archived / "fresh.bin").write_text("keep", encoding="utf-8")
    replay2 = run({**delete2, "action": "managed-observe"})
    assert replay2["state"] == "completed" and (root / archived / "fresh.bin").exists(), replay2
    print(json.dumps({"ok": True, "serverSelfClose": True, "failureWindowPreserved": True}))
finally:
    for session in subprocess.run(["tmux", "list-sessions", "-F", "#{session_name}"],
                                  capture_output=True, text=True, timeout=2).stdout.splitlines():
        if session.startswith("iso-"):
            subprocess.run(["tmux", "kill-session", "-t", session], capture_output=True, timeout=2)

"""End-to-end two-generation staged-slot lifecycle against the REAL production entries.

Spawns the receiver exactly as production does (argv base64/raw-deflate request + stdin
chunk frames, real filesystem), asks the read-only stale report as both inventory and
incoming-admission preview, proves a third generation fails closed, deletes exactly the
leaving slot through the confirmed-path production executor (root_guard → batch_inspect →
delete_fast with parent-cd "./leaf" semantics), lands the third generation into the freed
slot, and re-plays the retired generation idempotently. Prints one JSON verdict line.
"""
import base64
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import zlib

receiver_path, engine_path = sys.argv[1], sys.argv[2]
project = tempfile.mkdtemp(prefix="staged-slot-lifecycle-")


def encode(request):
    compressor = zlib.compressobj(9, zlib.DEFLATED, -15)
    raw = compressor.compress(json.dumps(request).encode("utf-8")) + compressor.flush()
    return base64.b64encode(raw).decode("ascii")


def call(request, stdin=b""):
    return subprocess.run([sys.executable, "-B", "-X", "utf8", receiver_path, encode(request)],
                          input=stdin, capture_output=True, timeout=8)


def tree_hash(root):
    rows = {}
    for parent, _dirs, names in os.walk(root):
        for name in names:
            full = os.path.join(parent, name)
            rel = os.path.relpath(full, root).replace(os.sep, "/")
            with open(full, "rb") as handle:
                rows[rel] = hashlib.sha256(handle.read()).hexdigest()
    return rows


KEY = "11" * 32
GEN_A, GEN_B, GEN_C = "a1" * 32, "b2" * 32, "c3" * 32
DID = "d-" + KEY[:24]
STAGING = "simple_cluster/.simple-sftp-staging"


def payload_bytes(tag):
    return (tag.encode("utf-8") * 4096)[:65536]


def land(generation, body, root=None, identity=None, path="out/large.bin"):
    digest = hashlib.sha256(body).hexdigest()
    entries = [{"path": path, "sha256": digest, "size": len(body)}]
    base = {"root": root or project, "identity": identity or KEY, "generation": generation, "entries": entries}
    status = call(dict(base, mode="chunkStatus"))
    assert status.returncode == 0, status.stderr.decode()[-2000:]
    assert json.loads(status.stdout)["offset"] == 0
    frame = json.dumps({"offset": 0, "size": len(body), "sha256": digest}).encode("utf-8") + b"\n" + body
    done = call(dict(base, mode="receiveChunk", offset=0), frame)
    assert done.returncode == 0, done.stderr.decode()[-2000:]
    assert json.loads(done.stdout)["completed"] is True
    return base


def slot_generation(slot):
    with open(os.path.join(project, STAGING, DID, slot, "manifest.json"), "rb") as handle:
        return json.loads(handle.read())


# Two committed generations occupy exactly the two slots.
land(GEN_A, payload_bytes("A"))
land(GEN_B, payload_bytes("B"))
assert slot_generation("0")["generation"] == GEN_A and slot_generation("0")["status"] == "committed"
assert slot_generation("1")["generation"] == GEN_B and slot_generation("1")["status"] == "committed"
assert open(os.path.join(project, "out", "large.bin"), "rb").read() == payload_bytes("B")

# Inventory is read-only and NEVER proposes the retained window.
before = tree_hash(project)
report = json.loads(call({"mode": "staleReport", "root": project, "identity": KEY}).stdout)
assert report["stale"] == [] and len(report["held"]) == 2, report
assert tree_hash(project) == before, "inventory mutated the staging tree"

# Admission preview for the incoming third generation names exactly the OLDEST slot as leaving.
report = json.loads(call({"mode": "staleReport", "root": project, "identity": KEY, "generation": GEN_C}).stdout)
assert [row["path"] for row in report["stale"]] == [STAGING + "/" + DID + "/0"], report
assert report["stale"][0]["type"] == "directory" and report["stale"][0]["generation"] == GEN_A
assert [row["path"] for row in report["held"]] == [STAGING + "/" + DID + "/1"]
assert tree_hash(project) == before, "admission preview mutated the staging tree"

# While both generations are retained, the third must fail closed.
blocked = call({"mode": "chunkStatus", "root": project, "identity": KEY, "generation": GEN_C,
                "entries": [{"path": "out/large.bin", "sha256": "0" * 64, "size": 10}]})
assert blocked.returncode != 0 and b"TRANSFER_STAGE_PENDING" in blocked.stderr, blocked.stderr[-500:]

# The confirmed managed executor removes EXACTLY the leaving slot subtree (entry-bound,
# parent-cd, non-overwriting), then absence is verified by the next real admission.
spec = importlib.util.spec_from_file_location("cleanup_engine", engine_path)
engine = importlib.util.module_from_spec(spec)
spec.loader.exec_module(engine)
root, identity = engine.root_guard(project)
leaving = report["stale"][0]["path"]
inspection = engine.batch_inspect(root, identity, {"authorizationMode": "confirmed_paths",
                                                   "operationId": "lifecycle-fixture",
                                                   "targets": [{"relativePath": leaving, "type": "directory"}]})
row = inspection["targets"][0]
kept_slot1 = tree_hash(os.path.join(project, STAGING, DID, "1"))
receipt = engine.delete_fast(root, identity, {"rootIdentity": identity, "operationId": "lifecycle-fixture",
                                              "authorizationMode": "confirmed_paths",
                                              "entries": [{key: row[key] for key in
                                                           ("relativePath", "type", "absolutePath", "device", "inode") if key in row}]})
assert receipt["ok"], receipt
assert not os.path.lexists(os.path.join(project, leaving)), "leaving slot still present after confirmed delete"
assert tree_hash(os.path.join(project, STAGING, DID, "1")) == kept_slot1, "retained generation was touched"

# The freed slot now admits the third generation and it lands byte-exact.
land(GEN_C, payload_bytes("C"))
assert open(os.path.join(project, "out", "large.bin"), "rb").read() == payload_bytes("C")
landed = slot_generation("0")
assert landed["generation"] == GEN_C and landed["status"] == "committed"
assert slot_generation("1")["generation"] == GEN_B and slot_generation("1")["status"] == "committed"
# The retired generation lost its slot to the confirmed cleanup: replaying it must fail closed
# instead of silently re-landing over the retained window.
replay = call({"mode": "chunkStatus", "root": project, "identity": KEY, "generation": GEN_A,
               "entries": [{"path": "out/large.bin", "sha256": "0" * 64, "size": 10}]})
assert replay.returncode != 0 and b"TRANSFER_STAGE_PENDING" in replay.stderr, replay.stderr[-500:]
# And the retained window again proposes nothing.
after = json.loads(call({"mode": "staleReport", "root": project, "identity": KEY}).stdout)
assert after["stale"] == [] and len(after["held"]) == 2

# ---------------------------------------------------------------------------
# r61 hardlink publication contract (artifact pending-alias regression).
# The scientific flow (quality_composition.py:402-406, read-only) writes the NEW content
# into a hidden ".<name>.<uuid>.pending" file first, then os.link()s that pending onto the
# declared result name — so target and alias share one inode (st_nlink == 2) and the alias
# must keep its exact bytes/inode afterwards. Publishing replaces only the CURRENT result
# directory entry (os.replace); it never writes new content into the shared inode, so a
# legal multi-link regular target must publish while non-regular targets stay rejected.
# Fixture mirrors that order: old file exists, then os.link onto the not-yet-existing alias.
# Separate sub-roots and identities keep every scenario's two-generation slot pool
# and artefact tree isolated (no shared state with the lifecycle block above).
# ---------------------------------------------------------------------------
import io
import tarfile


def tar_bytes(files):
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        for name, body in files.items():
            info = tarfile.TarInfo(name)
            info.size = len(body)
            info.mtime = 0
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(body))
    return buffer.getvalue()


def publish_tar(root, identity, generation, files):
    entries = [{"path": name, "sha256": hashlib.sha256(body).hexdigest(), "size": len(body)}
               for name, body in files.items()]
    return call({"root": root, "identity": identity, "generation": generation, "entries": entries},
                stdin=tar_bytes(files))


def write(rel, body, root=None):
    full = os.path.join(root or project, rel)
    os.makedirs(os.path.dirname(full), exist_ok=True)
    with open(full, "wb") as handle:
        handle.write(body)
    return full


def identity_key(tag):
    return (tag * 32)[:64]


# --- positive: tar publish onto a legal hard-linked metrics target + pending alias -------
KEY_T, KEY_C, KEY_N = identity_key("22"), identity_key("33"), identity_key("44")
GEN_D, GEN_E = "d1" * 32, "e1" * 32
tar_root = os.path.join(project, "tarcase")
os.makedirs(tar_root)
metrics = "test_results/job_metrics.csv"
alias = "test_results/.job_metrics.csv.5b0e4a3c-1f2d-4c6e-9a7b-0123456789ab.pending"
control = "test_results/metrics_summary.csv"
write(metrics, payload_bytes("M1"), tar_root)
os.link(os.path.join(tar_root, metrics), os.path.join(tar_root, alias))
write(control, payload_bytes("S1"), tar_root)  # plain single-link control target
before_target = os.lstat(os.path.join(tar_root, metrics))
before_alias = os.lstat(os.path.join(tar_root, alias))
assert before_target.st_ino == before_alias.st_ino and before_target.st_nlink == 2
published = publish_tar(tar_root, KEY_T, GEN_D, {metrics: payload_bytes("M2"), control: payload_bytes("S2")})
assert published.returncode == 0, published.stderr.decode()[-2000:]
after_target = os.lstat(os.path.join(tar_root, metrics))
after_alias = os.lstat(os.path.join(tar_root, alias))
assert open(os.path.join(tar_root, metrics), "rb").read() == payload_bytes("M2")
assert after_target.st_ino != before_target.st_ino, "publish must land a fresh inode, never write through the alias"
assert os.lstat(os.path.join(tar_root, alias)).st_ino == before_alias.st_ino
assert os.lstat(os.path.join(tar_root, alias)).st_nlink == 1  # old inode keeps exactly the alias reference
assert open(os.path.join(tar_root, alias), "rb").read() == payload_bytes("M1"), "pending alias bytes changed"
assert open(os.path.join(tar_root, control), "rb").read() == payload_bytes("S2"), "plain single-link control target must publish"

# --- positive: chunk publish obeys the SAME target contract (guard at the chunk commit) ----
chunk_root = os.path.join(project, "chunkcase")
os.makedirs(chunk_root)
chunk_file = "work2/metrics_case.csv"
chunk_alias = "work2/.metrics_case.csv.0f0e0d0c-0b0a-0908-0706-0504030201ff.pending"
write(chunk_file, payload_bytes("C1"), chunk_root)
os.link(os.path.join(chunk_root, chunk_file), os.path.join(chunk_root, chunk_alias))
chunk_before = os.lstat(os.path.join(chunk_root, chunk_file))
land(GEN_E, payload_bytes("C2"), root=chunk_root, identity=KEY_C, path=chunk_file)
chunk_after = os.lstat(os.path.join(chunk_root, chunk_file))
assert open(os.path.join(chunk_root, chunk_file), "rb").read() == payload_bytes("C2")
assert chunk_after.st_ino != chunk_before.st_ino
assert os.lstat(os.path.join(chunk_root, chunk_alias)).st_ino == chunk_before.st_ino
assert open(os.path.join(chunk_root, chunk_alias), "rb").read() == payload_bytes("C1")

# --- negatives: the pre-existing protections stay exactly in force --------------------------
neg_root = os.path.join(project, "negcase")
os.makedirs(os.path.join(neg_root, "locked_dir", "x.bin"))
link_target = write("link_target.bin", payload_bytes("L1"), neg_root)
os.symlink("link_target.bin", os.path.join(neg_root, "sym.bin"))
rejected_dir = publish_tar(neg_root, KEY_N, GEN_D, {"locked_dir/x.bin": payload_bytes("X2")})
assert rejected_dir.returncode != 0 and b"unsafe publication target" in rejected_dir.stderr, rejected_dir.stderr[-800:]
assert os.path.isdir(os.path.join(neg_root, "locked_dir", "x.bin")) and os.listdir(os.path.join(neg_root, "locked_dir", "x.bin")) == []
GEN_N2 = "e2" * 32
rejected_link = publish_tar(neg_root, KEY_N, GEN_N2, {"sym.bin": payload_bytes("Y2")})
assert rejected_link.returncode != 0 and b"unsafe publication target" in rejected_link.stderr, rejected_link.stderr[-800:]
assert os.readlink(os.path.join(neg_root, "sym.bin")) == "link_target.bin"
assert open(link_target, "rb").read() == payload_bytes("L1")

# ---------------------------------------------------------------------------
# r118 committed-slot expiry reclaim contract (0.2.113).
# terminalAt is written when a row ENTERS committed and never refreshed while terminal; the
# expiry verdict is computed ONLY from the remote clock over the trusted basis (terminalAt,
# legacy updatedAt, and the non-followed manifest mtime as last resort), and every time
# problem keeps the slot protected. The receiver itself NEVER reclaims — admission stays
# fail-closed TRANSFER_STAGE_PENDING and only adds the machine-readable stderr facts.
# ---------------------------------------------------------------------------
recv_spec = importlib.util.spec_from_file_location("staged_receive", receiver_path)
recv = importlib.util.module_from_spec(recv_spec)
recv_spec.loader.exec_module(recv)


def engine(request):
    done = subprocess.run([sys.executable, "-B", "-X", "utf8", engine_path],
                          input=json.dumps(request).encode("utf-8"), capture_output=True, timeout=15)
    assert done.returncode == 0, done.stderr.decode()[-1500:]
    return json.loads(done.stdout.decode("utf-8").strip().split("\n").pop())


def edit_journal(root_dir, identity, slot, mutate):
    full = os.path.join(root_dir, STAGING, "d-" + identity[:24], slot, "manifest.json")
    with open(full, "rb") as handle:
        row = json.loads(handle.read())
    mutate(row)
    with open(full, "wb") as handle:
        handle.write(json.dumps(row).encode("utf-8"))
    return row


KEY_X = identity_key("55")
GEN_X1, GEN_X2, GEN_X3, GEN_X4 = "f1" * 32, "f2" * 32, "f3" * 32, "f4" * 32
exp_root = os.path.join(project, "expcase")
os.makedirs(exp_root)
land(GEN_X1, payload_bytes("X1"), root=exp_root, identity=KEY_X)
land(GEN_X2, payload_bytes("X2"), root=exp_root, identity=KEY_X)
# terminalAtWritten: every fresh committed journal carries a positive terminal moment.
terminalAtWritten = all((slot_generation(slot).get("terminalAt") or 0) > 0
                        and abs(slot_generation(slot)["terminalAt"] - slot_generation(slot)["updatedAt"]) <= 1
                        for slot in ("0", "1"))
assert terminalAtWritten, (slot_generation("0"), slot_generation("1"))

# --- journal terminalAt lifecycle: enter committed writes it, terminal rewrites carry it,
# --- any non-terminal rewrite drops it, a fresh re-commit stamps a new terminal moment.
jcase = os.path.join(project, "jcase")
os.makedirs(os.path.join(jcase, STAGING, "d-" + KEY_X[:24], "0"))
journal_fd = os.open(os.path.join(jcase, STAGING, "d-" + KEY_X[:24], "0"), os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
recv.journal(journal_fd, {"identity": KEY_X, "generation": GEN_X4, "status": "committed", "count": 1})
first_commit = recv.read_journal(journal_fd)
assert (first_commit.get("terminalAt") or 0) > 0
recv.journal(journal_fd, {"identity": KEY_X, "generation": GEN_X4, "status": "committed", "count": 2})
second_commit = recv.read_journal(journal_fd)
assert second_commit["terminalAt"] == first_commit["terminalAt"], "terminal rewrites must never refresh terminalAt"
recv.journal(journal_fd, {"identity": KEY_X, "generation": GEN_X4, "status": "preparing", "entries": []})
assert "terminalAt" not in recv.read_journal(journal_fd), "a resumed (non-terminal) row must drop terminalAt"
os.close(journal_fd)
journalTerminalAtCarried = True

EXPIRY_MS = 86400000


def set_terminal(identity, slot, seconds_ago):
    edit_journal(exp_root, identity, slot, lambda row: row.update(terminalAt=int(time.time()) - seconds_ago))


set_terminal(KEY_X, "0", 172800)  # two days old, slot 1 stays fresh
exp_report = json.loads(call({"mode": "staleReport", "root": exp_root, "identity": KEY_X, "generation": GEN_X3,
                              "expiry": {"ms": EXPIRY_MS}}).stdout)
expiredOldGenerationTrue = (len(exp_report["stale"]) == 1
                            and exp_report["stale"][0]["expiredCommitted"] is True
                            and exp_report["stale"][0]["expiryReason"] == "expired"
                            and exp_report["stale"][0]["timeSource"] == "terminalAt"
                            and exp_report["stale"][0]["ageMs"] >= 172800000
                            and exp_report["stale"][0]["locked"] is False
                            and len(exp_report["held"]) == 1
                            and exp_report["held"][0]["protectedReason"] == "within-retention-window"
                            and len(exp_report["slots"]) == 2
                            and sorted(row["role"] for row in exp_report["slots"]) == ["held", "leaving"])
assert expiredOldGenerationTrue, exp_report

# While the stale candidate is only PROPOSED, the receiver itself never reclaims: the third
# generation stays fail-closed, and the refusal now additionally carries machine-readable facts.
blocked2 = call({"mode": "chunkStatus", "root": exp_root, "identity": KEY_X, "generation": GEN_X3,
                 "entries": [{"path": "out/large.bin", "sha256": "0" * 64, "size": 10}]})
claimStillPending = blocked2.returncode != 0 and b"TRANSFER_STAGE_PENDING" in blocked2.stderr
structuredPendingFacts = b"SIMPLE_STAGE_PENDING " in blocked2.stderr
if structuredPendingFacts:
    marker_line = next(line for line in blocked2.stderr.decode("utf-8").split("\n") if line.startswith("SIMPLE_STAGE_PENDING "))
    marker = json.loads(marker_line[len("SIMPLE_STAGE_PENDING "):])
    structuredPendingFacts = (marker["code"] == "TRANSFER_STAGE_PENDING" and marker["identity"] == KEY_X
                              and marker["incomingGeneration"] == GEN_X3 and len(marker["slots"]) == 2)
assert claimStillPending and structuredPendingFacts, blocked2.stderr[-600:]

# --- deterministic threshold boundary (same-process report so the clock cannot drift):
# exactly `expiry` old is expired (>=), one second younger is protected.
set_terminal(KEY_X, "0", 86400)
boundary_expired = recv.stale_report(exp_root, KEY_X, GEN_X4, EXPIRY_MS)
boundaryAtLeastDay = bool(boundary_expired["stale"]) and boundary_expired["stale"][0]["expiredCommitted"] is True
set_terminal(KEY_X, "0", 86399)
boundary_young = recv.stale_report(exp_root, KEY_X, GEN_X4, EXPIRY_MS)
boundaryJustBelow = not boundary_young["stale"][0]["expiredCommitted"] and boundary_young["stale"][0]["expiryReason"] == "within-threshold"
assert boundaryAtLeastDay and boundaryJustBelow, (boundary_expired["stale"], boundary_young["stale"])

# --- untrusted time NEVER expires: future stamps and clock contradictions stay protected.
set_terminal(KEY_X, "0", -3600)  # one hour into the future
future_report = recv.stale_report(exp_root, KEY_X, GEN_X4, EXPIRY_MS)
futureProtected = (future_report["stale"][0]["expiredCommitted"] is False
                   and future_report["stale"][0]["expiryReason"] == "time-future")
created_seconds = int(recv.read_journal(os.open(os.path.join(exp_root, STAGING, "d-" + KEY_X[:24], "0"),
                                                os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW))["createdAt"] // 1_000_000_000)
edit_journal(exp_root, KEY_X, "0", lambda row: row.update(terminalAt=created_seconds - 10))
contradiction_report = recv.stale_report(exp_root, KEY_X, GEN_X4, EXPIRY_MS)
contradictionProtected = (contradiction_report["stale"][0]["expiredCommitted"] is False
                          and contradiction_report["stale"][0]["expiryReason"] == "time-contradiction")
assert futureProtected and contradictionProtected, (future_report["stale"], contradiction_report["stale"])

# --- manifest-mtime fallback ONLY for a valid journal with no usable timestamps; slot
# --- directory/lock/data mtimes are never consulted (this is the last accepted source).
def strip_times(row):
    row.pop("terminalAt", None)
    row.pop("updatedAt", None)
edit_journal(exp_root, KEY_X, "0", strip_times)
manifest_path = os.path.join(exp_root, STAGING, "d-" + KEY_X[:24], "0", "manifest.json")
old = time.time() - 172800
os.utime(manifest_path, (old, old))
mtime_report = recv.stale_report(exp_root, KEY_X, GEN_X4, EXPIRY_MS)
mtimeAgedExpired = (mtime_report["stale"][0]["expiredCommitted"] is True
                    and mtime_report["stale"][0]["timeSource"] == "manifestMtime")
fresh = time.time()
os.utime(manifest_path, (fresh, fresh))
mtime_report2 = recv.stale_report(exp_root, KEY_X, GEN_X4, EXPIRY_MS)
mtimeFreshProtected = mtime_report2["stale"][0]["expiredCommitted"] is False
assert mtimeAgedExpired and mtimeFreshProtected, (mtime_report["stale"], mtime_report2["stale"])

# --- same-generation retry proposes nothing; inventory keeps every slot held.
own_report = recv.stale_report(exp_root, KEY_X, GEN_X1)  # GEN_X1 still owns slot 0 (only times were edited)
sameGenerationNoReclaim = own_report["stale"] == [] and own_report["slots"][0]["role"] == "held"
inventory_report = recv.stale_report(exp_root, KEY_X)
inventoryRolesHeld = inventory_report["stale"] == [] and all(row["role"] == "held" for row in inventory_report["slots"])
assert sameGenerationNoReclaim and inventoryRolesHeld, (own_report, inventory_report)

# --- corrupt journal stays protected even with expiry requested.
KEY_C2 = identity_key("66")
GEN_C2A, GEN_C2B = "a6" * 32, "b6" * 32
corrupt_root = os.path.join(project, "corruptcase")
os.makedirs(corrupt_root)
land(GEN_C2A, payload_bytes("K1"), root=corrupt_root, identity=KEY_C2)
land(GEN_C2B, payload_bytes("K2"), root=corrupt_root, identity=KEY_C2)
with open(os.path.join(corrupt_root, STAGING, "d-" + KEY_C2[:24], "0", "manifest.json"), "wb") as handle:
    handle.write(b"{not-json")
corrupt_report = recv.stale_report(corrupt_root, KEY_C2, "c6" * 32, EXPIRY_MS)
corruptProtected = (corrupt_report["stale"] == []
                    and any(row["status"] == "unresolved" and row["protectedReason"] == "journal-unresolved"
                            for row in corrupt_report["held"]))
assert corruptProtected, corrupt_report

# --- isolation-moment slot lock: while a claim holds the flock, BOTH the read-only report and
# --- the engine isolate refuse; after release the isolate lands and the freed slot re-admits.
KEY_L = identity_key("77")
GEN_L1, GEN_L2, GEN_L3 = "a7" * 32, "b7" * 32, "c7" * 32
lock_root = os.path.join(project, "lockcase")
os.makedirs(lock_root)
land(GEN_L1, payload_bytes("L1b"), root=lock_root, identity=KEY_L)
land(GEN_L2, payload_bytes("L2b"), root=lock_root, identity=KEY_L)
lock_slot = "0"  # the first land takes slot 0 deterministically
assert json.loads(open(os.path.join(lock_root, STAGING, "d-" + KEY_L[:24], lock_slot, "manifest.json"), "rb").read())["generation"] == GEN_L1
lock_holder = os.open(os.path.join(lock_root, STAGING, "d-" + KEY_L[:24], lock_slot + ".lock"),
                      os.O_RDWR | getattr(os, "O_NOFOLLOW", 0))
import fcntl as _fcntl
_fcntl.flock(lock_holder, _fcntl.LOCK_EX)
try:
    locked_report = recv.stale_report(lock_root, KEY_L, GEN_L3, EXPIRY_MS)
    lockedProtected = (locked_report["stale"] == []
                       and any(row["status"] == "locked" and row["protectedReason"] == "slot-locked"
                               and row["locked"] is True for row in locked_report["held"]))
    slot_rel = STAGING + "/d-" + KEY_L[:24] + "/" + lock_slot
    isolate_inspection = engine({"root": lock_root, "action": "inspect", "isolate": True, "operationId": "lock-iso",
                                 "target": {"relativePath": slot_rel, "type": "directory"}})
    assert isolate_inspection["ok"], isolate_inspection
    frozen_target = dict(isolate_inspection["target"], relativePath=slot_rel, type="directory")
    batch = "job-" + hashlib.sha256(b"lockcase-isolate").hexdigest()[:48]
    frozen_target["archiveBatch"] = batch
    frozen_target["destination"] = "clean_dir/" + batch + "/" + slot_rel
    locked_isolate = engine({"root": lock_root, "action": "isolate", "operationId": "lock-iso", "target": frozen_target})
    slotLockHeldBlocksIsolate = (locked_isolate["ok"] is False
                                 and locked_isolate["error"]["code"] in ("SLOT_LOCK_HELD", "SLOT_LOCK_UNCERTAIN"))
    assert lockedProtected and slotLockHeldBlocksIsolate, (locked_report, locked_isolate)
finally:
    _fcntl.flock(lock_holder, _fcntl.LOCK_UN)
    os.close(lock_holder)
released_isolate = engine({"root": lock_root, "action": "isolate", "operationId": "lock-iso-2", "target": frozen_target})
isolateAfterRelease = released_isolate["ok"] is True
claimAfterIsolate = call({"mode": "chunkStatus", "root": lock_root, "identity": KEY_L, "generation": GEN_L3,
                          "entries": [{"path": "out/large.bin", "sha256": "0" * 64, "size": 10}]})
claimAdmitted = claimAfterIsolate.returncode == 0 and json.loads(claimAfterIsolate.stdout)["offset"] == 0
assert isolateAfterRelease and claimAdmitted, (released_isolate, claimAfterIsolate.stderr[-400:])

print(json.dumps({"ok": True, "pendingBlocked": True, "leaving": leaving, "thirdGenerationLanded": True,
                  "hardlinkPublication": {"tarPublished": True, "pendingAliasPreserved": True,
                                          "chunkPublished": True, "normalTargetPublished": True,
                                          "directoryTargetRejected": True, "symlinkTargetRejected": True},
                  "expiryReclaim": {"terminalAtWritten": terminalAtWritten,
                                    "journalTerminalAtCarried": journalTerminalAtCarried,
                                    "expiredOldGenerationTrue": expiredOldGenerationTrue,
                                    "claimStillPending": claimStillPending,
                                    "structuredPendingFacts": structuredPendingFacts,
                                    "boundaryAtLeastDay": boundaryAtLeastDay,
                                    "boundaryJustBelow": boundaryJustBelow,
                                    "futureProtected": futureProtected,
                                    "contradictionProtected": contradictionProtected,
                                    "mtimeAgedExpired": mtimeAgedExpired,
                                    "mtimeFreshProtected": mtimeFreshProtected,
                                    "sameGenerationNoReclaim": sameGenerationNoReclaim,
                                    "inventoryRolesHeld": inventoryRolesHeld,
                                    "corruptProtected": corruptProtected,
                                    "lockedProtected": lockedProtected,
                                    "slotLockHeldBlocksIsolate": slotLockHeldBlocksIsolate,
                                    "isolateAfterRelease": isolateAfterRelease,
                                    "claimAdmitted": claimAdmitted}}))

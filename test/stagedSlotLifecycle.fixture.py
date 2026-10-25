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

print(json.dumps({"ok": True, "pendingBlocked": True, "leaving": leaving, "thirdGenerationLanded": True,
                  "hardlinkPublication": {"tarPublished": True, "pendingAliasPreserved": True,
                                          "chunkPublished": True, "normalTargetPublished": True,
                                          "directoryTargetRejected": True, "symlinkTargetRejected": True}}))

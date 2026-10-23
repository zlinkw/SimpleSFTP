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


def land(generation, body):
    digest = hashlib.sha256(body).hexdigest()
    entries = [{"path": "out/large.bin", "sha256": digest, "size": len(body)}]
    base = {"root": project, "identity": KEY, "generation": generation, "entries": entries}
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

print(json.dumps({"ok": True, "pendingBlocked": True, "leaving": leaving, "thirdGenerationLanded": True}))

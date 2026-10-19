"""v1.5 chunked frozen-manifest contract: a >50000-entry registered archive is
deleted only through bounded frozen chunks. Fresh runs stream two bounded
passes (O(1) state) that re-derive the frozen digest, then materialize every
hash-bound chunk and the applied watermark before the first unlink; an
interrupted run resumes from the watermark; unconfirmed new files are refused
and never absorbed; completion keeps only the minimal anti-replay identity; a
rebuilt same-name directory is new data that replay never touches. Fresh
disposable temp root only."""
import hashlib, json, os, pathlib, re, runpy, subprocess, sys, tempfile

engine_path = pathlib.Path(sys.argv[1]).resolve()
stage = sys.argv[2]
state_path = pathlib.Path(sys.argv[3])
BATCH = "job-" + "c" * 48
SRC_REL = "outputs/run"
OP_ID = "chunked-delete-op"

def engine_run(root, request, timeout=9):
    proc = subprocess.run([sys.executable, "-B", "-X", "utf8", str(engine_path)],
                          input=json.dumps(request), capture_output=True, text=True, timeout=timeout)
    assert proc.returncode == 0, (proc.stdout, proc.stderr)
    return json.loads(proc.stdout)

if stage == "build":
    root = pathlib.Path(tempfile.mkdtemp(prefix="se-chunked-"))
    src = root / SRC_REL
    src.mkdir(parents=True)
    # Mixed shape, 50001 frozen rows: 2000 small directories (8 files each,
    # names sorting after the flat files so descending post-order clears them
    # first) plus 32000 flat files, crossing the 50000 threshold by 1.
    for index in range(2000):
        deep = src / ("zz%04d" % index)
        deep.mkdir()
        for leaf in range(8):
            (deep / ("g%d" % leaf)).write_bytes(b"x")
    for index in range(32000):
        (src / ("yy%05d" % index)).write_bytes(b"y")
    dest = "clean_dir/%s/%s" % (BATCH, SRC_REL)
    insp = engine_run(str(root), {"root": str(root), "action": "inspect", "isolate": True,
                                  "operationId": OP_ID,
                                  "target": {"relativePath": SRC_REL, "type": "directory",
                                             "archiveBatch": BATCH, "destination": dest}})
    assert insp.get("ok"), insp
    isolated = engine_run(str(root), {"root": str(root), "rootIdentity": insp["rootIdentity"],
                                      "operationId": OP_ID, "action": "isolate",
                                      "target": {"relativePath": SRC_REL, "type": "directory",
                                                 "archiveBatch": BATCH, "destination": dest}})
    assert isolated.get("ok"), isolated
    assert not (root / SRC_REL).exists() and (root / dest).is_dir()
    state_path.write_text(json.dumps({"root": str(root), "dest": dest}), encoding="utf-8")
    print("ok")
    sys.exit(0)

state = json.loads(state_path.read_text(encoding="utf-8"))
root_text = state["root"]
root = pathlib.Path(root_text)
dest = state["dest"]

def target_for(extra=None):
    target = {"relativePath": dest, "type": "directory",
              "authorizationMode": "confirmed_paths", "destination": dest}
    return {**target, **(extra or {})}

def preview():
    value = engine_run(root_text, {"root": root_text, "action": "inspect", "target": target_for()})
    assert value.get("ok"), value
    return value

def frozen_delete_request():
    return {"root": root_text, "rootIdentity": state["rootIdentity"], "operationId": OP_ID,
            "action": "delete",
            "target": target_for({"chunked": True, "count": state["count"],
                                  "fingerprint": state["fingerprint"]})}

def summary_now():
    frozen = root / "clean_dir/.operations/frozen" / state["manifestKey"]
    return json.loads((frozen / "summary.json").read_text(encoding="utf-8")), frozen

if stage == "abort":
    seen = preview()
    shown = seen["target"]
    assert shown.get("chunked") is True and shown["count"] == 50001 > 50000, shown
    assert re.fullmatch(r"[0-9a-f]{64}", shown["fingerprint"])
    assert re.fullmatch(r"\d+", shown["inode"]) and shown["type"] == "directory"
    assert "inventory" not in shown and "sha256" not in json.dumps(seen), "preview must stay bounded"
    state.update({"count": shown["count"], "fingerprint": shown["fingerprint"],
                  "rootIdentity": seen["rootIdentity"]})
    # The bounded small path is closed for a chunked-claiming ghost target:
    # an unregistered archive batch refuses before any traversal or unlink.
    ghost = engine_run(root_text, {"root": root_text, "rootIdentity": state["rootIdentity"],
                                   "operationId": "ghost-op", "action": "delete",
                                   "target": {"relativePath": "clean_dir/%s/ghost" % BATCH,
                                              "type": "directory", "authorizationMode": "confirmed_paths",
                                              "destination": "clean_dir/%s/ghost" % BATCH,
                                              "chunked": True, "count": 50001, "fingerprint": "0" * 64}})
    assert ghost.get("ok") is not True and ghost["error"]["code"] == "NOT_REGISTERED_ISOLATION", ghost
    engine = runpy.run_path(str(engine_path))
    request = frozen_delete_request()
    unlinks = []
    real_unlink = os.unlink
    def bomb(name):
        unlinks.append(name)
        # Chunks apply newest-first (reversed frozen pre-order). The 5000th
        # unlink lands inside the second applied chunk, after the newest chunk
        # completed with a single unlink, so the watermark must read exactly 1.
        if len(unlinks) == 5000:
            raise OSError("fixture-interrupt")
        real_unlink(name)
    os.unlink = bomb
    try:
        engine["main"](request)
        raise AssertionError("the interrupted run must not report completion")
    except OSError as error:
        assert str(error) == "fixture-interrupt", error
    finally:
        os.unlink = real_unlink
    state["manifestKey"] = engine["manifest_key"](OP_ID, dest, dest)
    summary, frozen = summary_now()
    digests = summary.pop("chunkDigests", None)
    assert summary == {"schemaVersion": 1, "fingerprint": state["fingerprint"],
                       "count": 50001, "applied": 1}, summary
    chunks = sorted(name for name in os.listdir(frozen) if name.startswith("chunk-"))
    assert chunks == ["chunk-%06d.json" % index for index in range(6)], chunks
    assert isinstance(digests, list) and len(digests) == 6, digests
    for index, value in enumerate(digests):
        blob = (frozen / ("chunk-%06d.json" % index)).read_bytes()
        assert re.fullmatch(r"[0-9a-f]{64}", value) and hashlib.sha256(blob).hexdigest() == value, index
    assert not (root / dest / "zz1999").exists(), "the newest applied chunk must have been applied"
    assert (root / dest / "yy31999").exists() and (root / dest / "zz0005" / "g0").exists()
    state_path.write_text(json.dumps(state), encoding="utf-8")
    print("ok")
    sys.exit(0)

if stage == "refuse":
    injector = root / dest / "zz0005" / "unconfirmed-new.txt"
    injector.write_text("user data", encoding="utf-8")
    result = engine_run(root_text, frozen_delete_request())
    assert result.get("ok") is not True and result["error"]["code"] == "DIRECTORY_INVENTORY_CHANGED", result
    assert injector.read_text(encoding="utf-8") == "user data", "new data must never be absorbed"
    summary, _ = summary_now()
    assert summary["applied"] == 2, summary
    assert summary["chunkDigests"] and len(summary["chunkDigests"]) == 6
    # The refusal happened while applying the third newest chunk (zz0005 was no
    # longer empty): finishing the second chunk advanced the watermark once and
    # the refusing chunk never advanced it.
    # The injected file is a test-owned artifact: move it (never delete it)
    # into a retained directory inside this fixture root, so later stages see
    # the frozen layout again while the evidence file survives. Verify the
    # canonical fixture parent and a fresh non-existing target first, then do
    # a no-overwrite rename.
    assert os.path.realpath(str(root)) == str(root), "fixture root must be canonical"
    retain = root / "refuse-retained"
    retain.mkdir()
    assert not os.path.islink(retain) and os.path.realpath(str(retain)) == str(retain)
    retired = retain / injector.name
    assert not os.path.lexists(str(retired)), "retention target must not pre-exist"
    os.rename(str(injector), str(retired))
    assert not injector.exists() and retired.read_text(encoding="utf-8") == "user data"
    print("ok")
    sys.exit(0)

if stage == "complete":
    result = engine_run(root_text, frozen_delete_request())
    assert result.get("ok"), result
    receipt = result["receipt"]
    assert receipt["chunked"] is True and receipt["count"] == 50001, receipt
    assert receipt["fingerprint"] == state["fingerprint"]
    assert "inventory" not in json.dumps(result), "no deleted file list may survive"
    assert not (root / dest).exists() and (root / "clean_dir" / BATCH / "outputs").is_dir()
    control = "isolation:" + os.path.normcase(dest)
    iso = json.loads((root / "clean_dir/.operations/isolation" /
                      (hashlib.sha256(control.encode("utf-8")).hexdigest() + ".json")).read_text(encoding="utf-8"))
    assert iso["state"] == "deleted"
    assert not (root / "clean_dir/.operations/frozen" / state["manifestKey"]).exists()
    replay = engine_run(root_text, frozen_delete_request())
    assert replay.get("state") == "completed" and replay.get("verifiedBy") == "isolation_deleted", replay
    assert "receipt" not in replay and len(json.dumps(replay)) < 600, replay
    print("ok")
    sys.exit(0)

if stage == "rebuild":
    fresh = root / dest
    fresh.mkdir(parents=True)
    (fresh / "new.txt").write_text("new job", encoding="utf-8")
    replay = engine_run(root_text, frozen_delete_request())
    assert replay.get("state") == "completed" and replay.get("verifiedBy") == "isolation_deleted", replay
    assert (fresh / "new.txt").read_text(encoding="utf-8") == "new job"
    print("ok")
    sys.exit(0)

raise SystemExit("unknown stage")

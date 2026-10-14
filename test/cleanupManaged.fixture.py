"""Destructive operations are confined to new disposable CPU fixture files."""
import json, os, pathlib, subprocess, sys, tempfile, time
engine=pathlib.Path(sys.argv[1]);source=engine.read_text(encoding="utf-8")
root=pathlib.Path(tempfile.mkdtemp(prefix="se-clean-observe-"))
engine=root/"engine.py"
engine.write_text(source,encoding="utf-8")
os.environ["TMUX_TMPDIR"]=str(root)
def run(request):
    proc=subprocess.run([sys.executable,"-B",str(engine)],input=json.dumps(request),capture_output=True,text=True,timeout=4)
    assert proc.returncode==0,(proc.stderr,proc.stdout)
    value=json.loads(proc.stdout);assert value.get("ok"),value
    return value
def frozen(name,action):
    target={"relativePath":name,"type":"directory","destination":"clean_dir/"+name,"activityEvidenceMode":"managed_tmux"}
    inspected=run({"root":str(root),"action":"inspect","target":target})
    if name == "outputs/remove":
        assert any(row["binding"].get("planFile")=="experiments/plans/fixture.yaml" for row in inspected["target"].get("manifests",[]))
    return {"root":str(root),"rootIdentity":inspected["rootIdentity"],"target":{**target,**inspected["target"],"destination":target["destination"]},
            "operationId":"fixture-"+name.replace("/","-"),"cleanupAction":action,"runtimeSource":source}
def observe(request):
    return run({**request,"action":"managed-observe"})
def await_done(request):
    deadline=time.monotonic()+3
    while time.monotonic()<deadline:
        value=observe(request)
        if value["state"]=="completed":return value
        if value.get("executor",{}).get("dead") and value["state"]!="completed":
            pane=value["executor"]["paneId"]
            diagnostic=subprocess.run(["tmux","capture-pane","-p","-t",pane],capture_output=True,text=True,timeout=1)
            raise AssertionError((value,diagnostic.stdout))
        time.sleep(.05)
    raise AssertionError("bounded cleanup observation timed out")
try:
    for name in ("outputs/remove","outputs/move"):
        (root/name).mkdir(parents=True);(root/name/"weight.pth").write_bytes(b"fixture")
    (root/"outputs/remove/artifact_manifest.json").write_text(json.dumps({"simpleExperiment":{"runId":"fixture","planFile":"experiments/plans/fixture.yaml","outputDir":"outputs/remove","job":{"index":0,"case":"fixture","seed":42}}}),encoding="utf-8")
    deletion=frozen("outputs/remove","delete")
    run({**deletion,"action":"managed-start"})  # The caller deliberately ignores this transport response.
    await_done(deletion)
    assert not (root/"outputs/remove").exists()
    assert observe(deletion)["state"]=="completed"
    (root/"outputs/remove").mkdir();(root/"outputs/remove"/"new.txt").write_text("new job",encoding="utf-8")
    assert observe(deletion)["state"]=="changed"
    move=frozen("outputs/move","move")
    run({**move,"action":"managed-start"})
    await_done(move)
    assert (root/"clean_dir/outputs/move/weight.pth").read_bytes()==b"fixture"
    assert observe(move)["state"]=="completed"
    print(json.dumps({"ok":True,"realTmux":True,"receiptsRequired":False}))
finally:
    subprocess.run(["tmux","kill-server"],capture_output=True,timeout=2)

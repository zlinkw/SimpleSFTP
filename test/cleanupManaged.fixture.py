"""Destructive operations are confined to new disposable CPU fixture files."""
import base64, json, os, pathlib, subprocess, sys, tempfile, time
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
            "operationId":"fixture-"+name.replace("/","-"),"cleanupAction":action,"runtimeSource":source,"tmuxSessionPrefix":"research"}
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
    metadata=run({"root":str(root),"action":"inventory","manifestOnly":True,"target":{"relativePath":"outputs/remove","type":"directory"}})
    assert metadata["target"]["manifests"][0]["binding"]["runId"]=="fixture"
    # Live task windows block exact artifacts even with no state file or PID scan.
    subprocess.run(["tmux","new-session","-d","-s","writer"],check=True,timeout=1)
    task={"root":str(root),"outputDir":"outputs/remove","collectionResultCsv":"results/fixture.csv"}
    subprocess.run(["tmux","set-option","-w","-t","writer","@se_job",base64.urlsafe_b64encode(json.dumps(task).encode()).decode()],check=True,timeout=1)
    live={"root":str(root),"relativePath":"outputs/remove","destination":"clean_dir/outputs/remove"}
    subprocess.run(["tmux","set-option","-w","-t","writer","@sftp_cleanup_target",base64.urlsafe_b64encode(json.dumps(live).encode()).decode()],check=True,timeout=1)
    presence=run({"root":str(root),"action":"inventory","presenceOnly":True,"observeExecutors":True,"allowMissing":True,"target":{"relativePath":"outputs/remove","type":"directory"}})
    assert presence["target"]["missing"] is False and presence["executorsChecked"] and len(presence["executors"])==1
    rejected=subprocess.run([sys.executable,"-B",str(engine)],input=json.dumps({**deletion,"action":"managed-start"}),capture_output=True,text=True,timeout=2)
    assert json.loads(rejected.stdout)["error"]["code"]=="ACTIVE_TMUX_TASK",rejected.stdout
    subprocess.run(["tmux","kill-window","-t","writer:0"],check=True,timeout=1)
    run({**deletion,"action":"managed-start"})  # The caller deliberately ignores this transport response.
    await_done(deletion)
    names=subprocess.run(["tmux","list-sessions","-F","#{session_name}"],capture_output=True,text=True,timeout=1,check=True).stdout.splitlines()
    assert names and all(name.startswith("research-clean-") for name in names),names
    assert not (root/"outputs/remove").exists()
    absent=run({"root":str(root),"action":"inventory","presenceOnly":True,"observeExecutors":True,"allowMissing":True,"target":{"relativePath":"outputs/remove","type":"directory"}})
    assert absent["target"]["missing"] and absent["executorsChecked"] and not absent["executors"]
    assert observe(deletion)["state"]=="completed"
    (root/"outputs/remove").mkdir();(root/"outputs/remove"/"new.txt").write_text("new job",encoding="utf-8")
    # C3 contract: the persisted completion identity is authoritative. A recreated
    # canonical directory is new-run data; replay must report completed and never
    # re-delete or re-open a window for the finished operation.
    after_recreate=observe(deletion)
    assert after_recreate["state"]=="completed" and after_recreate.get("verifiedBy")=="completion_receipt",after_recreate
    replay=subprocess.run([sys.executable,"-B",str(engine)],input=json.dumps({**deletion,"action":"managed-start"}),capture_output=True,text=True,timeout=2,check=True).stdout
    replayed=json.loads(replay)
    assert replayed["state"]=="completed" and replayed.get("verifiedBy")=="completion_receipt",replay
    assert (root/"outputs/remove"/"new.txt").read_text(encoding="utf-8")=="new job"
    panes=subprocess.run(["tmux","list-panes","-a","-F","#{@sftp_cleanup}"],capture_output=True,text=True,timeout=1,check=True).stdout
    # Self close released the exact pane: no bound cleanup pane remains.
    assert not [line for line in panes.splitlines() if line.strip()],panes
    move=frozen("outputs/move","move")
    run({**move,"action":"managed-start"})
    await_done(move)
    assert (root/"clean_dir/outputs/move/weight.pth").read_bytes()==b"fixture"
    assert observe(move)["state"]=="completed"
    print(json.dumps({"ok":True,"realTmux":True,"receiptsRequired":False}))
finally:
    subprocess.run(["tmux","kill-server"],capture_output=True,timeout=2)

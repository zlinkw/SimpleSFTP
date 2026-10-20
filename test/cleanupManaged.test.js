const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path');
const {spawnSync}=require('node:child_process');
const {CleanupFileApi}=require('../cleanup-file-api');
const linux=p=>'/mnt/'+p[0].toLowerCase()+p.slice(2).replace(/\\/g,'/');
test('cleanup progress counts actual remaining frozen entries and bytes without reading weights',()=>{
  const fixture=path.resolve(__dirname,'cleanupDeleteProgress.fixture.py'),engine=path.resolve(__dirname,'../cleanup-files.py');
  const args=process.platform==='win32'?['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','python3',linux(fixture),linux(engine)]:[fixture,engine];
  const proc=spawnSync(process.platform==='win32'?'wsl.exe':'python3',args,{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(proc.status,0,proc.stderr||proc.stdout);assert.deepEqual(JSON.parse(proc.stdout),{ok:true,actualRemainingFiles:true});
});
test('a busy live mutation lock delays managed admission without becoming a terminal failure or duplicate execution',async()=>{
  let attempts=0,removed=false;
  const api=new CleanupFileApi({storageRoot:path.join(require('node:os').tmpdir(),'managed-busy-'+Date.now()),activity:async()=>{},
    transport:async request=>{
      if(request.action==='inspect')return {ok:true,rootIdentity:{path:'/scope'},target:{absolutePath:'/scope/job',fingerprint:'fp'}};
      if(request.action==='managed-observe')return {ok:true,state:removed?'completed':'pending'};
      if(request.action==='managed-start'){assert.equal(request.tmuxSessionPrefix,'research');if(++attempts===1)return {ok:false,error:{code:'OPERATION_BUSY'}};removed=true;return {ok:true,state:'requested'};}
      assert.fail(request.action);
    }});
  await assert.rejects(api.preview({tmuxSessionPrefix:'bad;command'}), /INVALID_TMUX_SESSION_PREFIX/);
  // v1.9: confirmed paths no longer admit through the managed window, so the
  // busy-lock contract runs on the surviving managed_tmux observation route.
  const p=await api.preview({tmuxSessionPrefix:'research',node:{kind:'remote',root:'/scope'},action:'delete',observationMode:'managed_tmux',targets:[{relativePath:'job',type:'directory',destination:'clean_dir/job'}]});
  for(const phase of [1,2])await api.confirm({token:p.token,digest:p.digest,phase,confirm:true,exactTargets:['/scope/job']});
  const request={token:p.token,digest:p.digest,index:0};
  assert.equal((await api.execute(request)).state,'waiting');
  assert.equal((await api.check(request)).state,'pending');
  await api.execute(request);assert.equal((await api.check(request)).state,'completed');
  await api.execute(request);assert.equal(attempts,2);
});
test('managed cleanup is observable while its execute response is lost, without a busy/receipt gate',async()=>{
  let removed=false,mutations=0;
  const api=new CleanupFileApi({storageRoot:path.join(require('node:os').tmpdir(),'se-managed-api-'+Date.now()),activity:async()=>{},lease:()=>assert.fail('managed query must not use old lease'),
    transport:async request=>{
      if(request.action==='inspect')return {ok:true,rootIdentity:{path:'/scope'},target:{fingerprint:'fp',contentFingerprint:'content',absolutePath:'/scope/job',inode:'i'}};
      if(request.action==='managed-start'){mutations++;removed=true;return new Promise(()=>{});}
      if(request.action==='managed-observe')return {ok:true,state:removed?'completed':'pending',rootIdentity:{path:'/scope'}};
      assert.fail(request.action);
    }});
  const preview=await api.preview({node:{kind:'remote',root:'/scope'},action:'delete',observationMode:'managed_tmux',targets:[{relativePath:'job',type:'directory',destination:'clean_dir/job'}]});
  for(const phase of [1,2])await api.confirm({token:preview.token,digest:preview.digest,phase,confirm:true,exactTargets:['/scope/job']});
  void api.execute({token:preview.token,digest:preview.digest,index:0});
  for(let i=0;i<20&&!removed;i++)await new Promise(resolve=>setTimeout(resolve,5));
  assert.equal((await api.check({token:preview.token,index:0})).state,'completed');
  assert.equal((await api.status({token:preview.token})).states[0],'completed');
  assert.equal((await api.execute({token:preview.token,digest:preview.digest,index:0})).state,'completed');
  assert.equal(mutations,1);
});
test('confirmed managed deletion is retired fail-closed with no mutation, tmux window, or receipt payload',()=>{
  const fixture=path.resolve(__dirname,'cleanupManaged.fixture.py'),engine=path.resolve(__dirname,'../cleanup-files.py');
  const args=process.platform==='win32'?['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','python3',linux(fixture),linux(engine)]:[fixture,engine];
  const proc=spawnSync(process.platform==='win32'?'wsl.exe':'python3',args,{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(proc.status,0,proc.stderr||proc.stdout);assert.deepEqual(JSON.parse(proc.stdout),{ok:true,managedDeleteRetired:true,receiptsRequired:false});
});
test('local cleanup queries the actual in-flight operation and cannot launch a concurrent duplicate',async()=>{
  let removed=false,mutations=0,release;
  const api=new CleanupFileApi({storageRoot:path.join(require('node:os').tmpdir(),'se-local-observe-'+Date.now()),activity:async()=>{},
    transport:async request=>{
      if(request.action==='inspect')return {ok:true,rootIdentity:{path:'/scope'},target:{fingerprint:'fp',contentFingerprint:'c',absolutePath:'/scope/output/job',inode:'i'}};
      if(request.action==='inventory')return {ok:true,rootIdentity:{path:'/scope'},target:{missing:removed,type:'directory',absolutePath:'/scope/output/job'}};
      if(request.action==='managed-observe')return {ok:true,state:removed?'completed':'pending'};
      if(request.action==='delete'){mutations++;return new Promise(resolve=>{release=()=>{removed=true;resolve({ok:true})}})}
      assert.fail(request.action);
    }});
  const p=await api.preview({node:{kind:'local',root:'/scope'},action:'delete',observationMode:'managed_tmux',targets:[{relativePath:'output/job',type:'directory',destination:'clean_dir/output/job'}]});
  for(const phase of [1,2])await api.confirm({token:p.token,digest:p.digest,phase,confirm:true,exactTargets:['/scope/output/job']});
  const execution=api.execute({token:p.token,digest:p.digest,index:0});
  for(let i=0;i<30&&!release;i++)await new Promise(resolve=>setTimeout(resolve,5));assert.ok(release);
  assert.equal((await api.check({token:p.token,index:0})).state,'executing');
  const presence=await api.inspect({node:{kind:'local',root:'/scope'},target:{relativePath:'output/job',type:'directory'},presenceOnly:true,allowMissing:true,observeExecutors:true});
  assert.equal(presence.executorsChecked,true);assert.equal(presence.executors.length,1);
  assert.equal((await api.execute({token:p.token,digest:p.digest,index:0})).state,'executing');assert.equal(mutations,1);
  release();await execution;assert.equal((await api.check({token:p.token,index:0})).state,'completed');
});

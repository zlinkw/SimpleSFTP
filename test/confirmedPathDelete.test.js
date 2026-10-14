const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const {spawnSync}=require('node:child_process');
const {CleanupFileApi}=require('../cleanup-file-api');
test('confirmed paths unlink hardlinked backups across frozen job batches without touching other aliases',()=>{
  const fixture=path.resolve(__dirname,'confirmedHardlinkDelete.fixture.py'),engine=path.resolve(__dirname,'../cleanup-files.py');
  const linux=p=>'/mnt/'+p[0].toLowerCase()+p.slice(2).replace(/\\/g,'/');
  const args=process.platform==='win32'?['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','python3',linux(fixture),linux(engine)]:[fixture,engine];
  const result=spawnSync(process.platform==='win32'?'wsl.exe':'python3',args,{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.deepEqual(JSON.parse(result.stdout),{ok:true,aliasesPreserved:true,changedContentRejected:true});
});
test('confirmed-path preview and deletion inspect metadata without hashing large weights',()=>{
  const fixture=path.resolve(__dirname,'confirmedPathMetadata.fixture.py'),engine=path.resolve(__dirname,'../cleanup-files.py');
  const linux=p=>'/mnt/'+p[0].toLowerCase()+p.slice(2).replace(/\\/g,'/');
  const args=process.platform==='win32'?['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','python3',linux(fixture),linux(engine)]:[fixture,engine];
  const result=spawnSync(process.platform==='win32'?'wsl.exe':'python3',args,{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.stderr||result.stdout);assert.deepEqual(JSON.parse(result.stdout),{ok:true,weightBytesRead:0,metadataChangeRejected:true});
});
test('confirmed-path deletion ignores task/owner activity gates but still requires both exact-path approvals',async()=>{
  let removed=false,mutations=0;
  const api=new CleanupFileApi({storageRoot:path.join(os.tmpdir(),'confirmed-path-'+Date.now()),
    activity:async()=>assert.fail('task/cache activity cannot gate explicit paths'),lease:()=>assert.fail('historical lease cannot gate explicit paths'),
    transport:async request=>{
      assert.equal(request.target.authorizationMode,'confirmed_paths');assert.equal(request.target.expectedOwner,undefined);assert.equal(request.target.expectedSha256,undefined);
      if(request.action==='inspect')return {ok:true,rootIdentity:{path:'/fixture'},target:{fingerprint:'fp',contentFingerprint:'fp',absolutePath:'/fixture/output/job',inode:'i'}};
      if(request.action==='managed-observe')return {ok:true,state:removed?'completed':'pending'};
      if(request.action==='delete'){removed=true;mutations++;return {ok:true};}
      assert.fail(request.action);
    }});
  const p=await api.preview({node:{kind:'local',root:'/fixture'},action:'delete',authorizationMode:'confirmed_paths',targets:[{
    relativePath:'output/job',destination:'clean_dir/output/job',type:'directory',expectedOwner:{obsolete:true},expectedSha256:'old-hash'}]});
  assert.equal(p.safety.confirmedPathDeletion,1);
  await assert.rejects(api.execute({token:p.token,digest:p.digest,index:0}),/CONFIRM_REQUIRED/);
  await api.confirm({token:p.token,digest:p.digest,phase:1,confirm:true,exactTargets:['/fixture/output/job']});
  await assert.rejects(api.execute({token:p.token,digest:p.digest,index:0}),/CONFIRM_REQUIRED/);
  await assert.rejects(api.confirm({token:p.token,digest:p.digest,phase:2,confirm:true,exactTargets:['/fixture/other']}),/CONFIRM_REQUIRED/);
  await api.confirm({token:p.token,digest:p.digest,phase:2,confirm:true,exactTargets:['/fixture/output/job']});
  await api.execute({token:p.token,digest:p.digest,index:0});assert.equal(mutations,1);
});
test('real executor keeps canonical-parent/type/link/content guards while ignoring stale metadata for explicit deletion',()=>{
  const fixture=path.resolve(__dirname,'confirmedPathDelete.fixture.py'),engine=path.resolve(__dirname,'../cleanup-files.py');
  const linux=p=>'/mnt/'+p[0].toLowerCase()+p.slice(2).replace(/\\/g,'/');
  const args=process.platform==='win32'?['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','python3',linux(fixture),linux(engine)]:[fixture,engine];
  const proc=spawnSync(process.platform==='win32'?'wsl.exe':'python3',args,{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(proc.status,0,proc.stderr||proc.stdout);assert.deepEqual(JSON.parse(proc.stdout),{ok:true,exactPathDeleted:true,guardsRetained:true});
});

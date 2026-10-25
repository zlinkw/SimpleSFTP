const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),fs=require('node:fs');
const __CONSUMER__ = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'consumer-root-'));
const {spawnSync}=require('node:child_process');
const {CleanupFileApi}=require('../cleanup-file-api');
const engine=path.resolve(__dirname,'../cleanup-files.py');

test('project root children support live presence, preview and physical-parent deletion while root/git/link guards remain (deletion mocked)',()=>{
 const fixture=path.resolve(__dirname,'rootChildrenCleanup.fixture.py');
 const child=spawnSync(process.platform==='win32'?'python':'python3',['-B','-X','utf8',fixture,engine],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(child.status,0,child.error?.message||child.stderr||child.stdout);
 assert.deepEqual(JSON.parse(child.stdout),{ok:true,rootChildren:true,physicalParentChecked:true,guardsRetained:true,mockedDeletion:true});
});

test('Linux root children use the same guarded executor (deletion mocked)',{skip:process.platform!=='win32'},()=>{
 const fixture=path.resolve(__dirname,'rootChildrenCleanup.fixture.py'),linux=value=>'/mnt/'+value[0].toLowerCase()+value.slice(2).replace(/\\/g,'/');
 const child=spawnSync('wsl.exe',['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','python3',linux(fixture),linux(engine)],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(child.status,0,child.error?.message||child.stderr||child.stdout);
 assert.deepEqual(JSON.parse(child.stdout),{ok:true,rootChildren:true,physicalParentChecked:true,guardsRetained:true,mockedDeletion:true});
});

test('root-file API inspection and preview use the real engine and keep two exact-path confirmations',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'root-file-api-')),relativePath='runtime_manifest.json';
 fs.writeFileSync(path.join(root,relativePath),'fixture only','utf8');
 const node={kind:'local',root},target={relativePath,type:'file',destination:'clean_dir/'+relativePath};
 const api=new CleanupFileApi({storageRoot:path.join(root,'state'),transport:async request=>{
  assert.ok(['inventory', 'inspect', 'batch-inspect', 'batch-verify'].includes(request.action), 'fixture must never execute a real deletion');
  const child=spawnSync(process.platform==='win32'?'python':'python3',['-B','-X','utf8',engine],{input:JSON.stringify(request),encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(child.status,0,child.stderr||child.error?.message);return JSON.parse(child.stdout);
 }});
 const presence=await api.inspect({consumerRoot: __CONSUMER__, node,target,presenceOnly:true,allowMissing:true,observeExecutors:true});assert.equal(presence.target.missing,false);
 const preview=await api.preview({consumerRoot: __CONSUMER__, node,action:'delete',authorizationMode:'confirmed_paths',targets:[target]});
 const approved={token:preview.token,digest:preview.digest,index:0,consumerRoot:__CONSUMER__};
 for(const phase of [1,2]){
  await assert.rejects(api.execute(approved),/CONFIRM_REQUIRED/);
  await assert.rejects(api.confirm({consumerRoot: __CONSUMER__, ...approved,phase,confirm:true,exactTargets:[path.join(root,'other.json')]}),/CONFIRM_REQUIRED/);
  await api.confirm({consumerRoot: __CONSUMER__, ...approved,phase,confirm:true,exactTargets:preview.targets.map(row=>row.absolutePath)});
 }
 assert.equal(fs.readFileSync(path.join(root,relativePath),'utf8'),'fixture only');
 assert.equal(api.previews.get(preview.token).confirmations,2);
});

const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os');
const __CONSUMER__ = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'consumer-root-'));
const {spawnSync}=require('node:child_process'),{CleanupFileApi}=require('../cleanup-file-api');

test('large frozen inventory stays out of post-start checks, including a lost start response and busy admission',async()=>{
 const inventory=Array.from({length:8000},(_,i)=>({path:'trace/'+String(i).padStart(8,'0')+'/checkpoint-name-with-metadata.bin',type:'file',size:1024,mtime:'123456789123456789',ctime:'123456789123456789',device:'12',inode:String(i)}));
 let starts=0,busy=true,active=false,absent=false;const requests=[];
 const api=new CleanupFileApi({storageRoot:path.join(os.tmpdir(),'large-cleanup-'+Date.now()),activity:async()=>{},transport:async request=>{
  requests.push(request);
  if(request.action==='inspect')return {ok:true,rootIdentity:{path:'/project'},target:{absolutePath:'/project/output/job',fingerprint:'fp',type:'directory',inventory}};
  if(request.action==='managed-observe'){
   if(active||absent){assert.ok(Buffer.byteLength(JSON.stringify(request))<8192,'progress queries must not resend the frozen directory inventory');assert.equal(request.target.inventory,undefined);assert.match(request.frozenTargetDigest,/^[a-f0-9]{64}$/);}
   else assert.equal(request.target.inventory.length,8000,'known-not-started admission still verifies the full approved target');
   return {ok:true,state:active?'executing':absent?'completed':'pending'};
  }
  if(request.action==='managed-start'){
   assert.ok(Buffer.byteLength(JSON.stringify(request))>1048576);starts++;
   if(busy){busy=false;return {ok:false,error:{code:'OPERATION_BUSY'}};}
   active=true;throw Error('start response lost');
  }
  assert.fail(request.action);
 }});
 const preview=await api.preview({consumerRoot: __CONSUMER__, node:{kind:'remote',root:'/project'},action:'delete',observationMode:'managed_tmux',targets:[{relativePath:'output/job',destination:'clean_dir/output/job',type:'directory'}]});
 const request={token:preview.token,digest:preview.digest,index:0,consumerRoot:__CONSUMER__};
 for(const phase of [1,2]){await assert.rejects(api.execute(request),/CONFIRM_REQUIRED/);await api.confirm({consumerRoot: __CONSUMER__, ...request,phase,confirm:true,exactTargets:['/project/output/job']});}
 assert.equal((await api.execute(request)).state,'waiting');assert.equal((await api.check(request)).state,'pending');
 await assert.rejects(api.execute(request),/response lost/);
 assert.equal((await api.check(request)).state,'executing');assert.equal((await api.execute(request)).state,'executing');
 active=false;absent=true;assert.equal((await api.check(request)).state,'completed');assert.equal(starts,2,'only explicit not-started admission permits the second send');
 assert.ok(requests.filter(row=>row.action==='managed-observe'&&row.frozenTargetDigest).length>=3);
});

test('real Python stdin and frozen-target observations support multi-MiB inventories with bounded input and no deletion',async()=>{
 const api=new CleanupFileApi({activity:async()=>{},transport:async()=>({ok:true,rootIdentity:{path:'/project'},target:{absolutePath:'/project/目录/📁',fingerprint:'fp',identityProbe:{'10':'十','2':'二','\ue000':'字','😀':'图',numbers:[0,-0,1,0.000001,1e-7,1e21,0.123456789]}}})});
 const preview=await api.preview({consumerRoot: __CONSUMER__, node:{kind:'remote',root:'/project'},action:'delete',observationMode:'managed_tmux',targets:[{relativePath:'目录/📁',destination:'clean_dir/目录/📁',type:'directory'}]});
 const fixture=path.resolve(__dirname,'cleanupLargeInventory.fixture.py'),engine=path.resolve(__dirname,'../cleanup-files.py');
 const child=spawnSync(process.platform==='win32'?'python':'python3',['-B','-X','utf8',fixture,engine],{input:JSON.stringify({target:preview.targets[0],digest:preview.targetDigests[0]}),encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(child.status,0,child.stderr||child.error?.message||child.stdout);
 assert.deepEqual(JSON.parse(child.stdout),{ok:true,largeInput:true,compactProgress:true,tamperRejected:true,noDeletion:true});
});

test('Linux large inventories retain compact observations and guarded child execution (deletion mocked)',{skip:process.platform!=='win32'},()=>{
 const fixture=path.resolve(__dirname,'cleanupLargeInventory.fixture.py'),engine=path.resolve(__dirname,'../cleanup-files.py'),linux=value=>'/mnt/'+value[0].toLowerCase()+value.slice(2).replace(/\\/g,'/');
 const child=spawnSync('wsl.exe',['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','python3',linux(fixture),linux(engine)],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(child.status,0,child.stderr||child.error?.message||child.stdout);
 assert.deepEqual(JSON.parse(child.stdout),{ok:true,largeInput:true,compactProgress:true,tamperRejected:true,noDeletion:true});
});

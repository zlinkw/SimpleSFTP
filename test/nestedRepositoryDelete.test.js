const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const {CleanupFileApi}=require('../cleanup-file-api');

test('confirmed whole-subtree deletion includes nested git, preserves main git and retains path guards (deletion mocked)',()=>{
 const fixture=path.resolve(__dirname,'nestedRepositoryDelete.fixture.py'),engine=path.resolve(__dirname,'../cleanup-files.py');
 const proc=spawnSync(process.platform==='win32'?'python':'python3',['-B','-X','utf8',fixture,engine],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(proc.status,0,proc.error?.message||proc.stderr||proc.stdout);
 assert.deepEqual(JSON.parse(proc.stdout),{ok:true,nestedGitRemoved:true,mainGitProtected:true,guardsRetained:true,mockedDeletion:true});
});

test('real engine fast preview stays entry-only read-only; protected descendants arm at execution',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nested-error-path-')),relativePath='repos/cpsc',blocked=path.join(root,'repos','cpsc','clean_dir');fs.mkdirSync(blocked,{recursive:true});
 const api=new CleanupFileApi({storageRoot:path.join(root,'state'),transport:async request=>{
  assert.ok(request.action==='batch-inspect','confirmed fast preview must stay on the read-only entry route');
  const result=spawnSync(process.platform==='win32'?'python':'python3',['-B','-X','utf8',path.resolve(__dirname,'../cleanup-files.py')],{input:JSON.stringify(request),encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.error?.message||result.stderr);return JSON.parse(result.stdout);
 }});
 const preview=await api.preview({node:{kind:'local',root},action:'delete',authorizationMode:'confirmed_paths',targets:[{relativePath,type:'directory',destination:'clean_dir/'+relativePath}]});
 // v1.9 entry-only preview: no descendant walk, so no preview-time refusal.
 assert.equal(preview.targets.length,1);assert.ok(preview.targets[0].absolutePath.endsWith('/repos/cpsc'));
 // Preview performed zero filesystem writes and opened no isolation.
 assert.ok(fs.readdirSync(path.join(root,'repos','cpsc')).includes('clean_dir'));
 assert.equal(fs.readdirSync(blocked).length,0);
 // Execution-time enforcement of PROTECTED_DESCENDANT (exact blockingPath and
 // reason preserved across the API boundary without leaking other fields) is
 // proven engine-side in nestedRepositoryDelete.fixture.py and JS-side below.
});

test('cleanup API preserves exact blocking path, code and reason without leaking unrelated error fields',async()=>{
 const api=new CleanupFileApi({storageRoot:path.join(os.tmpdir(),'unused-subtree-errors'),transport:async()=>({ok:false,error:{code:'PROTECTED_DESCENDANT',message:'/project/repos/cpsc/clean_dir',blockingPath:'/project/repos/cpsc/clean_dir',reason:'归档区受保护',token:'must-not-leak'}})});
 await assert.rejects(api.checked({}),error=>{assert.equal(error.code,'PROTECTED_DESCENDANT');assert.equal(error.apiData.blockingPath,'/project/repos/cpsc/clean_dir');assert.equal(error.apiData.reason,'归档区受保护');assert.equal(error.apiData.token,undefined);return true;});
});

test('nested-repository preview remains bound to two exact path confirmations',async()=>{
 let mutations=0;
 const api=new CleanupFileApi({storageRoot:path.join(os.tmpdir(),'nested-confirm-'+Date.now()),lease:async(node,targets,run)=>run(),transport:async request=>{
  if(request.action==='batch-inspect')return {ok:true,rootIdentity:{path:'/project'},metrics:{entryReads:request.targets.length},
   targets:request.targets.map(t=>({relativePath:t.relativePath,type:t.type,absolutePath:'/project/'+t.relativePath,device:'7',inode:'9',isolationName:'t'+t.relativePath.replace(/\//g,'-')+'__iso_0123456789abcdef'}))};
  if(request.action==='delete-fast'){mutations++;return {ok:true,receipt:{operationId:request.operationId,metrics:{},receipts:request.entries.map(e=>({relativePath:e.relativePath,mode:'removed'}))}};}
  if(request.action==='batch-verify')return {ok:true,rootIdentity:{path:'/project'},targets:request.entries.map(e=>({...e,status:'gone'}))};
  assert.fail(request.action);
 }});
 const preview=await api.preview({node:{kind:'local',root:'/project'},action:'delete',authorizationMode:'confirmed_paths',targets:[{relativePath:'repos/cpsc',destination:'clean_dir/repos/cpsc',type:'directory'}]});
 // v1.9 fast preview: entry-bound, no content hashing; nested-subtree scope
 // is confirmed by the whole-directory isolation row shown for approval.
 assert.equal(preview.safety.confirmedPathDeletion,1);assert.equal(preview.safety.entryIdentityBind,1);assert.equal(preview.safety.contentHash,0);
 assert.match(preview.targets[0].isolationAbsolutePath,/^\/project\/repos\/trepos-cpsc__iso_0123456789abcdef$/);
 for(const phase of [1,2]){await assert.rejects(api.execute({token:preview.token,digest:preview.digest,index:0}),/CONFIRM_REQUIRED/);await api.confirm({token:preview.token,digest:preview.digest,phase,confirm:true,exactTargets:['/project/repos/cpsc']});}
 assert.equal(mutations,0);await api.execute({token:preview.token,digest:preview.digest,index:0});assert.equal(mutations,1);
});

const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),os=require('node:os'),fs=require('node:fs');
const {spawnSync}=require('node:child_process');
const {CleanupFileApi}=require('../cleanup-file-api');

test('confirmed whole-subtree deletion includes nested git, preserves main git and retains path guards (deletion mocked)',()=>{
 const fixture=path.resolve(__dirname,'nestedRepositoryDelete.fixture.py'),engine=path.resolve(__dirname,'../cleanup-files.py');
 const proc=spawnSync(process.platform==='win32'?'python':'python3',['-B','-X','utf8',fixture,engine],{encoding:'utf8',timeout:10000,windowsHide:true});
 assert.equal(proc.status,0,proc.error?.message||proc.stderr||proc.stdout);
 assert.deepEqual(JSON.parse(proc.stdout),{ok:true,nestedGitRemoved:true,mainGitProtected:true,guardsRetained:true,mockedDeletion:true});
});

test('real Python response retains the exact protected child through the API boundary',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'nested-error-path-')),relativePath='repos/cpsc',blocked=path.join(root,'repos','cpsc','clean_dir');fs.mkdirSync(blocked,{recursive:true});
 const api=new CleanupFileApi({storageRoot:path.join(root,'state'),transport:async request=>{
  const result=spawnSync(process.platform==='win32'?'python':'python3',['-B','-X','utf8',path.resolve(__dirname,'../cleanup-files.py')],{input:JSON.stringify(request),encoding:'utf8',timeout:10000,windowsHide:true});
  assert.equal(result.status,0,result.error?.message||result.stderr);return JSON.parse(result.stdout);
 }});
 await assert.rejects(api.preview({node:{kind:'local',root},action:'delete',authorizationMode:'confirmed_paths',targets:[{relativePath,type:'directory',destination:'clean_dir/'+relativePath}]}),error=>{assert.equal(error.code,'PROTECTED_DESCENDANT');assert.equal(error.apiData.blockingPath,fs.realpathSync(blocked));assert.match(error.apiData.reason,/归档区受保护/);return true;});
});

test('cleanup API preserves exact blocking path, code and reason without leaking unrelated error fields',async()=>{
 const api=new CleanupFileApi({storageRoot:path.join(os.tmpdir(),'unused-subtree-errors'),transport:async()=>({ok:false,error:{code:'PROTECTED_DESCENDANT',message:'/project/repos/cpsc/clean_dir',blockingPath:'/project/repos/cpsc/clean_dir',reason:'归档区受保护',token:'must-not-leak'}})});
 await assert.rejects(api.checked({}),error=>{assert.equal(error.code,'PROTECTED_DESCENDANT');assert.equal(error.apiData.blockingPath,'/project/repos/cpsc/clean_dir');assert.equal(error.apiData.reason,'归档区受保护');assert.equal(error.apiData.token,undefined);return true;});
});

test('nested-repository preview remains bound to two exact path confirmations',async()=>{
 let mutations=0;
 const api=new CleanupFileApi({storageRoot:path.join(os.tmpdir(),'nested-confirm-'+Date.now()),transport:async request=>{
  if(request.action==='inspect')return {ok:true,rootIdentity:{path:'/project'},target:{absolutePath:'/project/repos/cpsc',fingerprint:'fp',inventory:[{path:'.git/config',type:'file'}]}};
  if(request.action==='managed-observe')return {ok:true,state:'pending'};
  if(request.action==='delete'){mutations++;return {ok:true};}assert.fail(request.action);
 }});
 const preview=await api.preview({node:{kind:'local',root:'/project'},action:'delete',authorizationMode:'confirmed_paths',targets:[{relativePath:'repos/cpsc',destination:'clean_dir/repos/cpsc',type:'directory'}]});
 assert.equal(preview.safety.confirmedPathNestedRepositories,1);
 for(const phase of [1,2]){await assert.rejects(api.execute({token:preview.token,digest:preview.digest,index:0}),/CONFIRM_REQUIRED/);await api.confirm({token:preview.token,digest:preview.digest,phase,confirm:true,exactTargets:['/project/repos/cpsc']});}
 assert.equal(mutations,0);await api.execute({token:preview.token,digest:preview.digest,index:0});assert.equal(mutations,1);
});

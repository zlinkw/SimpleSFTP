const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),Module=require('node:module'),{spawnSync}=require('node:child_process');
const original=Module._load;Module._load=function(name,...args){return name==='vscode'?{TreeItem:class{},ProgressLocation:{Notification:1},workspace:{workspaceFolders:[],getConfiguration:()=>({get:(_,fallback)=>fallback})},window:{withProgress:(_,work)=>work({report(){}})}}:original.call(this,name,...args);};
const {__test}=require('../extension.js');Module._load=original;
function probe(script,relative,setup=()=>{},prefix=''){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'sftp-tree-')),file=path.join(root,'probe.py');setup(root);
 fs.writeFileSync(file,"import json,sys\ntry:\n"+(prefix+script).split('\n').map(line=>' '+line).join('\n')+"\nexcept Exception as exc:\n print(json.dumps({'error':str(exc)}))\n",'utf8');
 const result=spawnSync(process.platform==='win32'?'python':'python3',['-B','-X','utf8',file,root,relative],{encoding:'utf8',timeout:10000,windowsHide:true});assert.equal(result.status,0,result.stderr||result.stdout);return {...result,value:JSON.parse(result.stdout)};
}
test('real metadata scripts distinguish empty, absent, nonempty and wrong-type paths without scanning file content',()=>{
 const script=__test.projectTreeStateScript();
 assert.deepEqual(probe(script,'empty',root=>fs.mkdirSync(path.join(root,'empty'))).value,{exists:true,empty:true});
 assert.deepEqual(probe(script,'gone').value,{exists:false});
 assert.deepEqual(probe(script,'full',root=>{fs.mkdirSync(path.join(root,'full'));fs.writeFileSync(path.join(root,'full','large.bin'),'bytes','utf8');}).value,{exists:true,empty:false});
 assert.match(probe(script,'file',root=>fs.writeFileSync(path.join(root,'file'),'x','utf8')).value.error,/NOT_DIRECTORY/);
 assert.match(probe(script,'../outside').value.error,/unsafe/);
 assert.match(probe(script,'empty',root=>fs.mkdirSync(path.join(root,'empty')),"import os\ndef denied(*args,**kwargs): raise PermissionError('permission denied')\nos.scandir=denied\n").value.error,/permission denied/);
});
test('real tree enumeration reports genuine entry progress and exposes an existing empty directory without old file rows',()=>{
 const script=__test.projectTreeScript();
 assert.deepEqual(probe(script,'empty',root=>fs.mkdirSync(path.join(root,'empty'))).value,{exists:true,entries:[]});
 assert.deepEqual(probe(script,'gone').value,{exists:false,entries:[]});
 const result=probe(script,'files',root=>{fs.mkdirSync(path.join(root,'files'));for(let i=0;i<70;i++)fs.writeFileSync(path.join(root,'files',i+'.txt'),'x','utf8');});
 assert.equal(result.value.entries.length,70);const counts=result.stderr.trim().split('\n').map(line=>JSON.parse(line.slice(16)).processedFiles);assert.deepEqual(counts,[32,64]);
 assert.equal(__test.projectTreePathAllowed('tmp/result/job.csv'),true);assert.equal(__test.projectTreePathAllowed('tmp/runtime.pid'),false);
});
test('new inventory reads do not wait for or replace old uncertain read receipts',async()=>{
 const old=[{operationId:'old-read',operationInstanceId:'old',status:'outcomeUnknown',requestKey:'a'.repeat(64),remoteMutation:false,recoveryContext:{method:'sync.projectInventory'}}];let saved;
 __test.setTransferSettlementTestContext({instanceId:'new',globalState:{get:(_,fallback)=>saved||old||fallback,update:async(_,value)=>saved=value}});
 __test.setRemoteBatchTransport(async()=>JSON.stringify({files:{}}));
 try{const result=await __test.createLocalApiMethods()['sync.projectInventory']({source:{host:'fixture.invalid',username:'u',remotePath:'/fixture'},relativePath:'.',scopePaths:['work_dirs'],_operationId:'new-read',_operationInstanceId:'new',_requestKey:'a'.repeat(64)});assert.deepEqual(result.files,{});assert.equal(saved,undefined,'pure reads persist no transfer transaction');}
 finally{__test.setRemoteBatchTransport(null);}
});
test('empty tree and existence queries do not queue behind large inventory or file-transfer work',async()=>{
 const source={host:'empty-fixture.invalid',username:'u',remotePath:'/fixture'};let release,entered=false;
 __test.setTransferSettlementTestContext({instanceId:'new',globalState:{get:(_,fallback)=>fallback,update:async()=>{}}});
 __test.setRemoteBatchTransport(async()=>{entered=true;return await new Promise(resolve=>release=()=>resolve(JSON.stringify({files:{}})));});
 __test.setProjectTreeTransport(async()=>JSON.stringify({exists:true,empty:true,entries:[]}));
 const methods=__test.createLocalApiMethods(),inventory=methods['sync.projectInventory']({source,scopePaths:['work_dirs']});await new Promise(setImmediate);assert.equal(entered,true);
 try{const tree=await methods['sync.projectTree']({source,relativePath:'work_dirs'});assert.deepEqual(tree.entries,[]);const state=await methods['sync.projectTreeState']({source,relativePath:'work_dirs'});assert.equal(state.empty,true);}
 finally{release();await inventory;__test.setRemoteBatchTransport(null);__test.setProjectTreeTransport(null);}
});

test('cleanup progress is request-scoped and does not consult or persist transfer receipts',async()=>{
 let observed=false;
 __test.setTransferSettlementTestContext({instanceId:'cleanup-instance',globalState:{get:()=>assert.fail('cleanup cannot read old transfer records'),update:()=>assert.fail('cleanup cannot persist transfer records')},
  cleanupApi:{preview:async()=>{const active=__test.listActiveTransfers();assert.ok(active.some(row=>row.operation==='files.cleanup.preview'&&row.operationId==='cleanup-progress'));observed=true;return {ok:true};}}});
 try {const result=await __test.createLocalApiMethods()['files.cleanup.preview']({_operationId:'cleanup-progress',_requestKey:'a'.repeat(64)});assert.equal(result.ok,true);assert.equal(observed,true);assert.equal(__test.listActiveTransfers().length,0);}
 finally {__test.setTransferSettlementTestContext({cleanupApi:null,globalState:{get:(_,fallback)=>fallback,update:async()=>{}}});}
});

test('bounded code inventory lane bypasses a bulk read on the same server and reports capacity timing',async()=>{
 const source={host:'slow-inventory.invalid',username:'u',remotePath:'/fixture'};
 let release,codeStarted=false;
 __test.setTransferSettlementTestContext({instanceId:'lanes',globalState:{get:(_,fallback)=>fallback,update:async()=>{}}});
 __test.setRemoteBatchTransport(async(_source,_command,paths)=>{
  if(paths.includes('src/train.py')){codeStarted=true;return JSON.stringify({files:{}});}
  return new Promise(resolve=>release=()=>resolve(JSON.stringify({files:{}})));
 });
 const methods=__test.createLocalApiMethods();
 const bulk=methods['sync.projectInventory']({source,scopePaths:['work_dirs'],_operationId:'bulk-lane'});
 await new Promise(setImmediate);
 const code=methods['sync.projectInventory']({source,scopePaths:['src/train.py'],inventoryPurpose:'code-sync',_operationId:'code-lane'});
 try {
  await new Promise(setImmediate);
  assert.equal(codeStarted,true,'code lookup must not wait for unrelated bulk inventory');
  const codeResult=await code;
  assert.equal(codeResult.queryTiming.lane,'code-sync');
  assert.ok(codeResult.queryTiming.completedAt);
  const active=__test.listActiveTransfers().find(t=>t.operationId==='bulk-lane');
  assert.equal(active.capacityState,'running');
  assert.ok(active.capacityQueuedAt);assert.ok(active.capacityGrantedAt);
  assert.ok(active.capacityWaitMs>=0);
 } finally {release();await Promise.all([bulk,code]);__test.setRemoteBatchTransport(null);}
});

test('code inventory lane still serializes the same server and releases its next ticket after a failure',async()=>{
 const source={host:'bounded-code.invalid',username:'u',remotePath:'/fixture'};
 let failFirst,starts=0;
 __test.setTransferSettlementTestContext({instanceId:'bounded',globalState:{get:(_,fallback)=>fallback,update:async()=>{}}});
 __test.setRemoteBatchTransport(async()=>{
  if(++starts===1)return new Promise((_resolve,reject)=>failFirst=()=>reject(Error('real read failure')));
  return JSON.stringify({files:{}});
 });
 const methods=__test.createLocalApiMethods();
 const first=methods['sync.projectInventory']({source,scopePaths:['src/a.py'],inventoryPurpose:'code-sync',_operationId:'code-first'});
 const failed=assert.rejects(first,/real read failure/);
 await new Promise(setImmediate);
 const next=methods['sync.projectInventory']({source,scopePaths:['src/b.py'],inventoryPurpose:'code-sync',_operationId:'code-next'});
 try {
  await new Promise(setImmediate);assert.equal(starts,1);
  const waiting=__test.listActiveTransfers().find(t=>t.operationId==='code-next');
  assert.equal(waiting.capacityState,'queued');assert.equal(waiting.capacityGrantedAt,undefined);
 } finally {failFirst();await failed;await next;__test.setRemoteBatchTransport(null);}
 assert.equal(starts,2);assert.equal(__test.listActiveTransfers().length,0);
});

test('bounded memory result reads bypass bulk inventory on the same host and release failed tickets',async()=>{
 const source={host:'memory-lane.invalid',username:'u',remotePath:'/fixture'},root=fs.mkdtempSync(path.join(os.tmpdir(),'sftp-memory-lane-'));
 let release,started=0,notify;const began=new Promise(resolve=>notify=resolve);
 __test.setTransferSettlementTestContext({instanceId:'memory-lane',globalState:{get:(_,fallback)=>fallback,update:async()=>{}}});
 __test.setRemoteBatchTransport(async()=>new Promise(resolve=>release=()=>resolve(JSON.stringify({files:{}}))));
 __test.setMappedDownloadTransport(async()=>{started++;notify();throw Error('memory source changed');});
 const methods=__test.createLocalApiMethods(),bulk=methods['sync.projectInventory']({source,scopePaths:['work_dirs'],_operationId:'bulk-memory'});
 await new Promise(setImmediate);
 const params={server:source,localPath:root,memoryOnly:true,metricsOnly:true,wrapperResults:true,compression:'none',confirm:true,pathConfirmed:true,
  entries:[{remotePath:'work_dirs/a/metrics.csv',localRelativePath:'unused/a.csv',bytes:1,sha256:'a'.repeat(64)}]};
 const first=assert.rejects(methods['sync.downloadMappedPaths']({...params,_operationId:'memory-first'}),/memory source changed/);
 try{
  await Promise.race([began,new Promise(resolve=>setTimeout(resolve,300))]);
  assert.equal(started,1,'a 4 MiB bounded memory read must not wait for the bulk inventory');
  await first;
  await assert.rejects(methods['sync.downloadMappedPaths']({...params,_operationId:'memory-next'}),/memory source changed/);
  assert.equal(started,2);assert.deepEqual(fs.readdirSync(root),[]);
 }finally{release();await Promise.allSettled([bulk,first]);__test.setRemoteBatchTransport(null);__test.setMappedDownloadTransport(null);}
});

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

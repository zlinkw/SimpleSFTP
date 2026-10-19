const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('real cleanup transport prepares the pinned program once and calls it by exact short path',async()=>{
 const source=fs.readFileSync(require.resolve('../extension.js'),'utf8');
 const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
 const engineSource='print(1)\n';
 const api=require('../cleanup-file-api');
 const expected=api.runtimePrepareRequest({root:'/fixture/project',source:engineSource});
 // Identity binding: the real object contract travels when known; a wrong
 // shape refuses loudly instead of silently dropping the binding.
 assert.deepEqual(api.runtimePrepareRequest({root:'/fixture/project',source:engineSource,rootIdentity:{path:'/fixture/project',device:'7',inode:'9',machine:'h',user:'u'}}).request.rootIdentity,{path:'/fixture/project',device:'7',inode:'9',machine:'h',user:'u'});
 assert.throws(()=>api.runtimePrepareRequest({root:'/fixture/project',source:engineSource,rootIdentity:'stale-string'}),/INVALID_REQUEST/);
 const calls=[];
 const context={fs:{readFileSync:()=>engineSource},path:require('node:path'),__dirname:'.',JSON,Buffer,
  normalizeSshPort:value=>{assert.ok(Number.isInteger(value)&&value>0&&value<65536);return value;},
  cleanupFail:(code)=>{throw Error(code)},shellQuote:JSON.stringify,
  runtimePrepareRequest:api.runtimePrepareRequest,remoteRuntimePrepareCommand:api.remoteRuntimePrepareCommand,remoteRuntimeCommand:api.remoteRuntimeCommand,
  readSharedServers:()=>assert.fail('saved aliases must not gate a fully specified cleanup target'),
  directSyncTarget:undefined,
  runRemoteBatchSsh:async(target,command,paths)=>{
   calls.push({command,stdin:paths&&paths[0]});
   if(paths&&paths[0].includes('"action":"runtime-prepare"'))
    return JSON.stringify({ok:true,state:'installed',runtimeSha256:expected.sha256,programRelativePath:expected.programRelativePath,rootIdentity:{path:'/fixture/project',device:'7',inode:'9',machine:'fixture-host',user:'fixture'}});
   assert.deepEqual(JSON.parse(JSON.stringify(target)),{host:'fixture-ip',username:'fixture',remotePath:'/fixture/project',port:30222});
   return '{"ok":true}';}};
 vm.createContext(context);vm.runInContext(extract('function directSyncTarget(', 'function directSyncRelativePath('),context);
 vm.runInContext(extract('const remoteRuntimePrograms = new Set()', 'function runSsh('),context);
 const result=await context.cleanupFileTransport({action:'inspect',node:{id:'worker',kind:'remote',host:'fixture-ip',user:'fixture',port:30222,root:'/fixture/project'}});
 assert.equal(result.ok,true);
 assert.equal(calls.length,2);
 assert.match(calls[0].command,/^python3 -B -c /);
 assert.ok(calls[0].command.length<20000);
 assert.match(JSON.parse(calls[0].stdin).runtimeSha256,/^[a-f0-9]{64}$/);
 assert.match(calls[1].command,/^python3 -B -X utf8 "\/fixture\/project\/clean_dir\/\.operations\/managed\/runtime-[a-f0-9]{64}\.py"$/);
 // The second request reuses the verified program without a new prepare round.
 await context.cleanupFileTransport({action:'inspect',node:{id:'worker',kind:'remote',host:'fixture-ip',user:'fixture',port:30222,root:'/fixture/project'}});
 assert.equal(calls.length,3);
 await assert.rejects(context.cleanupFileTransport({action:'inspect',node:{kind:'remote',host:'bad host',user:'fixture',port:30222,root:'/fixture/project'}}));
});

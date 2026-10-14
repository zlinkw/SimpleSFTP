const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
test('real cleanup transport uses the exact supplied endpoint without active or duplicate profile gates',async()=>{
 const source=fs.readFileSync(require.resolve('../extension.js'),'utf8');
 const extract=(start,end)=>source.slice(source.indexOf(start),source.indexOf(end,source.indexOf(start)));
 const context={fs:{readFileSync:()=>''},path:require('node:path'),__dirname:'.',JSON,
  normalizeSshPort:value=>{assert.ok(Number.isInteger(value)&&value>0&&value<65536);return value;},
  cleanupFail:code=>{throw Error(code)},cleanupRemoteLoader:()=> 'probe',shellQuote:JSON.stringify,
  readSharedServers:()=>assert.fail('saved aliases must not gate a fully specified cleanup target'),
  runRemoteBatchSsh:async(target)=>{assert.deepEqual(JSON.parse(JSON.stringify(target)),{host:'fixture-ip',username:'fixture',remotePath:'/fixture/project',port:30222});return '{"ok":true}';}};
 vm.createContext(context);vm.runInContext(extract('function directSyncTarget(', 'function directSyncRelativePath('),context);
 vm.runInContext(extract('async function cleanupFileTransport(', 'function runSsh('),context);
 const result=await context.cleanupFileTransport({action:'inspect',node:{id:'worker',kind:'remote',host:'fixture-ip',user:'fixture',port:30222,root:'/fixture/project'}});
 assert.equal(result.ok,true);
 await assert.rejects(context.cleanupFileTransport({action:'inspect',node:{kind:'remote',host:'bad host',user:'fixture',port:30222,root:'/fixture/project'}}));
});

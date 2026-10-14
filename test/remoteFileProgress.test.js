const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{spawnSync}=require('node:child_process');
const {remoteFileProgressScript}=require('../transfer-file-progress');
test('actual remote-file samples compare partial sizes and file count without treating old files as transferred',()=>{
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'remote-file-progress-')),script=path.join(directory,'progress.py');fs.writeFileSync(script,remoteFileProgressScript(),'utf8');
 const result=spawnSync('python',['-B','-X','utf8',path.join(__dirname,'remoteFileProgress.fixture.py'),script],{encoding:'utf8',windowsHide:true,timeout:10000});
 assert.equal(result.status,0,result.stderr||result.stdout);assert.deepEqual(JSON.parse(result.stdout),{ok:true,partialBytes:4,totalBytes:12,totalFiles:3,persistentProgressFiles:0});
});

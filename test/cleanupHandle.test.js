const test=require('node:test'), assert=require('node:assert/strict'),path=require('node:path');
const {spawnSync}=require('node:child_process');
test('unrelated inaccessible proc entries are reported; real target handles still block',()=>{
  const linux=file=>'/mnt/'+file[0].toLowerCase()+file.slice(2).replace(/\\/g,'/');
  const script=path.join(__dirname,'cleanupHandle.fixture.py'),source=path.join(__dirname,'../cleanup-files.py');
  const proc=spawnSync(process.platform==='win32'?'wsl.exe':'python3',process.platform==='win32'
    ? ['--distribution',process.env.SIMPLE_TEST_WSL_DISTRO||'Ubuntu-Codex','--exec','python3',linux(script),linux(source)] : [script,source],
    {encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(proc.status,0,proc.stderr||proc.stdout||proc.error?.message);
  assert.deepEqual(JSON.parse(proc.stdout),{ok:true,realLinuxHandles:true,permissionRace:true});
});

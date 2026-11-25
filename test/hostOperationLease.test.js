const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { HostOperationLeaseManager, HostOperationLeaseConflictError, HostOperationLeaseLostError } = require('../host-operation-lease');
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resource-lease-evidence-'));
  const leasePath = path.join(root, 'host-operation-lease.json');
  const manager = (windowId, extra = {}) => new HostOperationLeaseManager({leasePath, windowId, heartbeatMs:0, ttlMs:30000, ...extra});
  const input = (target='D:/project/plans/a.yaml', server='local', project='D:/project') => ({
    pluginId:'simple-local.test', workspaceUri:'file:///D:/project', hostProjectPath:project,
    actionType:'write', actionLabel:'写入目标', resources:[{server, project, target}],
  });
  return {root,leasePath,manager,input}; // Retain isolated evidence; never delete arbitrary fixture paths.
}
test('different targets, projects and Workers proceed in parallel across windows', async()=>{
  const f=fixture(), a=f.manager('a'), b=f.manager('b');
  const held=await a.acquire(f.input());
  const others=await Promise.all([
    b.acquire(f.input('D:/project/plans/b.yaml')),
    b.acquire(f.input('D:/other/a.yaml','local','D:/other')),
    b.acquire(f.input('/project/a','worker:22','/project')),
  ]);
  await held.assertHeld(); await Promise.all(others.map(h=>h.release())); await held.release();
});
test('same file and parent/child directory conflict; sibling-prefix is independent', async()=>{
  const f=fixture();const held=await f.manager('a').acquire(f.input('D:/project/output'));
  for (const target of ['d:/PROJECT/output','D:/project/output/metric.csv','D:/project']) {
    await assert.rejects(f.manager('b').acquire(f.input(target)),HostOperationLeaseConflictError);
  }
  const sibling=await f.manager('b').acquire(f.input('D:/project/output-other'));await sibling.release();await held.release();
});
test('pending cleanup survives owner loss and conflicts only on overlapping paths until resolved',async()=>{
  const f=fixture(), owner=f.manager('cleanup-owner',{processId:1234}), next=f.manager('next',{ownerAlive:()=>false});
  await owner.reservePendingCleanup('operation:0',f.input('D:/project/output'));
  for(const target of ['D:/project/output','D:/project/output/result','D:/project'])
    await assert.rejects(next.acquire(f.input(target)),HostOperationLeaseConflictError);
  const sibling=await next.acquire(f.input('D:/project/other'));await sibling.release();
  await assert.rejects(next.reservePendingCleanup('operation:0',f.input('D:/project/output')),/重复执行/);
  await next.resolvePendingCleanup('operation:0');
  const released=await next.acquire(f.input('D:/project/output'));await released.release();
  const transfer=await next.acquire(f.input('D:/project/output/file'));
  await assert.rejects(owner.reservePendingCleanup('operation:1',f.input('D:/project/output')),HostOperationLeaseConflictError);
  await transfer.release();
});
test('transfer settlement cannot release cleanup or another transfer identity',async()=>{
  const f=fixture(), owner=f.manager('owner'), next=f.manager('next');
  const operation='op-a', key='transfer:op-a:12345678-1234-4123-8123-123456789abc';
  const cleanup='cleanup-request:batch';
  const cleanupShapedLikeTransfer='transfer:op-a:12345678-1234-4123-8123-123456789abd';
  await owner.reservePendingCleanup(cleanup,f.input('D:/project/cleanup'));
  await owner.reservePendingCleanup(cleanupShapedLikeTransfer,f.input('D:/project/other-cleanup'));
  await owner.reservePendingTransfer(key,f.input('D:/project/upload'));
  await assert.rejects(owner.resolvePendingTransfer(cleanup,operation),/身份不匹配/);
  await assert.rejects(owner.resolvePendingTransfer(cleanupShapedLikeTransfer,operation),/类型或身份不匹配/);
  await assert.rejects(owner.resolvePendingTransfer(key,'op-b'),/身份不匹配/);
  await assert.rejects(next.acquire(f.input('D:/project/cleanup')),HostOperationLeaseConflictError);
  await assert.rejects(next.acquire(f.input('D:/project/other-cleanup')),HostOperationLeaseConflictError);
  await assert.rejects(next.acquire(f.input('D:/project/upload')),HostOperationLeaseConflictError);
  await owner.resolvePendingTransfer(key,operation); await owner.resolvePendingTransfer(key,operation);
  const upload=await next.acquire(f.input('D:/project/upload'));await upload.release();
  await assert.rejects(next.acquire(f.input('D:/project/cleanup')),HostOperationLeaseConflictError);
  await owner.resolvePendingCleanup(cleanup);
  await owner.resolvePendingCleanup(cleanupShapedLikeTransfer);
});
test('shared reads coexist but conflict with a writer on the same range',async()=>{
  const f=fixture(), first=f.manager('first'), second=f.manager('second');
  const input=f.input('D:/project/output');input.resources[0].access='read';
  const a=await first.acquire(input), b=await second.acquire(input);
  await assert.rejects(second.acquire(f.input('D:/project/output/child')),HostOperationLeaseConflictError);
  await a.release();await b.release();
});
test('simultaneous conflicting claims admit exactly one writer',async()=>{
  const f=fixture();const result=await Promise.allSettled(['a','b','c'].map(id=>f.manager(id).acquire(f.input())));
  assert.equal(result.filter(r=>r.status==='fulfilled').length,1);
  for(const row of result)if(row.status==='fulfilled')await row.value.release();
});
test('same-window unrelated work is parallel; only genuine nested operations reenter',async()=>{
  const f=fixture(), a=f.manager('a'), other=f.manager('b');
  await a.run(f.input('D:/project/output'),async()=>{
    await a.run(f.input('D:/project/output/result.csv'),async()=>{
      await assert.rejects(other.acquire(f.input('D:/project/output')),HostOperationLeaseConflictError);
    });
    await assert.rejects(other.acquire(f.input('D:/project/output')),HostOperationLeaseConflictError);
  });
  const held=await a.acquire(f.input());
  await assert.rejects(a.acquire(f.input()),HostOperationLeaseConflictError);await held.release();
});
test('nested transfer phases borrow the enclosing pending range',async()=>{
  const f=fixture(),owner=f.manager('owner'),other=f.manager('other'),whole=f.input('D:/project/output'),child=f.input('D:/project/output/a.csv');
  whole.resources.push({server:'worker:22',project:'/project',target:'/project/output',access:'read'});
  child.resources.push({server:'worker:22',project:'/project',target:'/project/output/a.csv',access:'read'});
  await owner.run(whole,async()=>{
    await owner.runPendingTransfer('whole',whole,async()=>{
      await owner.run(child,async()=>{
        const nested=await owner.runPendingTransfer('child',child,async()=>42,()=>assert.fail('covered phase must borrow'));
        assert.equal(nested.borrowed,true);assert.equal(nested.value,42);
      });
      await assert.rejects(other.acquire(child),HostOperationLeaseConflictError);
      const independent=await other.acquire(f.input('D:/project/other'));await independent.release();
    },()=>{});
    await owner.resolvePendingCleanup('whole');
  });
});
test('read-only queries bypass writers and stop callbacks need no resource admission',async()=>{
  const f=fixture(), a=f.manager('a'), b=f.manager('b');const held=await a.acquire(f.input());
  assert.equal(await b.run({...f.input(),readOnly:true},async()=>42),42);await held.release();
});
test('continuous heartbeat preserves ownership beyond lease TTL and keeps UTF-8 labels',async()=>{
  const f=fixture(), a=f.manager('a',{ttlMs:120,heartbeatMs:20});const held=await a.acquire(f.input());
  await new Promise(r=>setTimeout(r,190));await held.assertHeld();
  const row=(await a.inspect()).records.find(r=>r.leaseId===held.record.leaseId);
  assert.equal(row.actionLabel,'写入目标');assert.ok(Date.parse(row.expiresAt)>Date.now());
  await assert.rejects(f.manager('b').acquire(f.input()),HostOperationLeaseConflictError);await held.release();
});
test('crash expiration permits replacement and a stale release cannot touch another owner',async()=>{
  const f=fixture();let now=Date.now();const a=f.manager('a',{ttlMs:100,now:()=>now}),b=f.manager('b',{now:()=>now});
  const stale=await a.acquire(f.input());now+=101;
  const held=await b.acquire(f.input());await assert.rejects(stale.assertHeld(),HostOperationLeaseLostError);
  await stale.release();await held.assertHeld();await held.release();
});
test('an injected proven-dead owner permits crash recovery without unreliable Windows probes',async()=>{
  const f=fixture();const stale=await f.manager('a',{processId:1234}).acquire(f.input());
  const held=await f.manager('b',{ownerAlive:row=>row.processId!==1234}).acquire(f.input());
  await stale.release();await held.assertHeld();await held.release();
});
test('active legacy global lease blocks upgrade and is preserved byte-for-byte',async()=>{
  const f=fixture();const text=JSON.stringify({schemaVersion:1,windowId:'old-window',expiresAt:new Date(Date.now()+30000).toISOString()});
  fs.writeFileSync(f.leasePath,text,'utf8');await assert.rejects(f.manager('new').acquire(f.input()),/重新加载.*窗口/);
  assert.equal(fs.readFileSync(f.leasePath,'utf8'),text);
});

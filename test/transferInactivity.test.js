const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { ProgressInactivity } = require('../progress-inactivity');
function fixture(options={}) {
  const source=fs.readFileSync(require.resolve('../extension.js'),'utf8');
  const start=source.indexOf('function createTransferController('), end=source.indexOf('function transferTimeoutMs(',start);
  const events=[];
  const context={ProgressInactivity:options.ProgressInactivity||ProgressInactivity,Date,Set,Object,Number,Math,queueMicrotask,maybeSettleTransferOperation:async()=>{},
    transferContext:{getStore:()=>undefined},activeTransfers:new Map(),localApiServer:{publish:e=>events.push(e)}};
  vm.createContext(context);
  vm.runInContext(source.slice(start,end)+'; this.create=createTransferController; this.list=listActiveTransfers;',context);
  return {...context,events};
}
test('real transfer stalls remain cancellable and recover from later actual file progress',()=>{
 let clock=0,watch;
 class Clocked extends ProgressInactivity{constructor(ms,onIdle,_now,notifyOnly){super(120,onIdle,()=>clock,notifyOnly);watch=this;}}
 const f=fixture({ProgressInactivity:Clocked}),c=f.create({id:'actual',operation:'upload',observeOnlyIdle:true});
 c.updateProgress({phase:'transferring',processedBytes:2,writtenBytes:2,writtenFiles:0,totalBytes:10,totalFiles:2});
 clock=121;assert.equal(watch.check(),true);assert.equal(c.status,'running');assert.equal(c.stalled,true);
 clock=130;c.updateProgress({phase:'transferring',processedBytes:10,processedFiles:2,writtenBytes:10,writtenFiles:2,totalBytes:10,totalFiles:2});
 assert.equal(c.stalled,false);assert.equal(f.list()[0].writtenBytes,10);assert.equal(f.list()[0].writtenFiles,2);
 assert.equal(c.cancel('user cancelled'),true);assert.equal(c.status,'cancelled');c.dispose();
});
test('inventory, directory reads and cleanup controllers do not auto-cancel silent filesystem work',()=>{
 for(const operation of ['sync.projectInventory','sync.projectTree','sync.projectTreeState','sync.projectFileStats','files.cleanup.preview','files.cleanup.execute','remote.listDirs']){
  let clock=0,watch;
  class Clocked extends ProgressInactivity{constructor(ms,onIdle,_now,notifyOnly){super(120,onIdle,()=>clock,notifyOnly);watch=this;}}
  const f=fixture({ProgressInactivity:Clocked}),c=f.create({id:operation,operation});
  try{
   clock=121;assert.equal(watch.check(),true);assert.equal(c.status,'running');assert.equal(c.stalled,true);assert.equal(c.processedFiles,0);
   clock=150;c.updateProgress({phase:'preparing',processedFiles:2});assert.equal(c.stalled,false);assert.equal(c.processedFiles,2);
   assert.equal(c.cancel('explicit user cancellation'),true);assert.equal(c.status,'cancelled');
  }finally{c.dispose();}
 }
});

test('file SSH watcher preserves a silent child while control requests retain bounded waits',()=>{
 const {EventEmitter}=require('node:events');
 const source=fs.readFileSync(require.resolve('../extension.js'),'utf8');
 const start=source.indexOf('function watchTransferProcess('),end=source.indexOf('async function cleanupFileTransport(',start);
 for(const fileStep of [true,false]){
  let clock=0,watch,kills=0,failures=0,stalls=0;
  class Clocked extends ProgressInactivity{constructor(ms,onIdle,_now,notifyOnly){super(120,onIdle,()=>clock,notifyOnly);watch=this;}}
  const parent={status:'running',observeOnlyIdle:false,onCancel:()=>({dispose(){}}),markStalled:()=>stalls++,updateProgress(){}};
  const context={ProgressInactivity:Clocked,Date,Set,String,Boolean,Number,JSON,Error,
   transferContext:{getStore:()=>parent},currentApiRequestContext:()=>undefined,trackTransferResource(){}};
  vm.createContext(context);vm.runInContext(source.slice(start,end)+';this.watch=watchTransferProcess;',context);
  const child=new EventEmitter();child.pid=42;child.stderr=new EventEmitter();child.kill=()=>kills++;
  const monitor=context.watch(child,()=>failures++,fileStep);
  clock=121;watch.check();assert.equal(kills,fileStep?0:1);assert.equal(failures,fileStep?0:1);assert.equal(stalls,fileStep?1:0);
  monitor.dispose();child.emit('close',0);
 }
});
test('transfer list and events expose true counters and phases; cancellation reaches listeners',()=>{
  const f=fixture();const c=f.create({id:'t',operation:'upload'});let cancels=0;
  c.onCancel(()=>cancels++);
  c.transferredBytes=100;
  c.updateProgress({phase:'unpacking',processedFiles:2});
  const row=f.list()[0];
  assert.equal(row.processedBytes,100); assert.equal(row.processedFiles,2);
  assert.equal(row.phase,'unpacking'); assert.ok(row.lastProgressAt);
  const events=f.events.length;
  assert.equal(c.updateProgress({phase:'unpacking',processedFiles:2}),false);
  assert.equal(f.events.length,events);
  c.cancel('test'); assert.equal(cancels,1);
  c.transferredBytes=200;
  assert.equal(c.transferredBytes,100);
  assert.equal(c.updateProgress({status:'completed'}),false);
  c.dispose(); assert.equal(f.list().length,0);
});

test('parallel wire scopes aggregate once, hash bytes never inflate network totals',()=>{
  const f=fixture();const c=f.create({id:'t',operation:'sync'});
  c.updateProgress({phase:'transferring',metric:'wire',scope:'one',processedBytes:100});
  c.updateProgress({phase:'transferring',metric:'wire',scope:'two',processedBytes:50});
  c.updateProgress({phase:'transferring',metric:'wire',scope:'one',processedBytes:100});
  c.updateProgress({phase:'hashing',scope:'hash',processedBytes:9999,processedFiles:3});
  assert.equal(c.transferredBytes,150);
  assert.equal(f.list()[0].phase,'hashing');
  let notified=0;
  const subscription=c.onProgress(()=>notified++);
  c.updateProgress({phase:'publishing',scope:'receiver',processedFiles:1});
  assert.equal(notified,1);
  subscription.dispose();c.dispose();
});

test('hash diagnostics stay scoped while difference counts survive stream phase changes', () => {
  const f = fixture(); const c = f.create({id:'diagnostics',operation:'sync.serverToServerFpsync'});
  try {
    Object.assign(c, {unchangedFiles:4,missingFiles:1,differentFiles:1});
    c.updateProgress({phase:'hashing',scope:'source',processedFiles:6,cacheHits:5,cacheRehash:1,cacheStatus:'ready'});
    assert.equal(f.list()[0].cacheHits,5); assert.equal(f.events.at(-1).data.cacheStatus,'ready');
    c.updateProgress({phase:'hashing',scope:'destination',processedFiles:3,cacheHits:0,cacheRehash:3,cacheStatus:'write-failed'});
    assert.equal(f.list()[0].cacheHits,0); assert.equal(f.list()[0].cacheRehash,3);
    c.updateProgress({phase:'unpacking',processedBytes:100});
    assert.equal(f.list()[0].cacheHits,undefined); assert.equal(f.events.at(-1).data.cacheStatus,undefined);
    assert.equal(f.list()[0].unchangedFiles,4); assert.equal(f.list()[0].missingFiles,1); assert.equal(f.list()[0].differentFiles,1);
  } finally { c.dispose(); }
});

test('committed file progress survives parallel stage resets and is exposed to SSE and polling',()=>{
  const f=fixture();const c=f.create({id:'sync',operation:'sync.serverToServerFpsync'});
  try {
    c.updateProgress({phase:'transferring',scope:'groups',processedFiles:2,completedFiles:2,totalFiles:6,completedGroups:1,totalGroups:3});
    c.updateProgress({phase:'unpacking',scope:'child-b',processedFiles:0,processedBytes:1024});
    c.updateProgress({phase:'verifying',scope:'child-c',processedFiles:0,processedBytes:2048});
    let row=f.list()[0];
    assert.equal(row.processedFiles,0,'stage-local counts are kept separate');
    assert.equal(row.completedFiles,2);assert.equal(row.totalFiles,6);
    assert.equal(row.completedGroups,1);assert.equal(row.totalGroups,3);
    assert.equal(f.events.at(-1).data.completedFiles,2);
    c.updateProgress({phase:'transferring',scope:'groups',processedFiles:6,completedFiles:6,totalFiles:6,completedGroups:3,totalGroups:3});
    row=f.list()[0];assert.equal(row.completedFiles,6);assert.equal(row.completedGroups,3);
    c.updateProgress({phase:'unpacking',scope:'late-child',processedFiles:0,completedFiles:0,completedGroups:0,processedBytes:4096});
    assert.equal(f.list()[0].completedFiles,6,'late evidence must not reset committed totals');
  } finally {c.dispose();}
});

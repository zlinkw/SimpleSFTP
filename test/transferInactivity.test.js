const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { ProgressInactivity } = require('../progress-inactivity');
function fixture() {
  const source=fs.readFileSync(require.resolve('../extension.js'),'utf8');
  const start=source.indexOf('function createTransferController('), end=source.indexOf('function transferTimeoutMs(',start);
  const events=[];
  const context={ProgressInactivity,Date,Set,Object,Number,Math,queueMicrotask,
    transferContext:{getStore:()=>undefined},activeTransfers:new Map(),localApiServer:{publish:e=>events.push(e)}};
  vm.createContext(context);
  vm.runInContext(source.slice(start,end)+'; this.create=createTransferController; this.list=listActiveTransfers;',context);
  return {...context,events};
}
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

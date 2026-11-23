const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture(onPersist) {
  const source = fs.readFileSync(path.join(__dirname, '../extension.js'), 'utf8');
  const start = source.indexOf('"transfers.cancel": async (params = {}) => {');
  const end = source.indexOf('\n    "upload.workspace":', start);
  assert.ok(start >= 0 && end > start);
  const expression = source.slice(start, end).replace(/^"transfers\.cancel":\s*/, '').replace(/,\s*$/, '');
  const cancelled = [], writes = [];
  const operations = new Map(['a', 'b'].map(id => [id, { operationId: id, operationInstanceId: 'instance', status: 'running' }]));
  const transfers = new Map(['a', 'b'].map(id => [id + '-transfer', { id: id + '-transfer', operationId: id, cancel: () => cancelled.push(id) }]));
  const context = { activeTransfers: transfers, transferOperationLedger: operations, cancelledTransferOperations: new Map(),
    MAX_TRANSFER_OPERATIONS: 512, transferLedgerWrite: Promise.resolve(), currentTransferApiInstanceId: () => 'instance',
    persistTransferOperationLedger: async () => { writes.push('ledger'); if (onPersist) await onPersist(transfers); },
    maybeSettleTransferOperation: async () => {}, Date, String, Boolean, Error };
  return { call: vm.runInNewContext(`(${expression})`, context), operations, transfers, cancelled, writes, context };
}

test('mismatched operation and transfer do not modify either operation', async () => {
  const f = fixture();
  const result = await f.call({ operationId: 'a', transferId: 'b-transfer' });
  assert.equal(result.cancelled, false);
  assert.equal(f.operations.get('a').status, 'running');
  assert.equal(f.context.cancelledTransferOperations.size, 0);
  assert.deepEqual(f.cancelled, []);
  assert.deepEqual(f.writes, []);
});

test('matching IDs and the original single-ID forms cancel the intended controller', async () => {
  for (const args of [{ operationId: 'a', transferId: 'a-transfer' }, { operationId: 'a' }, { transferId: 'a-transfer' }]) {
    const f = fixture();
    await f.call(args);
    assert.deepEqual(f.cancelled, ['a']);
  }
});

test('wrong instance and settled or unknown operations do not falsely cancel another transfer', async () => {
  for (const [state, instance] of [['running', 'wrong'], ['settled', 'instance'], ['outcomeUnknown', 'instance']]) {
    const f = fixture();
    Object.assign(f.operations.get('a'), { status: state, outcomeUnknown: state === 'outcomeUnknown', persisted: true });
    const result = await f.call({ operationId: 'a', transferId: 'b-transfer', operationInstanceId: instance });
    assert.equal(result.cancelled, false);
    assert.deepEqual(f.cancelled, []);
    assert.deepEqual(f.writes, []);
    assert.equal(f.operations.get('a').status, state);
  }
  const f = fixture();
  const result = await f.call({ transferId: 'a-transfer', operationInstanceId: 'wrong' });
  assert.equal(result.cancelled, false);
  assert.deepEqual(f.cancelled, []);
  assert.deepEqual(f.writes, []);
});

test('unknown or missing matching controllers do not claim successful cancellation', async () => {
  const unknown = fixture();
  Object.assign(unknown.operations.get('a'), { status: 'outcomeUnknown', outcomeUnknown: true });
  const result = await unknown.call({ operationId: 'a', transferId: 'a-transfer', operationInstanceId: 'instance' });
  assert.equal(result.cancelled, false);
  assert.equal(result.status, 'outcomeUnknown');
  assert.deepEqual(unknown.cancelled, []);
  assert.deepEqual(unknown.writes, []);
  const missing = fixture();
  missing.transfers.delete('a-transfer');
  const unresolved = await missing.call({ operationId: 'a', transferId: 'a-transfer' });
  assert.equal(unresolved.cancelled, false);
  assert.equal(unresolved.status, 'outcomeUnknown');
  assert.deepEqual(missing.writes, []);
});

test('a replaced controller is never cancelled after the ledger write awaits', async () => {
  const f = fixture(transfers => transfers.set('a-transfer', { id: 'a-transfer', operationId: 'b', cancel: () => assert.fail('wrong controller') }));
  await f.call({ operationId: 'a', transferId: 'a-transfer' });
  assert.deepEqual(f.cancelled, []);
});

test('a controller reassigned during the ledger write is not cancelled', async () => {
  const f = fixture(transfers => { transfers.get('a-transfer').operationId = 'b'; });
  const result = await f.call({ operationId: 'a', transferId: 'a-transfer' });
  assert.equal(result.cancelled, false);
  assert.deepEqual(f.cancelled, []);
});

test('settled receipt is not attributed to a controller changed during the wait', async () => {
  const f = fixture();
  Object.assign(f.operations.get('a'), { status: 'settled', persisted: true });
  let release;
  f.context.transferLedgerWrite = new Promise(resolve => { release = resolve; });
  const pending = f.call({ operationId: 'a', transferId: 'a-transfer' });
  f.transfers.get('a-transfer').operationId = 'b';
  release();
  const result = await pending;
  assert.equal(result.cancelled, false);
  assert.equal(result.settled, false);
  assert.deepEqual(f.writes, []);
  assert.deepEqual(f.cancelled, []);
});

test('settled receipt is not attributed to a replaced operation during the wait', async () => {
  const f = fixture();
  Object.assign(f.operations.get('a'), { status: 'settled', persisted: true });
  let release;
  f.context.transferLedgerWrite = new Promise(resolve => { release = resolve; });
  const pending = f.call({ operationId: 'a', operationInstanceId: 'instance' });
  f.operations.set('a', { operationId: 'a', operationInstanceId: 'other', status: 'settled', persisted: true });
  release();
  const result = await pending;
  assert.equal(result.cancelled, false);
  assert.equal(result.settled, false);
  assert.deepEqual(f.writes, []);
});

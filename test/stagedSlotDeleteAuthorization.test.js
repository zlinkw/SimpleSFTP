const test = require('node:test');
const assert = require('node:assert/strict');
const { CleanupFileApi } = require('../cleanup-file-api.js');

test('legacy isolated deletion requires the actual twice-confirmed matching review', async () => {
  const destination = 'clean_dir/job-' + 'a'.repeat(48) + '/slot';
  const node = { kind: 'remote', host: 'worker', root: '/project' };
  const rootIdentity = { device: '1', inode: '2' };
  const row = { token: 'source', digest: 'digest', action: 'isolate', node, rootIdentity,
    targets: [{ destination }], operationId: 'operation' };
  const parent = { isolationParentCleanup: true, sourceIsolationTokens: ['source'], confirmations: 2,
    includeIsolatedArtifacts: true, node, rootIdentity, destinations: [destination], expiresAt: Date.now() + 60000 };
  let currentParent = parent, effects = 0;
  const api = Object.create(CleanupFileApi.prototype);
  api.read = async token => token === 'source' ? row : currentParent;
  api.busy = new Set(['source']);
  api.checked = async () => { effects++; throw new Error('unexpected transport'); };
  const request = { consumerRoot: '/local/project', token: 'source', digest: 'digest' };
  await assert.rejects(api.isolatedMaintenanceDelete(request), error => error.code === 'CONFIRM_REQUIRED');
  for (const changed of [
    { confirmations: 1 }, { expiresAt: 1 }, { includeIsolatedArtifacts: false }, { sourceIsolationTokens: ['other'] },
    { node: { ...node, host: 'other' } }, { rootIdentity: { device: '1', inode: '3' } },
    { destinations: [destination + '-other'] },
  ]) {
    currentParent = { ...parent, ...changed };
    await assert.rejects(api.isolatedMaintenanceDelete({ ...request, parentCleanupToken: 'review' }),
      error => error.code === 'CONFIRM_REQUIRED');
  }
  currentParent = parent;
  const result = await api.isolatedMaintenanceDelete({ ...request, parentCleanupToken: 'review' });
  assert.equal(result.state, 'already_accepted');
  assert.equal(effects, 0);
});

test('a previously uncertain request is observed without another delete', async () => {
  const archiveBatch = 'job-' + 'a'.repeat(48), destination = 'clean_dir/' + archiveBatch + '/slot';
  const row = { token: 'source', digest: 'digest', action: 'isolate', operationId: 'original',
    node: { kind: 'remote', host: 'worker', root: '/project' }, rootIdentity: { device: '1', inode: '2' },
    targets: [{ relativePath: 'slot', destination, archiveBatch, type: 'directory', device: '1', inode: '3' }],
    states: ['completed'], isolatedDelete: { phase: 'unknown', operationId: 'original' } };
  const calls = [], api = Object.create(CleanupFileApi.prototype);
  api.read = async () => row;
  api.busy = new Set();
  api.checked = async request => { calls.push(request.action); return { targets: [
    { relativePath: destination, type: 'directory', missing: false, isolationState: 'isolated' },
  ] }; };
  const result = await api.isolatedMaintenanceDelete({ consumerRoot: '/local/project', token: 'source', digest: 'digest' });
  assert.equal(result.state, 'unknown');
  assert.equal(result.operationId, 'original');
  assert.deepEqual(calls, ['batch-inspect']);
  api.checked = async request => { calls.push(request.action); return { targets: [
    { relativePath: destination, type: 'directory', missing: true, isolationState: 'deleted' },
  ] }; };
  const absent = await api.isolatedMaintenanceDelete({ consumerRoot: '/local/project', token: 'source', digest: 'digest' });
  assert.equal(absent.state, 'unknown');
  assert.equal(absent.targetsAbsent, true);
  assert.deepEqual(calls, ['batch-inspect', 'batch-inspect']);
});

test('a matching twice-confirmed review permits only its registered target', async () => {
  const archiveBatch = 'job-' + 'b'.repeat(48), destination = 'clean_dir/' + archiveBatch + '/slot';
  const node = { kind: 'remote', host: 'worker', root: '/project' }, rootIdentity = { device: '1', inode: '2' };
  const proof = { isolationCompletionProtocol: 1, renameCommitted: true, sourceMissingAtMove: true,
    registered: true, executorsChecked: true, executors: [], archiveBatch,
    sourceRelativePath: 'slot', destinationRelativePath: destination };
  const row = { token: 'source', digest: 'digest', action: 'isolate', operationId: 'operation', node, rootIdentity,
    targets: [{ relativePath: 'slot', destination, archiveBatch, type: 'directory', device: '1', inode: '3' }],
    states: ['completed'], receipts: { 0: proof } };
  const parent = { isolationParentCleanup: true, sourceIsolationTokens: ['source'], confirmations: 2,
    includeIsolatedArtifacts: true, node, rootIdentity, destinations: [destination], expiresAt: Date.now() + 60000 };
  const calls = [], api = Object.create(CleanupFileApi.prototype);
  api.read = async token => token === 'source' ? row : parent;
  api.busy = new Set();
  api.lease = async (_node, _targets, run) => run();
  api.saveIsolatedDelete = async () => {};
  api.checked = async request => {
    calls.push(request);
    if (request.action === 'batch-inspect') return { targets: [{ relativePath: destination, type: 'directory',
      archived: true, isolationState: 'isolated', device: '1', inode: '3' }] };
    assert.equal(request.action, 'delete-fast');
    return { receipt: { operationId: 'operation', action: 'delete-fast', phase: 'completed' } };
  };
  const result = await api.isolatedMaintenanceDelete({ consumerRoot: '/local/project', token: 'source',
    digest: 'digest', parentCleanupToken: 'review' });
  assert.equal(result.state, 'accepted');
  assert.deepEqual(calls.map(request => request.action), ['batch-inspect', 'delete-fast']);
  assert.deepEqual(calls[1].entries.map(entry => entry.relativePath), [destination]);
});

const test = require('node:test');
const __CONSUMER__ = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'consumer-root-'));
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CleanupFileApi } = require('../cleanup-file-api');
test('large multi-job previews retain the first frozen capability without writing or eviction', async () => {
  const storageRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'cleanup-capacity-'));
  const api = new CleanupFileApi({ storageRoot, activity: async () => {}, lease: async () => { throw Error('no execution'); },
    transport: async request => ({ ok: true, rootIdentity: { path: request.root }, target: { ...request.target, absolutePath: request.root + '/' + request.target.relativePath, fingerprint: 'hash' } }) });
  let first;
  for (let i = 0; i < 80; i++) { const row = await api.preview({consumerRoot: __CONSUMER__,  node: { root: '/fixture/project' }, action: 'delete', targets: [{ relativePath: 'work/job' + i, destination: 'clean_dir/work/job' + i, type: 'directory' }] }); first ||= row; }
  assert.equal((await api.read(first.token, __CONSUMER__)).digest, first.digest); assert.equal(first.safety.batchPreviewCapacity, 4096);
  assert.deepEqual(await fs.readdir(storageRoot), []);
  await api.confirm({consumerRoot: __CONSUMER__,  token: first.token, digest: first.digest, phase: 1, confirm: true, exactTargets: ['/fixture/project/work/job0'] });
  assert.equal((await api.read(first.token, __CONSUMER__)).confirmations, 1);
  const row = api.previews.values().next().value;
  for (let i = api.previews.size; i < 4096; i++) api.previews.set(String(i).padStart(48, 'a'), row);
  await assert.rejects(api.preview({consumerRoot: __CONSUMER__,  node: { root: '/fixture/project' }, targets: [{ relativePath: 'work/new', type: 'directory' }] }), error => error.code === 'CLEANUP_PREVIEW_CAPACITY_EXCEEDED');
  assert.equal((await api.read(first.token, __CONSUMER__)).digest, first.digest);
});

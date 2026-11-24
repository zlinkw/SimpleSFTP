const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
let subject;
try {
  Module._load = function (name, ...args) {
    if (name === 'vscode') return { TreeItem: class {}, EventEmitter: class {}, Disposable: class {},
      workspace: { workspaceFolders: [], getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
      window: {}, commands: {}, env: {}, Uri: {}, languages: {}, StatusBarAlignment: {}, ViewColumn: {}, ExtensionMode: {} };
    return originalLoad.call(this, name, ...args);
  };
  subject = require('../extension.js').__test;
} finally { Module._load = originalLoad; }

test('independent cleanup requests enter while earlier cleanup remains pending', async () => {
  const entered = [], release = {}, reject = {};
  const pending = params => {
    entered.push(params.id);
    return new Promise((resolve, fail) => { release[params.id] = resolve; reject[params.id] = fail; });
  };
  subject.setTransferSettlementTestContext({ cleanupApi: { execute: pending, preview: pending,
    status: async () => ({ state: 'running' }) },
    globalState: { get: (_key, fallback) => fallback, update: async () => {} }, instanceId: 'fixture' });
  const methods = subject.createLocalApiMethods();
  const a = methods['files.cleanup.execute']({ id: 'a' });
  const b = methods['files.cleanup.execute']({ id: 'b' });
  assert.deepEqual(entered, ['a', 'b']);
  const previewA = methods['files.cleanup.preview']({ id: 'preview-a', host: 'worker' });
  const previewB = methods['files.cleanup.preview']({ id: 'preview-b', host: 'worker' });
  assert.deepEqual(entered, ['a', 'b', 'preview-a', 'preview-b']);
  assert.deepEqual(await methods['files.cleanup.status']({}), { state: 'running' });
  assert.equal(subject.cleanupActivityGuard().blockingTransferCount, 0);
  release.a({ ok: true }); release.b({ ok: true });
  release['preview-a']({ ok: true }); release['preview-b']({ ok: true });
  assert.deepEqual(await Promise.all([a, b]), [{ ok: true }, { ok: true }]);
  await Promise.all([previewA, previewB]);
  const failed = methods['files.cleanup.execute']({ id: 'failed' });
  reject.failed(Error('cleanup failed'));
  await assert.rejects(failed, /cleanup failed/);
  assert.equal(subject.cleanupActivityGuard().blockingTransferCount, 0);
});

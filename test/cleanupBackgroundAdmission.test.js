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
  subject.setTransferSettlementTestContext({ cleanupApi: { execute: params => {
    entered.push(params.id);
    return new Promise((resolve, fail) => { release[params.id] = resolve; reject[params.id] = fail; });
  } }, globalState: { get: (_key, fallback) => fallback, update: async () => {} }, instanceId: 'fixture' });
  const methods = subject.createLocalApiMethods();
  const a = methods['files.cleanup.execute']({ id: 'a' });
  const b = methods['files.cleanup.execute']({ id: 'b' });
  assert.deepEqual(entered, ['a', 'b']);
  assert.equal(subject.cleanupActivityGuard().blockingTransferCount, 0);
  release.a({ ok: true }); release.b({ ok: true });
  assert.deepEqual(await Promise.all([a, b]), [{ ok: true }, { ok: true }]);
  const failed = methods['files.cleanup.execute']({ id: 'failed' });
  reject.failed(Error('cleanup failed'));
  await assert.rejects(failed, /cleanup failed/);
  assert.equal(subject.cleanupActivityGuard().blockingTransferCount, 0);
});

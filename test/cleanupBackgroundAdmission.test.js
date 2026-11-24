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

test('cleanup remains visible to the transfer guard until exact-path protection is available', async () => {
  let release;
  subject.setTransferSettlementTestContext({ cleanupApi: { execute: () => new Promise(resolve => { release = resolve; }) },
    globalState: { get: (_key, fallback) => fallback, update: async () => {} }, instanceId: 'fixture' });
  const methods = subject.createLocalApiMethods();
  const request = methods['files.cleanup.execute']({ id: 'a' });
  await new Promise(resolve => setImmediate(resolve));
  assert.throws(() => subject.cleanupActivityGuard(), /ACTIVE_TRANSFER/);
  release({ ok: true });
  assert.deepEqual(await request, { ok: true });
  assert.equal(subject.cleanupActivityGuard().blockingTransferCount, 0);
});

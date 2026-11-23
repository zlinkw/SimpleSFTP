const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../extension.js'), 'utf8');
const coreStart = source.indexOf('function resolveHandoffTarget(');
const coreEnd = source.indexOf('async function uploadWorkspace(', coreStart);
const resolverStart = source.indexOf('function resolveUploadSftp(');
const resolverEnd = source.indexOf('function firstNonEmpty(', resolverStart);
const apiStart = source.indexOf('    "handoff.markReady": async (params = {}) => {');
const apiEnd = source.indexOf('    "downloadScope.configure":', apiStart);
if ([coreStart, coreEnd, resolverStart, resolverEnd, apiStart, apiEnd].some(value => value < 0)) throw Error('handoff source missing');

function fixture() {
  const a = { host: 'worker-a', username: 'alice', port: 22, remotePath: '/a' };
  const b = { host: 'worker-b', username: 'bob', port: 22, remotePath: '/b' };
  const state = { config: b, workspace: '/project', choice: '仅标记', calls: [] };
  const context = {
    path, os: { userInfo: () => ({ username: 'local' }) }, DEFAULT_HANDOFF_MARKER: 'marker',
    getPrimaryWorkspaceFolder: () => ({ root: state.workspace }),
    workspaceLocationForFolder: folder => ({ hostPath: folder.root }),
    getWorkspaceRoot: () => state.workspace,
    readSftpConfig: () => state.config,
    firstNonEmpty: (...values) => values.find(Boolean) || '',
    sharedServerForOptions: () => ({}), normalizeSshPort: value => Number(value) || 22,
    mergeIgnorePatterns: () => [], DEFAULT_IGNORES: [], FIXED_IGNORES: [], resolvedConnectTimeoutSeconds: () => 30,
    confirmTransferPath: async ({ sftp }) => { state.calls.push(['confirm', sftp.host]); await state.onConfirm?.(); },
    uploadAllLocalToRemote: async ({ sftp }) => { state.calls.push(['upload', sftp.host]); await state.onUpload?.(); },
    writeRemoteHandoffMarker: async (sftp, _name, marker) => state.calls.push(['marker', sftp.host, marker.uploadRequested]),
    writeLocalSessionRecord: () => {}, getDeviceName: () => 'fixture',
    vscode: { workspace: { getConfiguration: () => ({ get: () => 'marker' }) }, window: {
      showInformationMessage: async () => state.choice, showErrorMessage: () => {},
    } },
    formatError: error => error.message,
  };
  const core = vm.runInNewContext(source.slice(resolverStart, resolverEnd) + source.slice(coreStart, coreEnd) + '\n({ resolveHandoffTarget, markHandoffReadyCore })', context);
  return { a, b, state, context, ...core };
}

test('handoff keeps explicit target through confirmation, upload and marker', async () => {
  const f = fixture();
  const result = await f.markHandoffReadyCore({ localPath: '/project', server: f.a, apiMode: true, upload: true });
  assert.equal(result.remotePath, '/a');
  assert.deepEqual(f.state.calls, [['confirm', 'worker-a'], ['upload', 'worker-a'], ['marker', 'worker-a', true]]);
  f.state.config = { ...f.b, port: 2222 };
  assert.equal(f.resolveHandoffTarget('/project', { server: { host: 'worker-a', username: 'alice', remotePath: '/a' } }).port, 22);
  await assert.rejects(f.markHandoffReadyCore({ localPath: '/project', server: { host: 'worker-a' }, apiMode: true }), /目标不完整/);
  await assert.rejects(f.markHandoffReadyCore({ localPath: '/project', sftpHost: 'worker-a', apiMode: true }), /目标不完整/);
});

test('handoff preserves API marker-only and the three UI choices', async () => {
  const api = fixture();
  assert.equal((await api.markHandoffReadyCore({ localPath: '/project', apiMode: true })).uploadRequested, false);
  assert.deepEqual(api.state.calls, [['confirm', 'worker-b'], ['marker', 'worker-b', false]]);
  for (const [choice, expected] of [['上传全部并标记', ['confirm', 'upload', 'marker']], ['仅标记', ['confirm', 'marker']], ['取消', ['confirm']]]) {
    const f = fixture(); f.state.choice = choice;
    await f.markHandoffReadyCore({ localPath: '/project' });
    assert.deepEqual(f.state.calls.map(row => row[0]), expected);
  }
});

test('handoff refuses new effects after workspace or target changes', async () => {
  const f = fixture(); f.state.onConfirm = () => { f.state.config = f.a; };
  await assert.rejects(f.markHandoffReadyCore({ localPath: '/project', apiMode: true, upload: true }), /目标在确认后发生变化/);
  assert.deepEqual(f.state.calls.map(row => row[0]), ['confirm']);
  const g = fixture(); g.state.onUpload = () => { g.state.workspace = '/other'; };
  await assert.rejects(g.markHandoffReadyCore({ localPath: '/project', server: g.a, apiMode: true, upload: true }), /工作区已变化/);
  assert.deepEqual(g.state.calls.map(row => row[0]), ['confirm', 'upload']);
});

test('API handler confirms the same resolved target passed to the core', async () => {
  const f = fixture(); let confirmed, forwarded;
  Object.assign(f.context, { resolveHandoffTarget: f.resolveHandoffTarget,
    requireApiConfirmation: (_params, detail) => { confirmed = detail.sftp; },
    markHandoffReady: async options => { forwarded = options; return { ok: true }; }, publishLocalApiEvent: () => {} });
  const handlers = vm.runInNewContext('({' + source.slice(apiStart, apiEnd) + '})', f.context);
  await handlers['handoff.markReady']({ localPath: '/project', server: f.a });
  assert.equal(confirmed.host, 'worker-a');
  assert.equal(forwarded.expectedTransferTarget, confirmed);
});

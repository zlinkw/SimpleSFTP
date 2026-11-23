const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../extension.js'), 'utf8');
const slice = (from, to) => {
  const start = source.indexOf(from), end = source.indexOf(to, start);
  if (start < 0 || end < 0) throw Error('source missing: ' + from);
  return source.slice(start, end);
};
const code = slice('async function syncFromRemoteCore(', 'async function markHandoffReady(')
  + slice('function targetScopeKey(', 'const MAPPED_DOWNLOAD_DEFAULT_MAX_FILE_BYTES')
  + slice('function readTargetDownloadScope(', 'function writeTargetDownloadScope(');

function fixture(contents) {
  const state = { contents, calls: [], scope: undefined };
  const sftp = { host: 'worker-a', username: 'alice', remotePath: '/project', name: 'a' };
  const fakeFs = { existsSync: () => state.contents !== undefined, readFileSync: () => {
    if (state.contents instanceof Error) throw state.contents;
    if (state.contents === undefined) throw Object.assign(Error('missing scope file'), { code: 'ENOENT' });
    return state.contents;
  } };
  const context = { fs: fakeFs, path, TARGET_DOWNLOAD_SCOPE_STATE: 'scope.json', DEFAULT_DOWNLOAD_EXTENSIONS: ['*'],
    DEFAULT_DOWNLOAD_MAX_FILE_SIZE_MB: 1024, DEFAULT_HANDOFF_MARKER: 'marker',
    toPosixPath: value => value.replace(/\\/g, '/'), getPrimaryWorkspaceFolder: () => ({}), getWorkspaceRoot: () => '/project',
    resolveUploadSftp: () => sftp, readSftpConfig: () => sftp,
    confirmTransferPath: async () => state.calls.push('confirm'),
    readRemoteHandoffMarker: async () => { state.calls.push('marker'); return null; },
    downloadRemoteToLocal: async ({ downloadScope }) => { state.calls.push('download'); state.scope = downloadScope; },
    assertSafeScopedLocalPaths: () => state.calls.push('paths'), writeLocalSessionRecord: () => {}, writeUploadState: () => {},
    getDeviceName: () => 'fake', formatError: error => error.message,
    vscode: { workspace: { getConfiguration: () => ({ get: () => 'marker' }) }, window: { showInformationMessage: async () => {}, showErrorMessage: () => {} } },
  };
  const actual = vm.runInNewContext(code + '\n({ syncFromRemoteCore, readTargetDownloadScope })', context);
  return { state, ...actual };
}
const params = { localPath: '/project', server: { id: 'a' }, apiMode: true, requireSavedScope: true };

test('strict saved scope rejects missing, empty, corrupt and unreadable state before remote calls', async () => {
  for (const input of [undefined, '{', JSON.stringify({ a: { paths: [] } }), JSON.stringify({ a: { paths: [' '] } }), Object.assign(Error('read denied'), { code: 'EACCES' })]) {
    const f = fixture(input);
    await assert.rejects(f.syncFromRemoteCore(params), /已保存下载范围/);
    assert.deepEqual(f.state.calls, []);
  }
});

test('strict saved scope preserves selected paths, filters, size and explicit project root', async () => {
  for (const paths of [['experiments/results'], ['.']]) {
    const f = fixture(JSON.stringify({ a: { paths, extensions: ['.csv'], maxFileSizeMB: 64 } }));
    await f.syncFromRemoteCore(params);
    assert.deepEqual(f.state.calls, ['confirm', 'marker', 'download']);
    assert.deepEqual(JSON.parse(JSON.stringify(f.state.scope)), { paths, extensions: ['.csv'], maxFileSizeMB: 64 });
  }
});

test('ordinary UI and API default or explicit path behavior is retained', async () => {
  for (const apiMode of [false, true]) {
    const f = fixture(undefined); await f.syncFromRemoteCore({ localPath: '/project', apiMode });
    assert.deepEqual(f.state.calls, ['confirm', 'marker', 'download']); assert.equal(f.state.scope, null);
  }
  const f = fixture(undefined); await f.syncFromRemoteCore({ localPath: '/project', apiMode: true, paths: ['results/a.csv'] });
  assert.deepEqual(f.state.calls, ['confirm', 'marker', 'paths', 'download']);
  assert.deepEqual(JSON.parse(JSON.stringify(f.state.scope)), { paths: ['results/a.csv'], extensions: ['*'], maxFileSizeMB: null, noSizeLimit: true });
});

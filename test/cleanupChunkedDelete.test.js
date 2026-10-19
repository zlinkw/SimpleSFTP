const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const guard = path.resolve(__dirname, '../cleanup-files.py');
const fixture = path.resolve(__dirname, 'cleanupChunkedDelete.fixture.py');

function stage(name, stateFile) {
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-B', '-X', 'utf8', fixture, guard, name, stateFile],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, name + ' failed: ' + (result.stderr || result.stdout));
  return result.stdout.trim();
}

test('a >50000-entry registered archive deletes only through resumable frozen chunks', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'simple-cleanup-chunked-'));
  const stateFile = path.join(root, 'state.json');
  try {
    assert.equal(stage('build', stateFile), 'ok');
    assert.equal(stage('abort', stateFile), 'ok');
    assert.equal(stage('refuse', stateFile), 'ok');
    assert.equal(stage('complete', stateFile), 'ok');
    assert.equal(stage('rebuild', stateFile), 'ok');
  } finally {
    const state = fs.existsSync(stateFile) ? JSON.parse(fs.readFileSync(stateFile, 'utf8')) : null;
    if (state && state.root && fs.existsSync(state.root)) fs.rmSync(state.root, { recursive: true, force: true });
    fs.rmSync(root, { recursive: true, force: true });
  }
});

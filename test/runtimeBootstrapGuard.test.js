const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Pure in-memory fake-OS regression for the pinned runtime-prepare bootstrap (M1/M2):
// the root identity must come from the pinned O_NOFOLLOW root fd itself, so a
// same-device inode swap is refused with ROOT_IDENTITY_CHANGED before any mkdir or
// program write; missing O_NOFOLLOW/O_DIRECTORY flags or a dir_fd NotImplementedError
// must fail closed with RUNTIME_CAPABILITY_UNAVAILABLE, and the removed plain_chain
// weak path may never come back. The harness injects fake os/socket/sys modules and
// a guarded builtins.open, so the installer under test performs zero real filesystem
// operations, never imports the engine, and spawns no process of its own.
test('pinned bootstrap binds identity to the pinned fd and fails closed without dir_fd capability', () => {
  const { RUNTIME_PREPARE_BOOTSTRAP } = require('../cleanup-file-api');
  assert.ok(!RUNTIME_PREPARE_BOOTSTRAP.includes('plain_chain'), 'plain_chain downgrade must stay removed');
  assert.ok(!RUNTIME_PREPARE_BOOTSTRAP.includes('dirfd is None'), 'dirfd None weak branches must stay removed');
  assert.ok(RUNTIME_PREPARE_BOOTSTRAP.includes('RUNTIME_CAPABILITY_UNAVAILABLE'), 'capability fail-closed code must exist');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'se-bootstrap-guard-'));
  const script = path.join(dir, 'bootstrap-under-test.py');
  fs.writeFileSync(script, RUNTIME_PREPARE_BOOTSTRAP, 'utf8');
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3',
    ['-B', '-X', 'utf8', path.resolve(__dirname, 'runtimeBootstrapGuard.fixture.py'), script],
    { timeout: 10000, windowsHide: true, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const report = JSON.parse(result.stdout.trim().split('\n').pop());
  assert.equal(report.ok, true, JSON.stringify(report.failures));
  assert.ok(report.scenarios >= 25, 'expected the full guard matrix, got ' + report.scenarios);
});

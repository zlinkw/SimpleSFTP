const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const guard = path.resolve(__dirname, '../cleanup-files.py');
const fixture = path.resolve(__dirname, 'chunkedTrimGuard.fixture.py');

test('chunked metadata trim only removes hash-bound ./<leaf> children inside the verified direct parent', () => {
  const source = fs.readFileSync(guard, 'utf8');
  // The retired unsafe tail must never come back: absolute-path removals,
  // directory-scan regex deletion and silently swallowed rmdir errors.
  assert.ok(!source.includes('os.remove(os.path.join(directory, name))'), 'absolute-path removal returned');
  assert.ok(!/for name in os\.listdir\(directory\):/.test(source), 'directory-scan removal loop returned');
  assert.ok(!source.includes('r"((chunk-\\d{6}|summary)\\.json'), 'regex-scanned trim pattern returned');
  assert.ok(!/os\.rmdir\(directory\)\s*\n\s*except OSError:\s*\n\s*pass/.test(source), 'silently swallowed rmdir error returned');
  const start = source.indexOf('def chunked_manifest_trim(');
  const end = source.indexOf('def chunked_permanent_delete(', start);
  assert.ok(start > 0 && end > start, 'trim function missing');
  const trim = source.slice(start, end);
  assert.match(trim, /parent_cd\(root, full\)/, 'per-file trim must enter the verified direct parent');
  assert.match(trim, /parent_cd\(root, directory\)/, 'directory trim must enter the verified direct parent');
  assert.match(trim, /os\.unlink\(child\)/, 'files must be unlinked as ./<leaf> after parent_cd');
  assert.match(trim, /os\.rmdir\(child\)/, 'directory must be rmdir-ed as ./<leaf> after parent_cd');
  assert.ok(!/os\.remove\(/.test(trim), 'trim must not use os.remove with composed absolute paths');
  assert.ok(!/os\.unlink\(os\.path\.join/.test(trim) && !/os\.rmdir\(directory\)/.test(trim), 'trim keeps absolute-path removals');
  assert.ok(!/except OSError:\s*\n\s*pass/.test(trim), 'trim must never swallow errors silently');
  // Completion separates the two facts: product deletion stands, an
  // untrimmed manifest is reported, never claimed as trimmed.
  const tail = source.slice(end, source.indexOf('\ndef ', end + 1));
  assert.match(tail, /chunked_manifest_trim\(root, key, summary, total_chunks\)/);
  assert.match(tail, /if trim\["status"\] != "trimmed":/);
  assert.match(tail, /result\["manifestTrim"\] = trim/);
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8', fixture, guard],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  for (const name of ['clean', 'unknown-names', 'tampered-chunk', 'link-entry', 'parent-entry-failure', 'swap-after-cd'])
    assert.match(result.stdout, new RegExp('^ok ' + name + '$', 'm'), 'fake-OS scenario ' + name + ' missing');
});

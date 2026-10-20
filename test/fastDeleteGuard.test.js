const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const guard = path.resolve(__dirname, '../cleanup-files.py');
const fixture = path.resolve(__dirname, 'fastDeleteGuard.fixture.py');

test('v1.9 fast chain isolates directories by non-overwriting rename and only removes ./<leaf> children', () => {
  const source = fs.readFileSync(guard, 'utf8');
  const start = source.indexOf('def delete_fast(');
  const end = source.indexOf('\ndef ', start + 1);
  assert.ok(start > 0 && end > start, 'delete_fast missing');
  const chain = source.slice(source.indexOf('def fast_tree_remove('), end);
  // Every mutation argument in the whole fast chain stays a ./<direct leaf>.
  assert.match(chain, /os\.unlink\("\.\/" \+ leaf\)/, 'files must be unlinked as ./<leaf>');
  assert.match(chain, /os\.rmdir\("\.\/" \+ rel_name\)/, 'directories must be removed as ./<leaf>');
  assert.match(chain, /os\.chdir\("\.\/" \+ rel_name\)/, 'tree descent must enter ./<leaf> from the verified parent');
  assert.match(chain, /no_replace\(child, "\.\/" \+ iso\)/, 'isolation rename must be non-overwriting and stay in the direct parent');
  assert.match(chain, /parent_cd\(root, full\)/, 'each mutation must start from the verified direct parent');
  assert.match(chain, /if os\.path\.lexists\("\.\/" \+ iso\):/, 'the isolation name must be verified absent before rename');
  assert.ok(!/shutil|os\.remove\(|os\.unlink\(os\.path\.join|os\.rmdir\(os\.path\.join/.test(chain),
    'the fast chain must never compose absolute deletion paths');
  assert.ok(!/contentFingerprint|digest\(rows\)|fingerprint/.test(source.slice(start, end)),
    'the fast chain must not content-hash or fingerprint descendants');
  // Exactly one confirmed-path production executor: the old frozen-inventory
  // and managed-window deletion routes refuse instead of acting as a fallback.
  assert.match(source, /deny\("UPDATE_REQUIRED", "", "确认路径永久删除已切换为入口绑定的隔离式快速链/,
    'legacy confirmed-path delete must be refused, not silently used');
  // Batched metadata transfer exists and the walk never follows links or devices.
  assert.match(source, /def batch_inspect\(/, 'batch_inspect missing');
  assert.match(chain, /deny\("LINK_OR_REPARSE_POINT"/, 'the walk must refuse links');
  assert.match(chain, /deny\("MOUNT_ESCAPE"/, 'the walk must refuse device/mount crossings');
  const result = spawnSync(process.platform === 'win32' ? 'python' : 'python3', ['-B', '-X', 'utf8', fixture, guard],
    { encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  // Retry safety is fact-based: the engine records started at every mutation
  // syscall site and every delete-fast failure envelope carries the fact.
  assert.match(source, /FAST_MUTATION_FACTS\["started"\] = True/, 'mutation syscall sites must record the fact');
  assert.match(source, /result\["error"\]\.setdefault\("mutationStarted", FAST_MUTATION_FACTS\["started"\]\)/,
    'delete-fast failure envelopes must carry the mutationStarted fact');
  for (const name of ['dir-isolate', 'original-recreated', 'identity-refused-zero-mutation', 'isolation-name-taken',
    'link-in-tree-refused', 'clean-dir-guard-refused', 'dev-crossing-refused', 'files-grouped-two-parents',
    'files-swap-zero-mutation', 'archived-registered-no-rename', 'archived-unregistered-refused',
    'deep-tree-refused', 'batch-inspect-entry-only', 'batch-verify-statuses',
    'capability-probe', 'mutation-facts-reset-and-false', 'mutation-facts-partial', 'mutation-facts-after-rename',
    'virtual-paths-stay-posix-ntpath-control'])
    assert.match(result.stdout, new RegExp('^ok ' + name + '$', 'm'), 'fake-OS scenario ' + name + ' missing');
});

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
test('0.2.111 维护入口复用唯一删除执行器：无第二 mutation 路径，参数只来自登记 destination', () => {
  const source = fs.readFileSync(guard, 'utf8');
  // 引擎侧：main() 仍只把 delete-fast 路由给唯一生产执行器，新入口没有添加第二条链。
  assert.match(source, /if action == "delete-fast":\s*\n\s*return delete_fast\(root, identity, request\)/,
    'delete-fast 必须继续且仅继续接到唯一 delete_fast 执行器');
  assert.equal((source.match(/def delete_fast\(/g) || []).length, 1, '生产删除执行器必须恰好一个');
  assert.match(source, /NOT_REGISTERED_ISOLATION/, '未登记归档路径的拒绝仍由执行器把守（维护入口共用同一道门）');
  // JS 侧：维护入口只发一条只读复检与一条 delete-fast；从不发出 move/restore/isolate/settle。
  const js = fs.readFileSync(path.resolve(__dirname, '../cleanup-file-api.js'), 'utf8');
  const start = js.indexOf('async isolatedMaintenanceDelete(params)');
  const end = js.indexOf('async verify(params)', start);
  assert.ok(start > 0 && end > start, 'isolatedMaintenanceDelete 缺失');
  const body = js.slice(start, end);
  assert.match(body, /action: "batch-inspect"/, '删除集合先做一次批量只读复检');
  assert.match(body, /action: "delete-fast"/, 'mutation 只走既有 delete-fast 单链');
  assert.ok(!/action:\s*"(managed-start|move|restore|isolate|settle)"/.test(body),
    '维护通道绝不发出移动/恢复/隔离/settle RPC');
  assert.match(body, /target\.destination !== "clean_dir\/" \+ target\.archiveBatch \+ "\/" \+ target\.relativePath/,
    'destination 与批次派生路径必须逐条等值，否则整批拒删');
  assert.match(body, /row\.states\[index\] !== "completed"/, '存在未完成隔离目标时整批不启动删除');
  assert.equal((body.match(/entries\.push\(/g) || []).length, 1, 'mutation 条目构造点必须唯一');
  const entryBuild = body.match(/entries\.push\([^;]*\);/)[0];
  assert.ok(entryBuild.includes('relativePath: target.destination') && !entryBuild.includes('binding'),
    '删除条目只取登记 destination；调用方绑定只做校验，永不进入 mutation');
  // 调用方参数名与 SE 契约逐字一致：只有 token/digest/targets(index, relativePath, destination)。
  assert.match(body, /Number\.isInteger\(binding\.index\)[\s\S]{0,400}binding\.relativePath[\s\S]{0,400}binding\.destination/,
    '绑定校验只核 index/relativePath/destination');
  assert.ok(!/params\.(targets|digest|token)[^;]*\bdelete\b/.test(body), '调用方参数不直接构成删除集');
});

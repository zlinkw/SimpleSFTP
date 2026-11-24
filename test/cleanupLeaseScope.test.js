const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

test('cleanup lease reserves only its source and destination paths', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../extension.js'), 'utf8');
  const match = source.match(/lease: \(node, targets, work\) => withFileResourceLease\([\s\S]*?\),\s*\n\s*\}\);/);
  assert.ok(match);
  const expression = match[0].replace(/,\s*\n\s*\}\);$/, '');
  const calls = [], pending = [];
  const lease = vm.runInNewContext('({' + expression + '}).lease', {
    remoteResourceServer: node => node.host + ':' + node.port,
    withFileResourceLease: (_label, root, paths, server, work) => {
      calls.push({ root, paths: Array.from(paths), server });
      return new Promise(resolve => pending.push(() => resolve(work())));
    },
  });
  const node = { kind: 'remote', root: '/project', host: 'worker', port: 22 };
  const first = lease(node, [{ relativePath: 'work/a', destination: 'clean/a' }], () => 'a');
  const second = lease(node, [{ relativePath: 'work/b' }], () => 'b');
  assert.deepEqual(calls, [
    { root: '/project', paths: ['work/a', 'clean/a'], server: 'worker:22' },
    { root: '/project', paths: ['work/b'], server: 'worker:22' },
  ]);
  pending.forEach(resolve => resolve());
  assert.deepEqual(await Promise.all([first, second]), ['a', 'b']);
});

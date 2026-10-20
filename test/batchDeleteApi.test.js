const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CleanupFileApi } = require('../cleanup-file-api.js');

// Pure transport-injected drive of the v1.9 confirmed-path fast chain: no
// python, no real deletion, no network. Scratch storage stays on disk (kept
// deliberately; this lane never deletes).
const IDENTITY = { path: '/srv/proj', device: '7', inode: '100', machine: 'host', user: '0' };
const JOB = 'clean_dir/job-' + 'a'.repeat(48) + '/out';

function harness(options = {}) {
  const calls = [];
  let deleteFastReplies = [];
  const transport = async request => {
    calls.push(JSON.parse(JSON.stringify(request)));
    if (request.action === 'batch-inspect') {
      return {
        ok: true, rootIdentity: IDENTITY,
        metrics: { metadataReads: request.targets.length, mountReads: 1, entryCheckMs: 2 },
        targets: request.targets.map(target => {
          if (target.relativePath === 'out/gone.log') return { relativePath: target.relativePath, type: 'file', missing: true };
          const row = {
            relativePath: target.relativePath, type: target.type,
            absolutePath: '/srv/proj/' + target.relativePath, device: '7', inode: '2' + calls.length + target.relativePath.length,
          };
          if (target.type === 'directory') row.isolationName = 'iso_candidate';
          if (target.relativePath.startsWith('clean_dir/')) row.archived = true;
          return row;
        }),
      };
    }
    if (request.action === 'delete-fast') {
      const reply = deleteFastReplies.length ? deleteFastReplies.shift() : {
        ok: true,
        receipt: { operationId: request.operationId, metrics: { groups: 2, unlinkedFiles: 3, renames: 1, treeDirsRemoved: 1 },
          receipts: request.entries.map(entry => ({ relativePath: entry.relativePath, mode: 'removed' })) },
      };
      return reply;
    }
    if (request.action === 'batch-verify') {
      return {
        ok: true, rootIdentity: IDENTITY, metrics: { metadataReads: request.entries.length },
        targets: request.entries.map(entry => ({ relativePath: entry.relativePath, type: entry.type,
          status: typeof options.verifyStatus === 'function' ? options.verifyStatus(entry) : (options.verifyStatus || 'gone') })),
      };
    }
    throw new Error('UNEXPECTED_ACTION:' + request.action);
  };
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-delete-api-'));
  const api = new CleanupFileApi({ storageRoot, transport, activity: async () => ({}), lease: async (node, targets, run) => run() });
  return { api, calls, transport, deleteFastReplies,
    preview: targets => api.preview({ node: { kind: 'local', root: '/srv/proj' }, action: 'delete',
      authorizationMode: 'confirmed_paths', targets }),
    counts: action => calls.filter(call => call.action === action).length,
    lastOf: action => [...calls].reverse().find(call => call.action === action) };
}
const file = relativePath => ({ relativePath, type: 'file' });

async function confirmed(h, row) {
  const exact = row.targets.filter(t => !t.missing).map(t => t.absolutePath);
  await apiConfirm(h, row, 1, exact);
  return apiConfirm(h, row, 2, exact);
}
async function apiConfirm(h, row, phase, exact) {
  return h.api.confirm({ token: row.token, digest: row.digest, confirm: true, phase, exactTargets: exact });
}

test('confirmed preview is one batched entry-only metadata read with identity-bound rows', async () => {
  const h = harness();
  const targets = [...Array.from({ length: 30 }, (_, i) => file('out/f' + i + '.log')),
    { relativePath: 'out/run1', type: 'directory' }, { relativePath: JOB, type: 'directory', destination: JOB },
    file('out/gone.log')];
  const row = await h.preview(targets);
  assert.equal(h.counts('batch-inspect'), 1, '32 entries must ride a single metadata RPC');
  assert.equal(h.counts('inspect'), 0, 'the fast chain must never use per-target inspect');
  assert.equal(row.targets.length, 33);
  assert.equal(row.authorizationMode, 'confirmed_paths');
  assert.equal(row.states.filter(s => s === 'absent').length, 1);
  assert.equal(row.safety.entryIdentityBind, 1);
  assert.equal(row.safety.directoryTreeIsolateDelete, 1);
  assert.equal(row.safety.contentHash, 0);
  assert.equal(row.safety.descendantFingerprint, 0);
  assert.equal(row.safety.handleScan, 'entry_only');
  assert.equal(row.metrics.inspectRpcCalls, 1);
  assert.equal(row.metrics.metadataReads, 33);
  const run1 = row.targets.find(t => t.relativePath === 'out/run1');
  assert.equal(run1.isolationName, 'iso_candidate');
  assert.equal(run1.device, '7');
  assert.ok(Number.isInteger(Number(run1.inode)) || typeof run1.inode === 'string');
});

test('confirmed preview refuses protected paths and non-delete actions before any RPC', async () => {
  const h = harness();
  await assert.rejects(h.preview([file('.git/config')]), error => error.code === 'PROTECTED_PATH');
  await assert.rejects(h.preview([file('clean_dir/scratch')]), error => error.code === 'UNSAFE_DESTINATION');
  await assert.rejects(h.preview([{ relativePath: '/etc/passwd', type: 'file' }]), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(h.api.preview({ node: { kind: 'local', root: '/srv/proj' }, action: 'move',
    authorizationMode: 'confirmed_paths', targets: [file('out/a')] }), error => error.code === 'INVALID_ACTION');
  assert.equal(h.calls.length, 0);
});

test('preview caps a confirmed row at 500 rows, and the batcher chunks metadata reads at 1000', async () => {
  const h = harness();
  const row = await h.preview(Array.from({ length: 500 }, (_, i) => file('out/f' + i + '.log')));
  assert.equal(h.counts('batch-inspect'), 1);
  assert.equal(row.targets.length, 500);
  await assert.rejects(h.preview(Array.from({ length: 501 }, (_, i) => file('out/f' + i + '.log'))),
    error => error.code === 'INVALID_REQUEST');
  // The internal batcher stays bounded-parallel for engines that allow more.
  const chunked = await h.api.previewFast({ kind: 'local', root: '/srv/proj' },
    Array.from({ length: 1200 }, (_, i) => file('out/f' + i + '.log')), 'simple');
  assert.equal(h.counts('batch-inspect'), 3, '1200 entries must ride two 1000-entry metadata RPCs');
  assert.equal(chunked.targets.length, 1200);
  assert.equal(chunked.metrics.inspectRpcCalls, 2);
});

test('a full confirmed row mutates through one serial RPC and never re-runs', async () => {
  const h = harness();
  const row = await h.preview(Array.from({ length: 500 }, (_, i) => file('out/f' + i + '.log')));
  await confirmed(h, row);
  const executed = await h.api.execute({ token: row.token, digest: row.digest, index: 0 });
  assert.equal(executed.ok, true);
  assert.equal(h.counts('delete-fast'), 1, 'the whole batch mutates through exactly one serial RPC');
  assert.equal(h.lastOf('delete-fast').entries.length, 500);
  assert.equal(h.lastOf('delete-fast').rootIdentity.inode, '100');
  const rerun = await h.api.execute({ token: row.token, digest: row.digest, index: 0 });
  assert.equal(rerun.alreadyCompleted, true);
  assert.equal(h.counts('delete-fast'), 1, 'a completed batch must never re-mutate');
});

test('execute passes entry identity through and verify settles with one batched query', async () => {
  const h = harness();
  const row = await h.preview([file('out/a.log'), { relativePath: 'out/run1', type: 'directory' },
    { relativePath: JOB, type: 'directory', destination: JOB }, file('out/gone.log')]);
  await confirmed(h, row);
  await h.api.execute({ token: row.token, digest: row.digest, index: 0 });
  const entries = h.lastOf('delete-fast').entries;
  assert.equal(entries.length, 3, 'the missing entry never reaches the mutation RPC');
  assert.deepEqual(entries.map(e => e.relativePath), ['out/a.log', 'out/run1', JOB]);
  assert.equal(entries[1].isolationName, 'iso_candidate', 'directories carry their preview isolation name');
  assert.ok(!entries[2].isolationName, 'registered archived artifacts must never gain an isolation rename');
  assert.equal(entries[0].device, '7');
  const proof = await h.api.verify({ token: row.token, index: 0 });
  assert.equal(proof.state, 'completed');
  assert.equal(h.counts('batch-verify'), 1, 'verification is one batched active query, not per file');
  const status = await h.api.status({ token: row.token });
  assert.equal(h.counts('batch-verify'), 2);
  assert.equal(status.statusQueryError, undefined);
  assert.ok(status.states.filter(s => s === 'completed').length === 3);
  assert.equal(status.states[3], 'absent');
});

test('pre-mutation refusals keep the batch retryable; lost receipts stay uncertain until an active query', async () => {
  const h = harness();
  h.deleteFastReplies.push({ ok: false, error: { code: 'ENTRY_IDENTITY_CHANGED' } });
  const row = await h.preview([file('out/a.log'), file('out/b.log')]);
  await confirmed(h, row);
  await assert.rejects(h.api.execute({ token: row.token, digest: row.digest, index: 0 }),
    error => error.code === 'ENTRY_IDENTITY_CHANGED');
  const stored = await h.api.read(row.token);
  assert.deepEqual(stored.states, ['pending', 'pending'], 'a zero-mutation refusal must leave the batch retryable');
  await h.api.execute({ token: row.token, digest: row.digest, index: 0 });
  assert.equal(h.counts('delete-fast'), 2, 'the retry after a proven zero-mutation refusal may run');

  const lost = harness();
  lost.deleteFastReplies.push({ ok: false, error: { code: 'TIMEOUT' } });
  const row2 = await lost.preview([file('out/c.log')]);
  await confirmed(lost, row2);
  await assert.rejects(lost.api.execute({ token: row2.token, digest: row2.digest, index: 0 }),
    error => error.code === 'TIMEOUT');
  await assert.rejects(lost.api.execute({ token: row2.token, digest: row2.digest, index: 0 }),
    error => error.code === 'DELETE_RECEIPT_UNCERTAIN', 'an unknown outcome must not blind-rerun');
  const settled = await lost.api.status({ token: row2.token });
  assert.equal(settled.states[0], 'completed', 'the active batch query, not a rerun, resolves reality');
  const rerun = await lost.api.execute({ token: row2.token, digest: row2.digest, index: 0 });
  assert.equal(rerun.alreadyCompleted, true);
  assert.equal(lost.counts('delete-fast'), 1);

  const present = harness({ verifyStatus: 'present' });
  const row3 = await present.preview([file('out/d.log')]);
  await confirmed(present, row3);
  present.deleteFastReplies.push({ ok: false, error: { code: 'TIMEOUT' } });
  await assert.rejects(present.api.execute({ token: row3.token, digest: row3.digest, index: 0 }));
  const contradicted = await present.api.status({ token: row3.token });
  assert.equal(contradicted.states[0], 'unknown', 'a still-present entry after a lost receipt is reported honestly');
});

test('check and settle on confirmed rows answer from one batched active query', async () => {
  const h = harness();
  const row = await h.preview([file('out/a.log'), file('out/b.log')]);
  const checked = await h.api.check({ token: row.token, index: 0 });
  assert.equal(checked.state, 'completed', 'entries already gone before execution report the truth');
  assert.equal(h.counts('batch-verify'), 1);
  assert.equal(h.counts('check'), 0, 'the fast chain must not use per-target check RPCs');
  await confirmed(h, row);
  const settled = await h.api.settle({ token: row.token, digest: row.digest, index: 0 });
  assert.equal(settled.state, 'completed');
  assert.equal(h.counts('batch-verify'), 2);
});

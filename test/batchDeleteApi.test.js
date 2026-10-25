const test = require('node:test');
const __CONSUMER__ = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'consumer-root-'));
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
  let active = 0;
  const counters = { peakActive: 0 };
  const transport = async request => {
    calls.push(JSON.parse(JSON.stringify(request)));
    if (request.action === 'batch-inspect') {
      active += 1;
      counters.peakActive = Math.max(counters.peakActive, active);
      const reply = {
        ok: true, rootIdentity: IDENTITY,
        metrics: { entryReads: request.targets.length, mountReads: 1, entryCheckMs: 2 },
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
      await new Promise(resolve => setImmediate(resolve)); // hold the slot so concurrency is observable
      active -= 1;
      return reply;
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
        ok: true, rootIdentity: IDENTITY, metrics: { entryReads: request.entries.length },
        targets: request.entries.map(entry => ({ relativePath: entry.relativePath, type: entry.type,
          status: typeof options.verifyStatus === 'function' ? options.verifyStatus(entry) : (options.verifyStatus || 'gone') })),
      };
    }
    throw new Error('UNEXPECTED_ACTION:' + request.action);
  };
  const storageRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-delete-api-'));
  const api = new CleanupFileApi({ storageRoot, transport, activity: async () => ({}), lease: async (node, targets, run) => run() });
  return { api, calls, transport, deleteFastReplies,
    get peakActive() { return counters.peakActive; },
    preview: targets => api.preview({consumerRoot: __CONSUMER__,  node: { kind: 'local', root: '/srv/proj' }, action: 'delete',
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
  return h.api.confirm({consumerRoot: __CONSUMER__,  token: row.token, digest: row.digest, confirm: true, phase, exactTargets: exact });
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
  assert.equal(row.metrics.entryReads, 33);
  const run1 = row.targets.find(t => t.relativePath === 'out/run1');
  assert.equal(run1.isolationName, 'iso_candidate');
  assert.equal(run1.isolationAbsolutePath, '/srv/proj/out/iso_candidate',
    'the confirmation page must show the absolute isolation target, not just the name');
  assert.equal(run1.device, '7');
  assert.ok(Number.isInteger(Number(run1.inode)) || typeof run1.inode === 'string');
});

test('confirmed preview refuses protected paths and non-delete actions before any RPC', async () => {
  const h = harness();
  await assert.rejects(h.preview([file('.git/config')]), error => error.code === 'PROTECTED_PATH');
  await assert.rejects(h.preview([file('clean_dir/scratch')]), error => error.code === 'UNSAFE_DESTINATION');
  await assert.rejects(h.preview([{ relativePath: '/etc/passwd', type: 'file' }]), error => error.code === 'INVALID_REQUEST');
  await assert.rejects(h.api.preview({consumerRoot: __CONSUMER__,  node: { kind: 'local', root: '/srv/proj' }, action: 'move',
    authorizationMode: 'confirmed_paths', targets: [file('out/a')] }), error => error.code === 'INVALID_ACTION');
  assert.equal(h.calls.length, 0);
});

test('the public confirmed preview entry carries 5000 targets through bounded batched reads', async () => {
  const h = harness();
  const row500 = await h.preview(Array.from({ length: 500 }, (_, i) => file('out/f' + i + '.log')));
  assert.equal(h.counts('batch-inspect'), 1);
  assert.equal(row500.targets.length, 500);
  // The reviewer counterexample: 1200 and 5000 targets must flow through the
  // PUBLIC api.preview(), not an internals backdoor, and never hit a 500 pre-cap.
  const row1200 = await h.preview(Array.from({ length: 1200 }, (_, i) => file('out/g' + i + '.log')));
  assert.equal(row1200.targets.length, 1200);
  assert.equal(row1200.metrics.inspectRpcCalls, 2, '1200 entries ride two 1000-entry metadata RPCs');
  const row5000 = await h.preview(Array.from({ length: 5000 }, (_, i) => file('out/h' + i + '.log')));
  assert.equal(row5000.targets.length, 5000);
  assert.equal(row5000.metrics.inspectRpcCalls, 5, 'the engine FAST_BATCH_LIMIT of 5000 is the public cap');
  assert.ok(h.peakActive <= 2, 'metadata reads must stay bounded-parallel: at most two RPCs in flight');
  assert.ok(h.peakActive >= 2, 'the batcher must actually overlap pairs, not serialize by accident');
  await assert.rejects(h.preview(Array.from({ length: 5001 }, (_, i) => file('out/i' + i + '.log'))),
    error => error.code === 'INVALID_REQUEST', 'beyond 5000 the public entry refuses before any RPC');
  // move/restore/isolate keep their own per-target 500 limit untouched.
  await assert.rejects(h.api.preview({consumerRoot: __CONSUMER__,  node: { kind: 'local', root: '/srv/proj' }, action: 'move',
    targets: Array.from({ length: 501 }, (_, i) => file('out/j' + i + '.log')) }), error => error.code === 'INVALID_REQUEST');
});

test('a full confirmed row mutates through one serial RPC and never re-runs', async () => {
  const h = harness();
  const row = await h.preview(Array.from({ length: 500 }, (_, i) => file('out/f' + i + '.log')));
  await confirmed(h, row);
  const executed = await h.api.execute({consumerRoot: __CONSUMER__,  token: row.token, digest: row.digest, index: 0 });
  assert.equal(executed.ok, true);
  assert.equal(h.counts('delete-fast'), 1, 'the whole batch mutates through exactly one serial RPC');
  assert.equal(h.lastOf('delete-fast').entries.length, 500);
  assert.equal(h.lastOf('delete-fast').rootIdentity.inode, '100');
  const rerun = await h.api.execute({consumerRoot: __CONSUMER__,  token: row.token, digest: row.digest, index: 0 });
  assert.equal(rerun.alreadyCompleted, true);
  assert.equal(h.counts('delete-fast'), 1, 'a completed batch must never re-mutate');
});

test('execute passes entry identity through and verify settles with one batched query', async () => {
  const h = harness();
  const row = await h.preview([file('out/a.log'), { relativePath: 'out/run1', type: 'directory' },
    { relativePath: JOB, type: 'directory', destination: JOB }, file('out/gone.log')]);
  await confirmed(h, row);
  await h.api.execute({consumerRoot: __CONSUMER__,  token: row.token, digest: row.digest, index: 0 });
  const entries = h.lastOf('delete-fast').entries;
  assert.equal(entries.length, 3, 'the missing entry never reaches the mutation RPC');
  assert.deepEqual(entries.map(e => e.relativePath), ['out/a.log', 'out/run1', JOB]);
  assert.equal(entries[1].isolationName, 'iso_candidate', 'directories carry their preview isolation name');
  assert.ok(!entries[2].isolationName, 'registered archived artifacts must never gain an isolation rename');
  assert.equal(entries[0].device, '7');
  const proof = await h.api.verify({consumerRoot: __CONSUMER__,  token: row.token, index: 0 });
  assert.equal(proof.state, 'completed');
  assert.equal(h.counts('batch-verify'), 1, 'verification is one batched active query, not per file');
  const status = await h.api.status({consumerRoot: __CONSUMER__,  token: row.token });
  assert.equal(h.counts('batch-verify'), 2);
  assert.equal(status.statusQueryError, undefined);
  assert.ok(status.states.filter(s => s === 'completed').length === 3);
  assert.equal(status.states[3], 'absent');
});

test('pre-mutation refusals keep the batch retryable; lost receipts stay uncertain until an active query', async () => {
  const h = harness();
  h.deleteFastReplies.push({ ok: false, error: { code: 'ENTRY_IDENTITY_CHANGED', mutationStarted: false } });
  const row = await h.preview([file('out/a.log'), file('out/b.log')]);
  await confirmed(h, row);
  await assert.rejects(h.api.execute({consumerRoot: __CONSUMER__,  token: row.token, digest: row.digest, index: 0 }),
    error => error.code === 'ENTRY_IDENTITY_CHANGED');
  const stored = await h.api.read(row.token, __CONSUMER__);
  assert.deepEqual(stored.states, ['pending', 'pending'], 'a zero-mutation refusal must leave the batch retryable');
  await h.api.execute({consumerRoot: __CONSUMER__,  token: row.token, digest: row.digest, index: 0 });
  assert.equal(h.counts('delete-fast'), 2, 'the retry after a proven zero-mutation refusal may run');

  const lost = harness();
  lost.deleteFastReplies.push({ ok: false, error: { code: 'TIMEOUT' } });
  const row2 = await lost.preview([file('out/c.log')]);
  await confirmed(lost, row2);
  await assert.rejects(lost.api.execute({consumerRoot: __CONSUMER__,  token: row2.token, digest: row2.digest, index: 0 }),
    error => error.code === 'TIMEOUT');
  await assert.rejects(lost.api.execute({consumerRoot: __CONSUMER__,  token: row2.token, digest: row2.digest, index: 0 }),
    error => error.code === 'DELETE_RECEIPT_UNCERTAIN', 'an unknown outcome must not blind-rerun');
  const settled = await lost.api.status({consumerRoot: __CONSUMER__,  token: row2.token });
  assert.equal(settled.states[0], 'completed', 'the active batch query, not a rerun, resolves reality');
  const rerun = await lost.api.execute({consumerRoot: __CONSUMER__,  token: row2.token, digest: row2.digest, index: 0 });
  assert.equal(rerun.alreadyCompleted, true);
  assert.equal(lost.counts('delete-fast'), 1);

  const present = harness({ verifyStatus: 'present' });
  const row3 = await present.preview([file('out/d.log')]);
  await confirmed(present, row3);
  present.deleteFastReplies.push({ ok: false, error: { code: 'TIMEOUT' } });
  await assert.rejects(present.api.execute({consumerRoot: __CONSUMER__,  token: row3.token, digest: row3.digest, index: 0 }));
  const contradicted = await present.api.status({consumerRoot: __CONSUMER__,  token: row3.token });
  assert.equal(contradicted.states[0], 'unknown', 'a still-present entry after a lost receipt is reported honestly');
});

test('check and settle on confirmed rows answer from one batched active query', async () => {
  const h = harness();
  const row = await h.preview([file('out/a.log'), file('out/b.log')]);
  const checked = await h.api.check({consumerRoot: __CONSUMER__,  token: row.token, index: 0 });
  assert.equal(checked.state, 'completed', 'entries already gone before execution report the truth');
  assert.equal(h.counts('batch-verify'), 1);
  assert.equal(h.counts('check'), 0, 'the fast chain must not use per-target check RPCs');
  await confirmed(h, row);
  const settled = await h.api.settle({consumerRoot: __CONSUMER__,  token: row.token, digest: row.digest, index: 0 });
  assert.equal(settled.state, 'completed');
  assert.equal(h.counts('batch-verify'), 2);
});

test('retry admits only the proven zero-mutation fact; partial or fact-less failures stay uncertain', async () => {
  // The reviewer counterexample: a TYPE_CHANGED raised by the file-group recheck
  // happens AFTER earlier unlinks. Only the engine fact distinguishes it from a
  // pre-mutation refusal sharing the same code.
  const partial = harness();
  partial.deleteFastReplies.push({ ok: false, error: { code: 'TYPE_CHANGED', mutationStarted: true } });
  const row = await partial.preview([file('out/a.log'), file('out/b.log')]);
  await confirmed(partial, row);
  await assert.rejects(partial.api.execute({consumerRoot: __CONSUMER__,  token: row.token, digest: row.digest, index: 0 }),
    error => error.code === 'TYPE_CHANGED' && error.mutationStarted === true);
  const stored = await partial.api.read(row.token, __CONSUMER__);
  assert.equal(stored.batchExecuting, true, 'a proven partial batch stays uncertain');
  assert.deepEqual(stored.states, ['executing', 'executing'], 'already-unlinked entries must not be shown pending');
  await assert.rejects(partial.api.execute({consumerRoot: __CONSUMER__,  token: row.token, digest: row.digest, index: 0 }),
    error => error.code === 'DELETE_RECEIPT_UNCERTAIN');
  assert.equal(partial.counts('delete-fast'), 1, 'the partial batch must never be blindly rerun');

  // An old engine envelope without the fact is treated conservatively: no rerun.
  const factless = harness();
  factless.deleteFastReplies.push({ ok: false, error: { code: 'ENTRY_IDENTITY_CHANGED' } });
  const row2 = await factless.preview([file('out/c.log')]);
  await confirmed(factless, row2);
  await assert.rejects(factless.api.execute({consumerRoot: __CONSUMER__,  token: row2.token, digest: row2.digest, index: 0 }),
    error => error.code === 'ENTRY_IDENTITY_CHANGED');
  await assert.rejects(factless.api.execute({consumerRoot: __CONSUMER__,  token: row2.token, digest: row2.digest, index: 0 }),
    error => error.code === 'DELETE_RECEIPT_UNCERTAIN', 'a missing fact must never unlock a rerun');
  assert.equal(factless.counts('delete-fast'), 1);

  // With the explicit zero-mutation fact the refusal is honestly retryable.
  const zero = harness();
  zero.deleteFastReplies.push({ ok: false, error: { code: 'TYPE_CHANGED', mutationStarted: false } });
  const row3 = await zero.preview([file('out/d.log')]);
  await confirmed(zero, row3);
  await assert.rejects(zero.api.execute({consumerRoot: __CONSUMER__,  token: row3.token, digest: row3.digest, index: 0 }),
    error => error.code === 'TYPE_CHANGED');
  const retried = await zero.api.execute({consumerRoot: __CONSUMER__,  token: row3.token, digest: row3.digest, index: 0 });
  assert.equal(retried.ok, true, 'a proven zero-mutation refusal may run again');
  assert.equal(zero.counts('delete-fast'), 2);
});

test('an interrupted isolate-then-delete never settles completed while its isolation tree stands', async () => {
  // Active verify probes the entry-bound isolation name in the same batch; while
  // that exact tree stands the deletion is unfinished, no matter that the
  // original path already reads gone. No blind rerun, no false completion.
  const h = harness({ verifyStatus: entry => entry.relativePath === 'out/iso_candidate' ? 'present' : 'gone' });
  const row = await h.preview([{ relativePath: 'out/run1', type: 'directory' }]);
  await confirmed(h, row);
  h.deleteFastReplies.push({ ok: false, error: { code: 'TIMEOUT' } });
  await assert.rejects(h.api.execute({consumerRoot: __CONSUMER__,  token: row.token, digest: row.digest, index: 0 }), error => error.code === 'TIMEOUT');
  const status = await h.api.status({consumerRoot: __CONSUMER__,  token: row.token });
  assert.equal(status.states[0], 'unknown', 'isolation tree standing means unfinished, not completed and not retryable-as-pending');
  await assert.rejects(h.api.verify({consumerRoot: __CONSUMER__,  token: row.token, index: 0 }), e => ['CLEANUP_NOT_VERIFIED', 'NOT_VERIFIED'].includes(e.code));
  const verify = h.lastOf('batch-verify');
  assert.deepEqual(verify.entries.map(e => e.relativePath), ['out/run1', 'out/iso_candidate'],
    'the verify batch carries the original entry and its entry-bound isolation probe');
  assert.equal(verify.entries[1].inode, row.targets[0].inode, 'the isolation probe stays bound to the frozen original identity');
  const proof = await h.api.check({consumerRoot: __CONSUMER__,  token: row.token, index: 0 });
  assert.equal(proof.state, 'unknown');
  assert.equal(proof.isolationStatus, 'present');
  // The next engine call for this row would be a blind rerun; the API must refuse it.
  await assert.rejects(h.api.execute({consumerRoot: __CONSUMER__,  token: row.token, digest: row.digest, index: 0 }),
    error => error.code === 'DELETE_RECEIPT_UNCERTAIN');
});

test('completion accounting finishes once the isolation tree is gone even if a fresh result reuses the original name', async () => {
  const h = harness({ verifyStatus: entry => entry.relativePath === 'out/iso_candidate' ? 'gone'
    : entry.relativePath === 'out/run1' ? 'replaced' : 'gone' });
  const row = await h.preview([{ relativePath: 'out/run1', type: 'directory' }]);
  await confirmed(h, row);
  await h.api.execute({consumerRoot: __CONSUMER__,  token: row.token, digest: row.digest, index: 0 });
  const status = await h.api.status({consumerRoot: __CONSUMER__,  token: row.token });
  assert.equal(status.states[0], 'completed',
    'the confirmed tree is gone; a same-name fresh result is new data, never pending work nor a deletion demand');
  const proof = await h.api.verify({consumerRoot: __CONSUMER__,  token: row.token, index: 0 });
  assert.equal(proof.state, 'completed');
  assert.equal(proof.isolationStatus, 'gone');
});

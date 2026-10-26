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
          if (options.entryRow) { const custom = options.entryRow(target); if (custom) return custom; }
          if (target.relativePath === 'out/gone.log') return { relativePath: target.relativePath, type: 'file', missing: true };
          const row = {
            relativePath: target.relativePath, type: target.type,
            absolutePath: '/srv/proj/' + target.relativePath, device: '7', inode: '2' + calls.length + target.relativePath.length,
          };
          if (target.type === 'directory') row.isolationName = 'iso_candidate';
          if (target.relativePath.startsWith('clean_dir/')) {
            row.archived = true;
            // 0.2.111 echo shapes stay opt-in so every pre-existing expectation
            // keeps its byte-for-byte transport; the maintenance tests ask for
            // exactly what the real engine answers.
            if (options.isolateProbeRow) Object.assign(row, options.isolateProbeRow(target));
          }
          return row;
        }),
      };
      await new Promise(resolve => setImmediate(resolve)); // hold the slot so concurrency is observable
      active -= 1;
      return reply;
    }
    if (request.action === 'delete-fast') {
      if (options.deleteFast) return options.deleteFast(request);
      const reply = deleteFastReplies.length ? deleteFastReplies.shift() : {
        ok: true,
        receipt: { operationId: request.operationId, metrics: { groups: 2, unlinkedFiles: 3, renames: 1, treeDirsRemoved: 1 },
          receipts: request.entries.map(entry => ({ relativePath: entry.relativePath, mode: 'removed' })) },
      };
      return reply;
    }
    if (request.action === 'inspect' && request.isolate === true) {
      if (options.inspectFail) return { ok: false, error: { code: options.inspectFail } };
      return { ok: true, rootIdentity: IDENTITY, backgroundIsolatedDelete: 1, target: { type: request.target.type, absolutePath: '/srv/proj/' + request.target.relativePath,
        fingerprint: 'top-' + request.target.relativePath, device: '7', inode: '9' + request.target.relativePath.length,
        fingerprintMode: 'top_level', inventory: [], executorsChecked: true, executors: [] } };
    }
    if (request.action === 'isolate') {
      if (typeof options.isolate === 'function') return options.isolate(request);
      if (options.isolateError) return { ok: false, error: { code: options.isolateError,
        ...(options.mutationStarted === undefined ? {} : { mutationStarted: options.mutationStarted }) } };
      return { ok: true, rootIdentity: IDENTITY, receipt: { operationId: request.operationId, action: 'isolate', phase: 'completed',
        isolationCompletionProtocol: 1, archiveBatch: request.target.archiveBatch, sourceRelativePath: request.target.relativePath,
        destinationRelativePath: request.target.destination, renameCommitted: true, sourceMissingAtMove: true, registered: true,
        executorsChecked: true, executors: [] } };
    }
    if (request.action === 'batch-verify') {
      return {
        ok: true, rootIdentity: IDENTITY, metrics: { entryReads: request.entries.length },
        targets: request.entries.map(entry => ({ relativePath: entry.relativePath, type: entry.type,
          status: typeof options.verifyStatus === 'function' ? options.verifyStatus(entry) : (options.verifyStatus || 'gone') })),
      };
    }
    if (request.action === 'managed-start') return options.managedStart ? options.managedStart(request) : { ok: true, state: 'requested', rootIdentity: IDENTITY };
    if (request.action === 'managed-observe') return options.managedObserve ? options.managedObserve(request) : { ok: true, state: 'pending', rootIdentity: IDENTITY };
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

test('completion accounting finishes once the isolation tree is gone even if a fresh result reuses the original name', async () => {  const h = harness({ verifyStatus: entry => entry.relativePath === 'out/iso_candidate' ? 'gone'
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

// ---------- 0.2.111 files.cleanup.isolatedMaintenanceDelete (wire contract verbatim) ----------
// params are exactly { token, digest, targets: [{ index, relativePath, destination }] };
// the answer state is "accepted" | "already_accepted" | "failed" (+ optional operationId);
// anything else the caller records as unknown. The delete set derives from the LEDGER only.
const ISO_BATCH = 'job-' + 'a'.repeat(48);
const ISO_SRC = 'out/run1';
const ISO_DEST = 'clean_dir/' + ISO_BATCH + '/out/run1';
const ISO_COMPLETION = { isolationCompletionProtocol: 1, archiveBatch: ISO_BATCH, renameCommitted: true,
  sourceMissingAtMove: true, registered: true, executorsChecked: true, executors: [] };
// the echo derives its bindings from the destination itself, exactly like the
// engine reads them back from the registration record.
const isolatedProbe = (target, extra = {}) => ({ relativePath: target.relativePath, type: target.type,
  absolutePath: '/srv/proj/' + target.relativePath, device: '7', inode: '3' + target.relativePath.length,
  archived: true, isolationState: 'isolated',
  isolationCompletion: { ...ISO_COMPLETION, archiveBatch: ISO_BATCH, sourceRelativePath: target.relativePath.slice(('clean_dir/' + ISO_BATCH + '/').length),
    destinationRelativePath: target.relativePath }, ...extra });
async function isolatedToken(h) {
  const preview = await h.api.preview({ consumerRoot: __CONSUMER__, node: { kind: 'local', root: '/srv/proj' }, action: 'isolate',
    targets: [{ relativePath: ISO_SRC, type: 'directory', archiveBatch: ISO_BATCH, destination: ISO_DEST }] });
  assert.equal(preview.safety.backgroundIsolatedDelete, 1, 'the isolate preview must advertise the SE-published capability verbatim');
  await h.api.confirm({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, confirm: true, phase: 1, exactTargets: ['/srv/proj/' + ISO_SRC] });
  await h.api.execute({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, index: 0 });
  return preview;
}

test('isolatedMaintenanceDelete derives the delete set from the ledger; a replaced caller destination is refused before any RPC', async () => {
  const h = harness({ entryRow: target => target.relativePath === ISO_DEST ? isolatedProbe(target) : null });
  const preview = await isolatedToken(h);
  await assert.rejects(h.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest,
    targets: [{ index: 0, relativePath: ISO_SRC, destination: 'clean_dir/' + ISO_BATCH + '/out/OTHER' }] }), error => error.code === 'TARGET_BINDINGS_MISMATCH');
  await assert.rejects(h.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest,
    targets: [{ index: 1, relativePath: ISO_SRC, destination: ISO_DEST }] }), error => error.code === 'TARGET_BINDINGS_MISMATCH', 'index must name the frozen target');
  await assert.rejects(h.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest,
    targets: [{ index: 0, relativePath: ISO_SRC, destination: ISO_DEST }, { index: 0, relativePath: ISO_SRC, destination: ISO_DEST }] }),
    error => error.code === 'TARGET_BINDINGS_MISMATCH', 'one ledger target may only be claimed once');
  await assert.rejects(h.api.isolatedMaintenanceDelete({ token: preview.token, digest: 'f'.repeat(64) }), error => error.code === 'CONFIRM_REQUIRED',
    'the frozen digest is mandatory');
  assert.equal(h.counts('delete-fast'), 0, 'every refusal above happened before the wire');
  assert.equal(h.counts('batch-inspect'), 0, 'even the read-only re-check is refused until the request shape and bindings hold');
  const bound = await h.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest,
    targets: [{ index: 0, relativePath: ISO_SRC, destination: ISO_DEST }] });
  assert.equal(bound.ok, true);
  assert.equal(bound.state, 'accepted', 'accepted is the highest claim this entry may make');
  assert.equal(bound.operationId, h.lastOf('isolate').operationId, 'the maintenance round is bound to the isolate operation');
  assert.equal(h.counts('delete-fast'), 1);
  const inspected = h.lastOf('batch-inspect');
  assert.deepEqual(inspected.targets.map(t => t.relativePath), [ISO_DEST], 'the ledger destination is the ONLY path re-checked');
  const entries = h.lastOf('delete-fast').entries;
  assert.deepEqual(entries.map(e => e.relativePath), [ISO_DEST]);
  assert.equal(entries[0].device, '7'); assert.equal(entries[0].inode, '3' + ISO_DEST.length, 'entries bind the engine-confirmed identity');
  assert.equal(JSON.stringify(h.calls.filter(c => ['batch-inspect', 'delete-fast'].includes(c.action))).includes('"' + ISO_SRC + '"'), false,
    'the source path never reaches the maintenance chain');
  assert.equal(JSON.stringify(h.lastOf('delete-fast')).includes('.operations'), false, 'the control region never appears in a mutation entry');
  const stored = await h.api.read(preview.token, __CONSUMER__);
  assert.equal(stored.isolatedDelete.phase, 'completed');
  assert.deepEqual(stored.isolatedDelete.targets, [{ destinationRelativePath: ISO_DEST, type: 'directory' }]);
  const again = await h.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest,
    targets: [{ index: 0, relativePath: ISO_SRC, destination: ISO_DEST }] });
  assert.equal(again.state, 'already_accepted');
  assert.equal(h.counts('delete-fast'), 1, 'a finished maintenance delete is never re-run');
});

test('non-isolate tokens, missing ledger residency and unregistered archive states all refuse without any mutation', async () => {
  const h = harness({ entryRow: target => target.relativePath === ISO_DEST ? isolatedProbe(target) : null });
  const del = await h.preview([file('out/x.log')]);
  await confirmed(h, del);
  await assert.rejects(h.api.isolatedMaintenanceDelete({ token: del.token, digest: del.digest }), error => error.code === 'NOT_ISOLATION_TOKEN',
    'the generic two-confirmation permanent delete chain keeps its own entry');
  // a token that lives in no ledger of THIS plugin process stops at the owner contract:
  await assert.rejects(h.api.isolatedMaintenanceDelete({ token: 'a'.repeat(48), digest: 'f'.repeat(64) }), error => error.code === 'PREVIEW_EXPIRED',
    'no owner is ever guessed by scanning');
  for (const [label, probe] of [
    ['restored registration', target => isolatedProbe(target, { isolationState: 'restored' })],
    ['unregistered archive path', target => ({ ...isolatedProbe(target), isolationState: undefined, isolationCompletion: undefined })],
    ['absent destination without a deleted marker', target => ({ relativePath: target.relativePath, type: target.type, missing: true, archived: true })],
  ]) {
    const g = harness({ entryRow: target => target.relativePath === ISO_DEST ? probe(target) : null });
    const preview = await isolatedToken(g);
    await assert.rejects(g.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest,
      targets: [{ index: 0, relativePath: ISO_SRC, destination: ISO_DEST }] }), error => error.code === 'NOT_REGISTERED_ISOLATION', label);
    assert.equal(g.counts('delete-fast'), 0, label + ': refusal happens before the mutation');
    const stored = await g.api.read(preview.token, __CONSUMER__);
    assert.equal(stored.isolatedDelete, undefined, label + ': a refused call records no lifecycle');
  }
});

test('a ledger without any move-moment receipt keeps the manual chain: NOT_ISOLATION_COMPLETION_RECEIPT, and the engine-side echo passes when the registration has it', async () => {
  // old-format token: the isolate response carries no completion facts and the
  // registration echo has none either — settle-repaired rows look exactly like
  // this, and they must NEVER be auto-deleted.
  const plain = harness({ isolate: () => ({ ok: true, rootIdentity: IDENTITY,
    receipt: { operationId: 'cleanup-op', action: 'isolate', phase: 'completed' } }),
  entryRow: target => target.relativePath === ISO_DEST ? isolatedProbe(target, { isolationCompletion: undefined }) : null });
  const preview = await isolatedToken(plain);
  await assert.rejects(plain.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest }),
    error => error.code === 'NOT_ISOLATION_COMPLETION_RECEIPT');
  assert.equal(plain.counts('delete-fast'), 0);
  // the same ledger WITHOUT the local receipt still runs when the persisted
  // registration itself echoes the completion facts (single source of truth).
  const echo = harness({ isolate: () => ({ ok: true, rootIdentity: IDENTITY,
    receipt: { operationId: 'cleanup-op', action: 'isolate', phase: 'completed' } }),
  entryRow: target => target.relativePath === ISO_DEST ? isolatedProbe(target) : null });
  const echoPreview = await isolatedToken(echo);
  const ran = await echo.api.isolatedMaintenanceDelete({ token: echoPreview.token, digest: echoPreview.digest });
  assert.equal(ran.state, 'accepted');
  assert.equal(echo.counts('delete-fast'), 1);
});

test('an incomplete isolate batch is never deleted: pending and absent siblings block the whole token', async () => {
  const h = harness({ entryRow: target => target.relativePath.startsWith('clean_dir/' + ISO_BATCH + '/') ? isolatedProbe(target) : null });
  const preview = await h.api.preview({ consumerRoot: __CONSUMER__, node: { kind: 'local', root: '/srv/proj' }, action: 'isolate',
    targets: [{ relativePath: ISO_SRC, type: 'directory', archiveBatch: ISO_BATCH, destination: ISO_DEST },
      { relativePath: 'out/run2', type: 'directory', archiveBatch: ISO_BATCH, destination: 'clean_dir/' + ISO_BATCH + '/out/run2' }] });
  await h.api.confirm({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, confirm: true, phase: 1,
    exactTargets: ['/srv/proj/' + ISO_SRC, '/srv/proj/out/run2'] });
  await h.api.execute({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, index: 0 });
  await assert.rejects(h.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest }), error => error.code === 'NOT_ISOLATED_COMPLETE',
    'one unfinished target blocks the whole token; partial maintenance deletion is not offered');
  assert.equal(h.counts('delete-fast'), 0);
  await h.api.execute({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, index: 1 });
  const done = await h.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest });
  assert.equal(done.state, 'accepted');
  assert.deepEqual(h.lastOf('delete-fast').entries.map(e => e.relativePath).sort(),
    [ISO_DEST, 'clean_dir/' + ISO_BATCH + '/out/run2']);
});

test('lost mutation answers stay unknown and resolve read-only; only the proven zero-mutation fact is a retryable failed', async () => {
  let gone = false;
  const h = harness({ entryRow: target => target.relativePath !== ISO_DEST ? null
    : gone ? { relativePath: ISO_DEST, type: 'directory', missing: true, archived: true, isolationState: 'deleted' } : isolatedProbe(target) });
  const preview = await isolatedToken(h);
  h.deleteFastReplies.push({ ok: false, error: { code: 'REQUEST_TIMEOUT', message: 'the mutation answer was lost' } });
  const lost = await h.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest });
  assert.equal(lost.ok, true, 'a maintenance failure is never thrown back into the dispatch chain');
  assert.equal(lost.state, 'unknown');
  assert.match(lost.reason, /REQUEST_TIMEOUT/, 'the failure carries a displayable reason');
  const mid = await h.api.read(preview.token, __CONSUMER__);
  assert.equal(mid.isolatedDelete.phase, 'unknown');
  // still-present destinations while unknown: NOT re-mutated, answered unknown.
  const stillThere = await h.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest });
  assert.equal(stillThere.state, 'unknown');
  assert.equal(h.counts('delete-fast'), 1, 'unknown is resolved by read-only re-inspection, never by a second mutation');
  // read-only facts show every destination gone with persisted deleted markers.
  gone = true;
  const resolved = await h.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest });
  assert.equal(resolved.state, 'already_accepted');
  assert.equal(resolved.verifiedBy, 'isolation_deleted');
  assert.equal(h.counts('delete-fast'), 1);
  const done = await h.api.read(preview.token, __CONSUMER__);
  assert.equal(done.isolatedDelete.phase, 'completed');
  // a refusal with the explicit zero-mutation fact is a displayable failed and stays retryable.
  const g = harness({ entryRow: target => target.relativePath === ISO_DEST ? isolatedProbe(target) : null });
  const gPreview = await isolatedToken(g);
  g.deleteFastReplies.push({ ok: false, error: { code: 'ENTRY_IDENTITY_CHANGED', message: 'identity drifted before any unlink', mutationStarted: false } });
  const refused = await g.api.isolatedMaintenanceDelete({ token: gPreview.token, digest: gPreview.digest });
  assert.equal(refused.state, 'failed', 'only the engine-proven zero-mutation fact may claim failed');
  assert.match(refused.reason, /ENTRY_IDENTITY_CHANGED/);
  assert.equal((await g.api.read(gPreview.token, __CONSUMER__)).isolatedDelete.phase, 'failed');
  const retried = await g.api.isolatedMaintenanceDelete({ token: gPreview.token, digest: gPreview.digest });
  assert.equal(retried.state, 'accepted');
  assert.equal(g.counts('delete-fast'), 2, 'a proven no-op failed is retryable exactly once per call, with no parallel executor');
});

test('concurrent calls for one token never create a second executor', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; });
  const base = harness({ entryRow: target => target.relativePath === ISO_DEST ? isolatedProbe(target) : null });
  const preview = await isolatedToken(base);
  const original = base.transport;
  // hold the delete-fast reply so the second call arrives while the first runs
  base.api.transport = async request => { const value = await original(request);
    if (request.action === 'delete-fast') await gate; return value; };
  const first = base.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest });
  await new Promise(resolve => setImmediate(resolve));
  let second;
  try { second = await base.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest }); }
  finally { release(); }
  assert.equal(second.state, 'already_accepted', 'a running maintenance delete answers already_accepted, never a second mutation');
  assert.match(second.reason, /不创建第二个删除执行器/);
  const finished = await first;
  assert.equal(finished.state, 'accepted');
  assert.equal(base.counts('delete-fast'), 1);
});

// ---------- r108: observation completion must reach the durable ledger ----------
// Field defect (0.2.111): managed isolation rows stayed states:["executing"] forever
// while the engine proved completion; isolatedMaintenanceDelete reads ONLY persisted
// states, so the background delete refused NOT_ISOLATED_COMPLETE for ever.
const MANAGED_COMPLETED = { ok: true, rootIdentity: IDENTITY, state: 'completed', verifiedBy: 'completion_receipt',
  irreversible: false, finalizePending: false, executor: null };
const MANAGED_PENDING = { ok: true, rootIdentity: IDENTITY, state: 'pending' };
async function managedIsolateToken(h, targets) {
  // The field rows are node.kind remote -> observationMode normalizes to "tmux"
  // (cleanup-file-api.js:458); a local node would normalize to "filesystem" and
  // execute would run the synchronous local isolate chain instead of managed-start.
  const preview = await h.api.preview({ consumerRoot: __CONSUMER__, node: { kind: 'remote', host: 'h', port: 22, user: 'zlk', root: '/srv/proj' }, action: 'isolate',
    observationMode: 'managed_tmux', targets });
  await h.api.confirm({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, confirm: true, phase: 1,
    exactTargets: targets.map(t => '/srv/proj/' + t.relativePath) });
  return preview;
}

test('r108 a completed managed observation is durable before the answer returns and admits the background delete', async () => {
  let rounds = 0;
  const h = harness({ entryRow: target => target.relativePath === ISO_DEST ? isolatedProbe(target) : null,
    managedObserve: () => (++rounds === 1 ? MANAGED_PENDING : MANAGED_COMPLETED) });
  const preview = await managedIsolateToken(h, [{ relativePath: ISO_SRC, type: 'directory', archiveBatch: ISO_BATCH, destination: ISO_DEST }]);
  await h.api.execute({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, index: 0 });
  assert.equal(h.counts('managed-start'), 1, 'the pending round proceeds to the managed start exactly once');
  assert.equal((await h.api.read(preview.token, __CONSUMER__)).states[0], 'executing', 'before any completion proof the ledger honestly says executing');
  const returned = await h.api.status({ consumerRoot: __CONSUMER__, token: preview.token });
  assert.equal(returned.states[0], 'completed'); assert.equal(returned.observations[0].verifiedBy, 'completion_receipt');
  assert.equal((await h.api.read(preview.token, __CONSUMER__)).states[0], 'completed',
    'the completion proof must be durable, not merely returned — this is the r108 field defect');
  const ran = await h.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest });
  assert.equal(ran.state, 'accepted', 'a durable completed isolation token enters the background delete; NOT_ISOLATED_COMPLETE is gone');
  assert.equal(h.counts('delete-fast'), 1);
});

test('r108 execute that re-observes a committed rename persists completed before returning, without re-mutating', async () => {
  const h = harness({ managedObserve: () => MANAGED_COMPLETED });
  const preview = await managedIsolateToken(h, [{ relativePath: ISO_SRC, type: 'directory', archiveBatch: ISO_BATCH, destination: ISO_DEST }]);
  const result = await h.api.execute({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, index: 0 });
  assert.equal(result.state, 'completed');
  assert.equal(h.counts('managed-start'), 0, 'an already committed rename is never re-started');
  assert.equal((await h.api.read(preview.token, __CONSUMER__)).states[0], 'completed');
});

test('r108 check persists a completed observation for observation-mode rows and still returns the engine proof verbatim', async () => {
  const h = harness({ managedObserve: () => MANAGED_COMPLETED });
  const preview = await managedIsolateToken(h, [{ relativePath: ISO_SRC, type: 'directory', archiveBatch: ISO_BATCH, destination: ISO_DEST }]);
  const proof = await h.api.check({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, index: 0 });
  assert.equal(proof.state, 'completed'); assert.equal(proof.verifiedBy, 'completion_receipt');
  assert.equal((await h.api.read(preview.token, __CONSUMER__)).states[0], 'completed');
});

test('r108 protection lock: one completed target never releases the whole-token delete while a sibling stays pending', async () => {
  const h = harness({ entryRow: target => target.relativePath.startsWith('clean_dir/' + ISO_BATCH + '/') ? isolatedProbe(target) : null,
    managedObserve: request => (request.target.relativePath === ISO_SRC ? MANAGED_COMPLETED : MANAGED_PENDING) });
  const preview = await managedIsolateToken(h, [
    { relativePath: ISO_SRC, type: 'directory', archiveBatch: ISO_BATCH, destination: ISO_DEST },
    { relativePath: 'out/run2', type: 'directory', archiveBatch: ISO_BATCH, destination: 'clean_dir/' + ISO_BATCH + '/out/run2' }]);
  const round = await h.api.status({ consumerRoot: __CONSUMER__, token: preview.token });
  assert.deepEqual(round.states, ['completed', 'pending'], 'each target advances only on its own completed proof');
  const stored = await h.api.read(preview.token, __CONSUMER__);
  assert.deepEqual(stored.states, ['completed', 'pending']);
  await assert.rejects(h.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest }),
    error => error.code === 'NOT_ISOLATED_COMPLETE', 'an unfinished sibling blocks the whole token — the protection is not relaxed');
  assert.equal(h.counts('delete-fast'), 0, 'refusal happens before any mutation');
});

// P2: api.read() prefers the in-memory previews copy, so every concurrency claim below is
// ALSO checked against the ledger JSON file itself (the durable truth a restart would see).
const readLedgerFile = token => JSON.parse(fs.readFileSync(
  path.join(__CONSUMER__, 'simple_cluster', 'state', 'simple-sftp', 'cleanup-operations', token + '.json'), 'utf8'));

// ---------- r110 (review blocker): concurrent rounds must merge, never write a stale copy back ----------
// read() hands out an independent copy and save() writes the whole row with no CAS. The gate below
// forces the interleave deterministically: both check() rounds capture their row copies (both
// [pending, pending]) BEFORE either persists, so a whole-copy writeback loses one completion no
// matter which save lands last; the per-token merge chain must keep both.
test('r110 two concurrent observations of one token each persist their own completion; the disk keeps both', async () => {
  let arrived = 0;
  let releaseFirst;
  const gate = new Promise(resolve => { releaseFirst = resolve; });
  const h = harness({ entryRow: target => target.relativePath.startsWith('clean_dir/' + ISO_BATCH + '/') ? isolatedProbe(target) : null,
    managedObserve: async () => {
      arrived += 1;
      // Hold the engine answer until BOTH rounds have passed their read() and wait in observe(),
      // so both ledger copies are provably captured before either completion is persisted.
      if (arrived === 1) await gate; else releaseFirst();
      return MANAGED_COMPLETED;
    } });
  const preview = await managedIsolateToken(h, [
    { relativePath: ISO_SRC, type: 'directory', archiveBatch: ISO_BATCH, destination: ISO_DEST },
    { relativePath: 'out/run2', type: 'directory', archiveBatch: ISO_BATCH, destination: 'clean_dir/' + ISO_BATCH + '/out/run2' }]);
  const [proof0, proof1] = await Promise.all([
    h.api.check({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, index: 0 }),
    h.api.check({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, index: 1 })]);
  assert.equal(proof0.state, 'completed'); assert.equal(proof1.state, 'completed');
  assert.equal(arrived, 2, 'both observation rounds must overlap inside the engine call');
  const stored = await h.api.read(preview.token, __CONSUMER__);
  assert.deepEqual(stored.states, ['completed', 'completed'],
    'each concurrent round may advance only its own target: neither completed may be erased by the other');
  assert.deepEqual(readLedgerFile(preview.token).states, ['completed', 'completed'],
    'P2: the durable ledger FILE must hold both completions, not only the memory preview');
  const ran = await h.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest });
  assert.equal(ran.state, 'accepted', 'both completions are durable, so the background delete admits at the first attempt');
  assert.equal(h.counts('delete-fast'), 1);
});

test('r110 a persisted completed never demotes: later pending answers and query failures keep the ledger completed', async () => {
  let mode = 'completed';
  const h = harness({ managedObserve: () => {
    if (mode === 'completed') return MANAGED_COMPLETED;
    if (mode === 'pending') return MANAGED_PENDING;
    throw new Error('TRANSPORT_EXPLODED');
  } });
  const preview = await managedIsolateToken(h, [{ relativePath: ISO_SRC, type: 'directory', archiveBatch: ISO_BATCH, destination: ISO_DEST }]);
  await h.api.check({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, index: 0 });
  assert.equal((await h.api.read(preview.token, __CONSUMER__)).states[0], 'completed', 'baseline: the completion proof is durable');
  assert.equal(readLedgerFile(preview.token).states[0], 'completed', 'P2: baseline completion is in the ledger file');
  mode = 'pending';
  const pendingCheck = await h.api.check({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, index: 0 });
  assert.equal(pendingCheck.state, 'pending', 'the engine answer is still returned verbatim while the ledger stays completed');
  const pendingRound = await h.api.status({ consumerRoot: __CONSUMER__, token: preview.token });
  assert.equal(pendingRound.states[0], 'completed');
  assert.equal(readLedgerFile(preview.token).states[0], 'completed', 'a later pending round rewrites the file only with the same truth');
  mode = 'error';
  const failedRound = await h.api.status({ consumerRoot: __CONSUMER__, token: preview.token });
  assert.equal(failedRound.states[0], 'completed');
  assert.equal(failedRound.observations[0].state, 'unknown');
  assert.equal(failedRound.observations[0].queryError, 'TRANSPORT_EXPLODED');
  assert.equal((await h.api.read(preview.token, __CONSUMER__)).states[0], 'completed',
    'missing or degraded evidence never erases the persisted completed, through check or status');
  assert.equal(readLedgerFile(preview.token).states[0], 'completed',
    'P2: the ledger file itself never demotes either');
});

// r110b (P1-1): the OPERATION_BUSY rollback happens on the row copy captured BEFORE the managed
// start attempt. The gates below make the window deterministic: the sibling completion fully
// persists while the start is held, so the rollback fires with a copy that cannot contain it.
test('r110b a mutation-busy rollback keeps the sibling completion durable on disk and in memory', async () => {
  let rounds = 0;
  let releaseStart, startArrived;
  const startGate = new Promise(resolve => { releaseStart = resolve; });
  const started = new Promise(resolve => { startArrived = resolve; });
  const h = harness({
    managedObserve: () => (++rounds === 1 ? MANAGED_PENDING : MANAGED_COMPLETED),
    managedStart: () => { startArrived(); return startGate.then(() => { const error = new Error('mutation window busy'); error.code = 'OPERATION_BUSY'; throw error; }); } });
  const preview = await managedIsolateToken(h, [
    { relativePath: ISO_SRC, type: 'directory', archiveBatch: ISO_BATCH, destination: ISO_DEST },
    { relativePath: 'out/run2', type: 'directory', archiveBatch: ISO_BATCH, destination: 'clean_dir/' + ISO_BATCH + '/out/run2' }]);
  const running = h.api.execute({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, index: 0 });
  await started;
  const sibling = await h.api.check({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, index: 1 });
  assert.equal(sibling.state, 'completed');
  releaseStart();
  const waited = await running;
  assert.equal(waited.state, 'waiting'); assert.equal(waited.reason, 'CLEANUP_MUTATION_BUSY'); assert.equal(waited.notStarted, true);
  assert.deepEqual(readLedgerFile(preview.token).states, ['pending', 'completed'],
    'P1-1: the rollback advances only its own target on the CURRENT row; a whole-copy writeback would erase the sibling completion');
  assert.deepEqual((await h.api.read(preview.token, __CONSUMER__)).states, ['pending', 'completed']);
});

// r110b (P1-2): the rollback races a RUNNING background delete. The engine call stays held, so
// acceptance+executing lifecycle is durable while the stale-copy rollback fires; the file is
// inspected at that instant (before the delete's own next save could mask any erasure).
test('r110b a rollback during a running background delete keeps the maintenance lifecycle and completions durable', async () => {
  let rounds = 0;
  let releaseStart, releaseDelete, startArrived, deleteArrived;
  const startGate = new Promise(resolve => { releaseStart = resolve; });
  const deleteGate = new Promise(resolve => { releaseDelete = resolve; });
  const started = new Promise(resolve => { startArrived = resolve; });
  const deleting = new Promise(resolve => { deleteArrived = resolve; });
  const h = harness({
    entryRow: target => target.relativePath.startsWith('clean_dir/' + ISO_BATCH + '/') ? isolatedProbe(target) : null,
    managedObserve: () => (++rounds === 1 ? MANAGED_PENDING : MANAGED_COMPLETED),
    managedStart: () => { startArrived(); return startGate.then(() => { const error = new Error('mutation window busy'); error.code = 'OPERATION_BUSY'; throw error; }); },
    deleteFast: request => deleteGate.then(() => ({ ok: true,
      receipt: { operationId: request.operationId, metrics: { groups: 1, unlinkedFiles: 2, renames: 1, treeDirsRemoved: 1 },
        receipts: request.entries.map(entry => ({ relativePath: entry.relativePath, mode: 'removed' })) } })) });
  const preview = await managedIsolateToken(h, [
    { relativePath: ISO_SRC, type: 'directory', archiveBatch: ISO_BATCH, destination: ISO_DEST },
    { relativePath: 'out/run2', type: 'directory', archiveBatch: ISO_BATCH, destination: 'clean_dir/' + ISO_BATCH + '/out/run2' }]);
  const running = h.api.execute({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, index: 0 });
  await started; // the pending observation and the held managed-start are in flight
  await h.api.check({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, index: 0 });
  await h.api.check({ consumerRoot: __CONSUMER__, token: preview.token, digest: preview.digest, index: 1 });
  const maintenance = h.api.isolatedMaintenanceDelete({ token: preview.token, digest: preview.digest });
  await deleting; // acceptance and executing lifecycle are saved; the engine is still running
  releaseStart();
  const waited = await running;
  assert.equal(waited.state, 'waiting');
  const mid = readLedgerFile(preview.token);
  assert.deepEqual(mid.states, ['completed', 'completed'],
    'P1-1: a target already proved completed is never rolled back by the busy path');
  assert.equal(mid.isolatedDelete && mid.isolatedDelete.phase, 'executing',
    'P1-2: the in-flight maintenance lifecycle must still be on disk after the rollback; a stale-copy writeback erases it');
  releaseDelete();
  const finished = await maintenance;
  assert.equal(finished.state, 'accepted');
  const done = readLedgerFile(preview.token);
  assert.equal(done.isolatedDelete.phase, 'completed');
  assert.deepEqual(done.states, ['completed', 'completed'], 'the maintenance saves keep the persisted completions');
  assert.deepEqual((await h.api.read(preview.token, __CONSUMER__)).states, ['completed', 'completed']);
});

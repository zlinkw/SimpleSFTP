"""C1/C2/C4 paired contract fixture: controlled fast isolation, exact subtree
single-writer locks and registered isolated-subtree permanent deletion.
Runs entirely inside fresh disposable temp roots; no tmux required."""
import builtins, json, os, pathlib, runpy, sys, tempfile

module = runpy.run_path(sys.argv[1])
root = pathlib.Path(tempfile.mkdtemp(prefix='plan-isolate-'))
outputs = root / 'work_dirs'
weight_dir = outputs / 'run1'
weight_dir.mkdir(parents=True)
weight = weight_dir / 'weight.bin'
with weight.open('wb') as stream:
    stream.truncate(64 * 1024 * 1024)  # sparse fixture; contents must never be read
(weight_dir / 'artifact_manifest.json').write_text(json.dumps({"schemaVersion": 1, "case": "c", "seed": 1}), encoding='utf-8')
_, identity = module['root_guard'](str(root))
BATCH = 'job-' + 'a' * 48

data_reads = []
original_open = builtins.open
def guarded_open(file, mode='r', *args, **kwargs):
    text = str(file)
    if 'b' in mode and 'w' not in mode and '+' not in mode and 'x' not in mode \
            and text.startswith(str(outputs) + os.sep) and 'manifest' not in os.path.basename(text):
        data_reads.append(text)
    return original_open(file, mode, *args, **kwargs)
builtins.open = guarded_open

def isolate_target(name, batch=BATCH, **target_extra):
    return {'relativePath': 'work_dirs/' + name, 'destination': 'clean_dir/' + batch + '/work_dirs/' + name,
            'type': 'directory', 'archiveBatch': batch, **target_extra}

def isolate_request(name, **extra):
    target = isolate_target(name, **extra)
    value = module['isolate_inspect'](str(root), target)
    return {**target, **value, 'destination': target['destination']}

def run(request):
    request.setdefault('root', str(root)); request.setdefault('rootIdentity', identity)
    return module['main'](request)

def expect_code(request, code):
    try:
        run(request)
    except module['GuardError'] as error:
        assert error.code == code, (code, error.code, error.reason)
        return error
    raise AssertionError('expected ' + code)

def isolation_state(rel):
    return module['isolation_state'](str(root), rel)

# 1) fast inspect proves top-level identity with zero data-content reads.
frozen = isolate_request('run1')
assert frozen['fingerprintMode'] == 'top_level' and 'contentFingerprint' not in frozen, frozen
assert not data_reads, data_reads
assert any(row.get('path') == 'artifact_manifest.json' for row in frozen['inventory'])

# 2) isolate renames into the intent batch with no content reads; the pending
# isolation mapping registers and MANIFEST facts stay inventory-free.
done = run({'action': 'isolate', 'operationId': 'op-iso-run1', 'target': frozen})
assert done['ok'] and done['receipt']['phase'] == 'completed'
moved = root / 'clean_dir' / BATCH / 'work_dirs' / 'run1'
assert moved.is_dir() and (moved / 'weight.bin').exists() and not weight_dir.exists()
assert not data_reads, data_reads
state = isolation_state('clean_dir/' + BATCH + '/work_dirs/run1')
assert state and state['state'] == 'isolated' and state['destination'].endswith('work_dirs/run1'), state
manifest_lines = (root / 'clean_dir' / 'MANIFEST.md').read_text(encoding='utf-8').splitlines()
assert any('"phase":"intent"' in line for line in manifest_lines) and any('"phase":"completed"' in line for line in manifest_lines)
assert not any('"inventory"' in line for line in manifest_lines), 'isolate audit must stay a compact fact'

# 3) a new run recreates the canonical path; recovery only acknowledges the
# frozen binding and never re-moves or reports the new data as the old source.
weight_dir.mkdir(parents=True)
(weight_dir / 'new-run.txt').write_text('new run data', encoding='utf-8')
settle_request = {'action': 'settle', 'settledAction': 'isolate', 'operationId': 'op-iso-run1',
                  'target': {key: frozen[key] for key in ('relativePath', 'destination', 'type', 'fingerprint', 'inode', 'device', 'fingerprintMode')}}
expect_code(settle_request, 'SOURCE_RECREATED_OR_NOT_MOVED')
expect_code({**settle_request, 'action': 'check'}, 'SOURCE_RECREATED_OR_CHANGED')
assert (weight_dir / 'new-run.txt').read_text(encoding='utf-8') == 'new run data'

# 4) crash window: rename committed but the completion record never did.
# Recovery trusts only the frozen binding, repairs the mapping, never re-moves.
(outputs / 'run2').mkdir()
(outputs / 'run2' / 'epoch.ckpt').write_text('ckpt', encoding='utf-8')
frozen2 = isolate_request('run2')
real_register = module['register_isolation']
patched = lambda *args, **kwargs: None
try:
    module['register_isolation'] = patched
    assert module['isolate_inspect'] is not None
    run({'action': 'isolate', 'operationId': 'op-iso-run2', 'target': frozen2})
finally:
    module['register_isolation'] = real_register
crashed_rel = 'clean_dir/' + BATCH + '/work_dirs/run2'
assert isolation_state(crashed_rel) is None and (root / crashed_rel).is_dir()
settled = run({'action': 'settle', 'settledAction': 'isolate', 'operationId': 'op-iso-run2',
               'target': {key: frozen2[key] for key in ('relativePath', 'destination', 'type', 'fingerprint', 'inode', 'device', 'fingerprintMode')}})
assert settled['ok'] and settled['receipt']['fingerprintMode'] == 'top_level'
assert isolation_state(crashed_rel)['state'] == 'isolated'

# 5) required-input overlap blocks the affected isolate before any mutation;
# an input outside the source never blocks; missing inputs never block.
(outputs / 'run3').mkdir()
(outputs / 'run3' / 'epoch.ckpt').write_text('needed by new job', encoding='utf-8')
overlap = {'action': 'isolate', 'operationId': 'op-iso-run3', 'target': isolate_target('run3', requiredInputs=['work_dirs/run3/epoch.ckpt'])}
expect_code(overlap, 'ISOLATE_REQUIRED_INPUT_OVERLAP')
assert (outputs / 'run3' / 'epoch.ckpt').exists() and not (root / 'clean_dir' / BATCH / 'work_dirs' / 'run3').exists()
missing_input = isolate_request('run3', requiredInputs=['work_dirs/gone/epoch.ckpt'])
run({'action': 'isolate', 'operationId': 'op-iso-run3', 'target': missing_input})
assert not (outputs / 'run3').exists() and (root / 'clean_dir' / BATCH / 'work_dirs' / 'run3' / 'epoch.ckpt').exists()

# 6) shape and destination guards.
(outputs / 'run4').mkdir()
expect_code({'action': 'isolate', 'operationId': 'op-x', 'target': {'relativePath': 'work_dirs/run4', 'type': 'directory',
          'destination': 'clean_dir/work_dirs/run4'}}, 'UNSAFE_ARCHIVE_BATCH')
expect_code({'action': 'isolate', 'operationId': 'op-x', 'target': {'relativePath': 'work_dirs/run4', 'type': 'directory',
          'destination': 'clean_dir/work_dirs/run4', 'archiveBatch': BATCH}}, 'UNSAFE_DESTINATION')
(outputs / 'run5').mkdir()
(root / 'clean_dir' / BATCH / 'work_dirs' / 'run5').mkdir(parents=True)
expect_code({'action': 'isolate', 'operationId': 'op-x', 'target': isolate_request('run5')}, 'DESTINATION_EXISTS')

# 7) C2 subtree locks: leaf exclusive, ancestors shared. Siblings parallel;
# parent/child and same-path overlap block with OPERATION_BUSY without ever
# holding the root mutation lock.
held = module['acquire_target_locks'](str(root), ['work_dirs/run6/deep'])
try:
    (outputs / 'run7').mkdir()
    sibling = isolate_request('run7')
    run({'action': 'isolate', 'operationId': 'op-iso-run7', 'target': sibling})  # disjoint sibling succeeds
    assert not (outputs / 'run7').exists()
    (outputs / 'run6').mkdir(exist_ok=True)
    expect_code({'action': 'isolate', 'operationId': 'op-x', 'target': isolate_request('run6')}, 'OPERATION_BUSY')  # ancestor overlap blocks
    expect_code({'action': 'delete', 'operationId': 'op-x', 'target': {'relativePath': 'work_dirs/run6', 'destination': 'clean_dir/work_dirs/run6', 'type': 'directory'}}, 'OPERATION_BUSY')
finally:
    for stream in held:
        stream.close()
# The mutations never parked the root mutation lock: a fresh root mutation
# lock stays immediately acquirable (C2 short control transaction).
control = module['mutation_lock'](str(root)); control.close()

# 8) C4 registered permanent deletion. Confirmed paths reach only registered
# isolated subtrees; the delete itself is metadata-only and replays complete.
archived_rel = 'clean_dir/' + BATCH + '/work_dirs/run2'
confirmed = {'relativePath': archived_rel, 'destination': archived_rel, 'type': 'directory', 'authorizationMode': 'confirmed_paths'}
previewed = run({'action': 'inspect', 'target': dict(confirmed)})
assert previewed['ok'] and not previewed['target'].get('missing')
frozen_delete = {**confirmed, 'fingerprint': previewed['target']['fingerprint']}
permanent = run({'action': 'delete', 'operationId': 'op-del-run2', 'target': frozen_delete})
assert permanent['ok'] and not (root / archived_rel).exists()
state = isolation_state(archived_rel)
assert state['state'] == 'deleted' and set(state) == {'schemaVersion', 'state', 'operationId', 'destination', 'deletedAt'}, state
replayed = run({'action': 'delete', 'operationId': 'op-del-run2-replay', 'target': frozen_delete})
assert replayed.get('alreadyDeleted') is True and replayed['state'] == 'completed'
check_after = run({'action': 'check', 'target': frozen_delete})
assert check_after['state'] == 'completed' and check_after.get('verifiedBy') == 'isolation_deleted'
# a rebuilt name after completion stays new data: replays complete and a fresh
# deletion requires a fresh registration (anti-replay, never re-delete).
(root / archived_rel).mkdir(parents=True); (root / archived_rel / 'fresh.bin').write_text('keep', encoding='utf-8')
rebuilt = run({'action': 'delete', 'operationId': 'op-del-replay2', 'target': frozen_delete})
assert rebuilt.get('alreadyDeleted') is True and (root / archived_rel / 'fresh.bin').read_text(encoding='utf-8') == 'keep'
# re-isolating into the same destination re-registers and replaces the record
(outputs / 'run2').mkdir()
frozen2b = isolate_request('run2')
run({'action': 'isolate', 'operationId': 'op-iso-run2b', 'target': frozen2b})
assert isolation_state(archived_rel)['state'] == 'isolated'

# 9) control regions and unregistered archive paths always stay refused.
for rel, code in (('clean_dir', 'PROTECTED_PATH'), ('clean_dir/MANIFEST.md', 'PROTECTED_PATH'),
                  ('clean_dir/.operations/isolation', 'PROTECTED_PATH'), ('clean_dir/' + BATCH, 'PROTECTED_PATH'),
                  ('clean_dir/' + BATCH + '/never/registered', 'NOT_REGISTERED_ISOLATION')):
    expect_code({'action': 'delete', 'operationId': 'op-x', 'target': {'relativePath': rel, 'destination': rel,
              'type': 'directory', 'authorizationMode': 'confirmed_paths'}}, code)

# 10) restore clears the isolation registration so a later confirmed delete
# requires a fresh registration.
archived2 = 'clean_dir/' + BATCH + '/work_dirs/run3'
restore_target = {'relativePath': archived2, 'type': 'directory', 'archiveBatch': BATCH, 'destination': 'work_dirs/run3'}
restore_preview = run({'action': 'inspect', 'archived': True, 'target': dict(restore_target)})
restored = run({'action': 'restore', 'operationId': 'op-restore-run3',
                'target': {**restore_target, 'fingerprint': restore_preview['target']['fingerprint']}})
assert restored['ok'] and (outputs / 'run3' / 'epoch.ckpt').exists()
assert isolation_state(archived2)['state'] == 'restored'
expect_code({'action': 'delete', 'operationId': 'op-x', 'target': {'relativePath': archived2, 'destination': archived2,
          'type': 'directory', 'authorizationMode': 'confirmed_paths'}}, 'NOT_REGISTERED_ISOLATION')

assert not data_reads, ('data content was read on fast paths', data_reads[:3])
print(json.dumps({'ok': True, 'fastIsolate': True, 'subtreeLocks': True, 'registeredDeletion': True}))

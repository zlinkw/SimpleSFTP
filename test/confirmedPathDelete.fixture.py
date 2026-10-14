import json
import os
import runpy
import sys
import tempfile

module = runpy.run_path(sys.argv[1])
env = module['inspect'].__globals__
root = tempfile.mkdtemp(prefix='confirmed-path-delete-')
os.makedirs(root + '/output')
os.makedirs(root + '/clean_dir/output')
for name in ('output/job.txt', 'clean_dir/output/job.txt'):
    with open(root + '/' + name, 'w', encoding='utf-8') as stream:
        stream.write('fixture only')
def stale(*args, **kwargs):
    raise module['GuardError']('STALE_METADATA_GATE')
for name in ('tracked_dirty', 'open_handles', 'managed_active'):
    env[name] = stale
target = {'relativePath': 'output/job.txt', 'destination': 'clean_dir/output/job.txt', 'type': 'file',
          'authorizationMode': 'confirmed_paths', 'expectedOwner': {'obsolete': True}, 'expectedSha256': 'obsolete'}
def denied(call):
    try:
        call()
    except module['GuardError']:
        return
    raise AssertionError('unsafe input accepted')
denied(lambda: module['inspect'](root, {**target, 'authorizationMode': None}))
denied(lambda: module['inspect'](root, {**target, 'relativePath': '../outside'}))
denied(lambda: module['inspect'](root, {**target, 'type': 'directory'}))
os.symlink(root + '/output/job.txt', root + '/output/link')
denied(lambda: module['inspect'](root, {**target, 'relativePath': 'output/link'}))
value = module['inspect'](root, target)
_, identity = module['root_guard'](root)
request = {'root': root, 'rootIdentity': identity, 'operationId': 'confirmed-fixture', 'action': 'delete', 'target': {**target, **value, 'destination': target['destination']}}
denied(lambda: module['main']({**request, 'action': 'move'}))
denied(lambda: module['main']({**request, 'action': 'managed-start', 'cleanupAction': 'move'}))
with open(root + '/output/job.txt', 'w', encoding='utf-8') as stream:
    stream.write('changed')
denied(lambda: module['main'](request))
value = module['inspect'](root, target)
request['target'] = {**target, **value, 'destination': target['destination']}
assert module['main'](request)['ok'] is True
assert not os.path.lexists(root + '/output/job.txt')
assert os.path.isfile(root + '/clean_dir/output/job.txt')
print(json.dumps({'ok': True, 'exactPathDeleted': True, 'guardsRetained': True}))

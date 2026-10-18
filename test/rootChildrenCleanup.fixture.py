import json, os, pathlib, runpy, stat, sys, tempfile

engine = runpy.run_path(sys.argv[1])
env = engine['main'].__globals__
base = pathlib.Path(tempfile.mkdtemp(prefix='root-child-cleanup-')).resolve()
root = base / 'project'
root.mkdir()
archive = root / 'clean_dir' / 'fixture-only'
archive.mkdir(parents=True)
main_git = root / '.git' / 'config'
main_git.parent.mkdir()
main_git.write_text('protected main repository', encoding='utf-8')
outside = base / 'outside.txt'
outside.write_text('untouched', encoding='utf-8')
file = root / 'runtime_manifest.json'
file.write_text('{"fixture":true}', encoding='utf-8')
folder = root / 'root-folder'
(folder / 'sub').mkdir(parents=True)
(folder / 'sub' / 'value.txt').write_text('fixture only', encoding='utf-8')

def target(name, kind='file'):
    return {'relativePath':name, 'destination':'clean_dir/' + name, 'type':kind, 'authorizationMode':'confirmed_paths'}

def inspect(t):
    return engine['main']({'root':str(root), 'action':'inspect', 'target':t})

def presence(t):
    return engine['main']({'root':str(root), 'action':'inventory', 'target':t, 'presenceOnly':True, 'allowMissing':True})

def denied(call, code):
    try:
        call()
    except engine['GuardError'] as error:
        assert error.code == code, (error.code, code)
        return error
    raise AssertionError('unsafe target accepted: ' + code)

for t in [target(file.name), target(folder.name, 'directory')]:
    assert not presence(t)['target']['missing']
    value = inspect(t)
    assert value['target']['parent'] == str(root)
    assert value['target']['fingerprintMode'] == 'metadata'
assert presence(target('missing.json'))['target']['missing']
denied(lambda: inspect(target(file.name, 'directory')), 'TYPE_CHANGED')
for rel in ['.', '..', '', '../outside.txt', '/absolute', 'root-folder/*']:
    denied(lambda rel=rel: inspect(target(rel)), 'UNSAFE_PATH')
for rel in ['.git', '.git/config', 'clean_dir']:
    denied(lambda rel=rel: inspect(target(rel, 'directory')), 'PROTECTED_PATH')

original_lstat, original_mounts = os.lstat, env['mount_points']
def linked(value, *args, **kwargs):
    if os.path.abspath(value) == str(file):
        from types import SimpleNamespace
        return SimpleNamespace(st_mode=stat.S_IFLNK, st_file_attributes=0)
    return original_lstat(value, *args, **kwargs)
os.lstat = linked
denied(lambda: presence(target(file.name)), 'LINK_OR_REPARSE_POINT')
os.lstat = original_lstat
env['mount_points'] = lambda: {str(folder)}
denied(lambda: presence(target(folder.name, 'directory')), 'MOUNT_ESCAPE')
env['mount_points'] = original_mounts

# The real parent guard still rejects the project root itself and outside targets.
for full in [str(root), str(outside)]:
    denied(lambda full=full: engine['parent_cd'](str(root), full), 'PARENT_CD_FAILED')

_, identity = engine['root_guard'](str(root))
def request(t):
    return {'root':str(root), 'rootIdentity':identity, 'operationId':'fixture-root-child', 'action':'delete',
            'target':{**t, **inspect(t)['target'], 'destination':t['destination']}}

# Exercise real delete executors, moving isolated fixture targets instead of unlinking them.
calls = []
original_chdir = os.chdir
def record_delete(name, *args, **kwargs):
    assert name.startswith('./') and '/' not in name[2:] and name[2:] not in ('', '.', '..'), name
    parent = pathlib.Path(os.getcwd()).resolve()
    assert parent == root or engine['below'](str(root), str(parent)), str(parent)
    full = parent / name[2:]
    assert full == file or full == folder or engine['below'](str(folder), str(full)), str(full)
    calls.append({'parent':str(parent), 'child':name})
    os.rename(name, archive / ('entry-' + str(len(calls))))
os.unlink = record_delete
os.rmdir = record_delete
approved = request(target(file.name))
file.write_text('{"changed":"after preview"}', encoding='utf-8')
denied(lambda: engine['main'](approved), 'PREVIEW_CHANGED')
assert not calls

approved = request(target(file.name))
def reject_chdir(value):
    raise PermissionError('fixture denied parent entry')
os.chdir = reject_chdir
denied(lambda: engine['main'](approved), 'PARENT_CD_FAILED')
os.chdir = original_chdir
assert not calls
original_chdir(str(archive))
os.chdir = lambda value: None
denied(lambda: engine['main'](approved), 'PARENT_CD_FAILED')
os.chdir = original_chdir
assert not calls

assert engine['main'](approved)['ok']
assert engine['main'](request(target(folder.name, 'directory')))['ok']
assert not file.exists() and not folder.exists()
assert presence(target(file.name))['target']['missing']
assert presence(target(folder.name, 'directory'))['target']['missing']
assert {'parent':str(root), 'child':'./runtime_manifest.json'} in calls
assert {'parent':str(root), 'child':'./root-folder'} in calls
assert main_git.read_text(encoding='utf-8') == 'protected main repository'
assert outside.read_text(encoding='utf-8') == 'untouched'
original_chdir(str(root))
print(json.dumps({'ok':True, 'rootChildren':True, 'physicalParentChecked':True, 'guardsRetained':True, 'mockedDeletion':True}))

import json, os, pathlib, runpy, stat, sys, tempfile

engine = runpy.run_path(sys.argv[1])
env = engine['inspect'].__globals__
root = pathlib.Path(tempfile.mkdtemp(prefix='nested-repository-')).resolve()
archive = root / 'clean_dir' / 'fixture-only'
archive.mkdir(parents=True)
main_git = root / '.git' / 'config'
main_git.parent.mkdir()
main_git.write_text('main repository must survive', encoding='utf-8')
child = root / 'comparison_methods' / '_repos' / 'cpsc'
(child / '.git' / 'objects').mkdir(parents=True)
(child / '.git' / 'config').write_text('fixture subrepository', encoding='utf-8')
(child / '.git' / 'objects' / 'pack').write_bytes(b'fixture only')
(child / 'model.py').write_text('fixture code', encoding='utf-8')
target = {'relativePath':'comparison_methods/_repos/cpsc', 'destination':'clean_dir/comparison_methods/_repos/cpsc',
          'type':'directory', 'authorizationMode':'confirmed_paths'}

def denied(call, code):
    try:
        call()
    except engine['GuardError'] as error:
        assert error.code == code, (error.code, code)
        return error
    raise AssertionError('unsafe target accepted: ' + code)

denied(lambda: engine['contents'](str(root), str(child), 'directory'), 'PROTECTED_DESCENDANT')
value = engine['inspect'](str(root), target)
assert any(row['path'] == '.git/objects/pack' for row in value['inventory'])
assert value['fingerprintMode'] == 'metadata'
for rel in ('.git', '.git/config', 'comparison_methods/_repos/cpsc/.git'):
    denied(lambda rel=rel: engine['inspect'](str(root), {**target,'relativePath':rel}), 'PROTECTED_PATH')
for rel in ('.', '..', ''):
    denied(lambda rel=rel: engine['inspect'](str(root), {**target,'relativePath':rel}), 'UNSAFE_PATH')

protected = child / 'clean_dir'
protected.mkdir()
error = denied(lambda: engine['inspect'](str(root), target), 'PROTECTED_DESCENDANT')
assert error.blocking_path == str(protected), str(error)
os.rename(protected, archive / 'protected-fixture')

# A .git pointer remains an ordinary approved file. Its external reference is never followed.
worktree = child / 'nested_worktree'
worktree.mkdir()
(worktree / '.git').write_text('gitdir: ' + str(main_git.parent), encoding='utf-8')
value = engine['inspect'](str(root), target)
original_lstat = os.lstat
def linked(value, *args, **kwargs):
    if os.path.abspath(value) == str(child / '.git'):
        from types import SimpleNamespace
        return SimpleNamespace(st_mode=stat.S_IFLNK, st_file_attributes=0)
    return original_lstat(value, *args, **kwargs)
os.lstat = linked
denied(lambda: engine['inspect'](str(root), target), 'LINK_OR_REPARSE_POINT')
os.lstat = original_lstat
original_mounts = env['mount_points']
env['mount_points'] = lambda: {str(child / '.git')}
denied(lambda: engine['inspect'](str(root), target), 'MOUNT_ESCAPE')
env['mount_points'] = original_mounts

# Exercise real deletion executors without permanently deleting even fixture files.
calls = []
original_chdir = os.chdir
def record_delete(name, *args, **kwargs):
    assert name.startswith('./') and '/' not in name[2:] and name[2:] not in ('', '.', '..'), name
    parent = pathlib.Path(os.getcwd()).resolve()
    assert engine['below'](str(root), str(parent)), str(parent)
    full = parent / name[2:]
    assert engine['below'](str(child), str(full)) or full == child
    calls.append(str(full))
    os.rename(name, archive / ('entry-' + str(len(calls))))
os.unlink = record_delete
os.rmdir = record_delete
_, identity = engine['root_guard'](str(root))
request = {'root':str(root), 'rootIdentity':identity, 'operationId':'fixture-subtree', 'action':'delete',
           'target':{**target, **value, 'destination':target['destination']}}
(child / '.git' / 'new-after-preview').write_text('unapproved change', encoding='utf-8')
denied(lambda: engine['main'](request), 'PREVIEW_CHANGED')
assert not calls
request['target'] = {**target, **engine['inspect'](str(root), target), 'destination':target['destination']}
assert engine['main'](request)['ok']
assert not child.exists()
assert any('/.git/' in name.replace('\\','/') for name in calls)
assert main_git.read_text(encoding='utf-8') == 'main repository must survive'
original_chdir(str(root))
print(json.dumps({'ok':True,'nestedGitRemoved':True,'mainGitProtected':True,'guardsRetained':True,'mockedDeletion':True}))

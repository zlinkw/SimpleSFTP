import ast
import json
import os
import re
import stat
import sys

with open(os.path.join(os.path.dirname(__file__), '..', 'cleanup-files.py'), encoding='utf-8') as stream:
    tree = ast.parse(stream.read())
function = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'batch_verify')
module = ast.fix_missing_locations(ast.Module(body=[function], type_ignores=[]))
namespace = {'os': os, 'stat': stat, 'FAST_BATCH_LIMIT': 100, 'ARCHIVED_BATCH_RE': re.compile(r'(?!)'),
             'relative': lambda value: value, 'path_guard': lambda root, rel, **kwargs: os.path.join(root, rel),
             'deny': lambda code: (_ for _ in ()).throw(ValueError(code))}
exec(compile(module, '<batch_verify>', 'exec'), namespace)
result = namespace['batch_verify'](sys.argv[1], {'root': 'fixture'},
    {'authorizationMode': 'confirmed_paths', 'entries': [{'relativePath': 'missing', 'type': 'file'}]})
prune = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'prune_isolation_parents')
module = ast.fix_missing_locations(ast.Module(body=[prune], type_ignores=[]))
class FakePath:
    present = False
    def lexists(self, _value):
        return self.present
class FakeOs:
    path = FakePath()
fake_os = FakeOs()
executors = []
prune_namespace = {'os': fake_os, 'isolation_parent_paths': lambda destinations: [],
    'path_guard': lambda root, rel, *_args: root + '/' + rel,
    'current_cleanup_executors': lambda _root, _full: executors,
    'deny': lambda code, *_args: (_ for _ in ()).throw(ValueError(code))}
exec(compile(module, '<prune_isolation_parents>', 'exec'), prune_namespace)
inspect = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'inspect_isolation_parents')
module = ast.fix_missing_locations(ast.Module(body=[inspect], type_ignores=[]))
exec(compile(module, '<inspect_isolation_parents>', 'exec'), prune_namespace)
request = {'rootIdentity': {'root': 'fixture'}, 'operationId': 'op', 'parentConfirmations': 2, 'destinations': ['missing'], 'entries': []}
pruned = prune_namespace['prune_isolation_parents']('/root', request['rootIdentity'], request)
assert pruned['state'] == 'completed' and pruned['receipt']['operationId'] == 'op'
assert prune_namespace['inspect_isolation_parents']('/root', request['rootIdentity'], request)['eligible'] is True
for present, active in [(True, False), (False, True)]:
    fake_os.path.present = present
    executors[:] = [{}] if active else []
    assert prune_namespace['inspect_isolation_parents']('/root', request['rootIdentity'], request)['eligible'] is False
    try:
        prune_namespace['prune_isolation_parents']('/root', request['rootIdentity'], request)
        raise AssertionError('an existing target or active executor was accepted')
    except ValueError as error:
        assert str(error) == 'ISOLATION_DELETE_NOT_COMPLETED'
print(json.dumps(result))

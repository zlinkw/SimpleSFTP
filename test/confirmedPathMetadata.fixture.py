import builtins, json, os, pathlib, runpy, sys, tempfile, time
module = runpy.run_path(sys.argv[1])
root = pathlib.Path(tempfile.mkdtemp(prefix='confirmed-metadata-'))
job = root / 'output' / 'job'
job.mkdir(parents=True)
weight = job / 'weights.pth'
with weight.open('wb') as stream:
    stream.truncate(64 * 1024 * 1024 * 1024)  # sparse fixture; must never be read or hashed
target = {'relativePath':'output/job','destination':'clean_dir/output/job','type':'directory','authorizationMode':'confirmed_paths'}
original = builtins.open
def metadata_only(file, mode='r', *args, **kwargs):
    if 'r' in mode and 'b' in mode and str(file).startswith(str(job)):
        raise AssertionError('confirmed-path deletion must not read weight contents')
    return original(file, mode, *args, **kwargs)
builtins.open = metadata_only
value = module['inspect'](str(root), target)
assert value['fingerprintMode'] == 'metadata'
assert all('sha256' not in row for row in value['inventory'])
_, identity = module['root_guard'](str(root))
request = {'root':str(root),'rootIdentity':identity,'operationId':'fixture','action':'delete','target':{**target,**value,'destination':target['destination']}}
with original(weight,'r+b') as stream:
    stream.write(b'changed')
stamp = os.stat(weight)
os.utime(weight, ns=(stamp.st_atime_ns, stamp.st_mtime_ns + 1_000_000_000))
try:
    module['main'](request)
    raise AssertionError('changed target was accepted')
except module['GuardError'] as error:
    assert error.code == 'PREVIEW_CHANGED', error.code
value = module['inspect'](str(root), target)
request['target'] = {**target,**value,'destination':target['destination']}
assert module['main'](request)['ok']
assert not job.exists()
print(json.dumps({'ok':True,'weightBytesRead':0,'metadataChangeRejected':True}))

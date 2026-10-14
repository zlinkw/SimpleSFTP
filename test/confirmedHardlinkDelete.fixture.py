import json, os, pathlib, runpy, sys, tempfile
m=runpy.run_path(sys.argv[1])
root=pathlib.Path(tempfile.mkdtemp(prefix='confirmed-hardlinks-'))
keep=root/'keep.py';keep.write_text('preserve this source',encoding='utf-8')
for name in ('job-a','job-b'):
    job=root/'outputs'/name;job.mkdir(parents=True)
    os.link(keep,job/'source.py');os.link(keep,job/'source-copy.py')
    (job/'best.pth').write_bytes(b'internal checkpoint')
    os.link(job/'best.pth',job/'last.pth')
def preview(name):
    target=dict(relativePath='outputs/'+name,destination='clean_dir/outputs/'+name,type='directory',authorizationMode='confirmed_paths')
    return {**target,**m['inspect'](str(root),target),'destination':target['destination']}
_,identity=m['root_guard'](str(root))
targets=[preview(name) for name in ('job-a','job-b')]
try:
    m['inspect'](str(root),dict(relativePath='outputs/job-a',destination='clean_dir/outputs/job-a',type='directory'))
    raise AssertionError('ordinary move lost its hardlink guard')
except m['GuardError'] as error:
    assert error.code=='SHARED_HARDLINK',error.code
for index,target in enumerate(targets):
    request=dict(root=str(root),rootIdentity=identity,operationId='fixture-'+str(index),action='delete',target=target)
    assert m['main'](request)['ok']
    assert not (root/target['relativePath']).exists()
    assert keep.read_text(encoding='utf-8')=='preserve this source'
assert os.stat(keep).st_nlink==1
job=root/'outputs'/'changed';job.mkdir()
os.link(keep,job/'source.py')
target=preview('changed')
keep.write_text('changed after confirmation',encoding='utf-8')
try:
    m['main'](dict(root=str(root),rootIdentity=identity,operationId='changed',action='delete',target=target))
    raise AssertionError('changed hardlink content accepted')
except m['GuardError'] as error:
    assert error.code=='PREVIEW_CHANGED',error.code
assert job.exists() and keep.exists()
print(json.dumps(dict(ok=True,aliasesPreserved=True,changedContentRejected=True)))

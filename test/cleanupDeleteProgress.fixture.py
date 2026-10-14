import json, pathlib, runpy, sys, tempfile
m=runpy.run_path(sys.argv[1])
root=pathlib.Path(tempfile.mkdtemp(prefix='cleanup-progress-'))
job=root/'output'/'job';job.mkdir(parents=True)
(job/'one.bin').write_bytes(b'123')
(job/'two.bin').write_bytes(b'12345')
target=dict(relativePath='output/job',destination='clean_dir/output/job',type='directory',authorizationMode='confirmed_paths')
target={**target,**m['inspect'](str(root),target)}
assert m['managed_delete_progress'](str(root),target)==dict(removedEntries=0,totalEntries=3,removedBytes=0,totalBytes=8)
row=next(row for row in target['inventory'] if row['path']=='one.bin')
m['delete_file'](str(root),str(job/'one.bin'),row,metadata_only=True)
assert m['managed_delete_progress'](str(root),target)==dict(removedEntries=1,totalEntries=3,removedBytes=3,totalBytes=8)
assert (job/'two.bin').read_bytes()==b'12345'
print(json.dumps(dict(ok=True,actualRemainingFiles=True)))

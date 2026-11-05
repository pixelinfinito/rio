import pathlib,subprocess,tarfile,hashlib,zlib,json,time,shutil
root=pathlib.Path('/dev/shm/rio-tanstack-work');repo=root/'seed-base';sha='8a28904aaccb6bc26398b751400a181c0f6d7f0e'
entries={}
for l in subprocess.check_output(['git','ls-tree','-r',sha],cwd=repo,text=True).splitlines():
 meta,name=l.split('\t',1);mode,kind,oid=meta.split()
 if kind=='blob':entries[name]=(mode,oid)
existing=set(subprocess.check_output(['git','cat-file','--batch-all-objects','--batch-check=%(objectname)'],cwd=repo,text=True).splitlines());needed={p:v for p,v in entries.items() if v[1] not in existing};print('Restoring',len(needed),'public snapshot blobs',flush=True)
with tarfile.open(root/'seed-base-public.tar.gz') as archive:
 for member in archive:
  name=member.name.split('/',1)[1] if '/' in member.name else ''
  if name not in needed:continue
  mode,oid=needed[name]
  content=member.linkname.encode() if member.issym() else archive.extractfile(member).read()
  raw=b'blob '+str(len(content)).encode()+b'\0'+content;assert hashlib.sha1(raw).hexdigest()==oid,(name,oid)
  obj=repo/'.git/objects'/oid[:2]/oid[2:];obj.parent.mkdir(exist_ok=True);obj.write_bytes(zlib.compress(raw));del needed[name]
assert not needed,len(needed)
for r in (repo,root/'seed-head'):
 p=subprocess.run(['git','checkout','--force','--detach',sha],cwd=r,capture_output=True);assert p.returncode==0,p.stderr.decode()[-1000:]
 status=subprocess.check_output(['git','status','--porcelain','-uno'],cwd=r,text=True);assert not status,status[:200]
 print(r,'clean restored',flush=True)
head=root/'seed-head';f=head/'packages/query-broadcast-client-experimental/src/index.ts';s=f.read_text();assert s.count('let transaction = false')==1;f.write_text(s.replace('let transaction = false','let transaction: string = false',1));subprocess.run(['git','add',str(f.relative_to(head))],cwd=head,check=True);subprocess.run(['git','-c','user.name=Rio Eval','-c','user.email=rio-eval@example.invalid','commit','-qm','Seed 20261105: invalid broadcast transaction string annotation'],cwd=head,check=True)
newsha=subprocess.check_output(['git','rev-parse','HEAD'],cwd=head,text=True).strip();patch=subprocess.check_output(['git','diff','HEAD^','HEAD','--'],cwd=head)
out=pathlib.Path('/home/ubuntu/.t3/worktrees/rio/eval-run-tanstack-query/eval/runs/tanstack-query-11522-seeded-evidence');(out/'mutation.patch').write_bytes(patch)
meta=dict(kind='seeded-mutation',case_id='11522-seeded-transaction-type-20261105',parent_pr='https://github.com/TanStack/query/pull/11522',base_sha=sha,head_sha=newsha,seed=20261105,patch_sha256=hashlib.sha256(patch).hexdigest(),expected=[dict(id='broadcast-transaction-string-type',mechanism='type-error',description='The existing boolean transaction flag is incorrectly annotated string; tsc must reject its boolean initializer and assignments.')],registered_utc=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime()),binary='b15dc8ff5001',profile='rio/base',archive_sha256=hashlib.sha256((root/'seed-base-public.tar.gz').read_bytes()).hexdigest(),archive_url='https://codeload.github.com/TanStack/query/tar.gz/'+sha,oracle_required='Base passes TypeScript; head emits TS2322 on the sole changed annotation, independently verified before Rio execution.')
(out/'preregistered-control.json').write_text(json.dumps(meta,indent=2)+'\n');print(json.dumps(meta),flush=True)

import pathlib,subprocess,tarfile,hashlib,zlib,json,time,urllib.request
work=pathlib.Path('/dev/shm/rio-tanstack-work');repo=work/'maintainer-mirror';out=pathlib.Path(__file__).resolve().parent
sha_list=['d09cf1d605c81238934f6f91a4982f5629065732','370ed5845530a928fcb5374162de67326724a7d1'];ledger=[]
def run(argv):subprocess.run(argv,check=True)
if not repo.exists():run(['git','clone','--shared','--no-checkout','/tmp/rio-tanstack-query-search',str(repo)])
for sha in sha_list:
 start=time.monotonic();entries={}
 for l in subprocess.check_output(['git','ls-tree','-r',sha],cwd=repo,text=True).splitlines():
  meta,name=l.split('\t',1);mode,kind,oid=meta.split()
  if kind=='blob':entries[name]=(mode,oid)
 existing=set(subprocess.check_output(['git','cat-file','--batch-all-objects','--batch-check=%(objectname)'],cwd=repo,text=True).splitlines());needed={p:v for p,v in entries.items() if v[1] not in existing}
 url='https://codeload.github.com/TanStack/query/tar.gz/'+sha;archive=work/(sha+'.tar.gz');urllib.request.urlretrieve(url,archive);original_count=len(needed)
 with tarfile.open(archive) as a:
  for member in a:
   name=member.name.split('/',1)[1] if '/' in member.name else ''
   if name not in entries:continue
   mode,oid=entries[name];content=member.linkname.encode() if member.issym() else a.extractfile(member).read();raw=b'blob '+str(len(content)).encode()+b'\0'+content
   assert hashlib.sha1(raw).hexdigest()==oid,(name,oid)
   if name in needed:
    obj=repo/'.git/objects'/oid[:2]/oid[2:];obj.parent.mkdir(exist_ok=True);obj.write_bytes(zlib.compress(raw));del needed[name]
 assert not needed,len(needed)
 ledger.append(dict(sha=sha,url=url,archive_sha256=hashlib.sha256(archive.read_bytes()).hexdigest(),restored_blobs=original_count,wall_time_seconds=time.monotonic()-start));(out/'source-provenance.json').write_text(json.dumps(ledger,indent=2)+'\n');print(sha,'verified',flush=True)
 run(['git','-C',str(repo),'branch','-f','eval-'+sha[:8],sha])
for side,sha in zip(['base','head'],sha_list):
 dest=work/('maintainer-'+side)
 run(['git','clone','--shared','--no-checkout',str(repo),str(dest)]);run(['git','-C',str(dest),'checkout','--detach',sha]);assert not subprocess.check_output(['git','-C',str(dest),'status','--porcelain','-uno'])

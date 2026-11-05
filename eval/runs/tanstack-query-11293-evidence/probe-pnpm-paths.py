from pathlib import Path
import hashlib,json,re
root=Path('/dev/shm/rio-tanstack-work/maintainer-head');store=root/'node_modules/.pnpm';lines=(store/'lock.yaml').read_text().splitlines();inside=False;rows=[]
for line in lines:
 if line=='snapshots:':inside=True;continue
 if not inside or not re.match(r'^  \S.*:$',line):continue
 key=line[2:-1].strip("'\"");rio=key.lstrip('/').replace('/','+').replace('(','_').replace(')','')
 if len(rio.encode())<=255:continue
 raw=re.sub(r'[\\/:*?"<>|#]','+',key.lstrip('/'))
 if '(' in raw:raw=re.sub(r'\)\(|\(|\)','_',re.sub(r'\)$','',raw))
 actual=raw
 if len(raw)>250 or (raw!=raw.lower() and not raw.startswith('file+')):actual=raw[:217]+'_'+hashlib.sha256(raw.encode()).hexdigest()[:32]
 pkg=key.split('(',1)[0].rsplit('@',1)[0];manifest=store/actual/'node_modules'/pkg/'package.json'
 if not manifest.is_file():continue
 data=json.loads(manifest.read_text());rows.append(dict(snapshot=key,rio_component=rio,rio_component_bytes=len(rio.encode()),filesystem_name_max=255,installed_directory=actual,installed_manifest=str(manifest),name=data['name'],version=data['version']))
out=Path(__file__).resolve().parent/'overlong-pnpm-paths.json';out.write_text(json.dumps(rows,indent=2)+'\n');print('Verified installed packages with unrepresentable Rio path:',len(rows))

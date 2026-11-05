#!/usr/bin/env python3
"""Expose existing pnpm packages under Rio b15dc8ff5001's expected directory spelling.
No source, lockfile, package metadata, or installed package content is changed.
"""
from pathlib import Path
import hashlib,json,re
root=Path.cwd();store=root/'node_modules/.pnpm';modules=(root/'node_modules/.modules.yaml').read_text();m=re.search(r'^virtualStoreDirMaxLength: (\d+)',modules,re.M);limit=int(m[1]) if m else 120
snapshots=False;aliases=[];unrepresentable=[]
for line in (store/'lock.yaml').read_text().splitlines():
    if line=='snapshots:':snapshots=True;continue
    if not snapshots or not re.match(r'^  \S.*:$',line):continue
    key=line[2:-1].strip("'\"");rio=key.lstrip('/').replace('/','+').replace('(','_').replace(')','')
    raw=re.sub(r'[\\/:*?"<>|#]','+',key.lstrip('/'))
    if '(' in raw:raw=re.sub(r'\)\(|\(|\)','_',re.sub(r'\)$','',raw))
    actual=raw
    if len(raw)>limit or (raw!=raw.lower() and not raw.startswith('file+')):actual=raw[:limit-33]+'_'+hashlib.sha256(raw.encode()).hexdigest()[:32]
    target=store/actual
    if not target.is_dir():continue
    if len(rio.encode())>255:unrepresentable.append(key);continue
    link=store/rio
    if not link.exists():link.symlink_to(actual,target_is_directory=True);aliases.append({'rio':rio,'actual':actual})
# pnpm's multiple TypeScript aliases share a tsc bin; pin it to the manifest's current compiler.
tsc=root/'node_modules/.bin/tsc';tsc.unlink(missing_ok=True);tsc.symlink_to('../typescript/bin/tsc')
print(json.dumps({'aliases':aliases,'unrepresentable_keys':unrepresentable,'virtual_store_dir_max_length':limit,'tsc':'node_modules/typescript/bin/tsc'},indent=2))

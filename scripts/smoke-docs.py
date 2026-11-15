#!/usr/bin/env python3
"""Check an installed/copied Rio binary without source files or executable tools."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

binary=Path(sys.argv[1]).resolve()
version=subprocess.check_output([str(binary),'--version'],text=True).split()
with tempfile.TemporaryDirectory(prefix='rio-docs-smoke-') as tmp:
    root=Path(tmp)
    copied=root/binary.name
    shutil.copy2(binary,copied)
    (root/'config').mkdir()
    (root/'config/config.toml').write_text('invalid [ toml')
    env=os.environ|{'PATH':'','RIO_CONFIG_DIR':str(root/'config'),'NO_COLOR':'1','HTTP_PROXY':'http://127.0.0.1:1','HTTPS_PROXY':'http://127.0.0.1:1'}
    for args in [[],['review'],['profiles','--section','inheritance'],['search','dependency mismatch']]:
        p=subprocess.run([str(copied),'docs',*args],cwd=root,env=env,capture_output=True,check=True)
        assert p.stdout and not p.stderr and b'\x1b' not in p.stdout,args
        p=subprocess.run([str(copied),'docs',*args,'--format','json'],cwd=root,env=env,capture_output=True,check=True)
        result=json.loads(p.stdout)
        assert result['schema_version']==1 and result['rio_version']==version[1]
        assert result['rio_commit']==version[3] and len(result['docs_revision'])==64
print('Copied binary: index/topic/section/search/JSON and build metadata passed')

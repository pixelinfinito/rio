#!/usr/bin/env python3
"""Publish a validated Wiki staging directory with non-force, conflict-aware Git."""
import argparse
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import tempfile
from documentation import digest

MANIFEST='.rio-wiki-manifest.json'

def git(cwd,*args):
    p=subprocess.run(['git',*args],cwd=cwd,text=True,capture_output=True)
    if p.returncode:
        # Avoid echoing remote URLs or credential-bearing Git errors.
        raise ValueError('Git operation failed ('+args[0]+'). Check Wiki initialization, write access, and concurrent changes; staging output is preserved.')
    return p.stdout.strip()

def safe(path):
    p=PurePosixPath(path)
    if p.is_absolute() or not p.parts or any(part.lower() in ('..','.git') for part in p.parts) or '\\' in path or ':' in path or path==MANIFEST:
        raise ValueError('Unsafe generated Wiki path')
    return p

def load(directory):
    if (directory/MANIFEST).is_symlink():raise ValueError('Symlink in Wiki input manifest')
    data=json.loads((directory/MANIFEST).read_text())
    if data.get('schema_version')!=1:raise ValueError('Unsupported Wiki manifest version')
    if not isinstance(data.get('files'),dict):raise ValueError('Missing Wiki file manifest')
    for path,hashed in data['files'].items():
        safe(path);p=directory/path
        if any(parent.is_symlink() for parent in [p,*p.parents] if parent!=directory.parent):raise ValueError('Symlink in Wiki input')
        if not p.is_file() or digest(p.read_bytes())!=hashed:raise ValueError(f'Wiki staging file missing/changed: {path}')
    return data

def publish(staging,remote,adopt=()):
    staging=Path(staging).resolve();desired=load(staging)
    # Git credentials are obtained from the existing helper. Never pass tokens
    # in the remote URL or capture them in output.
    if remote.startswith('-') or ('://' in remote and '@' in remote.split('://',1)[1].split('/',1)[0]):raise ValueError('Use a credential helper, not credentials in the remote URL')
    with tempfile.TemporaryDirectory(prefix='rio-wiki-publish-') as tmp:
        repo=Path(tmp)/'wiki';git(tmp,'clone','--quiet','--',remote,str(repo))
        base=git(repo,'rev-parse','HEAD');branch=git(repo,'symbolic-ref','--short','HEAD')
        if (repo/MANIFEST).is_symlink():raise ValueError('Symlink in Wiki ownership manifest')
        previous=json.loads((repo/MANIFEST).read_text()) if (repo/MANIFEST).exists() else {'files':{}}
        if previous.get('schema_version',1)!=1:raise ValueError('Unsupported existing ownership manifest')
        owned=previous.get('files',{})
        for path,expected in owned.items():
            safe(path);p=repo/path
            if any(parent.is_symlink() for parent in [p,*p.parents]) or not p.is_file() or digest(p.read_bytes())!=expected:raise ValueError(f'Wiki has an external edit to managed file: {path}')
        for path in adopt:
            safe(path)
            if path not in desired['files']:raise ValueError('Adopt must name a generated file')
        for path in desired['files']:
            p=repo/path
            if any(parent.is_symlink() for parent in [p,*p.parents]):raise ValueError('Symlink in Wiki destination')
            if p.exists() and path not in owned and path not in adopt:raise ValueError(f'Unmanaged Wiki file would be overwritten: {path}; inspect and explicitly --adopt that file if intended')
        for path in owned:
            if path not in desired['files']:(repo/path).unlink()
        for path in desired['files']:
            target=repo/path;target.parent.mkdir(parents=True,exist_ok=True);shutil.copyfile(staging/path,target)
        shutil.copyfile(staging/MANIFEST,repo/MANIFEST)
        git(repo,'add','--all')
        if not git(repo,'diff','--cached','--name-only'):
            return {'changed':False,'wiki_commit':base,'source_commit':desired['source_commit']}
        git(repo,'-c','user.name=Rio documentation','-c','user.email=rio-docs@users.noreply.github.com','commit','--quiet','-m',f"Publish Rio docs {desired['docs_revision'][:12]} from {desired['source_commit'][:12]}")
        remote_head=git(repo,'ls-remote','origin',f'refs/heads/{branch}').split()[0]
        if remote_head!=base:raise ValueError('Wiki changed concurrently; render/review again before retrying')
        git(repo,'push','origin',f'HEAD:refs/heads/{branch}')
        return {'changed':True,'wiki_commit':git(repo,'rev-parse','HEAD'),'source_commit':desired['source_commit']}

def main():
    p=argparse.ArgumentParser(description=__doc__);p.add_argument('staging');p.add_argument('--remote',required=True);p.add_argument('--adopt',action='append',default=[],help='Explicitly take ownership of an inspected pre-existing generated page (first publication only)')
    a=p.parse_args();print(json.dumps(publish(a.staging,a.remote,a.adopt),indent=2))
if __name__=='__main__':
    try:main()
    except (ValueError,KeyError,OSError) as e:
        print('Wiki publication stopped: '+str(e),file=__import__('sys').stderr);raise SystemExit(1)

#!/usr/bin/env python3
"""Independent, pinned upstream checks; disposable source and durable evidence."""
import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

p = argparse.ArgumentParser()
p.add_argument('--source', required=True)
p.add_argument('--sha', required=True)
p.add_argument('--out', required=True)
a = p.parse_args()
out = Path(a.out).resolve()
out.mkdir(parents=True, exist_ok=False)
ledger = {'sha': a.sha, 'environment': {'UV_PYTHON': '3.13.9'}, 'commands': []}
started = time.monotonic()
with tempfile.TemporaryDirectory(prefix='pydantic-oracle-') as tmp:
    root = Path(tmp) / 'repo'

    def run(argv, name, cwd=root):
        before = time.monotonic()
        with (out / (name + '.stdout')).open('wb') as so, (out / (name + '.stderr')).open('wb') as se:
            r = subprocess.run(argv, cwd=cwd, env={**os.environ, 'UV_PYTHON': '3.13.9'}, stdout=so, stderr=se, timeout=900)
        ledger['commands'].append({'argv': argv, 'cwd': str(cwd), 'exit_code': r.returncode,
                                   'wall_time_seconds': round(time.monotonic() - before, 3),
                                   'stdout': name + '.stdout', 'stderr': name + '.stderr'})
        (out / 'commands.json').write_text(json.dumps(ledger, indent=2) + '\n')
        print(name, r.returncode, flush=True)
        return r.returncode

    assert run(['git', 'clone', '--no-checkout', a.source, str(root)], 'clone', Path(tmp)) == 0
    assert run(['git', 'checkout', '--detach', a.sha], 'checkout') == 0
    ledger['lockfile_sha256'] = hashlib.sha256((root / 'uv.lock').read_bytes()).hexdigest()
    assert run(['uv', 'sync', '--locked', '--all-groups', '--all-extras'], 'install') == 0
    run(['uv', '--version'], 'uv-version')
    run(['uv', 'run', '--no-sync', 'python', '--version'], 'python-version')
    for tool in ('mypy', 'ruff', 'coverage', 'pytest'):
        run(['uv', 'run', '--no-sync', tool, '--version'], tool + '-version')
    run(['uv', 'run', '--no-sync', 'mypy', 'pydantic_settings'], 'mypy')
    run(['uv', 'run', '--no-sync', 'ruff', 'check'], 'ruff')
    run(['uv', 'run', '--no-sync', 'ruff', 'format', '--check', 'pydantic_settings', 'tests'], 'format')
    run(['uv', 'run', '--no-sync', 'coverage', 'run', '-m', 'pytest'], 'pytest-coverage')
    run(['uv', 'run', '--no-sync', 'coverage', 'report', '--include=pydantic_settings/*'], 'coverage-report')
    run(['uv', 'run', '--no-sync', 'coverage', 'json', '-o', str(out / 'coverage.json')], 'coverage-json')
    run(['git', 'status', '--porcelain', '--untracked-files=no'], 'tracked-status')
    cov = out / 'coverage.json'
    if cov.exists():
        with gzip.open(str(cov) + '.gz', 'wb') as f:
            f.write(cov.read_bytes())
        cov.unlink()
ledger['wall_time_seconds'] = round(time.monotonic() - started, 3)
(out / 'commands.json').write_text(json.dumps(ledger, indent=2) + '\n')

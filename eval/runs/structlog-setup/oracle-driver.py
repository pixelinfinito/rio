"""Independent oracle driver; runs repository-configured tools, never Rio."""
import argparse
import gzip
import json
from pathlib import Path
import subprocess
import time

p = argparse.ArgumentParser()
p.add_argument('--pr', required=True)
p.add_argument('--base', required=True)
p.add_argument('--head', required=True)
p.add_argument('--out', required=True)
a = p.parse_args()
out = Path(a.out).resolve()
out.mkdir(parents=True, exist_ok=False)
ledger = []
venv = Path('/dev/shm/structlog-eval-venv/bin')

def run(argv, cwd, name):
    start = time.monotonic()
    result = subprocess.run(list(map(str, argv)), cwd=cwd, capture_output=True)
    out.joinpath(name + '.stdout').write_bytes(result.stdout)
    out.joinpath(name + '.stderr').write_bytes(result.stderr)
    ledger.append(dict(argv=list(map(str, argv)), cwd=str(cwd), exit_code=result.returncode,
                       wall_time_ms=round((time.monotonic()-start)*1000),
                       stdout=name+'.stdout', stderr=name+'.stderr'))
    out.joinpath('commands.json').write_text(json.dumps(ledger, indent=2)+'\n')
    return result

for variant, sha in [('base', a.base), ('head', a.head)]:
    tree = Path('/dev/shm') / ('structlog-oracle-'+a.pr+'-'+variant)
    run(['git', 'clone', '--no-hardlinks', '/tmp/structlog-eval-oracle', tree], '/dev/shm', variant+'-clone')
    if run(['git', 'checkout', '--detach', sha], tree, variant+'-checkout').returncode:
        raise SystemExit('checkout failed')
    if run([venv/'pip', 'install', '--no-deps', '--no-build-isolation', '-e', '.'], tree, variant+'-install').returncode:
        raise SystemExit('install failed')
    run([venv/'pip', 'list', '--format=json'], tree, variant+'-versions')
    run([venv/'mypy', 'src'], tree, variant+'-mypy-src')
    run([venv/'mypy', 'tests/typing'], tree, variant+'-mypy-api')
    run([venv/'ruff', 'check', '.', '--output-format=json'], tree, variant+'-ruff')
    run([venv/'coverage', 'run', '-m', 'pytest', '-q'], tree, variant+'-pytest')
    run([venv/'coverage', 'combine'], tree, variant+'-coverage-combine')
    run([venv/'coverage', 'json', '-o', str(out/(variant+'-coverage.json'))], tree, variant+'-coverage-json')
    cp = out/(variant+'-coverage.json')
    if cp.exists():
        with gzip.open(str(cp)+'.gz', 'wb') as f:
            f.write(cp.read_bytes())
        cp.unlink()
    run(['git', 'status', '--porcelain', '--untracked-files=no'], tree, variant+'-status')

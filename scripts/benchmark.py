#!/usr/bin/env python3
"""Measure cold and warm fast reviews without modifying the selected repository."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import statistics
import subprocess
import time

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--repository', required=True, type=Path)
parser.add_argument('--base', required=True)
parser.add_argument('--binary', required=True, type=Path)
parser.add_argument('--output', required=True, type=Path)
parser.add_argument('--runs', type=int, default=10)
args = parser.parse_args()
if args.runs < 10:
    parser.error('at least ten runs per condition are required')
args.binary = args.binary.resolve()
args.repository = args.repository.resolve()
args.output.mkdir(parents=True, exist_ok=True)
cache = args.output.resolve() / 'cache'

def git(*arguments):
    return subprocess.check_output(['git', '-C', str(args.repository), *arguments], text=True).strip()

def percentile(values, fraction):
    values = sorted(values)
    position = (len(values) - 1) * fraction
    lower = int(position)
    upper = min(lower + 1, len(values) - 1)
    return values[lower] + (values[upper] - values[lower]) * (position - lower)

record = {
    'schema': 1,
    'platform': platform.platform(),
    'cpu_count': os.cpu_count(),
    'version': subprocess.check_output([str(args.binary), '--version'], text=True).strip(),
    'binary_sha256': hashlib.sha256(args.binary.read_bytes()).hexdigest(),
    'repository': git('remote', 'get-url', 'origin'),
    'base': git('rev-parse', args.base),
    'head': git('rev-parse', 'HEAD'),
    'diff_numstat': git('diff', '--numstat', args.base, 'HEAD'),
    'command': ['rio', 'review', '--base', args.base, '--offline', '--format', 'json'],
    'percentile_method': 'linear interpolation at (n-1)*p',
    'runs': [],
}
for condition in ['cold', 'warm']:
    for index in range(args.runs):
        if condition == 'cold' and cache.exists():
            shutil.rmtree(cache)
        environment = dict(os.environ, RIO_CACHE_DIR=str(cache), RIO_CONFIG_DIR=str(args.output.resolve() / 'config'), NO_COLOR='1')
        started = time.monotonic()
        result = subprocess.run([str(args.binary), *record['command'][1:]], cwd=args.repository, env=environment, capture_output=True, timeout=300)
        elapsed = (time.monotonic() - started) * 1000
        stem = f'{condition}-{index + 1:02}'
        (args.output / f'{stem}.json').write_bytes(result.stdout)
        (args.output / f'{stem}.log').write_bytes(result.stderr)
        report = json.loads(result.stdout)
        if result.returncode not in [0, 1, 4] or report.get('status') == 'error':
            raise RuntimeError(f'{stem} failed: {result.returncode}')
        record['runs'].append({
            'condition': condition, 'index': index + 1, 'wall_time_ms': round(elapsed, 3),
            'report_wall_time_ms': report['metrics']['wall_time_ms'], 'exit_code': result.returncode,
            'status': report['status'], 'review_id': report['review']['id'], 'checks': report['checks'],
        })
        (args.output / 'results.json').write_text(json.dumps(record, indent=2) + '\n')
        print(f'{stem}: {elapsed / 1000:.3f}s, {report["status"]}, exit {result.returncode}', flush=True)
record['summary'] = {}
for condition in ['cold', 'warm']:
    runs = [run for run in record['runs'] if run['condition'] == condition]
    values = [run['wall_time_ms'] for run in runs]
    checks = sorted({(check['kind'], check['root'], check['version']) for run in runs for check in run['checks']})
    record['summary'][condition] = {
        'p50_ms': statistics.median(values), 'p95_ms': percentile(values, .95),
        'per_check': [{
            'kind': kind, 'root': root, 'version': version,
            'p50_ms': statistics.median([check['wall_time_ms'] for run in runs for check in run['checks'] if (check['kind'], check['root'], check['version']) == (kind, root, version)]),
            'p95_ms': percentile([check['wall_time_ms'] for run in runs for check in run['checks'] if (check['kind'], check['root'], check['version']) == (kind, root, version)], .95),
        } for kind, root, version in checks],
    }
(args.output / 'results.json').write_text(json.dumps(record, indent=2) + '\n')
print(json.dumps(record['summary'], indent=2))

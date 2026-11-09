"""Council A/B (rio-v0-3-council task 7.3) over the labeled plausible bucket.

Usage: RIO_ENDPOINT=... RIO_SECRETS_FILE=... python3 -I drive.py CASES.json RIO_BINARY OUT_DIR [--jobs N] [--only ID,...]
Per case, the verifier-only arm (profile ab-baseline) runs first and the council arm
(ab-council) second, so the stage 3 agent cache gives both arms the same hypotheses.
Writes OUT_DIR/<arm>/<case>/{report.json, audit.json, stderr.log, exit_code,
wall_seconds} and, for the council arm, council/<finding>/<role>-r1.json from R2.
A case arm that already has exit 0 or 1 is kept.
"""
import argparse
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

WORK = Path(os.environ.get('RIO_AB_WORK', 'work'))
ENDPOINT = os.environ['RIO_ENDPOINT']
# The file credential store written by `rio deploy --credential-store file`.
SECRETS = Path(os.environ['RIO_SECRETS_FILE'])
ARMS = (('verifier-only', 'ab-baseline'), ('council', 'ab-council'))
ROLES = ('skeptic', 'exploit-author', 'code-owner', 'maintainer', 'tester')


def git(cwd, *args):
    subprocess.run(['git', *args], cwd=cwd, check=True, capture_output=True, text=True)


def fetch(case):
    path = WORK / case['id']
    if (path / '.git').is_dir():
        head = subprocess.run(['git', 'rev-parse', 'HEAD'], cwd=path, capture_output=True, text=True).stdout.strip()
        if head == case['head']:
            return path
        shutil.rmtree(path)
    path.mkdir(parents=True)
    git(path, 'init', '-q')
    git(path, 'remote', 'add', 'origin', f'https://github.com/{case["repo"]}.git')
    git(path, 'fetch', '-q', '--depth=2', 'origin', case['head'], case['base'])
    git(path, 'checkout', '-q', '--detach', case['head'])
    return path


def audit(review, target):
    token = json.loads(SECRETS.read_text())['RIO_API_TOKEN']
    subprocess.run(['curl', '-sS', '--fail', '--max-time', '60', '-o', str(target / 'audit.json'),
                    '-H', f'Authorization: Bearer {token}', f'{ENDPOINT}/v1/reviews/{review}/audit'], check=True)


def answers(review, report, target):
    selected = ((report.get('agent_audit') or {}).get('council') or {}).get('selected', [])
    for item in selected:
        folder = target / 'council' / item['id']
        folder.mkdir(parents=True, exist_ok=True)
        for role in ROLES:
            key = f'reviews/{review}/council/{item["id"]}/{role}-r1.json'
            out = subprocess.run(['cf', 'r2', 'objects', 'get', key, '--bucket-name', 'rio-artifacts', '--text'],
                                 capture_output=True, text=True)
            if out.returncode == 0 and out.stdout.strip().startswith('{'):
                (folder / f'{role}-r1.json').write_text(out.stdout)


def review(case, path, arm, profile, args):
    target = args.out / arm / case['id']
    if (target / 'exit_code').is_file() and (target / 'exit_code').read_text().strip() in {'0', '1'}:
        return f'{case["id"]} {arm}: kept'
    target.mkdir(parents=True, exist_ok=True)
    started = time.time()
    with open(target / 'report.json', 'wb') as stdout, open(target / 'stderr.log', 'wb') as stderr:
        code = subprocess.run([args.rio, 'review', '--base', case['base'], '--format', 'json', '--profile', profile],
                              cwd=path, stdout=stdout, stderr=stderr).returncode
    (target / 'exit_code').write_text(f'{code}\n')
    (target / 'wall_seconds').write_text(f'{time.time() - started:.0f}\n')
    match = re.search(r'Endpoint review: ([0-9a-f-]{36})', (target / 'stderr.log').read_text(errors='replace'))
    try:
        report = json.loads((target / 'report.json').read_text())
    except ValueError as error:
        return f'{case["id"]} {arm}: exit {code}, no usable report ({error})'
    if match:
        (target / 'endpoint_review').write_text(match.group(1) + '\n')
        try:
            audit(match.group(1), target)
            if arm == 'council':
                answers(match.group(1), report, target)
        except (subprocess.CalledProcessError, OSError) as error:
            # The review is kept (rerunning it would repeat its cost); fetch the audit by hand.
            (target / 'audit.json').unlink(missing_ok=True)
            return f'{case["id"]} {arm}: exit {code}, audit fetch failed ({error})'
    return f'{case["id"]} {arm}: exit {code} status {report.get("status")}'


def run_case(case, args):
    try:
        path = fetch(case)
    except subprocess.CalledProcessError as error:
        return [f'{case["id"]}: fetch failed: {error.stderr.strip()}']
    return [review(case, path, arm, profile, args) for arm, profile in ARMS]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('cases', type=Path)
    parser.add_argument('rio')
    parser.add_argument('out', type=Path)
    parser.add_argument('--jobs', type=int, default=3)
    parser.add_argument('--only')
    args = parser.parse_args()
    cases = json.loads(args.cases.read_text())
    if args.only:
        keep = set(args.only.split(','))
        cases = [c for c in cases if c['id'] in keep]
    WORK.mkdir(parents=True, exist_ok=True)
    date = time.strftime('%Y-%m-%d')
    for arm, _ in ARMS:
        (args.out / arm).mkdir(parents=True, exist_ok=True)
        manifest = args.out / arm / 'run.json'
        if not manifest.is_file():
            manifest.write_text(json.dumps({'arm': arm, 'case_set': 'v0.3-council-plausible-bucket', 'date': date}) + '\n')
    with concurrent.futures.ThreadPoolExecutor(args.jobs) as pool:
        for lines in pool.map(lambda c: run_case(c, args), cases):
            for line in lines:
                print(line, flush=True)


if __name__ == '__main__':
    main()

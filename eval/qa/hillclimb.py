"""Focused UX-review hillclimb runner (mobile/light, Codex harness, AI Gateway route).

Runs every selected case x rep through `rio qa --journey J` against the fixture,
grades the model-authored review with judge.py, and writes the hillclimb layout:
  FLOW/VARIANT/results.jsonl, summary.json, errors.jsonl, progress.txt,
  traces/<case>_rep<k>.json, reports/<case>_rep<k>.json, judge/<case>_rep<k>.json
Resume is idempotent at (case, rep). Re-grading stored reports needs --regrade only.

Run with the judge virtualenv, for example:
  ~/.venvs/rio-qa-judge/bin/python eval/qa/hillclimb.py --flow .claude/hillclimb/qa-ux --variant baseline
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(HERE))
import gateway_client  # noqa: E402
import judge  # noqa: E402

QA_MODEL = 'custom-node-openai/gpt-6.1-sol'
ROUTE_URL = f'https://gateway.ai.cloudflare.com/v1/{gateway_client.ACCOUNT}/rio/compat/chat/completions'
# Journeys for the original focused UX cases; new cases carry focus_journey in cases.json.
JOURNEYS = {'duplicate-address': 'checkout', 'ambiguous-next': 'checkout', 'lost-input': 'payment-recovery',
            'missing-cancel': 'payment-recovery', 'keyboard-barrier': 'keyboard-shopping',
            'intentional-brand': 'checkout', 'clean': 'checkout'}
PROFILE = ('version: 1\nname: hillclimb\nextends: rio/qa\nbudget:\n  fast:\n'
           '    qa: {wall: 90m, cell_wall: 15m, tokens: 300000, evidence_bytes: 1073741824, replay_wall: 10m}\n')
lock = threading.Lock()


def sha(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def cases():
    rows = json.loads((HERE / 'cases.json').read_text())['cases']
    return {row['id']: {**row, 'journey': row.get('focus_journey') or JOURNEYS.get(row['id'])}
            for row in rows if row['kind'] != 'defect'}


def keyring_route(private):
    """Store the gateway token in a private keyring and return a QA model route file."""
    os.environ['XDG_DATA_HOME'] = str(private / 'data')
    daemon = subprocess.run(['gnome-keyring-daemon', '--unlock', '--components=secrets'], input=os.urandom(24).hex().encode(),
                            capture_output=True, check=True)
    for line in daemon.stdout.decode().splitlines():
        if line.startswith('GNOME_KEYRING_CONTROL='):
            os.environ['GNOME_KEYRING_CONTROL'] = line.split('=', 1)[1]
    subprocess.run(['secret-tool', 'store', '--label=Rio QA hillclimb gateway', 'service', 'rio-qa-hillclimb', 'username', 'gateway',
                    'target', 'default'], input=gateway_client.gateway_token().encode(), stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, check=True, timeout=20)
    route = private / 'route.json'
    route.write_text(json.dumps({'url': ROUTE_URL, 'protocol': 'openai', 'authentication': 'ai_gateway', 'model': QA_MODEL,
                                 'provider_model': QA_MODEL, 'keychain_service': 'rio-qa-hillclimb', 'keychain_account': 'gateway'}))
    return route


def transcript_turns(cache):
    """Codex cell transcripts -> [{role, content}] turns, in journey order."""
    turns = []
    for path in sorted(cache.rglob('cell-transcript-*.jsonl'), key=lambda p: p.stat().st_mtime):
        turns.append({'role': 'system', 'content': f'--- {path.parent.parent.name} / {path.parent.name} ---'})
        for line in path.read_text().splitlines():
            row = json.loads(line)
            event = row.get('event') or {}
            item = event.get('item') or {}
            if row.get('kind') != 'event' or event.get('type') != 'item.completed':
                continue
            if item.get('type') == 'mcp_tool_call':
                turns.append({'role': 'tool_call', 'name': item.get('tool'), 'content': json.dumps(item.get('arguments'))})
                result = item.get('result') or {}
                text = '\n'.join(part.get('text', '') for part in result.get('content') or [] if isinstance(part, dict))
                turns.append({'role': 'tool_result', 'name': item.get('tool'), 'content': (text or json.dumps(item.get('error')))[:8000]})
            elif item.get('type') in ('agent_message', 'reasoning'):
                turns.append({'role': 'assistant', 'content': item.get('text', '')})
    return turns


def run_one(case, rep, args, out, route):
    key = f'{case["id"]}_rep{rep}'
    work = Path(args.work) / out.name / key
    shutil.rmtree(work, ignore_errors=True)
    repo = work / 'repo'
    shutil.copytree(ROOT / 'tests/fixtures/qa-sample', repo,
                    ignore=shutil.ignore_patterns('node_modules', 'dist', 'data', '.git', 'test-results'))
    config = repo / '.rio/qa.yaml'
    config.write_text(config.read_text().replace('viewports: [mobile, desktop]', 'viewports: [mobile]')
                      .replace('color_schemes: [light, dark]', 'color_schemes: [light]'))
    flags = json.loads((repo / 'defects.json').read_text())
    (repo / 'defects.json').write_text(json.dumps({flag: flag in case['flags'] for flag in flags}, indent=2) + '\n')
    for command in (['init', '-q'], ['add', '.'], ['-c', 'user.name=QA', '-c', 'user.email=qa@example.test', 'commit', '-qm', 'Fixture']):
        subprocess.run(['git', '-C', str(repo), *command], check=True, capture_output=True)
    profile = work / 'hillclimb.yaml'
    profile.write_text(PROFILE)
    env = {**os.environ, 'RIO_CONFIG_DIR': str(work / 'config'), 'RIO_CACHE_DIR': str(work / 'cache'),
           'RIO_QA_MODEL_ROUTE': str(route), 'RIO_QA_IMAGE': args.image,
           'QA_SHOPPER_USERNAME': 'shopper@example.test', 'QA_SHOPPER_PASSWORD': 'Synthetic-shopper-123',
           'QA_ADMIN_USERNAME': 'admin@example.test', 'QA_ADMIN_PASSWORD': 'Synthetic-admin-123'}
    env.pop('RIO_ENDPOINT_URL', None)
    start = time.monotonic()
    result = subprocess.run([args.rio, 'qa', '--journey', case['journey'], '--profile', str(profile), '--harness', 'codex',
                             '--format', 'json'], cwd=repo, env=env, capture_output=True, timeout=args.timeout)
    latency = time.monotonic() - start
    (out / 'stderr').mkdir(exist_ok=True)
    (out / 'stderr' / f'{key}.txt').write_bytes(result.stderr)
    try:
        report = json.loads(result.stdout)
    except ValueError:
        report = {}
    (out / 'reports').mkdir(exist_ok=True)
    (out / 'reports' / f'{key}.json').write_text(json.dumps(report, indent=1))
    (out / 'traces' / f'{key}.json').write_text(json.dumps(transcript_turns(work / 'cache'), indent=1))
    if not args.keep_work:
        shutil.rmtree(work, ignore_errors=True)
    qa = report.get('qa') or {}
    # Pre-registered rule: a QA report that exists is graded even when its cells were
    # cancelled (for example the agent exhausting its cell budget); only a run with
    # no QA report at all is an infrastructure failure, excluded and retried.
    if not qa:
        raise RuntimeError(f'no QA report (exit {result.returncode}, status {report.get("status")}): '
                           + result.stderr.decode(errors='replace')[-400:])
    return report, latency, result.returncode


def grade_row(case, rep, report, latency, exit_code, out):
    key = f'{case["id"]}_rep{rep}'
    review = (ROOT / 'tests/fixtures/qa-sample/REVIEW.md').read_text()
    journey = (ROOT / f'tests/fixtures/qa-sample/.rio/qa/journeys/{case["journey"]}.yaml').read_text()
    grade, explanation, judged, judge_usage = judge.judge(case, report, review, journey)
    (out / 'judge').mkdir(exist_ok=True)
    (out / 'judge' / f'{key}.json').write_text(json.dumps(judged, indent=1))
    qa = report.get('qa') or {}
    row = {'prompt_id': case['id'], 'rep': rep, 'prompt': f'{case["goal"]} (journey {case["journey"]}, mobile/light)',
           'tags': [case['kind'], case['journey']],
           'grade': {k: v for k, v in grade.items() if v is not None},
           'explanation': explanation, 'model': QA_MODEL, 'latency_s': round(latency, 1) if latency is not None else None,
           'qa_tokens': (qa.get('cost') or {}).get('tokens'), 'recommendations': len(qa.get('recommendations') or []),
           'observations': len(qa.get('observations_unverified') or []),
           'usage': {'total_tokens': (qa.get('cost') or {}).get('tokens')},
           'completed_cells': sum(cell.get('outcome') in ('passed', 'failed') for j in qa.get('journeys', []) for cell in j.get('cells', [])),
           'meta': {'run_id': (report.get('review') or {}).get('run_id'), 'exit_code': exit_code, 'report_status': report.get('status'),
                    'dropped': qa.get('recommendations_dropped')}}
    if judge_usage:
        row['judge_model'] = judge_usage.pop('model')
        row['judge_usage'] = judge_usage
    return row


def append(path, row):
    with lock, path.open('a') as handle:
        handle.write(json.dumps(row) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--flow', type=Path, required=True)
    parser.add_argument('--variant', required=True)
    parser.add_argument('--reps', type=int, default=2)
    parser.add_argument('--case', action='append', default=[])
    parser.add_argument('--parallel', type=int, default=4)
    parser.add_argument('--image', default='rio-qa:0.1.0')
    parser.add_argument('--rio', default=str(ROOT / 'target/debug/rio'))
    parser.add_argument('--work', default=str(Path.home() / 'qa-hillclimb-work'))
    parser.add_argument('--timeout', type=int, default=2400)
    parser.add_argument('--keep-work', action='store_true')
    parser.add_argument('--regrade', action='store_true', help='Re-judge stored reports without new QA runs')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    selected = [case for cid, case in cases().items() if not args.case or cid in args.case]
    out = args.flow / args.variant
    (out / 'traces').mkdir(parents=True, exist_ok=True)
    results = out / 'results.jsonl'
    image = subprocess.run(['docker', 'image', 'inspect', '--format', '{{.Id}}', args.image], capture_output=True, text=True).stdout.strip()
    fingerprint = {'commit': subprocess.run(['git', '-C', str(ROOT), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip(),
                   'image': args.image, 'image_id': image, 'rio_sha256': sha(args.rio), 'qa_model': QA_MODEL, 'judge_model': judge.JUDGE_MODEL,
                   'judge_sha256': sha(HERE / 'judge.py'), 'frictions_sha256': sha(HERE / 'frictions.json'),
                   'fixture_main_sha256': sha(ROOT / 'tests/fixtures/qa-sample/src/main.js')}
    print(json.dumps({'resolved': {'cases': len(selected), 'reps': args.reps, 'runs': len(selected) * args.reps,
                                   'qa_model': QA_MODEL, 'judge': judge.JUDGE_MODEL, **fingerprint}}), flush=True)
    if not image:
        raise SystemExit(f'image {args.image} is missing')
    if args.dry_run:
        return 0
    summary = out / 'summary.json'
    existing = json.loads(summary.read_text()) if summary.exists() else {}
    summary.write_text(json.dumps({**existing, 'fingerprint': fingerprint}, indent=1) + '\n')

    if args.regrade:
        rows = []
        for case in selected:
            for rep in range(args.reps):
                path = out / 'reports' / f'{case["id"]}_rep{rep}.json'
                if path.exists():
                    old = next((json.loads(l) for l in results.read_text().splitlines() if json.loads(l)['prompt_id'] == case['id']
                                and json.loads(l)['rep'] == rep), {}) if results.exists() else {}
                    stored = json.loads(path.read_text())
                    wall = ((stored.get('qa') or {}).get('cost') or {}).get('wall_time_ms')
                    rows.append(grade_row(case, rep, stored, old.get('latency_s', wall / 1000 if wall else None),
                                          (old.get('meta') or {}).get('exit_code'), out))
        keys = {(row['prompt_id'], row['rep']) for row in rows}
        kept = [l for l in (results.read_text().splitlines() if results.exists() else [])
                if (json.loads(l)['prompt_id'], json.loads(l)['rep']) not in keys]
        results.write_text(''.join(l + '\n' for l in kept) + ''.join(json.dumps(row) + '\n' for row in rows))
        print(f'regraded {len(rows)} rows')
        return 0

    # Each run builds untagged app images; hundreds of them slow Docker until app
    # preparation times out. Remove dangling images before any run starts.
    subprocess.run(['docker', 'image', 'prune', '-f'], capture_output=True, check=False)
    done = {(r['prompt_id'], r['rep']) for r in map(json.loads, results.read_text().splitlines())} if results.exists() else set()
    todo = [(case, rep) for case in selected for rep in range(args.reps) if (case['id'], rep) not in done]
    total, finished = len(todo), 0
    started = time.monotonic()
    keyrings = set(subprocess.run(['pgrep', 'gnome-keyring'], capture_output=True, text=True).stdout.split())
    with tempfile.TemporaryDirectory(prefix='rio-qa-hillclimb-') as directory:
      try:
        route = keyring_route(Path(directory))

        def task(case, rep):
            try:
                report, latency, code = run_one(case, rep, args, out, route)
                append(results, grade_row(case, rep, report, latency, code, out))
                return True
            except Exception as error:  # recorded per attempt; the case stays unscored and resumable
                append(out / 'errors.jsonl', {'prompt_id': case['id'], 'rep': rep, 'error': f'{type(error).__name__}: {error}'[:1500],
                                              'at': time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())})
                return False

        with concurrent.futures.ThreadPoolExecutor(args.parallel) as pool:
            futures = [pool.submit(task, case, rep) for case, rep in todo]
            for future in concurrent.futures.as_completed(futures):
                finished += future.result()
                elapsed = time.monotonic() - started
                line = f'{finished}/{total} done, {elapsed / 60:.0f} min elapsed'
                (out / 'progress.txt').write_text(line + '\n')
                print(line, flush=True)
      finally:
        # The private keyring daemon would otherwise keep owning the session's
        # secrets service after its data directory is deleted.
        for pid in set(subprocess.run(['pgrep', 'gnome-keyring'], capture_output=True, text=True).stdout.split()) - keyrings:
            subprocess.run(['kill', pid], check=False)
    return 0 if finished == total else 2


if __name__ == '__main__':
    raise SystemExit(main())

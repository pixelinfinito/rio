#!/usr/bin/env python3
"""Run real fixture journeys or score retained reports. Never synthesizes findings."""
import argparse
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[2]
CASES = Path(__file__).with_name('cases.json')
UX_SCORES = ('guidance_adherence', 'relevance', 'actionability')


def load_labels(path):
    """Human adjudication is explicitly supplied and bound to an immutable run."""
    if path is None:
        return {}
    document = json.loads(path.read_text())
    if not isinstance(document, dict) or document.get('version') != 1 or not isinstance(document.get('labels'), list):
        raise ValueError('Expected a version 1 labels document')
    labels = {}
    for label in document['labels']:
        if not isinstance(label, dict) or any(not isinstance(label.get(key), str) or not label[key].strip()
                                              for key in ('run_id', 'id', 'reviewer', 'evidence_notes')):
            raise ValueError('Each label needs run_id, id, reviewer and evidence_notes')
        if any(type(label.get(key)) is not int or label[key] not in (0, 1, 2) for key in UX_SCORES):
            raise ValueError('UX scores must be integers 0, 1 or 2')
        if type(label.get('unsupported_benefit_claim')) is not bool:
            raise ValueError('unsupported_benefit_claim must be true or false')
        key = (label['run_id'], label['id'])
        if key in labels:
            raise ValueError('Duplicate human label for the same run and recommendation')
        labels[key] = label
    return labels


def apply_labels(row, labels):
    for review in row['recommendation_review']:
        label = labels.get((row.get('run_id'), review['id']))
        if label:
            for field in (*UX_SCORES, 'unsupported_benefit_claim', 'reviewer', 'evidence_notes'):
                review[field] = label[field]
    return row


def observations(report):
    rows = []
    for finding in report.get('findings', []) + report.get('risks', []):
        if finding.get('category') == 'ux' and finding.get('qa'):
            rows.append({'id': finding['id'], 'rule_id': finding['rule_id'], 'journey': finding['qa']['journey'],
                         'verified': finding.get('evidence_level') in ('reproduced', 'static_proven'), 'source': finding})
    for index, observation in enumerate(report.get('qa', {}).get('observations_unverified', [])):
        rows.append({'id': observation.get('id', f'unverified-{index}'), 'rule_id': observation.get('rule_id'),
                     'journey': observation.get('journey'), 'verified': False, 'source': observation})
    # An observation repeated across cells is one detection, not added precision.
    unique = {}
    for row in rows:
        key = (row['rule_id'], row['journey'], row['id']) if row['verified'] else (row['rule_id'], row['journey'], row['source'].get('step'), row['source'].get('route'))
        unique.setdefault(key, row)
    return list(unique.values())


def retained_cell_metrics(report, cache):
    """Read the exact run named by the report, never a mutable latest pointer."""
    review = report.get('review', {})
    identity, run = review.get('id', ''), review.get('run_id', '')
    if not isinstance(identity, str) or not isinstance(run, str) or not re.fullmatch(r'[a-fA-F0-9]{16}', identity) or not re.fullmatch(r'[A-Z0-9]{26}', run):
        return []
    path = cache / identity / 'runs' / run / 'qa/result.json'
    try:
        if not path.resolve().is_relative_to(cache.resolve()) or path.stat().st_size > 64 * 1024 * 1024:
            return []
        runtime = json.loads(path.read_text())
    except (OSError, ValueError):
        return []
    if not isinstance(runtime, dict):
        return []
    # Comparisons retain head metrics at the top level and base metrics in the
    # immutable nested baseline. Read both, without counting a separately saved
    # baseline.json copy again or inventing rows for an unavailable baseline.
    baseline = runtime.get('baseline')
    versions = [runtime, baseline] if isinstance(baseline, dict) else [runtime]
    return [row for version in versions
            for row in (version.get('cell_metrics') if isinstance(version.get('cell_metrics'), list) else [])]


def score(case, report, elapsed=None, cell_metrics=None):
    qa = report.get('qa') or {}
    rows = observations(report)
    matches = lambda row: row.get('rule_id') in case['rules'] and (not case['journeys'] or row.get('journey') in case['journeys'])
    detected = [row for row in rows if matches(row)] if case['kind'] == 'defect' else []
    recommendations = qa.get('recommendations', [])
    relevant = [row for row in recommendations if matches(row)] if case['kind'] == 'ux' else []
    cells = [{'journey': journey['name'], **cell} for journey in qa.get('journeys', []) for cell in journey.get('cells', [])]
    completed = [cell for cell in cells if cell.get('outcome') in ('passed', 'failed')]
    cost = qa.get('cost', {})
    # Shared chains own one measurement per viewport/scheme. Both prerequisite
    # and dependent journeys use it; it must never be counted once per journey.
    measured = [{key: row.get(key) for key in ['id', 'version', 'scope', 'chain', 'journeys', 'cell', 'wall_time_ms', 'tokens', 'usage_estimated', 'usd']}
                for row in (cell_metrics if isinstance(cell_metrics, list) else []) if isinstance(row, dict) and row.get('scope') == 'browser_chain_cell']
    wall = cost.get('wall_time_ms')
    dollars = cost.get('usd')
    return {
        'case': case['id'], 'kind': case['kind'], 'report_status': report.get('status'),
        'run_id': report.get('review', {}).get('run_id'),
        'qa_present': bool(qa), 'cells': cells, 'completed_cells': len(completed),
        'expected_rules': case['rules'], 'detected': bool(detected),
        'matched_observation_ids': [row['id'] for row in detected],
        'verified_matches': sum(row['verified'] for row in detected),
        'unverified_matches': sum(not row['verified'] for row in detected),
        'miss': case['kind'] == 'defect' and not detected,
        'unexpected_observation_ids': [row['id'] for row in rows if row not in detected],
        'clean_noise_count': len(rows) + len(recommendations) if case['kind'] == 'clean' and completed else None,
        'recommendation_ids': [row['id'] for row in relevant],
        'recommendation_review': [{
            'id': row['id'], 'rule_id': row['rule_id'], 'verification_status': row.get('verification_status'),
            'has_evidence': bool(row.get('evidence')), 'has_basis': bool(row.get('basis')),
            'observed_friction': row.get('observed_friction'), 'proposed_improvement': row.get('proposed_improvement'),
            'expected_benefit': row.get('expected_benefit'), 'trade_offs': row.get('trade_offs'),
            'guidance_adherence': None, 'relevance': None, 'actionability': None, 'unsupported_benefit_claim': None,
        } for row in recommendations],
        'cost': {'cells': measured, 'cell_metrics_available': bool(measured), 'tokens': cost.get('tokens'), 'usd': dollars, 'wall_time_ms': wall, 'command_wall_ms': elapsed,
                 'average_usd_per_completed_cell': dollars / len(completed) if isinstance(dollars, (int, float)) and completed else None,
                 'average_wall_ms_per_completed_cell': wall / len(completed) if isinstance(wall, (int, float)) and completed else None},
        'assessment': qa.get('assessment', []),
    }


def summarize(rows):
    defects = [row for row in rows if row['kind'] == 'defect']
    hits = sum(row['detected'] for row in defects)
    matched = sum(len(row['matched_observation_ids']) for row in defects)
    unmatched = sum(len(row['unexpected_observation_ids']) for row in rows if row['kind'] in ('defect', 'clean'))
    # A stable recommendation can recur in different runs; human labels must
    # never silently carry over to new wording or different captured evidence.
    reviews = {(row.get('run_id'), review['id']): review for row in rows for review in row['recommendation_review']}
    labeled = [review for review in reviews.values() if review.get('reviewer')]
    return {'cases': rows, 'metrics': {
        'labeled_defects': len(defects), 'detected_defects': hits,
        'rule_match_recall': hits / len(defects) if defects else None,
        'rule_match_precision': matched / (matched + unmatched) if matched + unmatched else None,
        'verified_defects': sum(row['verified_matches'] > 0 for row in defects),
        'clean_noise_count': sum(row['clean_noise_count'] for row in rows if row['clean_noise_count'] is not None) if any(row['clean_noise_count'] is not None for row in rows) else None,
        'clean_cases_completed': sum(row['kind'] == 'clean' and row['completed_cells'] > 0 for row in rows),
        'human_confirmed_precision': None,
        'human_review_required': True,
    }, 'ux_metrics': {
        'recommendations': len(reviews), 'human_labeled': len(labeled),
        'pending_human_labels': len(reviews) - len(labeled),
        **{f'mean_{field}': sum(review[field] for review in labeled) / len(labeled) if labeled else None for field in UX_SCORES},
        'unsupported_benefit_claims': sum(review['unsupported_benefit_claim'] for review in labeled) if labeled else None,
    }, 'methodology': 'Rule/journey matches are detection signals, not human-confirmed precision. Local unverified observations are separate from verified findings. UX relevance, actionability, guidance adherence and benefit claims require independent human adjudication. Partial runs retain misses and coverage gaps.'}


def run_case(case, args, output):
    setup_start = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='rio-qa-eval-') as directory:
        root = Path(directory)
        repo = root / 'repo'
        def git(*arguments):
            subprocess.run(['git', '-C', str(repo), *arguments], check=True, capture_output=True)
        try:
            shutil.copytree(ROOT / 'tests/fixtures/qa-sample', repo,
                            ignore=shutil.ignore_patterns('node_modules', 'dist', 'data', '.git'))
            git('init', '-q')
            git('add', '.')
            git('-c', 'user.name=Rio QA evaluation', '-c', 'user.email=qa@example.test', 'commit', '-qm', 'Clean fixture')
            flags = json.loads((repo / 'defects.json').read_text())
            for flag in flags:
                flags[flag] = flag in case['flags']
            (repo / 'defects.json').write_text(json.dumps(flags, indent=2) + '\n')
        except (OSError, subprocess.CalledProcessError) as error:
            # An unstarted fixture is a coverage gap, not a fabricated QA report
            # or a reason to abort all remaining cases. Do not retain Git output,
            # which can expose machine configuration outside the test fixture.
            row = score(case, {}, round((time.monotonic() - setup_start) * 1000))
            row['error'] = 'fixture_setup_failed'
            row['setup_exit_code'] = error.returncode if isinstance(error, subprocess.CalledProcessError) else None
            row['setup_errno'] = error.errno if isinstance(error, OSError) else None
            return row
        # All fixture personas are synthetic. A private machine config keeps a
        # local evaluation from inadvertently selecting a saved hosted endpoint.
        env = {**os.environ, 'RIO_CONFIG_DIR': str(root / 'config'), 'RIO_CACHE_DIR': str(output / 'cache'),
               'QA_SHOPPER_USERNAME': 'shopper@example.test', 'QA_SHOPPER_PASSWORD': 'Synthetic-shopper-123',
               'QA_ADMIN_USERNAME': 'admin@example.test', 'QA_ADMIN_PASSWORD': 'Synthetic-admin-123'}
        env.pop('RIO_ENDPOINT_URL', None)
        start = time.monotonic()
        try:
            result = subprocess.run([args.rio, 'qa', '--full', '--harness', args.harness, '--format', 'json'],
                                    cwd=repo, env=env, capture_output=True, timeout=args.timeout)
            elapsed = round((time.monotonic() - start) * 1000)
            (output / f'{case["id"]}.stderr.txt').write_bytes(result.stderr)
            report = json.loads(result.stdout)
            if not isinstance(report, dict) or 'schema' not in report:
                raise ValueError('CLI did not return a report')
            (output / f'{case["id"]}.json').write_bytes(result.stdout)
            metrics = retained_cell_metrics(report, output / 'cache')
            (output / f'{case["id"]}.metrics.json').write_text(json.dumps(metrics, indent=2) + '\n')
            row = score(case, report, elapsed, metrics)
            row['exit_code'] = result.returncode
            return row
        except (subprocess.TimeoutExpired, ValueError) as error:
            row = score(case, {}, round((time.monotonic() - start) * 1000))
            row['error'] = 'command_timeout' if isinstance(error, subprocess.TimeoutExpired) else 'invalid_report'
            return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--local', action='store_true', help='Run the fixture through the installed CLI and real harness (model spend applies)')
    source.add_argument('--reports', type=Path, help='Score existing CASE.json reports without model calls')
    parser.add_argument('--rio', default=shutil.which('rio') or str(ROOT / 'target/debug/rio'))
    parser.add_argument('--harness', choices=['codex', 'pi'], default='codex')
    parser.add_argument('--case', action='append', default=[])
    parser.add_argument('--output', type=Path, default=ROOT / 'eval/qa/results')
    parser.add_argument('--timeout', type=int, default=2100)
    parser.add_argument('--labels', type=Path, help='Human recommendation labels bound to run_id and recommendation id')
    args = parser.parse_args()
    cases = json.loads(CASES.read_text())['cases']
    unknown = set(args.case) - {case['id'] for case in cases}
    if unknown:
        parser.error('Unknown cases: ' + ', '.join(sorted(unknown)))
    if args.timeout < 1:
        parser.error('--timeout must be positive')
    try:
        labels = load_labels(args.labels)
    except (OSError, ValueError) as error:
        parser.error(str(error))
    selected = [case for case in cases if not args.case or case['id'] in args.case]
    output = args.output.resolve()
    output.mkdir(parents=True, exist_ok=True)
    rows = []
    for case in selected:
        if args.local:
            row = run_case(case, args, output)
        else:
            path = args.reports / f'{case["id"]}.json'
            report = json.loads(path.read_text()) if path.exists() else {}
            metrics_path = args.reports / f'{case["id"]}.metrics.json'
            metrics = json.loads(metrics_path.read_text()) if metrics_path.exists() else retained_cell_metrics(report, args.reports / 'cache')
            row = score(case, report, cell_metrics=metrics)
            if not path.exists():
                row['error'] = 'missing_report'
        rows.append(apply_labels(row, labels))
        print(json.dumps({key: row[key] for key in ['case', 'detected', 'miss', 'recommendation_ids', 'clean_noise_count', 'completed_cells']}), flush=True)
        # Preserve a partial evaluation if interrupted between cases.
        (output / 'summary.json').write_text(json.dumps(summarize(rows), indent=2) + '\n')
    return 2 if any(not row['qa_present'] or not row['completed_cells'] for row in rows) else 0


if __name__ == '__main__':
    raise SystemExit(main())

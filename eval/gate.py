#!/usr/bin/env python3
"""Regression gate over the full case set: incidents, historical PRs and mutations.

  scorecard  build one scorecard for a pipeline version:
             python3 -I eval/gate.py scorecard --summary EVAL-SUMMARY.json
                 --cases eval/cases [--cases ...] --reports RUN-DIR --label NAME --out CARD.json
  gate       compare a candidate scorecard with the current baseline:
             python3 -I eval/gate.py gate --baseline BASE.json --candidate CAND.json [--out RESULT.json]

Precision and recall come from the adjudicated harness summary (`eval/evaluate.py
aggregate` over historical PRs and seeded mutations: eligible.precision and
eligible.positive_control_recall). Case recall comes from eval cases
(schemas/eval-case-v1.json): a case is caught when every expected finding is matched
by a reported finding (same file and enclosing symbol, or overlapping lines; see
eval/cases.py) in RUN-DIR/<case-id>/report.json or RUN-DIR/<case-id>.json. A case
whose report is missing is recorded as missing, never as caught.

The gate fails when the candidate lowers precision, recall or incident recall, when
a metric the baseline measured is missing, when a baseline case is absent, or when
any incident the baseline caught is missed (each missed incident is named).
Exit codes: 0 pass, 1 fail, 2 usage or input error.
"""
import argparse
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cases as c  # noqa: E402
import evaluate as e  # noqa: E402

SCORECARD_SCHEMA = e.SCHEMA / 'scorecard-v1.json'
METRICS = ('precision', 'recall', 'incident_recall')
EPSILON = 1e-9


def find_report(reports_dir, case_id):
    for path in (Path(reports_dir) / case_id / 'report.json', Path(reports_dir) / case_id / 'report.json.gz',
                 Path(reports_dir) / f'{case_id}.json'):
        if path.is_file():
            return path
    return None


def recall(rows):
    # Missing reports stay in the denominator: absent evidence is never a catch.
    return sum(r['status'] == 'caught' for r in rows) / len(rows) if rows else None


def scorecard(summary, case_paths, reports_dir, label):
    if summary.get('schema') not in ('rio-eval-summary-v1', 'rio-eval-summary-v2'):
        raise ValueError('expected an eval/evaluate.py aggregate summary')
    e.validate_summary(summary)
    eligible = summary['eligible']
    by_kind = eligible.get('positive_control_by_kind', {})
    rows = {}
    for case, path in c.load_cases(case_paths):
        report_path = find_report(reports_dir, case['id'])
        row = {'label': case['label'], 'case_path': str(path), 'report': None, 'matched': []}
        if report_path is None:
            row['status'] = 'missing'
        else:
            report = e.read_json(report_path)
            e.validate(report, e.ROOT / 'schemas/report-v1.json', label=str(report_path))
            matched = c.caught(case, report)
            row.update(report=str(report_path), matched=matched,
                       status='caught' if all(matched) else 'missed')
        rows[case['id']] = row
    by_label = {label_: [r for r in rows.values() if r['label'] == label_]
                for label_ in ('incident', 'historical', 'mutation')}
    card = {'schema': 'rio-eval-scorecard-v1', 'label': label,
            'rio_versions': summary.get('rio_versions', []), 'profile_hashes': summary.get('profile_hashes', []),
            'precision': eligible['precision'], 'recall': eligible['positive_control_recall'],
            'historical_recall': by_kind.get('real-pr', {}).get('recall'),
            'mutation_recall': by_kind.get('seeded-mutation', {}).get('recall'),
            'incident_recall': recall(by_label['incident']),
            'case_recall': {k: recall(v) for k, v in by_label.items()},
            'cases': rows, 'missing_reports': sorted(k for k, r in rows.items() if r['status'] == 'missing')}
    e.validate(card, SCORECARD_SCHEMA)
    return card


def gate(baseline, candidate):
    for card in (baseline, candidate):
        e.validate(card, SCORECARD_SCHEMA)
    reasons, notes = [], []
    for metric in METRICS:
        old, new = baseline[metric], candidate[metric]
        if new is None and (old is not None or metric != 'incident_recall'):
            reasons.append(f'{metric} is missing from the candidate')
        elif old is None and new is None:
            notes.append(f'{metric} not measured by either scorecard (no cases)')
        elif old is not None and new < old - EPSILON:
            reasons.append(f'{metric} fell from {old:.4f} to {new:.4f}')
    absent = sorted(set(baseline['cases']) - set(candidate['cases']))
    if absent:
        reasons.append('baseline cases absent from the candidate: ' + ', '.join(absent))
    if candidate['missing_reports']:
        reasons.append('candidate cases without a report: ' + ', '.join(candidate['missing_reports']))
    missed_incidents, regressed = [], []
    for case_id, old in sorted(baseline['cases'].items()):
        new = candidate['cases'].get(case_id)
        if old['status'] == 'caught' and new is not None and new['status'] != 'caught':
            (missed_incidents if old['label'] == 'incident' else regressed).append(case_id)
    if missed_incidents:
        reasons.append('previously caught incident(s) missed: ' + ', '.join(missed_incidents))
    if regressed:
        notes.append('previously caught non-incident case(s) missed: ' + ', '.join(regressed))
    return {'schema': 'rio-eval-gate-v1', 'passed': not reasons, 'reasons': reasons, 'notes': notes,
            'baseline': baseline['label'], 'candidate': candidate['label'],
            'missed_incidents': missed_incidents, 'regressed_cases': regressed,
            'metrics': {m: {'baseline': baseline[m], 'candidate': candidate[m]} for m in METRICS}}


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('scorecard')
    p.add_argument('--summary', required=True, help='eval/evaluate.py aggregate summary')
    p.add_argument('--cases', action='append', required=True, help='case file or directory (repeatable)')
    p.add_argument('--reports', required=True, help='directory with <case-id>/report.json per case')
    p.add_argument('--label', required=True, help='name of the pipeline version (prompt/tool/model change)')
    p.add_argument('--out', required=True)
    p = sub.add_parser('gate')
    p.add_argument('--baseline', required=True)
    p.add_argument('--candidate', required=True)
    p.add_argument('--out')
    args = parser.parse_args(argv)
    try:
        if args.command == 'scorecard':
            card = scorecard(e.read_json(args.summary), args.cases, args.reports, args.label)
            e.write_json(args.out, card)
            print(f'Scorecard {args.out}: precision {card["precision"]}, recall {card["recall"]}, '
                  f'incident recall {card["incident_recall"]}')
            return 0
        result = gate(e.read_json(args.baseline), e.read_json(args.candidate))
    except (ValueError, KeyError, OSError) as error:
        print(f'gate error: {error}', file=sys.stderr)
        return 2
    if args.out:
        e.write_json(args.out, result)
    print(('PASS' if result['passed'] else 'FAIL') + ''.join(f'\n- {r}' for r in result['reasons']))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())

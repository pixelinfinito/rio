#!/usr/bin/env python3
"""Regression gate over the full case set: incidents, historical PRs and mutations.

  scorecard  build one scorecard for a pipeline version:
             python3 -I eval/gate.py scorecard --summary EVAL-SUMMARY.json
                 --cases eval/cases [--cases ...] --reports RUN-DIR --label NAME --out CARD.json
  gate       compare a candidate scorecard with the current baseline:
             python3 -I eval/gate.py gate --baseline BASE.json --candidate CAND.json [--out RESULT.json]
                 [--false-positive-rate SOURCE [SOURCE ...]]

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

--false-positive-rate adds the v0.3 exit criterion "false positives per agent < 15 %".
Per producing agent, rate = wrong / responses, where responses are author responses
(fixed, wrong, intentional, irrelevant, style) to posted agent findings in report-v1
files (each identity counted once per lineage generation, latest round, as in
eval/convergence.py) plus adjudicated findings of noise runs. Noise runs label
findings on known-clean PRs harmful, neutral or useful: harmful counts as wrong, and
every adjudicated label counts as a response; unadjudicated findings are not
responses. A SOURCE is a report-v1 file (.json or .json.gz), a rio-noise-adjudication-v1
file, or a noise run directory (its */adjudication.json files). The gate fails when
an agent with at least 30 responses exceeds 15 %; agents under that floor are
reported, never gated. Tool findings are not agents and are not counted.

  council    the council keep-or-remove rule over a release cycle's A/B summaries:
             python3 -I eval/gate.py council --summary SUMMARY.json [SUMMARY.json ...] [--out RESULT.json]

The council stays in the `rio/security` and `rio/critical` profiles only when, over
all of the cycle's eval/council.py summaries together, the disagreement rate is at
least 5 % and the council's accuracy on the plausible bucket exceeds the verifier-only
accuracy on the same cases. Otherwise the result fails and names the removal.
Exit codes: 0 pass, 1 fail, 2 usage or input error.
"""
import argparse
from collections import Counter, defaultdict
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cases as c  # noqa: E402
import convergence as cv  # noqa: E402
import evaluate as e  # noqa: E402
import noise as nz  # noqa: E402
import council as cl  # noqa: E402

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


FP_THRESHOLD = 0.15
FP_MIN_RESPONSES = 30


def fp_sources(paths):
    """Split SOURCE paths into report-v1 documents and noise adjudication documents."""
    reports, adjudications = [], []
    for raw in paths:
        path = Path(raw)
        files = sorted(path.glob('*/adjudication.json')) if path.is_dir() else [path]
        if path.is_dir() and not files:
            raise ValueError(f'{path}: no */adjudication.json in this noise run directory')
        for file in files:
            doc = e.read_json(file)
            if doc.get('schema') == 'rio-report-v1':
                e.validate(doc, e.ROOT / 'schemas/report-v1.json', label=str(file))
                reports.append((doc, file))
            elif doc.get('schema') == 'rio-noise-adjudication-v1':
                nz.validate_adjudication(doc)
                adjudications.append(doc)
            else:
                raise ValueError(f'{file}: expected a rio-report-v1 or rio-noise-adjudication-v1 document')
    return reports, adjudications


def false_positive_rate(paths, threshold=FP_THRESHOLD, min_responses=FP_MIN_RESPONSES):
    reports, adjudications = fp_sources(paths)
    reasons = defaultdict(Counter)
    noise = defaultdict(Counter)
    findings, _, _ = cv.collect(reports, default_repository='reference-set')
    for f in findings.values():
        agent = f.get('source', {}).get('agent')
        response = f.get('author_response')
        if agent and response:
            reasons[agent][response['reason']] += 1
    for doc in adjudications:
        for entry in doc['findings'].values():
            source, label = entry['finding']['source'], entry['adjudication']['label']
            if label is not None and not source.startswith('tool:'):
                noise[source][label] += 1
    agents, failed, under = {}, [], []
    for agent in sorted(set(reasons) | set(noise)):
        wrong = reasons[agent]['wrong'] + noise[agent]['harmful']
        responses = sum(reasons[agent].values()) + sum(noise[agent].values())
        rate = wrong / responses if responses else None
        gated = responses >= min_responses
        passed = not gated or rate <= threshold + EPSILON
        agents[agent] = {'responses': responses, 'wrong': wrong, 'rate': rate, 'gated': gated, 'passed': passed,
                         'author_responses': {r: reasons[agent][r] for r in cv.REASONS},
                         'noise': {label: noise[agent][label] for label in ('harmful', 'neutral', 'useful')}}
        if not passed:
            failed.append(f'{agent}: {wrong}/{responses} = {rate:.1%} false positives exceeds {threshold:.0%}')
        elif not gated:
            under.append(f'{agent}: {responses} responses, under the {min_responses}-response floor '
                         f'({wrong} wrong); reported, not gated')
    return {'threshold': threshold, 'min_responses': min_responses, 'agents': agents,
            'passed': not failed, 'failed': failed, 'under_floor': under,
            'sources': {'reports': len(reports), 'noise_adjudications': len(adjudications)}}


def gate(baseline, candidate, fp_paths=None):
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
    fp = None
    if fp_paths:
        fp = false_positive_rate(fp_paths)
        reasons.extend(fp['failed'])
        notes.extend(fp['under_floor'])
        if not fp['agents']:
            reasons.append('false-positive rate: no agent responses in the given sources')
    result = {'schema': 'rio-eval-gate-v1', 'passed': not reasons, 'reasons': reasons, 'notes': notes,
            'baseline': baseline['label'], 'candidate': candidate['label'],
            'missed_incidents': missed_incidents, 'regressed_cases': regressed,
            'metrics': {m: {'baseline': baseline[m], 'candidate': candidate[m]} for m in METRICS}}
    if fp is not None:
        result['false_positive_rate'] = fp
    return result


COUNCIL_MIN_DISAGREEMENT = 0.05
COUNCIL_PROFILES = ('rio/security', 'rio/critical')


def council_gate(summaries):
    """The release checklist's keep-or-remove rule for the council step."""
    if not summaries:
        raise ValueError('council gate needs at least one eval/council.py summary')
    for summary in summaries:
        e.validate(summary, cl.SUMMARY_SCHEMA)
    councilled = sum(s['disagreement']['councilled'] for s in summaries)
    disagreeing = sum(s['disagreement']['disagreeing'] for s in summaries)
    arms = {arm: {k: sum(s['accuracy'][arm][k] for s in summaries) for k in ('cases', 'correct')}
            for arm in ('council', 'verifier_only')}
    for row in arms.values():
        row['accuracy'] = row['correct'] / row['cases'] if row['cases'] else None
    rate = disagreeing / councilled if councilled else None
    reasons = []
    if rate is None:
        reasons.append('no councilled finding had two or more answers; disagreement is unmeasured')
    elif rate < COUNCIL_MIN_DISAGREEMENT - EPSILON:
        reasons.append(f'council disagreement {disagreeing}/{councilled} = {rate:.1%} is below '
                       f'{COUNCIL_MIN_DISAGREEMENT:.0%}')
    council, baseline = arms['council']['accuracy'], arms['verifier_only']['accuracy']
    if council is None or baseline is None:
        reasons.append('accuracy on the plausible bucket is unmeasured')
    elif council <= baseline + EPSILON:
        reasons.append(f'council accuracy {council:.1%} does not exceed verifier-only {baseline:.1%} '
                       f'on the same cases')
    return {'schema': 'rio-eval-council-gate-v1', 'passed': not reasons, 'reasons': reasons,
            'action': None if not reasons else
            'remove the rio/council step from ' + ' and '.join(COUNCIL_PROFILES) + ' in this release',
            'disagreement': {'councilled': councilled, 'disagreeing': disagreeing, 'rate': rate},
            'accuracy': arms, 'runs': [{'case_set': s['case_set'], 'date': s['date']} for s in summaries]}


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
    p.add_argument('--false-positive-rate', nargs='+', metavar='SOURCE', dest='false_positive_rate',
                   help='report-v1 files and noise run directories; gate per-agent false positives at 15 %%')
    p = sub.add_parser('council')
    p.add_argument('--summary', nargs='+', required=True, help='eval/council.py summaries of one release cycle')
    p.add_argument('--out')
    args = parser.parse_args(argv)
    if args.command == 'council':
        try:
            result = council_gate([e.read_json(path) for path in args.summary])
        except (ValueError, KeyError, OSError) as error:
            print(f'gate error: {error}', file=sys.stderr)
            return 2
        if args.out:
            e.write_json(args.out, result)
        print(('KEEP' if result['passed'] else 'REMOVE') + ''.join(f'\n- {r}' for r in result['reasons'])
              + (f'\n{result["action"]}' if result['action'] else ''))
        return 0 if result['passed'] else 1
    try:
        if args.command == 'scorecard':
            card = scorecard(e.read_json(args.summary), args.cases, args.reports, args.label)
            e.write_json(args.out, card)
            print(f'Scorecard {args.out}: precision {card["precision"]}, recall {card["recall"]}, '
                  f'incident recall {card["incident_recall"]}')
            return 0
        result = gate(e.read_json(args.baseline), e.read_json(args.candidate), args.false_positive_rate)
    except (ValueError, KeyError, OSError) as error:
        print(f'gate error: {error}', file=sys.stderr)
        return 2
    if args.out:
        e.write_json(args.out, result)
    print(('PASS' if result['passed'] else 'FAIL') + ''.join(f'\n- {r}' for r in result['reasons']))
    for agent, row in result.get('false_positive_rate', {}).get('agents', {}).items():
        rate = 'n/a' if row['rate'] is None else f'{row["rate"]:.1%}'
        print(f'  false positives {agent}: {row["wrong"]}/{row["responses"]} = {rate}'
              + ('' if row['gated'] else ' (under the response floor; not gated)'))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    sys.exit(main())

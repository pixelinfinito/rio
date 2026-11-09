#!/usr/bin/env python3
"""Council evaluation: disagreement, A/B accuracy on the plausible bucket, cost and weights.

  summarize  one A/B run of the plausible bucket, council arm against verifier-only:
             python3 -I eval/council.py summarize --outcomes OUTCOMES.json
                 --council RUN-DIR --baseline RUN-DIR [--weights modules/members/weights.json]
                 --out SUMMARY.json
  weights    offline member weights per member and category from known outcomes:
             python3 -I eval/council.py weights --runs RUN-DIR [RUN-DIR ...]
                 [--outcomes OUTCOMES.json ...] --out modules/members/weights.json

A RUN-DIR holds `run.json` ({"arm": "council" | "verifier-only", "case_set", "date"}),
one `<case-id>/report.json` (report-v1, optionally .gz) per case and, for the council
arm, the members' stored answers `<case-id>/council/<finding-id>/<role>-r1.json` as the
Worker writes them (`{"assessment": {...}}` or `{"abstained": cause}`). OUTCOMES.json
is {"schema": "rio-council-outcomes-v1", "case_set", "cases": {case: {finding: "real" |
"not_real"}}}; its findings are the plausible bucket.

Decisions per arm: a council decision when the council decided; otherwise the evidence
level, `reproduced` or `static_proven` as promoted, `plausible` as plausible; a finding
absent from the report counts as refuted only when the report's `agent_audit.refuted_ids`
records its refutation; otherwise (held back by a cap, or an incomplete review) it is
unassessed and never correct.
Accuracy is the share of promoted-and-real plus refuted-and-not-real decisions; both
arms must cover the same case set on the same day, or the comparison is refused.

Disagreement counts councilled findings with at least two round-1 answers whose
members differ on `real` or `introduced_by_change`; basis disagreement (members differ
on `basis`) is reported separately, so wording and judgment stay distinguishable.

Weights: per member (`rio/council-<role>`) and finding category, the precision and
recall of the member's `real: yes` answers on councilled findings with a known outcome
(the outcomes files, else author responses: fixed and intentional are real, wrong is
not), weight = 2 × F1. Fewer than 30 cases leave the weight null and the Worker keeps
the manifest weight. Weights order experiments and the council note only.
Exit codes: 0 done, 2 usage or input error.
"""
import argparse
from collections import defaultdict
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import evaluate as e  # noqa: E402

SUMMARY_SCHEMA = e.SCHEMA / 'council-summary-v1.json'
WEIGHTS = e.ROOT / 'modules/members/weights.json'
ROLES = ('skeptic', 'exploit-author', 'code-owner', 'maintainer', 'tester')
WEIGHT_FLOOR = 30
OUTCOMES = ('real', 'not_real')


def read_run(directory):
    directory = Path(directory)
    manifest = e.read_json(directory / 'run.json')
    for key in ('arm', 'case_set', 'date'):
        if not isinstance(manifest.get(key), str) or not manifest[key]:
            raise ValueError(f'{directory}/run.json: missing {key}')
    reports = {}
    for case in sorted(p for p in directory.iterdir() if p.is_dir()):
        for name in ('report.json', 'report.json.gz'):
            if (case / name).is_file():
                report = e.read_json(case / name)
                e.validate(report, e.ROOT / 'schemas/report-v1.json', label=str(case / name))
                reports[case.name] = report
    return manifest, reports


def read_outcomes(path):
    doc = e.read_json(path)
    if doc.get('schema') != 'rio-council-outcomes-v1' or not isinstance(doc.get('cases'), dict):
        raise ValueError(f'{path}: expected a rio-council-outcomes-v1 document')
    for case, findings in doc['cases'].items():
        for finding, outcome in findings.items():
            if outcome not in OUTCOMES:
                raise ValueError(f'{path}: {case}/{finding}: outcome must be real or not_real')
    return doc


def findings_of(report):
    """Findings by id, including each instance of a class finding under its own id,
    so a merged class is never mistaken for refuted instances."""
    council = report.get('council') or {}
    found = {}
    for f in (report.get('findings', []) + report.get('risks', []) + report.get('security', [])
              + report.get('remembered', []) + council.get('refuted', [])
              + council.get('held', [])):
        found[f['id']] = f
        for location in f.get('locations', []):
            if location.get('id'):
                found.setdefault(location['id'], f)
    return found


def decision(finding):
    if finding is None:
        return 'refuted'
    council = finding.get('council')
    # A plausible council decision keeps the verifier's level (design D7), so
    # only a reproduction or refutation by the council overrides it.
    if council and not council.get('skipped') and council.get('decision') in ('reproduced', 'refuted'):
        return {'reproduced': 'promoted'}.get(council['decision'], council['decision'])
    level = finding['evidence_level']
    return 'promoted' if level in ('reproduced', 'static_proven') else level


def arm_accuracy(reports, outcomes):
    row = {'cases': 0, 'correct': 0, 'promoted': 0, 'promoted_correctly': 0, 'refuted': 0,
           'refuted_correctly': 0, 'accuracy': None}
    for case, expected in sorted(outcomes['cases'].items()):
        report = reports.get(case, {})
        found = findings_of(report)
        # A finding absent from the report counts as refuted only when the
        # review recorded its refutation; one held back by a presentation cap,
        # or missing from an incomplete review, is unassessed and never correct.
        refuted = set((report.get('agent_audit') or {}).get('refuted_ids', []))
        for finding, outcome in sorted(expected.items()):
            present = found.get(finding)
            made = (decision(present) if present is not None
                    else 'refuted' if finding in refuted else 'unassessed')
            row['cases'] += 1
            if made == 'promoted':
                row['promoted'] += 1
                row['promoted_correctly'] += outcome == 'real'
            elif made == 'refuted':
                row['refuted'] += 1
                row['refuted_correctly'] += outcome == 'not_real'
    row['correct'] = row['promoted_correctly'] + row['refuted_correctly']
    row['accuracy'] = row['correct'] / row['cases'] if row['cases'] else None
    return row


def answers(run_dir, case, finding):
    """Round-1 assessments of the members that answered."""
    folder = Path(run_dir) / case / 'council' / finding
    result = {}
    for role in ROLES:
        path = folder / f'{role}-r1.json'
        if path.is_file():
            stored = e.read_json(path)
            if 'assessment' in stored:
                result[role] = stored['assessment']
    return result


def unique_findings(report):
    """Each finding once, whatever ids it is indexed under."""
    seen, result = set(), []
    for f in findings_of(report).values():
        if f['id'] not in seen:
            seen.add(f['id'])
            result.append(f)
    return sorted(result, key=lambda f: f['id'])


def disagreement(run_dir, reports):
    row = {'councilled': 0, 'disagreeing': 0, 'basis_disagreeing': 0}
    for case, report in sorted(reports.items()):
        for finding in unique_findings(report):
            if not finding.get('council'):
                continue
            given = answers(run_dir, case, finding['id'])
            if len(given) < 2:
                continue
            row['councilled'] += 1
            if any(len({a[k] for a in given.values()}) > 1 for k in ('real', 'introduced_by_change')):
                row['disagreeing'] += 1
            if len({a['basis'] for a in given.values()}) > 1:
                row['basis_disagreeing'] += 1
    total = row['councilled']
    row['rate'] = row['disagreeing'] / total if total else None
    row['basis_rate'] = row['basis_disagreeing'] / total if total else None
    return row


def add_cost(into, cost):
    for key in ('members', 'rounds', 'experiments', 'runner_seconds'):
        into[key] += cost[key]
    for vendor, n in cost['tokens'].items():
        into['tokens'][vendor] = into['tokens'].get(vendor, 0) + n


def empty_cost():
    return {'members': 0, 'rounds': 0, 'experiments': 0, 'tokens': {}, 'runner_seconds': 0}


def cost(reports):
    per_finding, per_review, total = [], [], empty_cost()
    for case, report in sorted(reports.items()):
        council = report.get('council')
        if not council:
            continue
        for row in council['findings']:
            per_finding.append({'case': case, 'finding': row['id'], 'status': row['status'], 'cost': row['cost']})
        per_review.append({'case': case, 'total': council['total']})
        add_cost(total, council['total'])
    tokens = sum(n for row in per_finding for n in row['cost']['tokens'].values())
    return {'per_finding': per_finding, 'per_review': per_review, 'total': total,
            'mean_tokens_per_finding': tokens / len(per_finding) if per_finding else None}


def check_arms(outcomes, council, baseline):
    """Refuse a comparison across case sets, days or arms, naming the mismatch."""
    (cm, creports), (bm, breports) = council, baseline
    if cm['arm'] != 'council' or bm['arm'] != 'verifier-only':
        raise ValueError(f'arms are {cm["arm"]!r} and {bm["arm"]!r}; expected council and verifier-only')
    if cm['case_set'] != bm['case_set'] or cm['case_set'] != outcomes['case_set']:
        raise ValueError(f'case sets differ: council {cm["case_set"]!r}, verifier-only {bm["case_set"]!r}, '
                         f'outcomes {outcomes["case_set"]!r}')
    if cm['date'] != bm['date']:
        raise ValueError(f'arms ran on different days: council {cm["date"]}, verifier-only {bm["date"]}')
    expected = set(outcomes['cases'])
    for name, reports in (('council', creports), ('verifier-only', breports)):
        missing, extra = sorted(expected - set(reports)), sorted(set(reports) - expected)
        if missing or extra:
            raise ValueError(f'{name} arm case set differs: missing {missing or "none"}, extra {extra or "none"}')


def summarize(outcomes_path, council_dir, baseline_dir, weights_path=WEIGHTS):
    outcomes = read_outcomes(outcomes_path)
    council, baseline = read_run(council_dir), read_run(baseline_dir)
    check_arms(outcomes, council, baseline)
    arms = {'council': arm_accuracy(council[1], outcomes), 'verifier_only': arm_accuracy(baseline[1], outcomes)}
    a, b = arms['council']['accuracy'], arms['verifier_only']['accuracy']
    weights = e.read_json(weights_path) if Path(weights_path).is_file() else {}
    summary = {'schema': 'rio-eval-council-v1', 'case_set': outcomes['case_set'], 'date': council[0]['date'],
               'disagreement': disagreement(council_dir, council[1]),
               'accuracy': {**arms, 'difference': None if a is None or b is None else a - b},
               'cost': cost(council[1]), 'weights': weights}
    # An invalid or incomplete summary fails the run.
    e.validate(summary, SUMMARY_SCHEMA)
    return summary


def known_outcome(finding, outcomes, case):
    for doc in outcomes:
        if finding['id'] in doc['cases'].get(case, {}):
            return doc['cases'][case][finding['id']]
    response = (finding.get('author_response') or {}).get('reason')
    return {'fixed': 'real', 'intentional': 'real', 'wrong': 'not_real'}.get(response)


def estimate(run_dirs, outcome_paths=()):
    outcomes = [read_outcomes(p) for p in outcome_paths]
    counts = defaultdict(lambda: defaultdict(lambda: {'tp': 0, 'fp': 0, 'fn': 0, 'samples': 0}))
    for run_dir in run_dirs:
        _, reports = read_run(run_dir)
        for case, report in sorted(reports.items()):
            for finding in unique_findings(report):
                outcome = known_outcome(finding, outcomes, case) if finding.get('council') else None
                if outcome is None:
                    continue
                for role, assessment in answers(run_dir, case, finding['id']).items():
                    # The category the Worker looked weights up under.
                    category = finding['council'].get('weight_category', finding['category'])
                    row = counts[f'rio/council-{role}'][category]
                    row['samples'] += 1
                    said_real = assessment['real'] == 'yes'
                    row['tp'] += said_real and outcome == 'real'
                    row['fp'] += said_real and outcome == 'not_real'
                    row['fn'] += not said_real and outcome == 'real'
    weights = {}
    for member in sorted(counts):
        weights[member] = {}
        for category in sorted(counts[member]):
            row = counts[member][category]
            precision = row['tp'] / (row['tp'] + row['fp']) if row['tp'] + row['fp'] else None
            recall = row['tp'] / (row['tp'] + row['fn']) if row['tp'] + row['fn'] else None
            f1 = (2 * precision * recall / (precision + recall)
                  if precision and recall else 0.0)
            weights[member][category] = {
                'weight': round(max(2 * f1, 0.05), 4) if row['samples'] >= WEIGHT_FLOOR else None,
                'samples': row['samples'],
                'precision': None if precision is None else round(precision, 4),
                'recall': None if recall is None else round(recall, 4)}
    return weights


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('summarize')
    p.add_argument('--outcomes', required=True)
    p.add_argument('--council', required=True, help='council arm run directory')
    p.add_argument('--baseline', required=True, help='verifier-only arm run directory')
    p.add_argument('--weights', default=str(WEIGHTS))
    p.add_argument('--out', required=True)
    p = sub.add_parser('weights')
    p.add_argument('--runs', nargs='+', required=True)
    p.add_argument('--outcomes', nargs='*', default=[])
    p.add_argument('--out', required=True)
    args = parser.parse_args(argv)
    try:
        if args.command == 'summarize':
            summary = summarize(args.outcomes, args.council, args.baseline, args.weights)
            e.write_json(args.out, summary)
            acc = summary['accuracy']
            print(f'Council {acc["council"]["correct"]}/{acc["council"]["cases"]} vs verifier-only '
                  f'{acc["verifier_only"]["correct"]}/{acc["verifier_only"]["cases"]}; disagreement '
                  f'{summary["disagreement"]["disagreeing"]}/{summary["disagreement"]["councilled"]}')
        else:
            e.write_json(args.out, estimate(args.runs, args.outcomes))
            print(f'Weights written to {args.out}')
    except (ValueError, KeyError, OSError) as error:
        print(f'council error: {error}', file=sys.stderr)
        return 2
    return 0


if __name__ == '__main__':
    sys.exit(main())

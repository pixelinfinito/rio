#!/usr/bin/env python3
"""Aggregate author responses and rounds_to_pass from lineage reports, per repository.

Usage: python3 -I eval/convergence.py summarize REPORT.json [REPORT.json ...]
           [--repository NAME] --out SUMMARY.json

Inputs are Rio report-v1 JSON files (optionally .gz) of lineage reviews. A finding
identity is counted once per lineage generation, using its copy from the latest
round, so a response is not counted again on every push. Per repository:

* author_response_ratio = fixed / (fixed + wrong + intentional + irrelevant + style)
  over findings with an author_response (null when none responded);
* wrong per producing agent and evidence level (the false-positive signal);
* intentional per agent (intent calibration);
* irrelevant and style per rule and per category (posture and category floor);
* rounds_to_pass per lineage generation and its distribution.

No per-user aggregation exists: `actor` is never read. Suppressions suggested by
these counts still need approval through the normal profile review.
"""
import argparse
from collections import Counter, defaultdict
from pathlib import Path
import statistics
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import evaluate as e  # noqa: E402

REASONS = ('fixed', 'wrong', 'intentional', 'irrelevant', 'style')
SUMMARY_SCHEMA = e.SCHEMA / 'convergence-summary-v1.json'


def producer(finding):
    source = finding.get('source', {})
    return source.get('agent') or f'tool:{source.get("tool", "unknown")}'


def ratio(responses):
    total = sum(responses[r] for r in REASONS)
    return responses['fixed'] / total if total else None


def collect(reports, default_repository=None):
    """Latest copy of each finding per lineage generation, and per-lineage round history."""
    findings, lineages, skipped = {}, {}, []
    for index, (report, path) in enumerate(reports):
        lineage = report.get('lineage')
        repository = lineage['repository'] if lineage else default_repository
        if repository is None:
            skipped.append(str(path))
            continue
        key = ((lineage['kind'], lineage['ref'], lineage['generation']) if lineage else ('none', str(path), 0))
        round_ = lineage['round'] if lineage else 0
        if lineage:
            state = lineages.setdefault((repository, key), {'rounds': {}, 'rounds_to_pass': None})
            state['rounds'][round_] = lineage['rounds_to_pass']
        for f in report.get('findings', []) + report.get('risks', []) + report.get('security', []):
            ident = (repository, key, f['id'])
            if ident not in findings or (round_, index) >= findings[ident][0]:
                findings[ident] = ((round_, index), f)
    return {k: f for k, (_, f) in findings.items()}, lineages, skipped


def summarize(reports, default_repository=None):
    for report, path in reports:
        e.validate(report, e.ROOT / 'schemas/report-v1.json', label=str(path))
    findings, lineages, skipped = collect(reports, default_repository)
    repos = sorted({k[0] for k in findings} | {k[0] for k in lineages})
    by_repo = {}
    for repo in repos:
        responses = Counter()
        wrong = defaultdict(Counter)
        intentional = Counter()
        by_rule = defaultdict(Counter)
        by_category = defaultdict(Counter)
        posted = 0
        for (r, _, _), f in findings.items():
            if r != repo:
                continue
            posted += 1
            response = f.get('author_response')
            if not response:
                continue
            reason = response['reason']
            responses[reason] += 1
            if reason == 'wrong':
                wrong[producer(f)][f['evidence_level']] += 1
            elif reason == 'intentional':
                intentional[producer(f)] += 1
            elif reason in ('irrelevant', 'style'):
                by_rule[f['rule_id']][reason] += 1
                by_category[f['category']][reason] += 1
        lineage_rows = []
        for (r, (kind, ref, generation)), state in sorted(lineages.items(), key=lambda x: str(x[0])):
            if r != repo:
                continue
            converged = [state['rounds'][n] for n in sorted(state['rounds']) if state['rounds'][n] is not None]
            lineage_rows.append({'kind': kind, 'ref': ref, 'generation': generation,
                                 'last_round': max(state['rounds']),
                                 'rounds_to_pass': converged[0] if converged else None})
        values = [row['rounds_to_pass'] for row in lineage_rows if row['rounds_to_pass'] is not None]
        by_repo[repo] = {
            'findings': posted, 'responded': sum(responses.values()),
            'responses': {r: responses[r] for r in REASONS}, 'author_response_ratio': ratio(responses),
            'wrong_by_agent_evidence': {a: dict(sorted(c.items())) for a, c in sorted(wrong.items())},
            'intentional_by_agent': dict(sorted(intentional.items())),
            'irrelevant_style_by_rule': {k: {'irrelevant': c['irrelevant'], 'style': c['style']}
                                         for k, c in sorted(by_rule.items())},
            'irrelevant_style_by_category': {k: {'irrelevant': c['irrelevant'], 'style': c['style']}
                                             for k, c in sorted(by_category.items())},
            'rounds_to_pass': {
                'lineages': len(lineage_rows), 'converged': len(values), 'open': len(lineage_rows) - len(values),
                'mean': statistics.fmean(values) if values else None,
                'median': statistics.median(values) if values else None,
                'max': max(values) if values else None,
                'distribution': {str(k): v for k, v in sorted(Counter(values).items())},
                'by_lineage': lineage_rows}}
    total = Counter()
    for row in by_repo.values():
        total.update(row['responses'])
    summary = {'schema': 'rio-eval-convergence-v1', 'reports': [str(p) for _, p in reports],
               'skipped_reports': skipped, 'by_repository': by_repo,
               'overall': {'responded': sum(total.values()), 'responses': {r: total[r] for r in REASONS},
                           'author_response_ratio': ratio(total)},
               'notes': ['Each finding identity counts once per lineage generation (latest round).',
                         'No per-user aggregation; suppressions proposed from these counts require approval.']}
    e.validate(summary, SUMMARY_SCHEMA)
    return summary


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('summarize')
    p.add_argument('reports', nargs='+')
    p.add_argument('--repository', help='repository for reports without a lineage (otherwise skipped)')
    p.add_argument('--out', required=True)
    args = parser.parse_args(argv)
    summary = summarize([(e.read_json(p), p) for p in args.reports], args.repository)
    e.write_json(args.out, summary)
    for repo, row in summary['by_repository'].items():
        print(f'{repo}: author-response ratio {row["author_response_ratio"]}, '
              f'rounds_to_pass median {row["rounds_to_pass"]["median"]}')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError) as error:
        sys.exit(f'convergence error: {error}')

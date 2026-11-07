#!/usr/bin/env python3
"""Per-agent reference set for the v0.3 contracts and security agents.

  skeleton   write one verdicts file per case for independent adjudication:
             python3 -I eval/agents.py skeleton MANIFEST.json
  summarize  per-agent precision, control detection and cost from the run:
             python3 -I eval/agents.py summarize MANIFEST.json --out SUMMARY.json [--markdown OUT.md]

MANIFEST.json (schema rio-agent-reference-v1) lists each case with paths relative to
the manifest's directory: `report` (Rio report-v1 from the live run), `audit`
(endpoint audit with usage and cost), `verdicts` (eval/README.md verdicts format) and,
for positive cases, `case` (an eval/cases file whose expectations name the agent).

Verdict skeletons name no reviewer and record no verdict; adjudication belongs to an
independent reviewer. A case counts toward precision only when its verdicts file is
complete (a reviewer and a verdict class for every finding); its findings then go
through eval/evaluate.py records, and precision per agent is their per-agent view
over every adjudicated case, whether or not its deterministic checks were eligible. Until then the summary reports the case's findings as pending and
precision as null. Control detection needs no verdict: a positive case's control is
detected when a finding of the expected agent matches the expectation (eval/cases.py).
"""
import argparse
from collections import Counter, defaultdict
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cases as c  # noqa: E402
import evaluate as e  # noqa: E402

SCHEMA = 'rio-agent-reference-v1'
REVIEWER_TODO = 'TODO: independent reviewer (owner); no verdict recorded'
FAILED = ('partial', 'error')
MECHANISM = {'contracts': 'contract-break', 'security': 'security-vulnerability'}


def load(manifest_path):
    manifest = e.read_json(manifest_path)
    if manifest.get('schema') != SCHEMA:
        raise ValueError(f'{manifest_path}: expected a {SCHEMA} manifest')
    root = Path(manifest_path).parent
    rows = []
    for item in manifest['cases']:
        if item['kind'] not in ('positive', 'clean'):
            raise ValueError(f'{item["id"]}: kind must be positive or clean')
        if (item['kind'] == 'positive') != bool(item.get('case')):
            raise ValueError(f'{item["id"]}: positive cases, and only they, name an eval case')
        rows.append({**item, 'root': root})
    return manifest, rows


def agent_findings(report):
    return [f for f in c.report_findings(report) if 'agent' in f.get('source', {})]


def skeleton(item, report):
    case = e.read_json(item['root'] / item['case']) if item.get('case') else None
    verdicts = e.skeleton(report, item['repository'], item['pr'], item['languages'], item['id'])
    verdicts['reviewer'] = REVIEWER_TODO
    verdicts['notes'] = [f'{item["kind"]} case for the {item["agent"]} agent; verdicts are pending '
                         'independent adjudication.']
    if case:
        verdicts['positive_control'] = {'kind': 'real-pr', 'expected': [
            {'id': f'{item["id"].lower()}-{i + 1}', 'mechanism': MECHANISM[item['agent']],
             'evidence': 'TODO: independent evidence that the defect exists at the pinned head',
             'finding_ids': []} for i in range(len(case['expected']))]}
    return verdicts


def complete(verdicts):
    return (not str(verdicts.get('reviewer', '')).startswith('TODO')
            and all(v.get('verdict') in e.CLASSES for v in verdicts['findings'].values()))


def summarize(rows):
    cost, per_case, records, pending = 0.0, [], [], Counter()
    found, controls = defaultdict(Counter), []
    for item in rows:
        report_path = item['root'] / item['report']
        report = e.read_json(report_path)
        e.validate(report, e.ROOT / 'schemas/report-v1.json', label=str(report_path))
        audit = e.read_json(item['root'] / item['audit']) if item.get('audit') else {'usage': []}
        spent = [u.get('cost_usd') for u in audit.get('usage', [])]
        case_cost = None if any(x is None for x in spent) else round(sum(spent), 6)
        cost = None if cost is None or case_cost is None else cost + case_cost
        findings = agent_findings(report)
        for f in findings:
            found[f['source']['agent']][f['evidence_level']] += 1
        verdicts = e.read_json(item['root'] / item['verdicts'])
        if set(verdicts['findings']) != {f['id'] for f in c.report_findings(report)}:
            raise ValueError(f'{item["id"]}: verdict entries must match the report findings exactly')
        adjudicated = complete(verdicts)
        if adjudicated:
            records.append(e.build_record(report, verdicts, str(report_path)))
        else:
            for f in findings:
                pending[f['source']['agent']] += 1
        row = {'id': item['id'], 'kind': item['kind'], 'agent': item['agent'], 'status': report['status'],
               'agent_findings': len(findings), 'adjudicated': adjudicated, 'cost_usd': case_cost,
               'agents_run': sorted((report.get('agent_audit') or {}).get('agents', {})),
               'security_coverage': bool(report.get('security_coverage'))}
        # A review that did not finish is a product failure, never a missed control.
        row['failed'] = report['status'] in FAILED
        if item.get('case'):
            case = c.validate_case(e.read_json(item['root'] / item['case']))
            matched = c.caught(case, report)
            detected = None if row['failed'] else all(matched)
            controls.append({'id': item['id'], 'agent': item['agent'], 'detected': detected,
                             'finding_ids': matched})
            row['control_detected'] = detected
        per_case.append(row)
    # Agent verdicts do not depend on the deterministic-check environment (hosted
    # runners skip tools a project needs), so every adjudicated case counts.
    adjudicated_metrics = e.agent_metrics(records)
    agents = {}
    for agent in sorted(set(found) | set(adjudicated_metrics) | {'contracts', 'security'}):
        metrics = adjudicated_metrics.get(agent)
        agents[agent] = {'findings': sum(found[agent].values()),
                         'by_evidence_level': dict(sorted(found[agent].items())),
                         'pending_adjudication': pending[agent],
                         'counts': metrics['counts'] if metrics else None,
                         'precision': metrics['precision'] if metrics else None,
                         'controls': sum(1 for x in controls if x['agent'] == agent and x['detected'] is not None),
                         'controls_detected': sum(1 for x in controls if x['agent'] == agent and x['detected']),
                         'controls_failed': sum(1 for x in controls if x['agent'] == agent and x['detected'] is None)}
    awaiting = sorted(r['id'] for r in per_case if not r['adjudicated'])
    failed = sorted(r['id'] for r in per_case if r['failed'])
    return {'schema': 'rio-agent-reference-summary-v1', 'cases': per_case, 'agents': agents, 'failed_cases': failed,
            'controls': controls, 'cost_usd': None if cost is None else round(cost, 4),
            'adjudicated_cases': len(per_case) - len(awaiting), 'awaiting_adjudication': awaiting,
            'precision_final': not awaiting,
            'note': ('Precision is computed only over independently adjudicated cases; '
                     + ('every case is adjudicated.' if not awaiting else
                        f'{len(awaiting)} case(s) await adjudication, so precision is not yet measured.'))}


def markdown(summary):
    fmt = lambda x: 'pending' if x is None else f'{x:.3f}'  # noqa: E731
    lines = ['| Agent | Findings | Pending adjudication | True positives | False positives | Precision | '
             'Controls detected | Controls not scored (review failed) |',
             '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |']
    for agent, row in summary['agents'].items():
        counts = row['counts'] or {}
        lines.append(f'| {agent} | {row["findings"]} | {row["pending_adjudication"]} | '
                     f'{counts.get("true-positive", "–")} | {counts.get("false-positive", "–")} | '
                     f'{fmt(row["precision"])} | {row["controls_detected"]}/{row["controls"]} | '
                     f'{row["controls_failed"]} |')
    lines += ['', '| Case | Kind | Agent | Status | Agent findings | Control detected | Cost (USD) | Adjudicated |',
              '| --- | --- | --- | --- | ---: | --- | ---: | --- |']
    for row in summary['cases']:
        detected = ('review failed' if row['failed'] and row['kind'] == 'positive'
                    else {True: 'yes', False: 'no'}.get(row.get('control_detected'), '–'))
        spent = '–' if row['cost_usd'] is None else f'{row["cost_usd"]:.2f}'
        lines.append(f'| {row["id"]} | {row["kind"]} | {row["agent"]} | {row["status"]} | '
                     f'{row["agent_findings"]} | {detected} | {spent} | {"yes" if row["adjudicated"] else "no"} |')
    total = 'unknown' if summary['cost_usd'] is None else f'USD {summary["cost_usd"]:.2f}'
    lines += ['', f'Total provider cost: {total}. {summary["note"]}', '']
    return '\n'.join(lines)


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('skeleton')
    p.add_argument('manifest')
    p.add_argument('--force', action='store_true', help='overwrite existing verdicts files')
    p = sub.add_parser('summarize')
    p.add_argument('manifest')
    p.add_argument('--out', required=True)
    p.add_argument('--markdown')
    args = parser.parse_args(argv)
    try:
        _, rows = load(args.manifest)
        if args.command == 'skeleton':
            for item in rows:
                path = item['root'] / item['verdicts']
                if path.exists() and not args.force:
                    print(f'{item["id"]}: kept {path}')
                    continue
                e.write_json(path, skeleton(item, e.read_json(item['root'] / item['report'])))
                print(f'{item["id"]}: wrote {path}')
            return 0
        summary = summarize(rows)
    except (ValueError, KeyError, OSError) as error:
        print(f'agents error: {error}', file=sys.stderr)
        return 2
    e.write_json(args.out, summary)
    if args.markdown:
        Path(args.markdown).write_text(markdown(summary))
    print(f'{len(summary["cases"])} cases; {summary["note"]}')
    return 0


if __name__ == '__main__':
    sys.exit(main())

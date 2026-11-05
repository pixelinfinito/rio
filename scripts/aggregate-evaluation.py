#!/usr/bin/env python3
"""Normalize independent automated PR records without changing their verdicts."""
import argparse
from collections import Counter
from datetime import date
import json
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--conclusion', choices=['go', 'no-go'], required=True)
parser.add_argument('--reviewer', required=True)
parser.add_argument('--reason', required=True)
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
directory = root / 'docs/evaluation'
records = []
for name in ['agent-typescript.json', 'agent-python.json', 'agent-third.json', 'agent-rust.json']:
    source = json.loads((directory / name).read_text())
    for original in source['pull_requests']:
        pr = dict(original)
        pr['pr'] = pr.get('pr', pr.get('url'))
        pr['verdict'] = pr.get('verdict', pr.get('usefulness_verdict'))
        pr['reason'] = pr.get('reason', pr.get('usefulness_reason'))
        pr['misses'] = pr.get('misses', pr.get('missed_issues', []))
        pr['evidence_record'] = name
        records.append({key: pr[key] for key in [
            'repository', 'pr', 'title', 'languages', 'mode', 'review_id', 'wall_time_ms',
            'status', 'findings', 'misses', 'verdict', 'reason', 'reviewer', 'verdict_source',
            'checks', 'limitations', 'evidence_record',
        ] if key in pr})
record = {
    'schema': 'rio-automated-acceptance-v1', 'verdict_source': 'automated',
    'date': date.today().isoformat(), 'human_verdicts': False, 'pull_requests': records,
    'conclusion': args.conclusion, 'conclusion_reviewer': args.reviewer,
    'conclusion_verdict_source': 'automated', 'conclusion_reason': args.reason,
}
(directory / 'v0.1.json').write_text(json.dumps(record, indent=2) + '\n')

def cell(value):
    return str(value).replace('|', '\\|').replace('\n', ' ')

lines = [
    '# Rio v0.1 automated acceptance evaluation', '',
    '**All verdicts are automated independent sub-agent assessments. No human verdicts are claimed.**', '',
    'The user approved automated verdicts for this acceptance gate. These are real upstream pull requests, not seeded fixture PRs. Each reviewer inspected the PR and executed independent upstream tests or reproductions in addition to Rio. Raw reports, exact commits, setup details, and limitations are preserved in the linked agent records.', '',
    f'**Conclusion: {args.conclusion}.** {args.reason}', '',
    f'Conclusion reviewer: {args.reviewer} (automated).', '',
    '| Repository / PR | Review ID | Wall time | Automated verdict |',
    '| --- | --- | ---: | --- |',
]
for pr in records:
    lines.append(f'| [{pr["repository"]} #{pr["pr"].rsplit("/", 1)[-1]}]({pr["pr"]}) | `{pr["review_id"]}` | {pr["wall_time_ms"] / 1000:.3f}s | {pr["verdict"]} |')
lines += ['', 'The evaluation is offline: dependency auditing is explicitly skipped. Dependency trust, unavailable compatible metadata, existing tool diagnostics, and missing optional extras are reported individually below and in the raw records. Remediated prior-binary observations remain evidence of the evaluation process; they are not presented as current-binary defects.', '']
for index, pr in enumerate(records, 1):
    counts = Counter(f['verdict'] for f in pr['findings'])
    lines += [f'## {index}. {pr["repository"]} #{pr["pr"].rsplit("/", 1)[-1]}', '',
              f'[{pr["title"]}]({pr["pr"]}) · mode `{pr["mode"]}` · review `{pr["review_id"]}` · {pr["wall_time_ms"] / 1000:.3f}s · status `{pr["status"]}`.', '',
              f'Reviewer: {pr["reviewer"]}; verdict source: **automated**.', '',
              f'**{pr["verdict"]}:** {pr["reason"]}', '',
              f'Complete evidence: [{pr["evidence_record"]}]({pr["evidence_record"]}). Finding verdicts: {dict(counts)}.', '']
    if pr.get('limitations'):
        limitations = pr['limitations']
        if isinstance(limitations, list):
            lines += [f'- {cell(item)}' for item in limitations] + ['']
        else:
            lines += [cell(limitations), '']
    lines += ['### Findings', '']
    if pr['findings']:
        lines += ['| Finding ID | Automated verdict | Reason |', '| --- | --- | --- |']
        for finding in pr['findings']:
            lines.append(f'| `{finding["id"]}` | {finding["verdict"]} | {cell(finding["reason"])} |')
        lines.append('')
    else:
        lines += ['No findings; independently reviewed.', '']
    lines += ['### Independently reported misses', '']
    if pr['misses']:
        for missed in pr['misses']:
            lines += ['```json', json.dumps(missed, indent=2), '```', '']
    else:
        lines += ['No independently established missed issue. This does not establish absence of defects.', '']
(directory / 'v0.1.md').write_text('\n'.join(lines))
print(f'Wrote {len(records)} real PR records from {len(set(p["repository"] for p in records))} repositories; conclusion {args.conclusion}.')

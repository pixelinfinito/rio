#!/usr/bin/env python3
"""Validate automated acceptance evidence before permitting a stable release."""
import argparse
import json
from pathlib import Path
import sys
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--record-only', action='store_true', help='validate complete evidence, accepting a no-go conclusion')
args = parser.parse_args()
root = Path(__file__).resolve().parents[1]
path = root / 'docs/evaluation/v0.1.json'
if not path.exists():
    sys.exit('Stable release blocked: docs/evaluation/v0.1.json has no automated acceptance record')
record = json.loads(path.read_text())
prs = record.get('pull_requests', [])
errors = []
if len({pr.get('pr') for pr in prs}) < 10: errors.append('at least ten complete PR records required')
if len({pr.get('repository') for pr in prs}) < 3: errors.append('at least three repositories required')
if not {'typescript', 'python', 'rust'} <= {language for pr in prs for language in pr.get('languages', [])}: errors.append('TypeScript, Python and Rust required')
if not any(pr.get('repository') == 'pixelinfinito/rio' and 'rust' in pr.get('languages', []) for pr in prs): errors.append('Rio itself must be a Rust acceptance source')
for index, pr in enumerate(prs):
    for key in ['repository', 'pr', 'mode', 'review_id', 'wall_time_ms', 'findings', 'misses', 'verdict', 'reason', 'reviewer']:
        if key not in pr or pr[key] is None or pr[key] == '': errors.append(f'PR {index + 1}: missing {key}')
    if pr.get('verdict_source') != 'automated': errors.append(f'PR {index + 1}: verdict_source must be automated')
    if pr.get('verdict') not in ['useful', 'not-useful']: errors.append(f'PR {index + 1}: automated usefulness verdict required')
    for finding in pr.get('findings', []):
        if finding.get('verdict') not in ['true-positive', 'false-positive', 'noise'] or not all(finding.get(key) for key in ['id', 'reviewer', 'reason']): errors.append(f'PR {index + 1}: every finding needs an automated verdict/reviewer/reason')
if record.get('conclusion') not in ['go', 'no-go']: errors.append('an explicit go/no-go conclusion is required')
if not args.record_only and record.get('conclusion') != 'go': errors.append('Stable release blocked: the automated acceptance conclusion is no-go')
if not record.get('conclusion_reviewer') or not record.get('conclusion_reason'): errors.append('conclusion must name an independent reviewer and reason')
if not (root / 'docs/evaluation/v0.1.md').exists(): errors.append('readable Markdown evaluation required')
if errors: sys.exit('\n'.join(errors))
print('Automated acceptance record complete' + (': stable release gate passed' if not args.record_only else ': ' + record['conclusion']))

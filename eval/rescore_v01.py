#!/usr/bin/env python3
"""Reclassify preserved v0.1 evidence, without rerunning Rio or rewriting history."""
from collections import defaultdict
from pathlib import Path
import re

import evaluate as e

DIRECTORY = e.ROOT / 'docs/evaluation'
DESTINATION = DIRECTORY / 'v0.1-rescored'


def template(message):
    """Parameterize diagnostic payloads only for these proven shared setup causes.

    This historical override is NOT the harness default. Old adjudications identify
    all these diagnostics as the same target/configuration problem. Preserve the
    grammatical message shape and rule; retain the untouched diagnostic in evidence.
    """
    message = re.sub(r'"[^"\n]*"|\'[^\'\n]*\'|`[^`\n]*`', '{parameter}', message)
    return ' '.join(re.sub(r'\b\d+\b', '{number}', message).split())


def rescore():
    records, paths = [], []
    for source_name, folder, family in [
        ('agent-typescript.json', 'typescript', 'immer-installation-and-test-tsconfig'),
        ('agent-python.json', 'python', 'pydantic-mypy-target-scope'),
        ('agent-third.json', 'structlog', 'structlog-unpinned-tools-and-existing-diagnostics')]:
        source = e.read_json(DIRECTORY / source_name)
        for old in source['pull_requests']:
            pr = old.get('pr', old.get('url'))
            number = pr.rsplit('/', 1)[-1]
            if folder == 'typescript':
                raw_path = DIRECTORY / 'evidence' / folder / f'pr-{number}-report.json'
            elif folder == 'python':
                raw_path = DIRECTORY / 'evidence' / folder / f'{number}-final-report.json.gz'
            else:
                raw_path = DIRECTORY / 'evidence' / folder / f'pr-{number}-trusted.json'
            raw = e.read_json(raw_path)
            annotations = {}
            raw_by_id = {f['id']: f for f in raw['findings'] + raw['risks']}
            if set(raw_by_id) != {f['id'] for f in old['findings']}:
                raise ValueError(f'{pr}: historical verdict/report IDs differ')
            # Shared file sets are explicit adjudication overrides. They merge only
            # identical rules/templates within one evidenced setup failure per PR.
            file_sets = defaultdict(set)
            for old_f in old['findings']:
                f = raw_by_id[old_f['id']]
                file_sets[(f['rule_id'], template(f['message']))].update(
                    p['path'] for p in [f['location'], *f['locations']])
            for old_f in old['findings']:
                f = raw_by_id[old_f['id']]
                if old_f['verdict'] not in ('noise', 'false-positive'):
                    raise ValueError('unexpected legacy verdict; review mapping')
                verdict = 'pre-existing-shown' if old_f['verdict'] == 'noise' else 'false-positive'
                annotations[f['id']] = {
                    'verdict': verdict,
                    'reason': old_f['reason'] + ' Historical rescoring groups parameterized '
                    'messages with the same rule across the evidenced shared configuration/file '
                    'set; original diagnostic and original adjudication are preserved.',
                    'message_template': template(f['message']),
                    'file_set': sorted(file_sets[(f['rule_id'], template(f['message']))]),
                    'family': 'secret-heuristic-false-alerts' if verdict == 'false-positive' else family}
            misses = []
            for miss in old.get('misses', old.get('missed_issues', [])):
                misses.append({'id': miss['id'], 'scope_class': 'agent-layer',
                               'description': miss.get('description', miss.get('reason', miss.get('title'))),
                               'evidence': f'{source_name}, PR {pr}, original miss {miss["id"]}: '
                               'independent base/head semantic reproduction; no type/lint/coverage/secret/'
                               'dependency oracle establishes deterministic detectability.'})
            notes = [f'Historical evidence: docs/evaluation/{source_name}; '
                     'original automated adjudications reused, not a fresh PR execution or human assessment.',
                     'Message-template override parameterizes quoted payloads and numeric positions; '
                     'file sets union only the same rule/template within the documented shared setup '
                     'cause. These are rubric keys; explanatory families may span several keys.',
                     f'Original verdict: {old.get("verdict", old.get("usefulness_verdict"))}. '
                     f'Original external wall time: {old["wall_time_ms"]}ms; normalized wall time comes from Rio metrics.']
            if folder == 'python':
                notes.append('Old outside-target adjudications establish unwanted test diagnostics; '
                             'this rescoring does not independently re-prove every diagnostic on base. '
                             'Trust prevented Rio from classifying them. They cannot become scored false positives.')
            if old.get('remediation_confirmation'):
                notes.append('A later different-binary confirmation removed the two ContextVar alerts. '
                             'That run still lacked a working baseline and is not substituted into this cohort.')
            verdicts = {'repository': old['repository'], 'pr': pr, 'case_id': number,
                        'languages': old['languages'], 'reviewer': old['reviewer'] + ' (legacy evidence; rubric rescoring)',
                        'verdict_source': 'automated', 'commands': [old['command']] if 'command' in old else [],
                        'notes': notes, 'independently_clean': False,
                        'positive_control': {'kind': 'none', 'expected': []},
                        'findings': annotations, 'misses': misses}
            relative_report = raw_path.relative_to(e.ROOT).as_posix()
            record = e.build_record(raw, verdicts, relative_report)
            path = DESTINATION / 'records' / f'{folder}-{number}.json.gz'
            e.write_json(path, record)
            records.append(record)
            paths.append(path.relative_to(e.ROOT).as_posix())
    summary = e.aggregate(records, paths)
    e.write_json(DESTINATION / 'summary.json', summary)
    narrative = (e.ROOT / 'eval/v0.1-rescoring-notes.md').read_text()
    e.render(records, paths, summary, 'v0.1 rescored', DIRECTORY / 'v0.1-rescored.md', narrative)
    print(f'Rescored {len(records)} PRs; {len(summary["environment_failures"])} environment failures; '
          f'{len(summary["agent_layer_backlog"])} agent-layer misses.')
    print('Per-PR causes:', summary['observed_cause_counts'])
    print('Unique repo/cause keys:', summary['observed_unique_cause_counts'])
    print('Families:', sorted({c['family'] for r in records for c in r['root_causes']}))


if __name__ == '__main__':
    rescore()

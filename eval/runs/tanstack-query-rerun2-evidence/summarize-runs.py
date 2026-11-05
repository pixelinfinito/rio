#!/usr/bin/env python3
"""Index every rerun2 capture, including failures without a parseable report."""
from collections import Counter, defaultdict
from datetime import datetime
import gzip
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
RUNS = ROOT / 'eval/runs'


def read(path):
    if path.suffix == '.gz':
        return json.loads(gzip.decompress(path.read_bytes()))
    return json.loads(path.read_text())


def json_path(directory, name):
    path = directory / name
    return path if path.exists() else path.with_suffix(path.suffix + '.gz')


ledger = []
index = []
for directory in sorted(RUNS.glob('tanstack-query-*-rerun2*')):
    if not (directory / 'commands.json').exists():
        continue
    commands = read(directory / 'commands.json')
    item = {'attempt': directory.name, 'binary': 'f6e4f87e4c65',
            'started_utc': commands['started_utc'], 'finished_utc': commands.get('finished_utc'),
            'elapsed_seconds': None, 'command_wall_time_ms': defaultdict(int),
            'capture_failures': commands['failures']}
    if item['finished_utc']:
        item['elapsed_seconds'] = (datetime.fromisoformat(item['finished_utc']) -
                                   datetime.fromisoformat(item['started_utc'])).total_seconds()
    for command in commands['commands']:
        argv = command['argv']
        kind = ('install' if argv[:3] == ['corepack', 'pnpm', 'install'] else
                'review' if 'review' in argv else 'doctor' if 'doctor' in argv else 'other')
        item['command_wall_time_ms'][kind] += command.get('wall_time_ms', 0)
    report_path = json_path(directory, 'report.json')
    record_path = json_path(directory, 'record.json')
    if record_path.exists():
        record = read(record_path)
        report = read(report_path)
        env = record['environment']
        item.update(baseline_ran=env['baseline_ran'],
                    baseline_classification_ran=env['baseline_classification_ran'],
                    dependency_state=env['dependency_state'], eligible=env['eligible'],
                    exclusion_reasons=env['reasons'], rio_metrics_wall_time_ms=record['wall_time_ms'])
        verdicts = read(directory / 'verdicts.json')
        result = {'path': str(record_path.relative_to(ROOT)), 'binary': 'f6e4f87e4c65',
                  'baseline_classification_ran': env['baseline_classification_ran'],
                  'dependency_state': env['dependency_state'], 'eligible': env['eligible'],
                  'overall': record['verdict'],
                  'raw_state_counts': dict(Counter(f['state'] for f in report['findings'] + report['risks'])),
                  'adjudication_counts': dict(Counter(v['verdict'] for v in verdicts['findings'].values())),
                  'raw_counts': dict(Counter(f['verdict'] for f in record['findings'])),
                  'cause_counts': dict(Counter(c['verdict'] for c in record['root_causes'])),
                  'expected': len(record['positive_control']['expected']),
                  'detected': sum(bool(e['finding_ids']) for e in record['positive_control']['expected']),
                  'misses': len(record['misses'])}
        index.append(result)
    else:
        item.update(baseline_ran=False, baseline_classification_ran=False,
                    dependency_state='unavailable', eligible=False,
                    exclusion_reasons=['Capture failed before a parseable Rio report was available; no record can be built.'])
    ledger.append(item)

out = Path(__file__).resolve().parent
(out / 'attempt-ledger.json').write_text(json.dumps(ledger, indent=2) + '\n')
(out / 'result-index.json').write_text(json.dumps(index, indent=2) + '\n')
for name, entries in [('tanstack-query-attempt-ledger.json', ledger), ('tanstack-query-result-index.json', index)]:
    path = RUNS / name
    previous = [item for item in read(path) if item.get('binary') != 'f6e4f87e4c65']
    path.write_text(json.dumps(previous + entries, indent=2) + '\n')
print(json.dumps(index, indent=2))

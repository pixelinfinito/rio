#!/usr/bin/env python3
"""Compare pinned single-voter and quorum runs without treating fixtures as live acceptance."""
import argparse
import hashlib
import json
from collections import Counter
from pathlib import Path


def read(path):
    return json.loads(Path(path).read_text())


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def precision(counts):
    total = counts['true-positive'] + counts['false-positive']
    return counts['true-positive'] / total if total else None


def score_run(run, root):
    report_path = root / run['report']
    audit_path = root / run['audit']
    verdict_path = root / run['verdicts']
    for key, path in [('report_sha256', report_path), ('audit_sha256', audit_path), ('verdicts_sha256', verdict_path)]:
        if digest(path) != run[key]:
            raise ValueError(f'pinned artifact changed: {path}')
    report, audit, verdicts = map(read, [report_path, audit_path, verdict_path])
    if report['status'] != 'complete':
        raise ValueError('only completed reviews can establish acceptance')
    if not verdicts.get('reviewer') or verdicts['reviewer'].startswith('TODO'):
        raise ValueError('independent reviewer identity is required')
    findings = [f for f in report['findings'] + report['risks'] + report.get('security', []) if 'agent' in f['source']]
    if {f['id'] for f in findings} != set(verdicts['findings']):
        raise ValueError('every rendered agent finding requires an independent verdict')
    votes = audit['votes']
    by_level = {level: Counter() for level in ['plausible', 'static_proven', 'reproduced']}
    blind = {bucket: Counter() for bucket in ['same', 'related', 'none']}
    counts = Counter()
    high = set()
    for finding in findings:
        verdict = verdicts['findings'][finding['id']]
        if verdict['verdict'] not in ['true-positive', 'false-positive'] or not verdict.get('evidence'):
            raise ValueError('verdict requires positive/negative classification and artifact-backed evidence')
        key = verdict['verdict']
        counts[key] += 1
        by_level[finding['evidence_level']][key] += 1
        if finding['evidence_level'] != 'plausible':
            ranks = {'refuted': 0, 'plausible': 1, 'static_proven': 2, 'reproduced': 3}
            supported = {v['voter'] for v in votes if v.get('hypothesis_id') == finding['id'] and v['status'] == 'completed'
                         and ranks.get(v.get('validated_level'), 0) >= ranks[finding['evidence_level']] and v.get('answer', {}).get('evidence')}
            required = finding.get('verification', {}).get('agreeing', 1)
            if required < 1 or len(supported) < required:
                raise ValueError('proof-level finding lacks artifact-backed votes')
        for bucket in set(finding.get('verification', {}).get('blind_match', ['none'])):
            blind[bucket][key] += 1
        if key == 'true-positive' and verdict.get('control_id'):
            high.add(verdict['control_id'])
    usage = [u for u in audit['usage'] if u['phase'].startswith('verify')]
    if any(u['status'] != 'completed' for u in usage):
        raise ValueError('incomplete provider usage cannot establish measured acceptance')
    return {
        'counts': dict(counts), 'by_evidence': {k: {**dict(v), 'precision': precision(v)} for k, v in by_level.items()},
        'blind_match': {k: dict(v) for k, v in blind.items()}, 'detected_high_controls': sorted(high),
        'verification_tokens': sum(u['input_tokens'] + u['output_tokens'] for u in usage),
        'verification_cost_usd': None if any(u['cost_usd'] is None for u in usage) else sum(u['cost_usd'] for u in usage),
        'base': report['review']['base'], 'head': report['review']['head'],
    }


def compare(manifest, root):
    if manifest.get('schema') != 'rio-verifier-eval-v1' or not manifest.get('cases'):
        raise ValueError('expected a nonempty pinned verifier manifest')
    cases, ids = [], set()
    total = {'single': Counter(), 'quorum': Counter()}
    controls = {'single': set(), 'quorum': set()}
    has_clean = has_high = False
    for case in manifest['cases']:
        if case['id'] in ids:
            raise ValueError('duplicate reference case')
        ids.add(case['id'])
        if not case.get('generator_model') or not case.get('voter_model') or not case.get('profile_hash'):
            raise ValueError('model identifiers and generator profile hash must be pinned')
        has_clean |= case.get('independently_clean') is True
        expected = set(case['high_controls'])
        has_high |= bool(expected)
        scores = {arm: score_run(case[arm], root) for arm in total}
        if (scores['single']['base'], scores['single']['head']) != (scores['quorum']['base'], scores['quorum']['head']):
            raise ValueError('comparison arms must review identical selected snapshots')
        for arm in total:
            total[arm].update(scores[arm]['counts'])
            found = set(scores[arm]['detected_high_controls'])
            if not found <= expected:
                raise ValueError('verdict claims an unregistered high-severity control')
            controls[arm].update(f'{case["id"]}/{control}' for control in found)
        cases.append({'id': case['id'], **scores})
    measured_precision = precision(total['quorum'])
    recall_preserved = controls['single'] <= controls['quorum']
    reasons = []
    if not has_clean or not has_high:
        reasons.append('reference set requires high-severity issues and independently clean controls')
    if measured_precision is None or measured_precision < .8:
        reasons.append('quorum precision did not reach 0.80')
    if not recall_preserved:
        reasons.append('known high-severity recall fell against the single-voter baseline')
    if manifest.get('execution') != 'live-model':
        reasons.append('recorded fixtures do not establish empirical model acceptance')
    return {'schema': 'rio-verifier-comparison-v1', 'cases': cases, 'precision': measured_precision,
            'high_severity_recall_preserved': recall_preserved, 'accepted': not reasons, 'reasons': reasons}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--out', required=True, type=Path)
    args = parser.parse_args()
    result = compare(read(args.manifest), args.manifest.parent)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(result, indent=2) + '\n')
    return 0 if result['accepted'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

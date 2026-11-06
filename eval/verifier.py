#!/usr/bin/env python3
"""Compare pinned single-verifier and quorum runs without treating fixtures as live acceptance.

Usage: python3 -I eval/verifier.py MANIFEST.json --out COMPARISON.json [--markdown SUMMARY.md]

The manifest (eval/schema/verifier-manifest-v1.json) pins, per reference case, the
generator and voter models, the profile hash and two arms (`single`, `quorum`), each
naming report, audit and verdict files with SHA-256 pins. The comparison
(eval/schema/verifier-comparison-v1.json) records per case and per arm artifact-backed
verdict counts, blind-match buckets, precision by evidence level, verification
tokens and cost, and detected high-severity controls.

v0.2 acceptance requires: a reference set containing known high-severity issues and
independently clean controls; quorum precision >= 0.80; every high-severity control
the single-verifier baseline detected also detected by the quorum; complete data
(every case scored, verification cost known); and `execution: live-model`. Any
failure is written as evidence (false positives and lost controls are named) and
the exit code is 1; acceptance is never reported on missing data.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import evaluate as e  # noqa: E402

ARMS = ('single', 'quorum')
LEVELS = ('plausible', 'static_proven', 'reproduced')
BUCKETS = ('same', 'related', 'none')
VERDICTS = ('true-positive', 'false-positive')
RANKS = {'refuted': 0, 'plausible': 1, 'static_proven': 2, 'reproduced': 3}
GATE = 0.8
MANIFEST_SCHEMA = e.SCHEMA / 'verifier-manifest-v1.json'
COMPARISON_SCHEMA = e.SCHEMA / 'verifier-comparison-v1.json'


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
    by_level = {level: Counter() for level in LEVELS}
    blind = {bucket: Counter() for bucket in BUCKETS}
    counts = Counter()
    high = set()
    false_positives = []
    for finding in findings:
        verdict = verdicts['findings'][finding['id']]
        if verdict['verdict'] not in VERDICTS or not verdict.get('evidence'):
            raise ValueError('verdict requires positive/negative classification and artifact-backed evidence')
        key = verdict['verdict']
        counts[key] += 1
        if finding['evidence_level'] not in by_level:
            raise ValueError(f'unexpected rendered evidence level {finding["evidence_level"]}')
        by_level[finding['evidence_level']][key] += 1
        if finding['evidence_level'] != 'plausible':
            supported = {v['voter'] for v in votes if v.get('hypothesis_id') == finding['id'] and v['status'] == 'completed'
                         and RANKS.get(v.get('validated_level'), 0) >= RANKS[finding['evidence_level']]
                         and v.get('answer', {}).get('evidence')}
            required = finding.get('verification', {}).get('agreeing', 1)
            if required < 1 or len(supported) < required:
                raise ValueError('proof-level finding lacks artifact-backed votes')
        for bucket in set(finding.get('verification', {}).get('blind_match', ['none'])):
            blind[bucket][key] += 1
        if key == 'true-positive' and verdict.get('control_id'):
            high.add(verdict['control_id'])
        if key == 'false-positive':
            false_positives.append({'finding_id': finding['id'], 'rule_id': finding['rule_id'],
                                    'evidence_level': finding['evidence_level'], 'evidence': verdict['evidence']})
    usage = [u for u in audit['usage'] if u['phase'].startswith('verify')]
    if any(u['status'] != 'completed' for u in usage):
        raise ValueError('incomplete provider usage cannot establish measured acceptance')
    return {
        'counts': {k: counts[k] for k in VERDICTS}, 'precision': precision(counts),
        'by_evidence': {k: {**{x: v[x] for x in VERDICTS}, 'precision': precision(v)} for k, v in by_level.items()},
        'blind_match': {k: {x: v[x] for x in VERDICTS} for k, v in blind.items()},
        'detected_high_controls': sorted(high), 'false_positives': false_positives,
        'verification_tokens': sum(u['input_tokens'] + u['output_tokens'] for u in usage),
        'verification_cost_usd': None if any(u.get('cost_usd') is None for u in usage) else sum(u['cost_usd'] for u in usage),
        'base': report['review']['base'], 'head': report['review']['head'],
    }


def totals(scored, arm):
    counts, levels, blind = Counter(), {k: Counter() for k in LEVELS}, {k: Counter() for k in BUCKETS}
    tokens, cost, expected, detected = 0, 0.0, 0, 0
    cost_known = True
    for case in scored:
        run = case[arm]
        counts.update(run['counts'])
        for k in LEVELS:
            levels[k].update({x: run['by_evidence'][k][x] for x in VERDICTS})
        for k in BUCKETS:
            blind[k].update(run['blind_match'][k])
        tokens += run['verification_tokens']
        if run['verification_cost_usd'] is None:
            cost_known = False
        else:
            cost += run['verification_cost_usd']
        expected += len(case['high_controls'])
        detected += len(run['detected_high_controls'])
    return {'counts': {k: counts[k] for k in VERDICTS}, 'precision': precision(counts),
            'by_evidence': {k: {**{x: v[x] for x in VERDICTS}, 'precision': precision(v)} for k, v in levels.items()},
            'blind_match': {k: {x: v[x] for x in VERDICTS} for k, v in blind.items()},
            'verification_tokens': tokens, 'verification_cost_usd': cost if cost_known else None,
            'high_controls_expected': expected, 'high_controls_detected': detected,
            'high_severity_recall': detected / expected if expected else None}


def compare(manifest, root, manifest_sha256=None):
    """Structural manifest errors raise; per-case scoring failures are kept as evidence."""
    e.validate(manifest, MANIFEST_SCHEMA)
    ids = [case['id'] for case in manifest['cases']]
    if len(set(ids)) != len(ids):
        raise ValueError('duplicate reference case')
    cases, errors, reasons = [], [], []
    has_clean = has_high = False
    for case in manifest['cases']:
        has_clean |= case['independently_clean'] is True
        expected = set(case['high_controls'])
        has_high |= bool(expected)
        row = {'id': case['id'], 'generator_model': case['generator_model'], 'voter_model': case['voter_model'],
               'profile_hash': case['profile_hash'], 'independently_clean': case['independently_clean'],
               'high_controls': sorted(expected)}
        try:
            scores = {arm: score_run(case[arm], root) for arm in ARMS}
            if (scores['single']['base'], scores['single']['head']) != (scores['quorum']['base'], scores['quorum']['head']):
                raise ValueError('comparison arms must review identical selected snapshots')
            for arm in ARMS:
                unregistered = set(scores[arm]['detected_high_controls']) - expected
                if unregistered:
                    raise ValueError(f'{arm} verdict claims unregistered high-severity control(s) {sorted(unregistered)}')
            row.update(scores)
            cases.append(row)
        except (ValueError, KeyError, OSError, json.JSONDecodeError) as error:
            errors.append({'id': case['id'], 'error': str(error)})
            reasons.append(f'case {case["id"]} could not be scored: {error}')
    arms = {arm: totals(cases, arm) for arm in ARMS}
    lost = sorted(f'{case["id"]}/{control}' for case in cases
                  for control in set(case['single']['detected_high_controls']) - set(case['quorum']['detected_high_controls']))
    false_positives = [{'case': case['id'], **fp} for case in cases for fp in case['quorum']['false_positives']]
    measured = arms['quorum']['precision']
    gates = {'reference_set': has_clean and has_high,
             'precision': None if measured is None else measured >= GATE,
             'high_severity_recall': None if errors else not lost,
             'complete_data': not errors and all(arms[a]['verification_cost_usd'] is not None for a in ARMS),
             'live_model': manifest['execution'] == 'live-model'}
    if not gates['reference_set']:
        reasons.append('reference set requires high-severity issues and independently clean controls')
    if measured is None:
        reasons.append('quorum precision has no denominator (no adjudicated agent findings)')
    elif measured < GATE:
        reasons.append(f'quorum precision {measured:.2f} did not reach {GATE:.2f}; false positives: '
                       + ', '.join(f'{fp["case"]}/{fp["finding_id"]}' for fp in false_positives))
    if lost:
        reasons.append('known high-severity recall fell against the single-verifier baseline: ' + ', '.join(lost))
    if not errors and not gates['complete_data']:
        reasons.append('verification cost is unavailable for at least one arm')
    if not gates['live_model']:
        reasons.append('recorded fixtures do not establish empirical model acceptance')
    result = {'schema': 'rio-verifier-comparison-v1', 'execution': manifest['execution'],
              'manifest_sha256': manifest_sha256, 'cases': cases, 'errors': errors, 'arms': arms,
              'precision': measured, 'gate': GATE, 'high_severity_recall_preserved': gates['high_severity_recall'] is True,
              'lost_high_controls': lost, 'quorum_false_positives': false_positives, 'gates': gates,
              'accepted': not reasons and all(v is True for v in gates.values()), 'reasons': reasons}
    e.validate(result, COMPARISON_SCHEMA)
    return result


def failed(reason, execution=None, manifest_sha256=None):
    """A comparison document for an unusable manifest: kept as evidence, never accepted."""
    empty = totals([], 'quorum')
    result = {'schema': 'rio-verifier-comparison-v1', 'execution': execution if execution in ('live-model', 'recorded') else None,
              'manifest_sha256': manifest_sha256, 'cases': [], 'errors': [], 'arms': {a: empty for a in ARMS},
              'precision': None, 'gate': GATE, 'high_severity_recall_preserved': False, 'lost_high_controls': [],
              'quorum_false_positives': [],
              'gates': {'reference_set': False, 'precision': None, 'high_severity_recall': None,
                        'complete_data': False, 'live_model': execution == 'live-model'},
              'accepted': False, 'reasons': [f'manifest rejected: {reason}']}
    e.validate(result, COMPARISON_SCHEMA)
    return result


def pct(value):
    return 'n/a' if value is None else f'{value:.1%}'


def markdown(result):
    lines = ['# v0.2 verifier comparison', '',
             f'Execution: `{result["execution"]}`. Accepted: **{"yes" if result["accepted"] else "no"}**.', '']
    if result['reasons']:
        lines += ['Reasons acceptance is not reported:', ''] + [f'- {r}' for r in result['reasons']] + ['']
    lines += ['| Arm | TP | FP | Precision | High-severity recall | Verify tokens | Verify cost (USD) |',
              '|---|---:|---:|---:|---:|---:|---:|']
    for arm in ARMS:
        a = result['arms'][arm]
        cost = 'unavailable' if a['verification_cost_usd'] is None else f'{a["verification_cost_usd"]:.4f}'
        lines.append(f'| {arm} | {a["counts"]["true-positive"]} | {a["counts"]["false-positive"]} | '
                     f'{pct(a["precision"])} | {pct(a["high_severity_recall"])} | {a["verification_tokens"]} | {cost} |')
    lines += ['', '| Arm | Evidence level | TP | FP | Precision |', '|---|---|---:|---:|---:|']
    for arm in ARMS:
        for level in LEVELS:
            x = result['arms'][arm]['by_evidence'][level]
            lines.append(f'| {arm} | {level} | {x["true-positive"]} | {x["false-positive"]} | {pct(x["precision"])} |')
    lines += ['', '| Arm | Blind match | TP | FP |', '|---|---|---:|---:|']
    for arm in ARMS:
        for bucket in BUCKETS:
            x = result['arms'][arm]['blind_match'][bucket]
            lines.append(f'| {arm} | {bucket} | {x["true-positive"]} | {x["false-positive"]} |')
    lines += ['', '## Cases', '']
    for case in result['cases']:
        lines.append(f'- `{case["id"]}` ({"clean control" if case["independently_clean"] else "reference"}; '
                     f'high controls: {", ".join(case["high_controls"]) or "none"}): single detected '
                     f'{", ".join(case["single"]["detected_high_controls"]) or "none"}, quorum detected '
                     f'{", ".join(case["quorum"]["detected_high_controls"]) or "none"}')
    for error in result['errors']:
        lines.append(f'- `{error["id"]}`: not scored ({error["error"]})')
    return '\n'.join(lines) + '\n'


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('manifest', type=Path)
    parser.add_argument('--out', required=True, type=Path)
    parser.add_argument('--markdown', type=Path, help='also write a human-readable summary (e.g. docs/evaluation/)')
    args = parser.parse_args(argv)
    manifest_sha = digest(args.manifest)
    manifest = None
    try:
        manifest = read(args.manifest)
        result = compare(manifest, args.manifest.parent, manifest_sha)
    except (ValueError, KeyError, json.JSONDecodeError) as error:
        execution = manifest.get('execution') if isinstance(manifest, dict) else None
        result = failed(str(error), execution, manifest_sha)
    e.write_json(args.out, result)
    if args.markdown:
        args.markdown.parent.mkdir(parents=True, exist_ok=True)
        args.markdown.write_text(markdown(result))
    print(('ACCEPTED' if result['accepted'] else 'NOT ACCEPTED') + ''.join(f'\n- {r}' for r in result['reasons']))
    return 0 if result['accepted'] else 1


if __name__ == '__main__':
    raise SystemExit(main())

#!/usr/bin/env python3
"""Build, validate, aggregate and render baseline-gated Rio evaluation records."""
import argparse
from collections import Counter, defaultdict
import copy
import gzip
import hashlib
import json
import os
from pathlib import Path
import re
import sys
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
CLASSES = ('true-positive', 'false-positive', 'pre-existing-shown',
           'environment-failure', 'out-of-scope', 'pre-existing-hidden')
SUCCESS = {'passed', 'findings'}
SCHEMA = ROOT / 'eval/schema'


def read_json(path):
    path = Path(path)
    data = gzip.decompress(path.read_bytes()) if path.suffix == '.gz' else path.read_bytes()
    return json.loads(data)


def write_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    data = (json.dumps(value, indent=2, ensure_ascii=False) + '\n').encode()
    path.write_bytes(gzip.compress(data, mtime=0) if path.suffix == '.gz' else data)


def validate(value, schema_path, fragment='', label='$'):
    """Offline JSON Schema subset used by our schemas and Rio's finding/check refs.

    No network resolution or third-party packages. Unsupported validation keywords
    fail closed so schema edits cannot silently weaken runtime validation.
    """
    schema_path = Path(schema_path).resolve()
    document = read_json(schema_path)
    schema = document
    if fragment:
        for part in fragment.lstrip('/').split('/'):
            schema = schema[unquote(part).replace('~1', '/').replace('~0', '~')]
    _validate(value, schema, schema_path, label)


def _validate(value, schema, path, label):
    supported = {'$schema', '$id', '$ref', '$defs', 'title', 'description', 'type',
                 'properties', 'required', 'additionalProperties', 'items', 'enum',
                 'const', 'pattern', 'minLength', 'minimum', 'maximum', 'minItems', 'uniqueItems',
                 'oneOf', 'allOf', 'if', 'then', 'else', 'not'}
    if isinstance(schema, bool):
        if not schema:
            raise ValueError(f'{label}: forbidden value')
        return
    if set(schema) - supported:
        raise ValueError(f'{label}: unsupported schema keywords {set(schema) - supported}')
    if '$ref' in schema:
        filename, _, fragment = schema['$ref'].partition('#')
        validate(value, path.parent / filename if filename else path, fragment, label)
    types = {'object': lambda x: isinstance(x, dict), 'array': lambda x: isinstance(x, list),
             'string': lambda x: isinstance(x, str), 'boolean': lambda x: isinstance(x, bool),
             'integer': lambda x: type(x) is int,
             'number': lambda x: type(x) in (int, float), 'null': lambda x: x is None}
    if 'type' in schema:
        expected = schema['type'] if isinstance(schema['type'], list) else [schema['type']]
        if not any(types[t](value) for t in expected):
            raise ValueError(f'{label}: expected {expected}')
    if 'enum' in schema and value not in schema['enum']:
        raise ValueError(f'{label}: invalid enum {value!r}')
    if 'const' in schema and value != schema['const']:
        raise ValueError(f'{label}: expected {schema["const"]!r}')
    if isinstance(value, dict):
        missing = set(schema.get('required', [])) - value.keys()
        if missing:
            raise ValueError(f'{label}: missing {sorted(missing)}')
        props = schema.get('properties', {})
        for k, v in value.items():
            sub = props.get(k, schema.get('additionalProperties', True))
            _validate(v, sub, path, f'{label}.{k}')
    if isinstance(value, list):
        if len(value) < schema.get('minItems', 0):
            raise ValueError(f'{label}: too few items')
        if schema.get('uniqueItems') and len({json.dumps(v, sort_keys=True) for v in value}) != len(value):
            raise ValueError(f'{label}: duplicate items')
        for i, item in enumerate(value):
            _validate(item, schema.get('items', True), path, f'{label}[{i}]')
    if isinstance(value, str):
        if len(value) < schema.get('minLength', 0):
            raise ValueError(f'{label}: empty string')
        if 'pattern' in schema and not re.search(schema['pattern'], value):
            raise ValueError(f'{label}: pattern mismatch')
    if type(value) in (int, float) and value < schema.get('minimum', float('-inf')):
        raise ValueError(f'{label}: below minimum')
    if type(value) in (int, float) and value > schema.get('maximum', float('inf')):
        raise ValueError(f'{label}: above maximum')
    for sub in schema.get('allOf', []):
        _validate(value, sub, path, label)
    if 'not' in schema:
        try:
            _validate(value, schema['not'], path, label)
        except ValueError:
            pass
        else:
            raise ValueError(f'{label}: forbidden schema match')
    if 'if' in schema:
        try:
            _validate(value, schema['if'], path, label)
        except ValueError:
            _validate(value, schema.get('else', True), path, label)
        else:
            _validate(value, schema.get('then', True), path, label)
    if 'oneOf' in schema:
        matches = 0
        for sub in schema['oneOf']:
            try:
                _validate(value, sub, path, label)
                matches += 1
            except ValueError:
                pass
        if matches != 1:
            raise ValueError(f'{label}: expected exactly one schema match, got {matches}')


def occurrences(finding):
    locations = [finding['location'], *finding.get('locations', [])]
    return len({(p['path'], p['line_start'], p['line_end'], p.get('column'),
                 p['symbol_path']) for p in locations})


def dedupe(findings, annotations, legacy=False):
    """Exact tuple keys; explicit reviewer templates/file sets permit proven merges."""
    if len({f['id'] for f in findings}) != len(findings):
        raise ValueError('duplicate finding IDs across top-level findings/risks')
    if {f['id'] for f in findings} != set(annotations):
        raise ValueError('verdict IDs must match all top-level findings and risks exactly')
    adjudicated, groups = [], {}
    for finding in findings:
        a = annotations[finding['id']]
        if not isinstance(a, dict):
            raise ValueError('finding annotation must be an object')
        allowed = {'verdict', 'reason', 'message_template', 'file_set', 'family'}
        if set(a) - allowed:
            raise ValueError(f'unknown annotation fields: {set(a) - allowed}')
        if a.get('verdict') not in CLASSES or not isinstance(a.get('reason'), str) or not a['reason'].strip():
            raise ValueError('every finding needs a verdict class and nonempty evidence reason')
        verdict = a['verdict']
        if not legacy:
            if finding['state'] in {'pre-existing', 'fixed'}:
                verdict = 'pre-existing-hidden'
            elif verdict == 'pre-existing-hidden':
                raise ValueError('pre-existing-hidden requires a hidden raw finding state')
        actual_files = {p['path'] for p in [finding['location'], *finding.get('locations', [])]}
        declared_files = a.get('file_set', sorted(actual_files))
        if (not isinstance(declared_files, list) or not declared_files
                or any(not isinstance(p, str) or not p for p in declared_files)
                or not actual_files <= set(declared_files)):
            raise ValueError('declared file_set must include every finding path')
        if not isinstance(a.get('message_template', finding['message']), str):
            raise ValueError('message_template must be a string')
        template = ' '.join(a.get('message_template', finding['message']).split())
        files = sorted(set(declared_files))
        if not files or not template:
            raise ValueError('root cause needs a message template and file set')
        identity = [finding['rule_id'], template, files]
        key = hashlib.sha256(json.dumps(identity, ensure_ascii=False,
                                       separators=(',', ':')).encode()).hexdigest()
        family = a.get('family', finding['rule_id'])
        entry = {'finding': copy.deepcopy(finding), 'verdict': verdict,
                 'reason': a['reason'], 'message_template': template,
                 'file_set': files, 'root_cause_key': key, 'family': family}
        adjudicated.append(entry)
        group_key = key if legacy else (key, verdict == 'pre-existing-hidden')
        if group_key not in groups:
            groups[group_key] = {'root_cause_key': key, 'rule_id': finding['rule_id'],
                           'message_template': template, 'file_set': files,
                           'verdict': verdict, 'family': family,
                           'finding_count': 0, 'occurrence_count': 0, 'finding_ids': []}
        g = groups[group_key]
        if (g['verdict'], g['family']) != (verdict, family):
            raise ValueError(f'conflicting verdict/family within root cause {key}')
        g['finding_count'] += 1
        g['occurrence_count'] += occurrences(finding)
        g['finding_ids'].append(finding['id'])
    for g in groups.values():
        g['finding_ids'].sort()
    return adjudicated, sorted(groups.values(), key=lambda g: (g['root_cause_key'], g['verdict']))


def environment(report, legacy=False):
    checks = report['checks']
    def inapplicable(c):
        return (c['outcome'] == 'skipped' and c.get('reason') in
                {'disabled', 'no_project_config'})

    diagnostic = [c for c in checks if c['kind'] in ('typecheck', 'lint')
                  and (legacy or not inapplicable(c))]
    bases = {(c['kind'], c['language'], c['root']): c for c in diagnostic if c['version'] == 'base'}
    heads = {(c['kind'], c['language'], c['root']): c for c in diagnostic if c['version'] == 'head'}
    reasons = []
    roots = set(heads) if legacy else set(heads) | set(bases)
    if not roots:
        reasons.append('No typecheck/lint baseline pairs establish classification')
    classification = bool(roots)
    allowed_states = {'verified'} if legacy else {'verified', 'trusted'}
    for key in sorted(roots):
        h, b = heads.get(key), bases.get(key)
        if (not h or h['outcome'] not in SUCCESS or h.get('dependency_state') not in allowed_states
                or not b or b['outcome'] not in SUCCESS or b.get('dependency_state') not in allowed_states):
            classification = False
            reasons.append(f'{key[0]} {key[2]}: head={h["outcome"] if h else "unavailable"}, '
                           f'dependency_state={h.get("dependency_state", "unavailable") if h else "unavailable"}, '
                           f'base={b["outcome"] if b else "unavailable"}')
    for c in checks:
        # An offline cohort explicitly excludes network audits, not tool failures.
        expected_offline = c['kind'] == 'dependencies' and c.get('reason') in ('offline', 'nothing_to_audit')
        if (c['outcome'] not in SUCCESS and not expected_offline
                and (legacy or not inapplicable(c))):
            reasons.append(f'{c["kind"]} {c["root"]} {c["version"]}: '
                           f'{c["outcome"]} {c.get("reason", "")} {c.get("hint", "")}'.strip())
    if report['status'] in ('partial', 'error', 'no_changes'):
        reasons.append(f'report status {report["status"]} cannot establish a complete change review')
    state_checks = checks if legacy else diagnostic
    states = {c.get('dependency_state', 'unavailable') for c in state_checks
              if not legacy or 'dependency_state' in c}
    state = next(iter(states)) if len(states) == 1 else ('mixed' if states else 'unavailable')
    return {'dependency_state': state, 'baseline_ran': bool(bases),
            'baseline_classification_ran': classification, 'eligible': classification and not reasons,
            # Check metadata establishes eligibility; diagnostic copies remain in the raw report.
            'reasons': sorted(set(reasons)), 'checks': [{**c, 'findings': []} for c in checks],
            'notes': list(report['footer']['notes'])}


def provenance(report_path):
    """Use captured hashes, never mistake a profile name/version string for a hash."""
    ledger = Path(report_path).with_name('commands.json')
    metadata = read_json(ledger) if ledger.exists() else {}
    return {'rio_binary_sha256': metadata.get('rio_binary_sha256'),
            'profile_sha256': metadata.get('resolved_profile_sha256')}


def build_record(report, verdicts, report_path):
    validate(report, ROOT / 'schemas/report-v1.json')
    allowed = {'repository', 'pr', 'case_id', 'languages', 'reviewer', 'verdict_source',
               'commands', 'notes', 'independently_clean', 'positive_control', 'findings', 'misses'}
    if set(verdicts) - allowed:
        raise ValueError(f'unknown verdict fields: {set(verdicts) - allowed}')
    findings, causes = dedupe(report['findings'] + report['risks'], verdicts['findings'])
    env = environment(report)
    review = report['review']
    record = {'schema': 'rio-eval-record-v2', 'methodology': 'deterministic-v2',
              **{k: verdicts[k] for k in ('repository', 'pr', 'case_id', 'languages',
                                         'reviewer', 'verdict_source', 'independently_clean')},
              'commands': verdicts.get('commands', []), 'notes': verdicts.get('notes', []),
              'positive_control': verdicts['positive_control'], 'base_sha': review['base'],
              'head_sha': review['head'], 'mode': review['mode'], 'review_id': review['id'],
              'run_id': review['run_id'], 'rio_version': review['rio_version'], 'profile': review['profile'],
              'wall_time_ms': report['metrics']['wall_time_ms'], 'status': report['status'],
              'report_path': str(report_path), **provenance(report_path),
              'environment': env, 'findings': findings,
              'root_causes': causes, 'misses': verdicts.get('misses', [])}
    record['misses'] = copy.deepcopy(record['misses'])
    for expected in record['positive_control']['expected']:
        if not expected['finding_ids'] and not any(
                m.get('expectation_id') == expected['id'] for m in record['misses']):
            record['misses'].append({'id': f'control/{expected["id"]}',
                'scope_class': 'deterministic', 'description': f'Positive control {expected["id"]} was not detected.',
                'evidence': expected['evidence'], 'mechanism': expected['mechanism'],
                'expectation_id': expected['id']})
    record['verdict'], record['reason'] = usefulness(record)
    validate_record(record)
    return record


def usefulness(record):
    if not record['environment']['eligible']:
        return 'environment-failure', 'Baseline/setup must be repaired before this PR can be scored.'
    classes = {g['verdict'] for g in record['root_causes']}
    if record['schema'] != 'rio-eval-record-v1':
        classes.discard('pre-existing-hidden')
    if 'true-positive' in classes:
        return 'useful', 'At least one independently confirmed actionable deterministic root cause.'
    if (record['independently_clean'] and not classes
            and not any(m['scope_class'] == 'deterministic' for m in record['misses'])
            and not record['positive_control']['expected']):
        return 'useful', 'Independently clean change confirmed with working baseline and no unwanted findings.'
    return 'not-useful', 'No actionable finding or independently confirmed clean report.'


def validate_record(record):
    legacy = record.get('schema') == 'rio-eval-record-v1'
    schema = SCHEMA / ('record-v1.json' if legacy else 'record-v2.json')
    validate(record, schema)
    if record['reviewer'].startswith('TODO'):
        raise ValueError('replace the skeleton reviewer before producing a record')
    findings, causes = dedupe([f['finding'] for f in record['findings']],
                             {f['finding']['id']: {k: f[k] for k in
                              ('verdict', 'reason', 'message_template', 'file_set', 'family')}
                              for f in record['findings']}, legacy=legacy)
    if findings != record['findings'] or causes != record['root_causes']:
        raise ValueError('record root causes do not match findings')
    derived_env = environment({'checks': record['environment']['checks'], 'status': record['status'],
                               'footer': {'notes': record['environment']['notes']}}, legacy=legacy)
    if derived_env != record['environment']:
        raise ValueError('record environment does not match check evidence')
    if (record['verdict'], record['reason']) != usefulness(record):
        raise ValueError('record usefulness does not match evidence')
    control = record['positive_control']
    if (control['kind'] == 'none') != (not control['expected']):
        raise ValueError('positive controls need nonempty expectations; non-controls need none')
    expected = {e['id'] for e in control['expected']}
    if len(expected) != len(control['expected']):
        raise ValueError('duplicate expected bug IDs')
    if len({m['id'] for m in record['misses']}) != len(record['misses']):
        raise ValueError('duplicate miss IDs')
    verdict_by_id = {f['finding']['id']: f['verdict'] for f in record['findings']}
    for e in control['expected']:
        if len(set(e['finding_ids'])) != len(e['finding_ids']):
            raise ValueError('duplicate expected finding IDs')
        if any(verdict_by_id.get(i) != 'true-positive' for i in e['finding_ids']):
            raise ValueError('only adjudicated true-positive findings can satisfy a control')
        if not e['finding_ids'] and not any(m.get('expectation_id') == e['id'] for m in record['misses']):
            raise ValueError('undetected control must be recorded as a deterministic miss')
        if e['mechanism'] == 'vulnerable-dependency':
            if not any(c['kind'] == 'dependencies' and c['outcome'] in SUCCESS
                       for c in record['environment']['checks']):
                raise ValueError('vulnerable dependency control needs an executed audit')
        if e['mechanism'] == 'uncovered-lines':
            if not any(c['kind'] == 'coverage' and c['outcome'] in SUCCESS
                       for c in record['environment']['checks']):
                raise ValueError('coverage control needs executed coverage')
    for m in record['misses']:
        if m['scope_class'] == 'deterministic':
            if 'mechanism' not in m:
                raise ValueError('deterministic miss needs a plausible mechanism')
            if control['kind'] != 'none' and m.get('expectation_id') not in expected:
                raise ValueError('positive-control deterministic miss needs an expectation ID')
        if 'expectation_id' in m:
            e = next((e for e in control['expected'] if e['id'] == m['expectation_id']), None)
            if not e or e['finding_ids'] or m['scope_class'] != 'deterministic':
                raise ValueError('miss references absent, detected, or out-of-scope expectation')
            if m['mechanism'] != e['mechanism']:
                raise ValueError('control miss mechanism differs from expected bug')


def current_record(record):
    """Rescore preserved v1 evidence without rewriting the historical artifact."""
    validate_record(record)
    if record['schema'] == 'rio-eval-record-v2':
        return record
    updated = copy.deepcopy(record)
    updated.update(schema='rio-eval-record-v2', methodology='deterministic-v2',
                   **provenance(record['report_path']))
    updated['findings'], updated['root_causes'] = dedupe(
        [f['finding'] for f in record['findings']],
        {f['finding']['id']: {k: f[k] for k in
         ('verdict', 'reason', 'message_template', 'file_set', 'family')}
         for f in record['findings']})
    updated['environment'] = environment({'checks': record['environment']['checks'],
        'status': record['status'], 'footer': {'notes': record['environment']['notes']}})
    updated['verdict'], updated['reason'] = usefulness(updated)
    validate_record(updated)
    return updated


def class_counts(records, unit):
    counts = Counter()
    for r in records:
        for f in r['findings'] if unit != 'causes' else r['root_causes']:
            counts[f['verdict']] += occurrences(f['finding']) if unit == 'occurrences' else 1
    return {k: counts[k] for k in CLASSES}


def unique_counts(records):
    groups = defaultdict(set)
    for r in records:
        for c in r['root_causes']:
            groups[c['verdict']].add((r['repository'], c['root_cause_key']))
    return {k: len(groups[k]) for k in CLASSES}


def ratio(n, d):
    return n / d if d else None


def metrics(records):
    causes = class_counts(records, 'causes')
    expected = [e for r in records for e in r['positive_control']['expected']]
    useful = sum(r['verdict'] == 'useful' for r in records)
    control_kinds = {}
    for kind in ('real-pr', 'seeded-mutation'):
        subset = [r for r in records if r['positive_control']['kind'] == kind]
        bugs = [e for r in subset for e in r['positive_control']['expected']]
        detected = sum(bool(e['finding_ids']) for e in bugs)
        control_kinds[kind] = {'cases': len(subset), 'expected': len(bugs),
                               'detected': detected, 'recall': ratio(detected, len(bugs))}
    return {'eligible_prs': len(records), 'raw_counts': class_counts(records, 'raw'),
            'occurrence_counts': class_counts(records, 'occurrences'), 'cause_counts': causes,
            'unique_cause_counts': unique_counts(records),
            'precision': ratio(causes['true-positive'], causes['true-positive'] + causes['false-positive']),
            'positive_control_cases': sum(bool(r['positive_control']['expected']) for r in records),
            'positive_control_by_kind': control_kinds,
            'positive_control_expected': len(expected),
            'positive_control_detected': sum(bool(e['finding_ids']) for e in expected),
            'positive_control_recall': ratio(sum(bool(e['finding_ids']) for e in expected), len(expected)),
            'false_positive_per_pr': ratio(causes['false-positive'], len(records)),
            'pr_with_false_positive_fraction': ratio(sum(any(c['verdict'] == 'false-positive'
                for c in r['root_causes']) for r in records), len(records)),
            'useful_prs': useful, 'useful_real_prs': sum(r['verdict'] == 'useful'
                and r['positive_control']['kind'] != 'seeded-mutation' for r in records),
            'usefulness_fraction': ratio(useful, len(records))}


def case_identity(record):
    # Attempts sometimes encode a retry suffix in case_id. Real PR URLs still
    # identify the same case; synthetic controls retain their own declared ID.
    return (record['repository'], record['case_id'] if
            record['positive_control']['kind'] == 'seeded-mutation' else record['pr'])


def select_records(records, paths, select=None):
    if len(records) != len(paths):
        raise ValueError('record/path length mismatch')
    pairs = list(zip(records, paths))
    if select and select not in {'latest', 'eligible-only'}:
        manifest = Path(select)
        entries = read_json(manifest)
        if not isinstance(entries, list) or any(not isinstance(p, str) for p in entries):
            raise ValueError('selection manifest must be a JSON array of record paths relative to the manifest')
        resolved = [(manifest.parent / p).resolve() for p in entries]
        if len(set(resolved)) != len(resolved):
            raise ValueError('duplicate record paths in selection manifest')
        available = {Path(p).resolve(): (r, p) for r, p in pairs}
        missing = [str(p) for p in resolved if p not in available]
        if missing:
            raise ValueError(f'selection manifest paths are not inputs: {missing}')
        pairs = [available[p] for p in resolved]
    if select == 'eligible-only':
        pairs = [(r, p) for r, p in pairs if r['environment']['eligible']]
    groups = defaultdict(list)
    for r, p in pairs:
        groups[case_identity(r)].append((r, p))
    duplicates = {key: group for key, group in groups.items() if len(group) > 1}
    if duplicates and select != 'latest':
        detail = '; '.join(f'{repo} / {case}: ' + ', '.join(str(p) for _, p in group)
                           for (repo, case), group in sorted(duplicates.items()))
        raise ValueError('duplicate case: ' + detail +
                         '. Use --select latest, --select eligible-only (when only one attempt is eligible), '
                         'or --select MANIFEST.json listing one record per case.')
    if select == 'latest':
        # Rio run IDs are time-ordered ULIDs; paths break ties deterministically.
        pairs = [max(group, key=lambda pair: (pair[0]['run_id'], str(pair[1])))
                 for group in groups.values()]
    return [r for r, _ in pairs], [p for _, p in pairs]


def version_identity(record):
    return record['rio_version'] + '@sha256:' + (record['rio_binary_sha256'] or 'unavailable')


def aggregate(records, paths, select=None, allow_mixed_versions=False):
    records = [current_record(r) for r in records]
    input_paths = list(map(str, paths))
    records, paths = select_records(records, paths, select)
    eligible = [r for r in records if r['environment']['eligible']]
    # Prevent duplicate real PRs from inflating sample sizes under different case IDs.
    real_ids = [(r['repository'], r['pr']) for r in eligible
                if r['positive_control']['kind'] != 'seeded-mutation']
    if len(set(real_ids)) != len(real_ids):
        raise ValueError('duplicate real PR in scored cohort')
    versions = sorted({version_identity(r) for r in records})
    if len(versions) > 1 and not allow_mixed_versions:
        raise ValueError('different Rio versions require separate cohorts; '
                         'use --allow-mixed-versions for an explicitly mixed summary: ' + ', '.join(versions))
    m = metrics(eligible)
    controls = [r for r in eligible if r['positive_control']['expected']]
    languages = sorted({lang for r in eligible for lang in r['languages']})
    control_languages = {lang: sum(lang in r['languages'] for r in controls)
                         for lang in ('typescript', 'python')}
    clean = sum(r['independently_clean'] and r['positive_control']['kind'] == 'none' for r in eligible)
    sample = {'eligible_real_prs': len(real_ids), 'repositories': len({r['repository'] for r in eligible}),
              'languages': languages, 'positive_control_repositories': len({r['repository'] for r in controls}),
              'positive_controls_by_language': control_languages, 'clean_negative_controls': clean}
    real_controls = sum(r['positive_control']['kind'] == 'real-pr' for r in controls)
    seeded_controls = len(controls) - real_controls
    counted_controls = real_controls + min(seeded_controls, real_controls)
    sample.update(real_positive_controls=real_controls, seeded_positive_controls=seeded_controls,
                  counted_positive_controls=counted_controls)
    requirements = []
    for ok, reason in [
        (len(real_ids) >= 10, 'Need at least 10 eligible real PRs'),
        (sample['repositories'] >= 5, 'Need at least 5 eligible repositories'),
        (set(languages) == {'typescript', 'python'}, 'Need both languages'),
        (counted_controls >= 10, 'Need at least 10 eligible positive controls after the seeded cap'),
        (seeded_controls <= real_controls, 'Seeded controls must be at most 50% of positive-control cases'),
        (sample['positive_control_repositories'] >= 3, 'Need controls across at least 3 repositories'),
        (all(n >= 5 for n in control_languages.values()), 'Need at least 5 controls per language'),
        (clean > 0, 'Need an independently clean negative control'),
        (m['precision'] is not None, 'Precision denominator is absent'),
        (m['positive_control_recall'] is not None, 'Recall denominator is absent')]:
        if not ok:
            requirements.append(reason)
    sample.update(adequate=not requirements, requirements_missing=requirements)
    failures = []
    for value, ok, reason in [
        (m['precision'], lambda x: x >= .8, 'Precision below 0.80'),
        (m['positive_control_recall'], lambda x: x >= .8, 'Positive-control recall below 0.80'),
        (m['false_positive_per_pr'], lambda x: x < .15, 'False-positive causes per PR must be < 0.15'),
        (m['useful_real_prs'], lambda x: x >= 10, 'Need at least 10 useful real PRs')]:
        if value is not None and not ok(value):
            failures.append(reason)
    result = {'schema': 'rio-eval-summary-v2', 'methodology': 'deterministic-v2',
              'records': list(map(str, paths)), 'attempts': len(records),
              'selection': {'policy': str(select) if select else 'error-on-duplicates',
                            'omitted_records': [p for p in input_paths if p not in set(map(str, paths))]},
              'rio_versions': versions, 'mixed_versions': len(versions) > 1,
              'binary_identity_complete': all(r['rio_binary_sha256'] is not None for r in records),
              'profile_hashes': sorted({r['profile_sha256'] for r in records if r['profile_sha256']}),
              'record_profiles': [{'record_path': str(p), 'repository': r['repository'],
                  'case_id': r['case_id'], 'profile': r['profile'],
                  'profile_sha256': r['profile_sha256'], 'rio_binary_sha256': r['rio_binary_sha256'],
                  'dependency_state': r['environment']['dependency_state'],
                  'eligible': r['environment']['eligible']} for r, p in zip(records, paths)],
              'observed_raw_counts': class_counts(records, 'raw'),
              'observed_occurrence_counts': class_counts(records, 'occurrences'),
              'observed_cause_counts': class_counts(records, 'causes'),
              'observed_unique_cause_counts': unique_counts(records), 'eligible': m,
              'verified_only': metrics([r for r in eligible
                                        if r['environment']['dependency_state'] == 'verified']),
              'dependency_states': dict(sorted(Counter(r['environment']['dependency_state']
                                                       for r in records).items())),
              'by_repository': {repo: metrics([r for r in eligible if r['repository'] == repo])
                                for repo in sorted({r['repository'] for r in records})},
              'by_language': {lang: metrics([r for r in eligible if lang in r['languages']])
                              for lang in sorted({lang for r in records for lang in r['languages']})},
              'environment_failures': [{'repository': r['repository'], 'pr': r['pr'],
                  'case_id': r['case_id'], 'record_path': str(p), 'reasons': r['environment']['reasons']}
                  for r, p in zip(records, paths) if not r['environment']['eligible']],
              'agent_layer_backlog': [{'repository': r['repository'], 'pr': r['pr'],
                  'record_path': str(p), 'miss': miss} for r, p in zip(records, paths)
                  for miss in r['misses'] if miss['scope_class'] == 'agent-layer'],
              'deterministic_misses': sum(miss['scope_class'] == 'deterministic'
                  for r in records for miss in r['misses']), 'sample': sample,
              'decision': 'insufficient-evidence' if requirements else ('no-go' if failures else 'go'),
              'decision_reasons': requirements + failures}
    validate_summary(result)
    return result


def validate_summary(summary):
    validate(summary, SCHEMA / ('summary-v1.json' if summary.get('schema') ==
                              'rio-eval-summary-v1' else 'summary-v2.json'))


def cell(value):
    return str(value).replace('|', '\\|').replace('\n', ' ').replace('`', "'")


def link(path, output):
    return Path(os.path.relpath(Path(path).resolve(), Path(output).resolve().parent)).as_posix()


def render(records, paths, summary, version, output, narrative=None):
    available = {str(p): current_record(r) for r, p in zip(records, paths)}
    paths = summary['records']
    records = [available[p] for p in paths]
    m = summary['eligible']
    fmt = lambda x: 'undefined' if x is None else f'{x:.3f}'
    lines = [f'# Rio {version} evaluation', '',
             f'**Decision: {summary["decision"]}.** Release is allowed only by a go decision.', '',
             'Method: [deterministic-v2](' + link(ROOT / 'eval/METHODOLOGY.md', output) + '). '
             'Reviewer identities and human/automated provenance are in each raw record.', '']
    lines += [('**MIXED RIO VERSIONS**' if summary['mixed_versions'] else 'Rio versions')
              + ': ' + ', '.join(f'`{v}`' for v in summary['rio_versions']) + '.', '',
              'Binary hashes complete: ' + str(summary['binary_identity_complete']).lower() + '.', '',
              'Distinct resolved profile hashes: ' +
              (', '.join(f'`{h}`' for h in summary['profile_hashes']) or 'unavailable') + '.', '']
    if narrative:
        lines += [narrative.rstrip(), '']
    strict = summary['verified_only']
    lines += ['| Metric view | Eligible PRs | TP causes | FP causes | Precision | Controls detected / expected | Useful PRs |',
              '| --- | ---: | ---: | ---: | ---: | ---: | ---: |']
    for name, view in [('All eligible', m), ('Verified only', strict)]:
        lines.append(f'| {name} | {view["eligible_prs"]} | {view["cause_counts"]["true-positive"]} | '
                     f'{view["cause_counts"]["false-positive"]} | {fmt(view["precision"])} | '
                     f'{view["positive_control_detected"]} / {view["positive_control_expected"]} | '
                     f'{view["useful_prs"]} |')
    lines += ['', '| Recall view | Real detected / expected | Real recall | Seeded detected / expected | Seeded recall |',
              '| --- | ---: | ---: | ---: | ---: |']
    for name, view in [('All eligible', m), ('Verified only', strict)]:
        real = view['positive_control_by_kind']['real-pr']
        seeded = view['positive_control_by_kind']['seeded-mutation']
        lines.append(f'| {name} | {real["detected"]} / {real["expected"]} | {fmt(real["recall"])} | '
                     f'{seeded["detected"]} / {seeded["expected"]} | {fmt(seeded["recall"])} |')
    sample = summary['sample']
    lines += ['', f'Control cases counted toward the decision after the 50% seeded cap: '
              f'{sample["counted_positive_controls"]} '
              f'(real: {sample["real_positive_controls"]}; seeded: {sample["seeded_positive_controls"]}).', '',
              f'{len(records)} attempts; {m["eligible_prs"]} eligible; '
              f'{len(summary["environment_failures"])} environment failures. '
              f'Precision: {fmt(m["precision"])}; positive-control recall: '
              f'{fmt(m["positive_control_recall"])}; FP causes/PR: {fmt(m["false_positive_per_pr"])}. '
              f'Useful: {m["useful_prs"]}/{m["eligible_prs"]} eligible PRs.', '',
              'Counts below include excluded attempts as observations; they are not release metrics.', '',
              '| Class | Raw findings | Location occurrences | Per-PR causes | Unique repo/cause keys |',
              '| --- | ---: | ---: | ---: | ---: |']
    for c in CLASSES:
        lines.append(f'| {c} | {summary["observed_raw_counts"][c]} | '
                     f'{summary["observed_occurrence_counts"][c]} | {summary["observed_cause_counts"][c]} | '
                     f'{summary["observed_unique_cause_counts"][c]} |')
    lines += ['', 'Decision reasons:', ''] + [f'- {r}' for r in summary['decision_reasons']]
    lines += ['', '## Environment failures', '']
    if not summary['environment_failures']:
        lines += ['None.', '']
    for e in summary['environment_failures']:
        lines += [f'- [{e["repository"]} / {e["case_id"]}]({link(e["record_path"], output)}): '
                  + cell('; '.join(e['reasons']))]
    lines += ['', '## PR records', '']
    for r, path in zip(records, paths):
        lines += [f'### {r["repository"]} / {r["case_id"]}', '',
                  f'[PR]({r["pr"]}) · [raw record]({link(path, output)}) · '
                  f'[Rio report]({link(r["report_path"], output)}) · review `{r["review_id"]}` · '
                  f'{r["wall_time_ms"] / 1000:.3f}s · {r["verdict_source"]} ({cell(r["reviewer"])}).', '',
                  f'Profile: `{cell(r["profile"])}`; SHA-256: `{r["profile_sha256"] or "unavailable"}`.', '',
                  f'Dependencies: `{r["environment"]["dependency_state"]}`; '
                  f'eligible: `{str(r["environment"]["eligible"]).lower()}`; '
                  f'baseline classification: `{str(r["environment"]["baseline_classification_ran"]).lower()}`.', '',
                  f'**{r["verdict"]}:** {r["reason"]}', '']
        lines += [cell(note) for note in r['notes']] + ([''] if r['notes'] else [])
        if r['root_causes']:
            lines += ['| Cause | Rule / template | Verdict | Findings | Occurrences | Files | Raw record |',
                      '| --- | --- | --- | ---: | ---: | --- | --- |']
            for c in r['root_causes']:
                lines.append(f'| `{c["root_cause_key"][:12]}` | {cell(c["rule_id"])}: '
                    f'{cell(c["message_template"])} | {c["verdict"]} | {c["finding_count"]} | '
                    f'{c["occurrence_count"]} | {cell(", ".join(c["file_set"]))} | '
                    f'[record]({link(path, output)}) |')
        else:
            lines += ['No emitted findings.']
        lines += ['']
    lines += ['## Agent-layer backlog', '']
    for item in summary['agent_layer_backlog']:
        lines += [f'- [{item["repository"]}]({item["pr"]}): '
                  f'{cell(item["miss"]["description"])} '
                  f'[Evidence]({link(item["record_path"], output)}).']
    if not summary['agent_layer_backlog']:
        lines += ['None recorded.']
    lines += ['', f'Deterministic misses recorded across all attempts: {summary["deterministic_misses"]}.', '']
    Path(output).parent.mkdir(parents=True, exist_ok=True)
    Path(output).write_text('\n'.join(lines))


def skeleton(report, repository, pr, languages, case_id=None):
    return {'repository': repository, 'pr': pr, 'case_id': case_id or pr.rsplit('/', 1)[-1],
            'languages': languages, 'reviewer': 'TODO', 'verdict_source': 'automated',
            'commands': [], 'notes': [], 'independently_clean': False,
            'positive_control': {'kind': 'none', 'expected': []}, 'misses': [],
            'findings': {f['id']: {'verdict': 'TODO', 'reason': 'TODO: independent evidence'}
                         for f in report['findings'] + report['risks']}}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('record')
    p.add_argument('--report', required=True); p.add_argument('--verdicts', required=True)
    p.add_argument('--out', required=True)
    p = sub.add_parser('skeleton')
    p.add_argument('--report', required=True); p.add_argument('--repository', required=True)
    p.add_argument('--pr', required=True); p.add_argument('--languages', nargs='+', required=True)
    p.add_argument('--case-id'); p.add_argument('--out', required=True)
    p = sub.add_parser('aggregate')
    p.add_argument('records', nargs='+'); p.add_argument('--out', required=True)
    p = sub.add_parser('render')
    p.add_argument('records', nargs='+'); p.add_argument('--version', required=True)
    p.add_argument('--out', required=True); p.add_argument('--narrative')
    for name in ('aggregate', 'render'):
        sub.choices[name].add_argument('--select', help='latest, eligible-only, or JSON selection manifest')
        sub.choices[name].add_argument('--allow-mixed-versions', action='store_true')
    p = sub.add_parser('validate')
    p.add_argument('path')
    args = parser.parse_args()
    if args.command == 'record':
        write_json(args.out, build_record(read_json(args.report), read_json(args.verdicts), args.report))
    elif args.command == 'skeleton':
        write_json(args.out, skeleton(read_json(args.report), args.repository, args.pr,
                                     args.languages, args.case_id))
    elif args.command in ('aggregate', 'render'):
        records = [read_json(p) for p in args.records]
        summary = aggregate(records, args.records, args.select, args.allow_mixed_versions)
        if args.command == 'aggregate':
            write_json(args.out, summary)
        else:
            narrative = Path(args.narrative).read_text() if args.narrative else None
            render(records, args.records, summary, args.version, args.out, narrative)
    elif args.command == 'validate':
        value = read_json(args.path)
        if value.get('schema') in ('rio-eval-record-v1', 'rio-eval-record-v2'):
            validate_record(value)
        elif value.get('schema') in ('rio-eval-summary-v1', 'rio-eval-summary-v2'):
            validate_summary(value)
        else:
            raise ValueError('unknown evaluation schema')
        print(f'Valid: {args.path}')


if __name__ == '__main__':
    try:
        main()
    except (ValueError, KeyError, OSError) as error:
        sys.exit(f'evaluation error: {error}')

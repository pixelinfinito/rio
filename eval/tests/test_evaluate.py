"""Scoring invariants, using Rio's real report/finding fixtures."""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

MODULE = Path(__file__).resolve().parents[1] / 'evaluate.py'
spec = importlib.util.spec_from_file_location('evaluate', MODULE)
e = importlib.util.module_from_spec(spec)
spec.loader.exec_module(e)
FIXTURES = e.ROOT / 'crates/rio-core/tests/fixtures'


def finding(index=1, message='Type mismatch', path='src/a.ts', line=1):
    f = e.read_json(FIXTURES / 'finding.json')
    f.update(id=f'{index:064x}', rule_id='typecheck/tsc/TS2322', message=message)
    f['location'].update(path=path, line_start=line, line_end=line)
    f['locations'] = [copy.deepcopy(f['location'])]
    return f


def report(findings=(), baseline=True):
    r = e.read_json(FIXTURES / 'complete.json')
    r['findings'] = list(findings); r['risks'] = []; r['incomplete'] = []
    r['review'].update(base='a' * 40, head='b' * 40, id='review', run_id='run',
                       mode='branch', profile='rio/base', rio_version='0.1.0')
    r['checks'] = [{'kind': 'typecheck', 'language': 'typescript', 'root': '.',
                    'version': v, 'scheduled_as': 'changed', 'outcome': 'passed',
                    'dependency_state': 'verified', 'wall_time_ms': 1, 'findings': []}
                   for v in (['base', 'head'] if baseline else ['head'])]
    return r


def record(index=1, verdicts=(), baseline=True, control=False, clean=False, lang='typescript'):
    fs = [finding(i + 1, message=verdict) for i, verdict in enumerate(verdicts)]
    r = report(fs, baseline)
    v = e.skeleton(r, f'owner/repo{index % 5}', f'https://github.com/owner/repo{index % 5}/pull/{index}', [lang])
    v.update(reviewer='independent oracle', independently_clean=clean)
    v['findings'] = {f['id']: {'verdict': verdict, 'reason': 'independent evidence'}
                     for f, verdict in zip(fs, verdicts)}
    if control:
        v['positive_control'] = {'kind': 'real-pr', 'expected': [
            {'id': 'bug-1', 'mechanism': 'type-error', 'evidence': 'oracle failed at head',
             'finding_ids': [fs[0]['id']] if verdicts and verdicts[0] == 'true-positive' else []}]}
    return e.build_record(r, v, 'raw.json')


class DedupeTests(unittest.TestCase):
    def test_repeated_lines_collapse_but_file_rule_and_message_remain_distinct(self):
        fs = [finding(1), finding(2, line=9), finding(3, path='src/b.ts'),
              finding(4, message='Different type')]
        a = {f['id']: {'verdict': 'true-positive', 'reason': 'oracle'} for f in fs}
        entries, groups = e.dedupe(fs, a)
        self.assertEqual(len(groups), 3)
        self.assertEqual(sorted(g['finding_count'] for g in groups), [1, 1, 2])
        self.assertEqual(entries[0]['root_cause_key'], entries[1]['root_cause_key'])
        self.assertEqual(entries[0]['finding'], fs[0])

    def test_reviewed_template_file_set_and_order_stability(self):
        fs = [finding(1, message='Bad Foo', path='a.ts'), finding(2, message='Bad Bar', path='b.ts')]
        a = {f['id']: {'verdict': 'pre-existing-shown', 'reason': 'shared config evidence',
                       'message_template': 'Bad {symbol}', 'file_set': ['b.ts', 'a.ts', 'a.ts']}
             for f in fs}
        _, groups = e.dedupe(fs, a)
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]['file_set'], ['a.ts', 'b.ts'])
        self.assertEqual(groups, e.dedupe(list(reversed(fs)), a)[1])

    def test_conflicting_verdicts_and_missing_ids_rejected(self):
        fs = [finding(1), finding(2)]
        a = {fs[0]['id']: {'verdict': 'false-positive', 'reason': 'oracle'},
             fs[1]['id']: {'verdict': 'true-positive', 'reason': 'oracle'}}
        with self.assertRaisesRegex(ValueError, 'conflicting'):
            e.dedupe(fs, a)
        with self.assertRaisesRegex(ValueError, 'match'):
            e.dedupe(fs, {})

    def test_locations_are_not_counted_twice(self):
        f = finding()
        self.assertEqual(e.occurrences(f), 1)
        f['locations'].append({**f['location'], 'line_start': 8, 'line_end': 8})
        self.assertEqual(e.occurrences(f), 2)

    def test_override_cannot_drop_the_actual_file(self):
        f = finding()
        annotation = {'verdict': 'true-positive', 'reason': 'oracle', 'file_set': ['other.ts']}
        with self.assertRaisesRegex(ValueError, 'every finding path'):
            e.dedupe([f], {f['id']: annotation})


class AggregationTests(unittest.TestCase):
    def test_environment_failures_excluded_and_semantic_misses_separate(self):
        good = record(1, ['true-positive'], control=True)
        excluded = record(2, ['false-positive'], baseline=False)
        excluded['misses'] = [{'id': 'semantic', 'scope_class': 'agent-layer',
                               'description': 'predicate semantics', 'evidence': 'reproduction'}]
        missed = record(3, control=True)
        summary = e.aggregate([good, excluded, missed], ['1.json', '2.json', '3.json'])
        self.assertEqual(summary['eligible']['precision'], 1)
        self.assertEqual(summary['eligible']['positive_control_recall'], .5)
        self.assertEqual(summary['observed_raw_counts']['false-positive'], 1)
        self.assertEqual(summary['eligible']['cause_counts']['false-positive'], 0)
        self.assertEqual(len(summary['agent_layer_backlog']), 1)
        self.assertEqual(summary['deterministic_misses'], 1)
        self.assertEqual(len(summary['environment_failures']), 1)
        self.assertEqual(summary['decision'], 'insufficient-evidence')

    def test_raw_multiplicity_does_not_weight_precision(self):
        r = record(1, ['true-positive'] * 20)
        fp = record(2, ['false-positive'])
        s = e.aggregate([r, fp], ['1', '2'])
        self.assertEqual(s['eligible']['precision'], .5)
        self.assertEqual(s['eligible']['raw_counts']['true-positive'], 20)
        self.assertEqual(s['eligible']['false_positive_per_pr'], .5)

    def test_empty_denominators_and_all_excluded(self):
        for records in ([], [record(1, baseline=False)]):
            s = e.aggregate(records, [str(i) for i in range(len(records))])
            self.assertIsNone(s['eligible']['precision'])
            self.assertIsNone(s['eligible']['positive_control_recall'])
            self.assertIsNone(s['eligible']['usefulness_fraction'])
            self.assertEqual(s['decision'], 'insufficient-evidence')

    def test_clean_confirmation_and_actionable_definition(self):
        self.assertEqual(record(1, clean=True)['verdict'], 'useful')
        self.assertEqual(record(1)['verdict'], 'not-useful')
        self.assertEqual(record(1, clean=True, baseline=False)['verdict'], 'environment-failure')
        self.assertEqual(record(1, ['pre-existing-shown'], clean=True)['verdict'], 'not-useful')
        self.assertEqual(record(1, ['true-positive', 'false-positive'])['verdict'], 'useful')

    def test_full_sample_go_and_threshold_no_go(self):
        records = [record(i, ['true-positive'], control=True,
                          lang='typescript' if i <= 5 else 'python') for i in range(1, 11)]
        records += [record(11, clean=True)]
        paths = [str(i) for i in range(len(records))]
        self.assertEqual(e.aggregate(records, paths)['decision'], 'go')
        # Three FP causes across 14 PRs violates <.15 even with precision >.8.
        records += [record(i, ['false-positive']) for i in range(12, 15)]
        self.assertEqual(e.aggregate(records, [str(i) for i in range(len(records))])['decision'], 'no-go')

    def test_duplicate_cohort_and_tampered_records_rejected(self):
        r = record()
        with self.assertRaisesRegex(ValueError, 'duplicate case'):
            e.aggregate([r, r], ['a', 'b'])
        r['environment']['eligible'] = False
        with self.assertRaisesRegex(ValueError, 'environment'):
            e.validate_record(r)

    def test_false_positive_cannot_satisfy_positive_control(self):
        r = record(1, ['false-positive'], control=True)
        r['positive_control']['expected'][0]['finding_ids'] = [r['findings'][0]['finding']['id']]
        with self.assertRaisesRegex(ValueError, 'true-positive'):
            e.validate_record(r)

    def test_undetected_control_creates_a_scoped_miss(self):
        r = record(1, control=True)
        self.assertEqual(len(r['misses']), 1)
        self.assertEqual(r['misses'][0]['scope_class'], 'deterministic')
        self.assertEqual(r['misses'][0]['expectation_id'], 'bug-1')
        self.assertEqual(r['misses'][0]['mechanism'], 'type-error')
        r['misses'] = []
        with self.assertRaisesRegex(ValueError, 'deterministic miss'):
            e.validate_record(r)

    def test_successful_baseline_accepts_trusted_and_cached(self):
        r = report()
        r['checks'][0]['dependency_state'] = 'trusted'
        env = e.environment(r)
        self.assertTrue(env['baseline_ran'])
        self.assertTrue(env['baseline_classification_ran'])
        self.assertTrue(env['eligible'])
        self.assertEqual(env['dependency_state'], 'mixed')
        r['checks'][0]['dependency_state'] = 'verified'
        r['checks'][0]['cached'] = True
        self.assertTrue(e.environment(r)['eligible'])

    def test_verified_only_metrics_exclude_trusted_and_mixed_pairs(self):
        verified = record(1, ['true-positive'])
        trusted = record(2, ['false-positive'])
        for c in trusted['environment']['checks']:
            c['dependency_state'] = 'trusted'
        trusted['environment'] = e.environment({'checks': trusted['environment']['checks'],
            'status': trusted['status'], 'footer': {'notes': []}})
        summary = e.aggregate([verified, trusted], ['verified', 'trusted'])
        self.assertEqual(summary['eligible']['precision'], .5)
        self.assertEqual(summary['verified_only']['precision'], 1)
        self.assertEqual(summary['dependency_states'], {'verified': 1, 'trusted': 1})
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'result.md'
            e.render([verified, trusted], ['verified', 'trusted'], summary, 'test', output)
            text = output.read_text()
            self.assertIn('Verified only', text)
            self.assertIn('Dependencies: `trusted`; eligible: `true`', text)

    def test_every_applicable_root_needs_both_successful_versions(self):
        for outcome in ('failed', 'cancelled', 'skipped'):
            r = report()
            r['checks'][0].update(outcome=outcome, reason='tool_missing')
            self.assertFalse(e.environment(r)['eligible'])
        r = report()
        r['checks'].append({**r['checks'][0], 'root': 'other'})
        self.assertFalse(e.environment(r)['eligible'])
        r = report()
        r['checks'][1]['dependency_state'] = 'unavailable'
        self.assertFalse(e.environment(r)['eligible'])
        self.assertFalse(e.environment({'checks': [], 'status': 'complete',
                                       'footer': {'notes': []}})['eligible'])

    def test_deliberate_disabled_and_unconfigured_checks_are_inapplicable(self):
        r = report()
        for reason in ('disabled', 'no_project_config'):
            r['checks'].append({**r['checks'][1], 'kind': 'lint', 'outcome': 'skipped',
                                'reason': reason})
        self.assertTrue(e.environment(r)['eligible'])
        r['checks'].append({**r['checks'][1], 'kind': 'coverage', 'outcome': 'skipped',
                            'reason': 'tool_missing'})
        self.assertFalse(e.environment(r)['eligible'])

    def test_hidden_states_derived_from_report_for_findings_and_risks(self):
        for state in ('pre-existing', 'fixed'):
            for collection in ('findings', 'risks'):
                r = report()
                f = finding(); f['state'] = state
                r[collection] = [f]
                v = e.skeleton(r, 'o/r', 'https://github.com/o/r/pull/1', ['typescript'])
                v.update(reviewer='oracle', independently_clean=True)
                v['findings'][f['id']] = {'verdict': 'false-positive', 'reason': 'oracle'}
                built = e.build_record(r, v, 'raw.json')
                self.assertEqual(built['findings'][0]['verdict'], 'pre-existing-hidden')
                self.assertEqual(built['findings'][0]['finding'], f)
                self.assertEqual(built['verdict'], 'useful')
                summary = e.aggregate([built], ['record'])
                self.assertIsNone(summary['eligible']['precision'])
                self.assertEqual(summary['eligible']['cause_counts']['pre-existing-hidden'], 1)
        for state in ('new', 'worsened', 'unclassified'):
            f = finding(); f['state'] = state
            annotation = {f['id']: {'verdict': 'pre-existing-shown', 'reason': 'base oracle'}}
            self.assertEqual(e.dedupe([f], annotation)[0][0]['verdict'], 'pre-existing-shown')
            annotation[f['id']]['verdict'] = 'pre-existing-hidden'
            with self.assertRaisesRegex(ValueError, 'hidden raw'):
                e.dedupe([f], annotation)

    def test_same_cause_hidden_occurrences_do_not_conflict_with_visible(self):
        fs = [finding(1), finding(2)]
        fs[1]['state'] = 'pre-existing'
        annotations = {f['id']: {'verdict': 'true-positive', 'reason': 'oracle'} for f in fs}
        _, causes = e.dedupe(fs, annotations)
        self.assertEqual({c['verdict'] for c in causes}, {'true-positive', 'pre-existing-hidden'})
        self.assertEqual(len({c['root_cause_key'] for c in causes}), 1)

    def test_schema_rejects_wrong_rio_fields_and_advisory_missing(self):
        r = record(1, ['true-positive'])
        r['findings'][0]['finding']['rio_state'] = 'new'
        with self.assertRaises(ValueError):
            e.validate_record(r)
        f = finding(); f['rule_id'] = 'dependency/osv'
        with self.assertRaises(ValueError):
            e.validate(f, e.ROOT / 'schemas/finding-v1.json')

    def test_profiles_can_mix_but_binary_versions_need_explicit_override(self):
        a, b = record(1, clean=True), record(2, clean=True)
        a.update(rio_binary_sha256='a' * 64, profile_sha256='1' * 64)
        b.update(rio_binary_sha256='a' * 64, profile_sha256='2' * 64, profile='custom')
        s = e.aggregate([a, b], ['a', 'b'])
        self.assertEqual(s['profile_hashes'], ['1' * 64, '2' * 64])
        self.assertFalse(s['mixed_versions'])
        self.assertEqual(s['record_profiles'][1]['profile'], 'custom')
        b['rio_binary_sha256'] = 'b' * 64
        with self.assertRaisesRegex(ValueError, 'different Rio versions'):
            e.aggregate([a, b], ['a', 'b'])
        s = e.aggregate([a, b], ['a', 'b'], allow_mixed_versions=True)
        self.assertTrue(s['mixed_versions'])
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'result.md'
            e.render([a, b], ['a', 'b'], s, 'test', output)
            self.assertIn('MIXED RIO VERSIONS', output.read_text())
            self.assertIn('Profile: `custom`; SHA-256: `' + '2' * 64, output.read_text())

    def test_selection_latest_eligible_manifest_and_helpful_duplicates(self):
        a = record(1, baseline=False)
        b = record(1, clean=True)
        # Same real PR with a retry suffix must still be a duplicate.
        a['case_id'] += '-attempt1'
        a['run_id'], b['run_id'] = '01-old', '02-new'
        with self.assertRaisesRegex(ValueError, 'a.json, b.json.*--select'):
            e.aggregate([a, b], ['a.json', 'b.json'])
        for policy in ('latest', 'eligible-only'):
            s = e.aggregate([a, b], ['a.json', 'b.json'], select=policy)
            self.assertEqual(s['records'], ['b.json'])
            self.assertEqual(s['selection']['omitted_records'], ['a.json'])
        with self.assertRaisesRegex(ValueError, 'duplicate case'):
            e.aggregate([b, b], ['a.json', 'b.json'], select='eligible-only')
        with tempfile.TemporaryDirectory() as tmp:
            manifest = Path(tmp) / 'selection.json'
            paths = [str(Path(tmp) / p) for p in ('a.json', 'b.json')]
            e.write_json(manifest, ['b.json'])
            s = e.aggregate([a, b], paths, select=str(manifest))
            self.assertEqual(s['records'], paths[1:])
            output = Path(tmp) / 'result.md'
            e.render([a, b], paths, s, 'test', output)
            self.assertNotIn('attempt1', output.read_text())
            e.write_json(manifest, ['missing.json'])
            with self.assertRaisesRegex(ValueError, 'not inputs'):
                e.aggregate([a, b], paths, select=str(manifest))
            e.write_json(manifest, ['b.json', 'b.json'])
            with self.assertRaisesRegex(ValueError, 'duplicate record paths'):
                e.aggregate([a, b], paths, select=str(manifest))

    def test_captured_provenance_is_used_without_inventing_hashes(self):
        r = report()
        v = e.skeleton(r, 'o/r', 'https://github.com/o/r/pull/1', ['typescript'])
        v['reviewer'] = 'oracle'
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'report.json'
            self.assertIsNone(e.build_record(r, v, path)['rio_binary_sha256'])
            e.write_json(path.with_name('commands.json'), {'rio_binary_sha256': 'a' * 64,
                         'resolved_profile_sha256': 'b' * 64})
            built = e.build_record(r, v, path)
            self.assertEqual(built['rio_binary_sha256'], 'a' * 64)
            self.assertEqual(built['profile_sha256'], 'b' * 64)

    def test_seeded_controls_cannot_supply_more_than_half_of_decision_sample(self):
        records = [record(i, ['true-positive'], control=True,
                          lang='typescript' if i <= 5 else 'python') for i in range(1, 11)]
        records.append(record(11, clean=True))
        for r in records[:6]:
            r['positive_control']['kind'] = 'seeded-mutation'
        summary = e.aggregate(records, [str(i) for i in range(len(records))])
        self.assertEqual(summary['eligible']['positive_control_by_kind']['real-pr']['recall'], 1)
        self.assertEqual(summary['eligible']['positive_control_by_kind']['seeded-mutation']['recall'], 1)
        self.assertEqual(summary['sample']['counted_positive_controls'], 8)
        self.assertEqual(summary['decision'], 'insufficient-evidence')
        self.assertTrue(any('50%' in r for r in summary['decision_reasons']))
        records[5]['positive_control']['kind'] = 'real-pr'
        # Restore sufficient real PRs as mutations do not count as public PRs.
        records += [record(i, clean=True) for i in range(12, 17)]
        summary = e.aggregate(records, [str(i) for i in range(len(records))])
        self.assertEqual(summary['sample']['counted_positive_controls'], 10)
        self.assertEqual(summary['decision'], 'go')

    def test_renderer_compacts_root_causes_and_links_records(self):
        r = record(1, ['true-positive'] * 100)
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'evaluation.md'
            s = e.aggregate([r], ['records/1.json'])
            e.render([r], ['records/1.json'], s, 'test', output)
            text = output.read_text()
            self.assertEqual(text.count('| `'), 1)
            self.assertIn('| 100 | 100 |', text)
            self.assertIn('records/1.json', text)
            self.assertNotIn(r['findings'][0]['finding']['id'], text)


if __name__ == '__main__':
    unittest.main()

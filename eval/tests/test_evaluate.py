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
        self.assertEqual(summary['deterministic_misses'], 0)
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

    def test_successful_baseline_must_be_verified(self):
        r = report()
        r['checks'][0]['dependency_state'] = 'trusted'
        env = e.environment(r)
        self.assertTrue(env['baseline_ran'])
        self.assertFalse(env['baseline_classification_ran'])
        self.assertFalse(env['eligible'])
        r['checks'][0]['dependency_state'] = 'verified'
        r['checks'][0]['cached'] = True
        self.assertTrue(e.environment(r)['eligible'])

    def test_schema_rejects_wrong_rio_fields_and_advisory_missing(self):
        r = record(1, ['true-positive'])
        r['findings'][0]['finding']['rio_state'] = 'new'
        with self.assertRaises(ValueError):
            e.validate_record(r)
        f = finding(); f['rule_id'] = 'dependency/osv'
        with self.assertRaises(ValueError):
            e.validate(f, e.ROOT / 'schemas/finding-v1.json')

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

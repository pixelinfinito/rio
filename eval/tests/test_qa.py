import importlib.util
import json
import tempfile
from pathlib import Path
import unittest
from unittest.mock import patch
from types import SimpleNamespace
import subprocess

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('qa_eval', ROOT / 'eval/qa/run.py')
qa = importlib.util.module_from_spec(spec)
spec.loader.exec_module(qa)


class QaEvaluationTests(unittest.TestCase):
    def test_fixture_setup_failure_is_a_reported_coverage_gap_without_a_fake_report(self):
        case = {'id': 'missing-confirmation', 'kind': 'defect', 'rules': ['ui/no-feedback'], 'journeys': ['checkout'], 'flags': []}
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            for failure in [subprocess.CalledProcessError(128, ['git'], stderr=b'private machine configuration'), OSError(28, 'No space left on device')]:
                with patch.object(qa.subprocess, 'run', side_effect=failure) as command:
                    row = qa.run_case(case, SimpleNamespace(), output)
                self.assertEqual(row['error'], 'fixture_setup_failed')
                self.assertTrue(row['miss'])
                self.assertFalse(row['qa_present'])
                self.assertEqual(row['completed_cells'], 0)
                self.assertEqual(command.call_count, 1)
                self.assertNotIn('private machine configuration', json.dumps(row))
                self.assertFalse((output / 'missing-confirmation.json').exists())

    def test_every_fixture_variant_has_an_independent_label(self):
        flags = json.loads((ROOT / 'tests/fixtures/qa-sample/defects.json').read_text())
        cases = json.loads(qa.CASES.read_text())['cases']
        self.assertEqual(set(flags), {flag for case in cases for flag in case['flags']})
        self.assertEqual(len(cases), len({case['id'] for case in cases}))
        self.assertEqual(next(case for case in cases if case['id'] == 'intentional-brand')['kind'], 'clean')

    def test_local_matches_do_not_claim_verification_or_human_precision(self):
        case = {'id': 'confirmation', 'kind': 'defect', 'rules': ['ui/no-feedback'], 'journeys': ['checkout']}
        report = {'status': 'partial', 'qa': {'observations_unverified': [
            {'rule_id': 'ui/no-feedback', 'journey': 'checkout', 'cell': {'viewport': name}} for name in ['mobile', 'desktop']
        ], 'journeys': [{'name': 'checkout', 'cells': [{'outcome': 'failed'}]}], 'cost': {'tokens': None, 'usd': None, 'wall_time_ms': 100}}}
        row = qa.score(case, report)
        self.assertTrue(row['detected'])
        self.assertEqual(row['verified_matches'], 0)
        self.assertEqual(row['unverified_matches'], 1)
        self.assertIsNone(row['cost']['average_usd_per_completed_cell'])
        summary = qa.summarize([row])
        self.assertEqual(summary['metrics']['rule_match_recall'], 1)
        self.assertIsNone(summary['metrics']['human_confirmed_precision'])

    def test_clean_recommendation_is_noise_and_ux_quality_requires_adjudication(self):
        report = json.loads((ROOT / 'crates/rio-core/tests/qa-fixtures/report.json').read_text())
        case = {'id': 'clean', 'kind': 'clean', 'rules': [], 'journeys': []}
        row = qa.score(case, report)
        self.assertEqual(row['clean_noise_count'], 2)
        self.assertFalse(row['detected'])
        review = row['recommendation_review'][0]
        for field in ['guidance_adherence', 'relevance', 'actionability', 'unsupported_benefit_claim']:
            self.assertIsNone(review[field])
        case.update(kind='ux', rules=['ux/task-efficiency'])
        ux = qa.score(case, report)
        self.assertEqual(ux['recommendation_ids'], ['ux-address-reuse'])
        self.assertFalse(ux['detected'], 'Recommendations must not inflate defect recall')

    def test_cell_metrics_use_the_exact_run_and_do_not_duplicate_shared_chains(self):
        case = {'id': 'confirmation', 'kind': 'defect', 'rules': [], 'journeys': []}
        report = {'review': {'id': 'a' * 16, 'run_id': '01J00000000000000000000000'},
                  'qa': {'journeys': [{'name': name, 'cells': [{'outcome': 'passed'}]} for name in ['cart', 'checkout']]}}
        metric = {'id': 'b' * 64, 'version': 'head', 'scope': 'browser_chain_cell', 'chain': ['cart', 'checkout'],
                  'journeys': ['cart', 'checkout'], 'cell': {'viewport': 'mobile', 'color_scheme': 'light'},
                  'wall_time_ms': 1250, 'tokens': 40, 'usage_estimated': False, 'usd': None}
        with tempfile.TemporaryDirectory() as directory:
            cache = Path(directory)
            path = cache / report['review']['id'] / 'runs' / report['review']['run_id'] / 'qa/result.json'
            path.parent.mkdir(parents=True)
            path.write_text(json.dumps({'cell_metrics': [metric]}))
            metrics = qa.retained_cell_metrics(report, cache)
            row = qa.score(case, report, cell_metrics=metrics)
            self.assertEqual(row['completed_cells'], 2)
            self.assertEqual(row['cost']['cells'], [metric])
            self.assertTrue(row['cost']['cell_metrics_available'])
            self.assertIsNone(row['cost']['cells'][0]['usd'])
            base_metric = {**metric, 'id': 'c' * 64, 'version': 'base', 'tokens': 25, 'wall_time_ms': 900}
            baseline = {'cell_metrics': [base_metric]}
            path.write_text(json.dumps({'cell_metrics': [metric], 'baseline': baseline}))
            path.with_name('baseline.json').write_text(json.dumps(baseline))
            self.assertEqual(qa.retained_cell_metrics(report, cache), [metric, base_metric])
            path.write_text(json.dumps({'cell_metrics': [metric], 'baseline': {'outcome': 'partial'}}))
            self.assertEqual(qa.retained_cell_metrics(report, cache), [metric], 'Unavailable baseline has no invented metrics')
            report['review']['run_id'] = '01J00000000000000000000001'
            self.assertEqual(qa.retained_cell_metrics(report, cache), [])
            report['review']['id'] = '../outside'
            self.assertEqual(qa.retained_cell_metrics(report, cache), [])
        self.assertFalse(qa.score(case, report)['cost']['cell_metrics_available'])

    def test_missing_or_incomplete_reports_keep_misses(self):
        case = {'id': 'confirmation', 'kind': 'defect', 'rules': ['ui/no-feedback'], 'journeys': ['checkout']}
        row = qa.score(case, {})
        self.assertTrue(row['miss'])
        self.assertFalse(row['qa_present'])
        self.assertEqual(qa.summarize([row])['metrics']['rule_match_recall'], 0)
        self.assertIsNone(qa.summarize([row])['metrics']['rule_match_precision'])

    def test_human_ux_labels_bind_to_the_run_and_do_not_change_defect_metrics(self):
        report = json.loads((ROOT / 'crates/rio-core/tests/qa-fixtures/report.json').read_text())
        report['review']['run_id'] = 'original-run'
        case = {'id': 'duplicate-address', 'kind': 'ux', 'rules': ['ux/task-efficiency'], 'journeys': []}
        label = {'run_id': 'original-run', 'id': 'ux-address-reuse', 'reviewer': 'test reviewer',
                 'evidence_notes': 'Test adjudication of retained checkout evidence.',
                 'guidance_adherence': 2, 'relevance': 1, 'actionability': 2, 'unsupported_benefit_claim': False}
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'labels.json'
            path.write_text(json.dumps({'version': 1, 'labels': [label]}))
            labels = qa.load_labels(path)
        original = qa.score(case, report)
        before = qa.summarize([original])
        self.assertIsNone(before['ux_metrics']['mean_relevance'])
        self.assertEqual(before['ux_metrics']['pending_human_labels'], 1)
        after = qa.summarize([qa.apply_labels(original, labels)])
        self.assertEqual(after['metrics'], before['metrics'])
        self.assertEqual(after['ux_metrics']['human_labeled'], 1)
        self.assertEqual(after['ux_metrics']['mean_relevance'], 1)
        self.assertEqual(after['ux_metrics']['unsupported_benefit_claims'], 0)
        report['review']['run_id'] = 'different-run'
        other = qa.summarize([qa.apply_labels(qa.score(case, report), labels)])
        self.assertEqual(other['ux_metrics']['human_labeled'], 0)
        self.assertIsNone(other['ux_metrics']['unsupported_benefit_claims'])

    def test_human_labels_reject_missing_provenance_invalid_scores_and_duplicates(self):
        label = {'run_id': 'run', 'id': 'recommendation', 'reviewer': 'test reviewer', 'evidence_notes': 'Test evidence.',
                 'guidance_adherence': 2, 'relevance': 1, 'actionability': 2, 'unsupported_benefit_claim': False}
        invalid = [
            [{**label, 'guidance_adherence': True}], [{**label, 'relevance': 3}],
            [{**label, 'unsupported_benefit_claim': None}], [{**label, 'reviewer': ''}],
            [{**label, 'evidence_notes': ''}], [label, label],
        ]
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'labels.json'
            for entries in invalid:
                path.write_text(json.dumps({'version': 1, 'labels': entries}))
                with self.assertRaises(ValueError):
                    qa.load_labels(path)


if __name__ == '__main__':
    unittest.main()

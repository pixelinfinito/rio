"""Council evaluation (rio-v0-3-council group 6): metrics, A/B guard, weights and the gate."""
import contextlib
import copy
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import council  # noqa: E402
import evaluate as e  # noqa: E402
import gate  # noqa: E402

FIXTURES = e.ROOT / 'crates/rio-core/tests/fixtures'
ROLES = council.ROLES


def finding(index, level='plausible', block=None, category='risk', response=None):
    f = e.read_json(FIXTURES / 'finding.json')
    f.update(id=f'{index:064x}', rule_id=f'agent/x/{index}', category=category, evidence_level=level,
             source={'agent': 'security'}, message=f'Finding {index}')
    if block:
        f['council'] = block
    if response:
        f['author_response'] = {'reason': response, 'actor': 'dev', 'at': '2026-11-01T10:00:00Z'}
    return f


def block(decision, skipped=False):
    base = {'members': [{'role': r, 'abstained': False} for r in ROLES], 'experiments': [],
            'partial': False, 'answered': 5, 'total': 5}
    if skipped:
        return {**base, 'skipped': True, 'answered': 1}
    tier = {'reproduced': 'experiment', 'refuted': 'protection', 'plausible': 'judgment'}[decision]
    return {**base, 'decision': decision, 'tier': tier, 'note': 'In words.'}


def cost(experiments=1):
    return {'members': 5, 'rounds': 2, 'experiments': experiments,
            'tokens': {'anthropic': 1000, 'openai': 800}, 'runner_seconds': 10 * experiments}


def report(risks=(), refuted=(), metrics=True):
    r = e.read_json(FIXTURES / 'complete.json')
    r['findings'], r['risks'] = [], list(risks)
    councilled = [f for f in list(risks) + list(refuted) if f.get('council')]
    if metrics and councilled:
        r['council'] = {'councilled': len(councilled), 'not_councilled': 0,
                        'findings': [{'id': f['id'], 'status': 'complete', 'answered': 5, 'total': 5,
                                      'cost': cost()} for f in councilled],
                        'total': {**cost(len(councilled)), 'members': 5 * len(councilled),
                                  'rounds': 2 * len(councilled)}}
        if refuted:
            r['council']['refuted'] = list(refuted)
    return r


def assessment(role, real='yes', basis='static_path', introduced='yes'):
    return {'assessment': {'member': role, 'round': 1, 'real': real, 'introduced_by_change': introduced,
                           'impact': 'x', 'basis': basis, 'evidence_refs': ['file-1']}}


def write_run(root, arm, reports, answers=None, case_set='plausible-2026-11', date='2026-11-08'):
    root = Path(root)
    root.mkdir(parents=True, exist_ok=True)
    (root / 'run.json').write_text(json.dumps({'arm': arm, 'case_set': case_set, 'date': date}))
    for case, doc in reports.items():
        e.write_json(root / case / 'report.json', doc)
    for (case, finding_id), given in (answers or {}).items():
        for role, stored in given.items():
            e.write_json(root / case / 'council' / finding_id / f'{role}-r1.json', stored)
    return root


def outcomes(cases, case_set='plausible-2026-11'):
    return {'schema': 'rio-council-outcomes-v1', 'case_set': case_set, 'cases': cases}


class Fixture:
    """Two cases: one finding reproduced, one refuted, one left plausible; known outcomes."""

    def __init__(self, tmp):
        self.tmp = Path(tmp)
        a, b, c = finding(1), finding(2), finding(3)
        council_reports = {
            'case-a': report([finding(1, 'reproduced', block('reproduced')),
                              finding(3, 'plausible', block('plausible'))]),
            'case-b': report(refuted=[finding(2, 'refuted', block('refuted'))]),
        }
        # Verifier-only: everything stayed plausible.
        baseline_reports = {'case-a': report([a, c], metrics=False), 'case-b': report([b], metrics=False)}
        agreeing = {r: assessment(r) for r in ROLES}
        split = {**agreeing, 'skeptic': assessment('skeptic', real='no', basis='protection_found'),
                 'tester': assessment('tester', real='no', basis='none')}
        wording = {r: assessment(r, basis=b) for r, b in
                   zip(ROLES, ('static_path', 'reproduction', 'none', 'static_path', 'none'))}
        self.council = write_run(self.tmp / 'council', 'council', council_reports, {
            ('case-a', a['id']): agreeing, ('case-a', c['id']): wording, ('case-b', b['id']): split})
        self.baseline = write_run(self.tmp / 'baseline', 'verifier-only', baseline_reports)
        self.outcomes = self.tmp / 'outcomes.json'
        e.write_json(self.outcomes, outcomes({'case-a': {a['id']: 'real', c['id']: 'not_real'},
                                              'case-b': {b['id']: 'not_real'}}))


class CouncilSummaryTests(unittest.TestCase):
    def test_metrics_from_recorded_runs(self):
        with tempfile.TemporaryDirectory() as tmp:
            fx = Fixture(tmp)
            summary = council.summarize(fx.outcomes, fx.council, fx.baseline, Path(tmp) / 'none.json')
        # Disagreement on real separates from disagreement in basis only.
        self.assertEqual(summary['disagreement'], {'councilled': 3, 'disagreeing': 1, 'basis_disagreeing': 2,
                                                   'rate': 1 / 3, 'basis_rate': 2 / 3})
        acc = summary['accuracy']
        self.assertEqual(acc['council'], {'cases': 3, 'correct': 2, 'promoted': 1, 'promoted_correctly': 1,
                                          'refuted': 1, 'refuted_correctly': 1, 'accuracy': 2 / 3})
        self.assertEqual(acc['verifier_only']['correct'], 0)
        self.assertAlmostEqual(acc['difference'], 2 / 3)
        self.assertEqual(len(summary['cost']['per_finding']), 3)
        self.assertEqual(summary['cost']['per_finding'][0]['cost'], cost())
        self.assertEqual(summary['cost']['total']['experiments'], 3)
        self.assertEqual(summary['cost']['mean_tokens_per_finding'], (3 * 1000 + 3 * 800) / 3)

    def test_five_yes_with_different_bases_is_agreement_on_real_and_a_basis_disagreement(self):
        with tempfile.TemporaryDirectory() as tmp:
            fx = Fixture(tmp)
            _, reports = council.read_run(fx.council)
            only = {'case-a': copy.deepcopy(reports['case-a'])}
            only['case-a']['risks'] = only['case-a']['risks'][1:]
            row = council.disagreement(fx.council, only)
        self.assertEqual((row['disagreeing'], row['basis_disagreeing']), (0, 1))

    def test_mismatched_case_sets_days_and_arms_are_refused_by_name(self):
        with tempfile.TemporaryDirectory() as tmp:
            fx = Fixture(tmp)
            other = write_run(Path(tmp) / 'other', 'verifier-only',
                              {'case-a': report(metrics=False)}, case_set='plausible-2026-11')
            with self.assertRaisesRegex(ValueError, r"verifier-only arm case set differs: missing \['case-b'\]"):
                council.summarize(fx.outcomes, fx.council, other)
            elsewhere = write_run(Path(tmp) / 'elsewhere', 'verifier-only', {}, case_set='other-set')
            with self.assertRaisesRegex(ValueError, "case sets differ"):
                council.summarize(fx.outcomes, fx.council, elsewhere)
            later = write_run(Path(tmp) / 'later', 'verifier-only', {}, date='2026-11-09')
            with self.assertRaisesRegex(ValueError, "different days"):
                council.summarize(fx.outcomes, fx.council, later)
            with self.assertRaisesRegex(ValueError, "expected council and verifier-only"):
                council.summarize(fx.outcomes, fx.baseline, fx.council)

    def test_a_summary_missing_an_arm_fails_validation(self):
        with tempfile.TemporaryDirectory() as tmp:
            fx = Fixture(tmp)
            summary = council.summarize(fx.outcomes, fx.council, fx.baseline)
        del summary['accuracy']['verifier_only']
        with self.assertRaises(ValueError):
            e.validate(summary, council.SUMMARY_SCHEMA)

    def test_cli_writes_a_valid_summary_and_reports_input_errors(self):
        with tempfile.TemporaryDirectory() as tmp:
            fx = Fixture(tmp)
            out = Path(tmp) / 'summary.json'
            with contextlib.redirect_stdout(io.StringIO()):
                code = council.main(['summarize', '--outcomes', str(fx.outcomes), '--council', str(fx.council),
                                     '--baseline', str(fx.baseline), '--out', str(out)])
            self.assertEqual(code, 0)
            e.validate(e.read_json(out), council.SUMMARY_SCHEMA)
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(council.main(['summarize', '--outcomes', str(fx.outcomes), '--council',
                                               str(fx.baseline), '--baseline', str(fx.council),
                                               '--out', str(out)]), 2)


class WeightTests(unittest.TestCase):
    def runs(self, tmp, cases, real_answer='yes'):
        reports, answers = {}, {}
        for i in range(cases):
            outcome = 'fixed' if i % 3 else 'wrong'
            f = finding(100 + i, block=block('plausible'), category='security', response=outcome)
            reports[f'case-{i:03}'] = report([f])
            answers[(f'case-{i:03}', f['id'])] = {
                'skeptic': assessment('skeptic', real='no'),
                'tester': assessment('tester', real=real_answer)}
        return write_run(Path(tmp) / f'run-{cases}', 'council', reports, answers)

    def test_thirty_case_floor_and_sample_sizes(self):
        with tempfile.TemporaryDirectory() as tmp:
            small = council.estimate([self.runs(tmp, 12)])
            large = council.estimate([self.runs(tmp, 30)])
        self.assertEqual(small['rio/council-tester']['security'],
                         {'weight': None, 'samples': 12, 'precision': 0.6667, 'recall': 1.0})
        tester = large['rio/council-tester']['security']
        self.assertEqual(tester['samples'], 30)
        self.assertAlmostEqual(tester['weight'], 2 * (2 * (2 / 3) * 1.0) / (2 / 3 + 1.0), places=3)
        # A member that never says real has no recall: the floor weight, never zero.
        self.assertEqual(large['rio/council-skeptic']['security']['weight'], 0.05)

    def test_estimation_is_deterministic(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = self.runs(tmp, 31)
            first = json.dumps(council.estimate([run]), sort_keys=True)
            second = json.dumps(council.estimate([run]), sort_keys=True)
        self.assertEqual(first, second)

    def test_outcome_files_take_precedence_over_author_responses(self):
        with tempfile.TemporaryDirectory() as tmp:
            run = self.runs(tmp, 3)
            path = Path(tmp) / 'outcomes.json'
            e.write_json(path, outcomes({'case-000': {finding(100)['id']: 'real'}}))
            weights = council.estimate([run], [path])
        # case-000 was answered `wrong` but its known outcome is real.
        self.assertEqual(weights['rio/council-tester']['security']['precision'], 1.0)


def summary(councilled, disagreeing, council_correct, baseline_correct, cases=40):
    def arm(correct):
        return {'cases': cases, 'correct': correct, 'promoted': correct, 'promoted_correctly': correct,
                'refuted': 0, 'refuted_correctly': 0, 'accuracy': correct / cases}
    return {'schema': 'rio-eval-council-v1', 'case_set': 'plausible', 'date': '2026-11-08',
            'disagreement': {'councilled': councilled, 'disagreeing': disagreeing, 'basis_disagreeing': 0,
                             'rate': disagreeing / councilled, 'basis_rate': 0.0},
            'accuracy': {'council': arm(council_correct), 'verifier_only': arm(baseline_correct),
                         'difference': (council_correct - baseline_correct) / cases},
            'cost': {'per_finding': [], 'per_review': [], 'total': council.empty_cost(),
                     'mean_tokens_per_finding': None},
            'weights': {}}


class CouncilGateTests(unittest.TestCase):
    def test_low_disagreement_removes_the_step_from_both_profiles(self):
        result = gate.council_gate([summary(100, 3, 30, 20)])
        self.assertFalse(result['passed'])
        self.assertIn('3.0% is below 5%', result['reasons'][0])
        self.assertEqual(result['action'],
                         'remove the rio/council step from rio/security and rio/critical in this release')

    def test_accuracy_not_above_the_baseline_removes_the_step(self):
        result = gate.council_gate([summary(100, 11, 20, 20)])
        self.assertFalse(result['passed'])
        self.assertIn('does not exceed verifier-only', result['reasons'][0])

    def test_disagreement_and_better_accuracy_keep_the_step(self):
        result = gate.council_gate([summary(50, 6, 15, 10), summary(50, 5, 15, 10)])
        self.assertTrue(result['passed'])
        self.assertAlmostEqual(result['disagreement']['rate'], 0.11)
        self.assertIsNone(result['action'])
        with contextlib.redirect_stdout(io.StringIO()) as out, tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 's.json'
            e.write_json(path, summary(100, 11, 30, 20))
            self.assertEqual(gate.main(['council', '--summary', str(path)]), 0)
        self.assertIn('KEEP', out.getvalue())



class IncompleteReviewTests(unittest.TestCase):
    def test_an_incomplete_review_earns_no_refutation_by_omission(self):
        empty = report()
        empty['status'] = 'incomplete'
        outcome = outcomes({'case-a': {finding(9)['id']: 'not_real'}})
        self.assertEqual(council.arm_accuracy({'case-a': empty}, outcome)['correct'], 0)
        # A completed review counts the absence only when it recorded the refutation.
        self.assertEqual(council.arm_accuracy({'case-a': report()}, outcome)['correct'], 0)
        recorded = report()
        recorded['agent_audit'] = {'refuted_ids': [finding(9)['id']]}
        self.assertEqual(council.arm_accuracy({'case-a': recorded}, outcome)['correct'], 1)


class WeightCategoryTests(unittest.TestCase):
    def test_weights_use_the_category_the_worker_looked_up(self):
        reports, answers = {}, {}
        for i in range(3):
            b = {**block('plausible'), 'weight_category': 'defect'}
            f = finding(300 + i, block=b, category='risk', response='fixed')
            reports[f'case-{i}'] = report([f])
            answers[(f'case-{i}', f['id'])] = {'tester': assessment('tester')}
        with tempfile.TemporaryDirectory() as tmp:
            run = write_run(Path(tmp) / 'run', 'council', reports, answers)
            weights = council.estimate([run])
        self.assertEqual(list(weights['rio/council-tester']), ['defect'])


class ClassFindingTests(unittest.TestCase):
    def test_instances_of_a_class_finding_are_present_not_refuted(self):
        cls = finding(500)
        instances = [finding(501), finding(502)]
        cls['locations'] = [{**copy.deepcopy(cls['location']), 'id': f['id']} for f in instances]
        outcome = outcomes({'case-a': {f['id']: 'not_real' for f in instances}})
        row = council.arm_accuracy({'case-a': report([cls], metrics=False)}, outcome)
        self.assertEqual((row['cases'], row['refuted'], row['correct']), (2, 0, 0))


class PreservedEvidenceTests(unittest.TestCase):
    def test_a_plausible_decision_scores_the_kept_verifier_level(self):
        kept = finding(600, 'static_proven', block('plausible'))
        outcome = outcomes({'case-a': {kept['id']: 'real'}})
        self.assertEqual(council.arm_accuracy({'case-a': report([kept])}, outcome)['correct'], 1)


class RememberedFindingTests(unittest.TestCase):
    def test_a_remembered_councilled_finding_still_scores(self):
        kept = finding(700, 'reproduced', block('reproduced'))
        r = report(metrics=False)
        r['remembered'] = [kept]
        outcome = outcomes({'case-a': {kept['id']: 'real'}})
        self.assertEqual(council.arm_accuracy({'case-a': r}, outcome)['correct'], 1)


class AliasTests(unittest.TestCase):
    def test_a_class_finding_counts_once_whatever_its_aliases(self):
        cls = finding(800, block=block('plausible'), category='security', response='fixed')
        cls['locations'] = [{**copy.deepcopy(cls['location']), 'id': f'{900 + i:064x}'} for i in range(30)]
        reports = {'case-a': report([cls])}
        answers = {('case-a', cls['id']): {'tester': assessment('tester'), 'skeptic': assessment('skeptic', real='no')}}
        with tempfile.TemporaryDirectory() as tmp:
            run = write_run(Path(tmp) / 'run', 'council', reports, answers)
            _, loaded = council.read_run(run)
            self.assertEqual(council.disagreement(run, loaded)['councilled'], 1)
            self.assertEqual(council.estimate([run])['rio/council-tester']['security']['samples'], 1)


if __name__ == '__main__':
    unittest.main()

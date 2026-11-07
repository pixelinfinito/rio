"""The v0.3 release gate: false positives per agent below 15 % (rio-v0-3-core task 10.1)."""
import contextlib
import copy
import io
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import evaluate as e  # noqa: E402
import gate  # noqa: E402
from test_convergence import finding, lineage_report  # noqa: E402


def responses(agent, wrong, other, start=0):
    """`wrong` + `other` responded findings by one agent, distinct identities."""
    reasons = ['wrong'] * wrong + [('fixed', 'intentional', 'irrelevant', 'style')[i % 4] for i in range(other)]
    return [finding(start + i + 1, reason=reason, agent=agent) for i, reason in enumerate(reasons)]


def noise_case(directory, case_id, labels, agent='contracts'):
    """A noise run case with one adjudicated finding per label (None stays unadjudicated)."""
    findings = {}
    for i, label in enumerate(labels):
        findings[f'{i + 1:064x}'] = {
            'finding': {'rule_id': 'contracts/signature/changed', 'category': 'risk', 'severity': 'warning',
                        'evidence_level': 'plausible', 'source': agent, 'path': 'src/api.ts', 'line_start': i + 1,
                        'message': f'Finding {i}'},
            'adjudication': {'label': label, 'adjudicator': None if label is None else 'reviewer',
                             'rationale': None if label is None else 'checked against the merged code'}}
    e.write_json(directory / case_id / 'adjudication.json', {
        'schema': 'rio-noise-adjudication-v1', 'repository': 'acme/api', 'case_id': case_id, 'pr': 7,
        'title': 'Refactor', 'base': 'a' * 40, 'head': 'b' * 40, 'report': 'report.json',
        'report_sha256': None, 'findings': findings})


class FalsePositiveRate(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def report(self, name, findings, **lineage):
        path = self.root / f'{name}.json'
        e.write_json(path, lineage_report(findings, 1, **lineage))
        return path

    def test_failing_passing_and_under_floor_agents(self):
        # correctness: 4 wrong of 30 (13.3 %) passes; security: 6 of 32 (18.8 %) fails;
        # contracts: 5 of 10 is far above 15 % but under the 30-response floor.
        found = (responses('correctness', 4, 26) + responses('security', 6, 26, start=100)
                 + responses('contracts', 5, 5, start=200))
        tool = finding(300, reason='wrong')
        tool['source'] = {'tool': 'eslint', 'version': '9'}
        path = self.report('reference', found + [tool])
        result = gate.false_positive_rate([path])
        agents = result['agents']
        self.assertEqual(set(agents), {'correctness', 'security', 'contracts'})
        self.assertEqual((agents['correctness']['wrong'], agents['correctness']['responses']), (4, 30))
        self.assertTrue(agents['correctness']['gated'] and agents['correctness']['passed'])
        self.assertAlmostEqual(agents['security']['rate'], 6 / 32)
        self.assertFalse(agents['security']['passed'])
        self.assertFalse(agents['contracts']['gated'])
        self.assertTrue(agents['contracts']['passed'])
        self.assertFalse(result['passed'])
        self.assertEqual(result['failed'], ['security: 6/32 = 18.8% false positives exceeds 15%'])
        self.assertEqual(result['under_floor'],
                         ['contracts: 10 responses, under the 30-response floor (5 wrong); reported, not gated'])

    def test_exactly_fifteen_percent_passes_and_rounds_count_once(self):
        # 6 of 40 = 15 % exactly; the same identities in a later round are not counted again.
        found = responses('correctness', 6, 34)
        first = self.report('round1', found, ref='feature/y')
        second = lineage_report(copy.deepcopy(found), 2, ref='feature/y')
        e.write_json(self.root / 'round2.json', second)
        result = gate.false_positive_rate([first, self.root / 'round2.json'])
        self.assertEqual(result['agents']['correctness']['responses'], 40)
        self.assertTrue(result['passed'])

    def test_noise_runs_count_harmful_as_wrong_and_skip_unadjudicated(self):
        run = self.root / 'noise' / '2026-11-07'
        noise_case(run, 'pr-7', ['harmful'] * 3 + ['neutral'] * 10 + ['useful'] * 7 + [None, None])
        noise_case(run, 'pr-8', ['harmful'] * 2 + ['neutral'] * 10)
        reports = self.report('reference', responses('contracts', 0, 2))
        result = gate.false_positive_rate([run, reports])
        row = result['agents']['contracts']
        self.assertEqual(row['noise'], {'harmful': 5, 'neutral': 20, 'useful': 7})
        self.assertEqual((row['wrong'], row['responses']), (5, 34))
        self.assertTrue(row['gated'] and row['passed'])
        self.assertEqual(result['sources'], {'reports': 1, 'noise_adjudications': 2})

    def test_gate_cli_adds_the_criterion_and_rejects_unknown_sources(self):
        card = {'schema': 'rio-eval-scorecard-v1', 'label': 'v0.3', 'rio_versions': [], 'profile_hashes': [],
                'precision': .9, 'recall': .85, 'historical_recall': None, 'mutation_recall': None,
                'incident_recall': None, 'case_recall': {'incident': None, 'historical': None, 'mutation': None},
                'cases': {}, 'missing_reports': []}
        e.write_json(self.root / 'card.json', card)
        failing = self.report('failing', responses('security', 6, 26))
        passing = self.report('passing', responses('security', 1, 29))
        base = ['gate', '--baseline', str(self.root / 'card.json'), '--candidate', str(self.root / 'card.json')]
        with contextlib.redirect_stdout(io.StringIO()) as out:
            self.assertEqual(gate.main(base + ['--false-positive-rate', str(failing)]), 1)
            self.assertEqual(gate.main(base + ['--false-positive-rate', str(passing),
                                               '--out', str(self.root / 'result.json')]), 0)
            self.assertEqual(gate.main(base), 0)
        self.assertIn('security: 6/32 = 18.8% false positives exceeds 15%', out.getvalue())
        self.assertIn('false positives security: 1/30 = 3.3%', out.getvalue())
        result = e.read_json(self.root / 'result.json')
        self.assertTrue(result['false_positive_rate']['agents']['security']['passed'])
        e.write_json(self.root / 'other.json', {'schema': 'rio-eval-summary-v1'})
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(gate.main(base + ['--false-positive-rate', str(self.root / 'other.json')]), 2)
        self.assertIn('expected a rio-report-v1 or rio-noise-adjudication-v1 document', err.getvalue())
        empty = self.report('empty', [])
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(gate.main(base + ['--false-positive-rate', str(empty)]), 1)


if __name__ == '__main__':
    unittest.main()

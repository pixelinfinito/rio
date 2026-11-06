"""Reason aggregation and rounds_to_pass (8.5) and the full-case-set regression gate."""
import contextlib
import copy
import io
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import convergence  # noqa: E402
import evaluate as e  # noqa: E402
import gate  # noqa: E402

FIXTURES = e.ROOT / 'crates/rio-core/tests/fixtures'


def finding(index, reason=None, agent='correctness', level='plausible', rule='agent/correctness/null-guard',
            category='risk', path='src/a.py', line=None):
    f = e.read_json(FIXTURES / 'finding.json')
    f.update(id=f'{index:064x}', rule_id=rule, category=category, evidence_level=level,
             source={'agent': agent}, message=f'Finding {index}', round=1, first_posted_in='snap-1')
    f['location'].update(path=path, line_start=line or index + 1, line_end=line or index + 1, symbol_path=f'mod.fn{index}')
    f['locations'] = [copy.deepcopy(f['location'])]
    if reason:
        # Lifecycle `status` is omitted: report-v1's embedded finding definition may lag
        # finding-v1 while task 2.2 lands; aggregation reads only author_response.
        f['author_response'] = {'reason': reason, 'actor': 'dev@example.test', 'at': '2026-11-01T10:00:00Z'}
    return f


def lineage_report(findings, round_, rounds_to_pass=None, repository='acme/shop', ref='feature/x', generation=1):
    r = e.read_json(FIXTURES / 'complete.json')
    r['findings'], r['risks'] = [], findings
    r['lineage'] = {'repository': repository, 'kind': 'branch', 'ref': ref, 'generation': generation,
                    'round': round_, 'cap': 3, 'capped': False, 'diff_only': round_ > 1,
                    'previous_head': None if round_ == 1 else f'snap-{round_ - 1}', 'held_back': 0,
                    'rounds_to_pass': rounds_to_pass, 'author_response_ratio': None}
    return r


class ReasonAggregation(unittest.TestCase):
    def reports(self):
        reasons = ['fixed'] * 6 + ['wrong', 'wrong', 'intentional', 'style']
        agents = {6: ('correctness', 'plausible'), 7: ('security', 'static_proven'), 8: ('intent', 'plausible'),
                  9: ('correctness', 'plausible')}
        answered = [finding(i, r, *agents.get(i, ('correctness', 'plausible')),
                            category='defect' if i == 9 else 'risk') for i, r in enumerate(reasons)]
        # Round 1 posted the same identities still open; round 2 carries the responses.
        round1 = lineage_report([finding(i) for i in range(10)], 1)
        round2 = lineage_report(answered + [finding(10)], 2, rounds_to_pass=None)
        round3 = lineage_report([], 3, rounds_to_pass=3)
        other = lineage_report([finding(20, 'irrelevant', rule='agent/style/naming', category='risk')], 1,
                               rounds_to_pass=1, ref='feature/y')
        open_lineage = lineage_report([finding(30)], 1, repository='acme/other', ref='main')
        return [(r, f'r{i}.json') for i, r in enumerate([round1, round2, round3, other, open_lineage])]

    def test_ratio_example_is_point_six_and_wrong_counts_by_agent_and_level(self):
        reports = self.reports()[:3]
        summary = convergence.summarize(reports)
        repo = summary['by_repository']['acme/shop']
        self.assertEqual(repo['responses'], {'fixed': 6, 'wrong': 2, 'intentional': 1, 'irrelevant': 0, 'style': 1})
        self.assertEqual(repo['responded'], 10, 'responses are counted once per identity, not per round')
        self.assertEqual(repo['findings'], 11)
        self.assertAlmostEqual(repo['author_response_ratio'], 0.6)
        self.assertEqual(repo['wrong_by_agent_evidence'], {'correctness': {'plausible': 1},
                                                           'security': {'static_proven': 1}})
        self.assertEqual(repo['intentional_by_agent'], {'intent': 1})
        self.assertEqual(repo['irrelevant_style_by_rule'], {'agent/correctness/null-guard': {'irrelevant': 0, 'style': 1}})
        self.assertEqual(repo['irrelevant_style_by_category'], {'defect': {'irrelevant': 0, 'style': 1}})

    def test_rounds_to_pass_per_repository(self):
        summary = convergence.summarize(self.reports())
        shop = summary['by_repository']['acme/shop']['rounds_to_pass']
        self.assertEqual((shop['lineages'], shop['converged'], shop['open']), (2, 2, 0))
        self.assertEqual(shop['distribution'], {'1': 1, '3': 1})
        self.assertEqual((shop['mean'], shop['median'], shop['max']), (2, 2, 3))
        self.assertEqual([x['rounds_to_pass'] for x in shop['by_lineage']], [3, 1])
        other = summary['by_repository']['acme/other']
        self.assertEqual(other['rounds_to_pass']['open'], 1)
        self.assertIsNone(other['rounds_to_pass']['median'])
        self.assertIsNone(other['author_response_ratio'])
        self.assertEqual(summary['by_repository']['acme/shop']['irrelevant_style_by_rule']['agent/style/naming'],
                         {'irrelevant': 1, 'style': 0})
        self.assertNotIn('dev@example.test', str(summary), 'no per-user aggregation')

    def test_reports_without_lineage_need_a_repository(self):
        plain = e.read_json(FIXTURES / 'complete.json')
        self.assertEqual(convergence.summarize([(plain, 'plain.json')])['skipped_reports'], ['plain.json'])
        summary = convergence.summarize([(plain, 'plain.json')], 'acme/shop')
        self.assertEqual(summary['by_repository']['acme/shop']['rounds_to_pass']['lineages'], 0)

    def test_unknown_reason_is_rejected_by_the_finding_schema(self):
        report = lineage_report([finding(1, 'wrong')], 1)
        report['risks'][0]['author_response']['reason'] = 'false_positive'
        with self.assertRaisesRegex(ValueError, 'invalid enum'):
            convergence.summarize([(report, 'bad.json')])

    def test_cli(self):
        with tempfile.TemporaryDirectory() as tmp:
            paths = []
            for i, (r, _) in enumerate(self.reports()):
                paths.append(str(Path(tmp) / f'{i}.json'))
                e.write_json(paths[-1], r)
            with contextlib.redirect_stdout(io.StringIO()) as out:
                self.assertEqual(convergence.main(['summarize', *paths, '--out', str(Path(tmp) / 's.json')]), 0)
            e.validate(e.read_json(Path(tmp) / 's.json'), convergence.SUMMARY_SCHEMA)
            self.assertIn('acme/shop: author-response ratio', out.getvalue())


def case(case_id, label, path='src/billing.py', symbol='total', line=10):
    value = {'schema': 'rio-eval-case-v1', 'id': case_id, 'label': label, 'repository': 'acme/shop',
             'input': {'pr': 41, 'url': None, 'base': {'ref': 'main', 'sha': 'a' * 40},
                       'head': {'ref': 'x', 'sha': 'b' * 40}, 'files': [path]},
             'expected': [{'locations': [{'path': path, 'line_start': line, 'line_end': line,
                                          'symbol_path': symbol, 'symbol_line': line - 1}],
                           'trigger': 'negative totals', 'trigger_source': 'manual'}],
             'provenance': {'source': 'manual', 'created_at': '2026-11-06T00:00:00Z', 'tool': 'test'}}
    if label == 'incident':
        value['counterfactual_catch'] = 'none'
        value['provenance'].update(source='import-incident', overlap=[path],
                                   fix={'pr': 57, 'url': None, 'base': {'ref': 'main', 'sha': 'c' * 40},
                                        'head': {'ref': 'y', 'sha': 'd' * 40}, 'files': [path]})
    return value


class RegressionGate(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        for c in [case('incident-41-57', 'incident'), case('incident-50-60', 'incident', path='src/auth.py', symbol='login'),
                  case('hist-1', 'historical', path='src/cart.py', symbol='add'),
                  case('mut-1', 'mutation', path='src/tax.py', symbol='rate')]:
            e.write_json(self.root / 'cases' / f'{c["id"]}.json', c)
        summary = e.read_json(e.ROOT / 'docs/evaluation/v0.1-rescored/summary.json')
        summary['eligible'].update(precision=.9, positive_control_recall=.85)
        self.summary = summary

    def run_reports(self, name, catches):
        directory = self.root / name
        targets = {'incident-41-57': ('src/billing.py', 'billing.total'), 'incident-50-60': ('src/auth.py', 'auth.login'),
                   'hist-1': ('src/cart.py', 'cart.add'), 'mut-1': ('src/tax.py', 'tax.rate')}
        for case_id, (path, symbol) in targets.items():
            findings = []
            if case_id in catches:
                f = finding(len(findings) + 1, path=path, line=200)
                f['location']['symbol_path'] = symbol
                f['locations'] = [copy.deepcopy(f['location'])]
                findings.append(f)
            e.write_json(directory / case_id / 'report.json', lineage_report(findings, 1))
        return directory

    def card(self, name, catches, precision=.9, recall=.85):
        summary = copy.deepcopy(self.summary)
        summary['eligible'].update(precision=precision, positive_control_recall=recall)
        return gate.scorecard(summary, [self.root / 'cases'], self.run_reports(name, catches), name)

    def test_prompt_change_missing_an_incident_fails_and_names_it(self):
        everything = {'incident-41-57', 'incident-50-60', 'hist-1', 'mut-1'}
        baseline = self.card('baseline', everything)
        self.assertEqual(baseline['incident_recall'], 1)
        candidate = self.card('prompt-v2', everything - {'incident-50-60'})
        result = gate.gate(baseline, candidate)
        self.assertFalse(result['passed'])
        self.assertEqual(result['missed_incidents'], ['incident-50-60'])
        self.assertIn('previously caught incident(s) missed: incident-50-60', result['reasons'])
        self.assertIn('incident_recall fell from 1.0000 to 0.5000', result['reasons'])
        self.assertEqual(result['metrics']['precision'], {'baseline': .9, 'candidate': .9})

    def test_lower_precision_or_recall_fails_and_equal_passes(self):
        everything = {'incident-41-57', 'incident-50-60', 'hist-1', 'mut-1'}
        baseline = self.card('baseline', everything)
        self.assertTrue(gate.gate(baseline, self.card('same', everything))['passed'])
        result = gate.gate(baseline, self.card('model-b', everything, precision=.85))
        self.assertEqual(result['reasons'], ['precision fell from 0.9000 to 0.8500'])
        result = gate.gate(baseline, self.card('tool-c', everything, recall=.8))
        self.assertEqual(result['reasons'], ['recall fell from 0.8500 to 0.8000'])

    def test_missing_reports_and_metrics_never_pass(self):
        everything = {'incident-41-57', 'incident-50-60', 'hist-1', 'mut-1'}
        baseline = self.card('baseline', everything)
        directory = self.run_reports('partial', everything)
        (directory / 'mut-1/report.json').unlink()
        candidate = gate.scorecard(self.summary, [self.root / 'cases'], directory, 'partial')
        self.assertEqual(candidate['cases']['mut-1']['status'], 'missing')
        self.assertIn('candidate cases without a report: mut-1', gate.gate(baseline, candidate)['reasons'])
        candidate = self.card('no-precision', everything, precision=None)
        self.assertIn('precision is missing from the candidate', gate.gate(baseline, candidate)['reasons'])

    def test_cli_exit_codes(self):
        everything = {'incident-41-57', 'incident-50-60', 'hist-1', 'mut-1'}
        e.write_json(self.root / 'summary.json', self.summary)
        self.run_reports('base-run', everything)
        self.run_reports('cand-run', everything - {'incident-41-57'})
        with contextlib.redirect_stdout(io.StringIO()) as out:
            for name in ('base', 'cand'):
                self.assertEqual(gate.main(['scorecard', '--summary', str(self.root / 'summary.json'),
                                            '--cases', str(self.root / 'cases'), '--reports', str(self.root / f'{name}-run'),
                                            '--label', name, '--out', str(self.root / f'{name}.json')]), 0)
            self.assertEqual(gate.main(['gate', '--baseline', str(self.root / 'base.json'),
                                        '--candidate', str(self.root / 'cand.json')]), 1)
            self.assertEqual(gate.main(['gate', '--baseline', str(self.root / 'base.json'),
                                        '--candidate', str(self.root / 'base.json')]), 0)
        self.assertIn('incident-41-57', out.getvalue())
        with contextlib.redirect_stderr(io.StringIO()):
            self.assertEqual(gate.main(['gate', '--baseline', str(self.root / 'missing.json'),
                                        '--candidate', str(self.root / 'base.json')]), 2)


if __name__ == '__main__':
    unittest.main()

"""The v0.3 agent reference set (tasks 8.3 and 9.6): per-agent precision, control detection and cost."""
import contextlib
import copy
import io
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import agents  # noqa: E402
import cases  # noqa: E402
import evaluate as e  # noqa: E402
from test_evaluate import finding, report  # noqa: E402

REFERENCE = e.ROOT / 'eval/cases/v0.3-agents'


def agent_finding(index, agent, path, line, symbol, category='defect', rule=None):
    f = finding(index, message=f'{agent} finding {index}', path=path, line=line)
    f.update(source={'agent': agent}, category=category, evidence_level='plausible',
             rule_id=rule or {'contracts': 'contracts/route/removed', 'security': 'security/sql-injection'}.get(
                 agent, 'correctness/null-guard'))
    f['location']['symbol_path'] = symbol
    f['locations'] = [copy.deepcopy(f['location'])]
    return f


def eval_case(case_id, agent, path, line, symbol):
    return {'schema': 'rio-eval-case-v1', 'id': case_id, 'label': 'historical', 'repository': 'acme/api',
            'input': {'pr': 7, 'url': 'https://github.com/acme/api/pull/7',
                      'base': {'ref': None, 'sha': 'a' * 40}, 'head': {'ref': None, 'sha': 'b' * 40},
                      'files': [path]},
            'expected': [{'locations': [{'path': path, 'line_start': line, 'line_end': line + 2,
                                         'symbol_path': symbol, 'symbol_line': line}],
                          'trigger': 'a client calling the removed route', 'trigger_source': 'manual',
                          'rule_id': None, 'category': 'defect', 'severity': 'high', 'agent': agent}],
            'provenance': {'source': 'manual', 'created_at': '2026-11-07T00:00:00Z', 'tool': 'test'}}


class ReferenceSet(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def write_run(self):
        positive = report([agent_finding(1, 'contracts', 'src/routes.ts', 12, 'routes.remove'),
                           agent_finding(2, 'correctness', 'src/client.ts', 4, 'client.logout')])
        security = agent_finding(3, 'security', 'src/db.ts', 9, 'db.find', category='security')
        positive['security'] = [security]
        clean = report([agent_finding(4, 'contracts', 'src/api.ts', 3, 'api.create')])
        e.write_json(self.root / 'run/CT-POS-01/report.json', positive)
        e.write_json(self.root / 'run/CT-CL-01/report.json', clean)
        e.write_json(self.root / 'run/CT-POS-01/audit.json',
                     {'usage': [{'cost_usd': 0.25}, {'cost_usd': 0.5}]})
        e.write_json(self.root / 'run/CT-CL-01/audit.json', {'usage': [{'cost_usd': 0.125}]})
        e.write_json(self.root / 'cases/CT-POS-01.json',
                     eval_case('CT-POS-01', 'contracts', 'src/routes.ts', 11, 'remove'))
        common = {'repository': 'acme/api', 'pr': 'https://github.com/acme/api/pull/7',
                  'languages': ['typescript'], 'agent': 'contracts'}
        manifest = {'schema': agents.SCHEMA, 'cases': [
            {**common, 'id': 'CT-POS-01', 'kind': 'positive', 'case': 'cases/CT-POS-01.json',
             'report': 'run/CT-POS-01/report.json', 'audit': 'run/CT-POS-01/audit.json',
             'verdicts': 'run/CT-POS-01/verdicts.json'},
            {**common, 'id': 'CT-CL-01', 'kind': 'clean', 'case': None,
             'report': 'run/CT-CL-01/report.json', 'audit': 'run/CT-CL-01/audit.json',
             'verdicts': 'run/CT-CL-01/verdicts.json'}]}
        e.write_json(self.root / 'manifest.json', manifest)
        return self.root / 'manifest.json'

    def test_pending_skeletons_report_findings_detection_and_cost_but_no_precision(self):
        manifest = self.write_run()
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(agents.main(['skeleton', str(manifest)]), 0)
        verdicts = e.read_json(self.root / 'run/CT-POS-01/verdicts.json')
        self.assertTrue(verdicts['reviewer'].startswith('TODO'))
        self.assertEqual(len(verdicts['findings']), 3)
        self.assertTrue(all(v['verdict'] == 'TODO' for v in verdicts['findings'].values()))
        self.assertEqual(verdicts['positive_control']['expected'][0]['id'], 'ct-pos-01-1')
        out = self.root / 'summary.json'
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(agents.main(['summarize', str(manifest), '--out', str(out),
                                          '--markdown', str(self.root / 'summary.md')]), 0)
        summary = e.read_json(out)
        self.assertFalse(summary['precision_final'])
        self.assertEqual(summary['awaiting_adjudication'], ['CT-CL-01', 'CT-POS-01'])
        self.assertEqual(summary['agents']['contracts']['pending_adjudication'], 2)
        self.assertIsNone(summary['agents']['contracts']['precision'])
        self.assertEqual(summary['agents']['security']['findings'], 1)
        # The correctness finding is in the right file but not by the expected agent.
        self.assertEqual(summary['controls'], [{'id': 'CT-POS-01', 'agent': 'contracts', 'detected': True,
                                                'finding_ids': [[f'{1:064x}']]}])
        self.assertEqual(summary['cost_usd'], 0.875)
        self.assertIn('| contracts | 2 | 2 | – | – | pending | 1/1 | 0 |', (self.root / 'summary.md').read_text())
        self.assertEqual(summary['failed_cases'], [])

    def test_a_review_that_did_not_finish_is_not_a_missed_control(self):
        manifest = self.write_run()
        broken = e.read_json(self.root / 'run/CT-POS-01/report.json')
        broken['status'] = 'partial'
        broken['findings'], broken['security'] = [], []
        e.write_json(self.root / 'run/CT-POS-01/report.json', broken)
        with contextlib.redirect_stdout(io.StringIO()):
            agents.main(['skeleton', str(manifest), '--force'])
        _, rows = agents.load(manifest)
        summary = agents.summarize(rows)
        self.assertEqual(summary['failed_cases'], ['CT-POS-01'])
        self.assertIsNone(summary['controls'][0]['detected'])
        self.assertEqual((summary['agents']['contracts']['controls'],
                          summary['agents']['contracts']['controls_failed']), (0, 1))

    def test_completed_verdicts_yield_per_agent_precision(self):
        manifest = self.write_run()
        with contextlib.redirect_stdout(io.StringIO()):
            agents.main(['skeleton', str(manifest)])
        for case_id, verdict in (('CT-POS-01', 'true-positive'), ('CT-CL-01', 'false-positive')):
            path = self.root / f'run/{case_id}/verdicts.json'
            v = e.read_json(path)
            v['reviewer'] = 'independent reviewer'
            v['findings'] = {fid: {'verdict': verdict, 'reason': 'checked at the pinned head'}
                             for fid in v['findings']}
            if case_id == 'CT-POS-01':
                v['positive_control']['expected'][0].update(
                    evidence='client test fails at head', finding_ids=[f'{1:064x}'])
            e.write_json(path, v)
        _, rows = agents.load(manifest)
        summary = agents.summarize(rows)
        self.assertTrue(summary['precision_final'])
        self.assertEqual(summary['agents']['contracts']['precision'], 0.5)
        self.assertEqual(summary['agents']['security']['precision'], 1.0)
        self.assertEqual(summary['agents']['contracts']['counts']['false-positive'], 1)

    def test_agent_expectations_need_the_named_agent(self):
        case = eval_case('X', 'security', 'src/db.ts', 8, 'find')
        cases.validate_case(case)
        by_correctness = report([agent_finding(1, 'correctness', 'src/db.ts', 9, 'db.find')])
        self.assertEqual(cases.caught(case, by_correctness), [[]])
        by_security = report([])
        by_security['security'] = [agent_finding(2, 'security', 'src/db.ts', 9, 'db.find', category='security')]
        self.assertEqual(cases.caught(case, by_security), [[f'{2:064x}']])
        # Rust paths match by their last segment, on both sides.
        rust = eval_case('R', 'security', 'src/fs.rs', 100, 'Scope::is_allowed')
        hit = report([])
        hit['security'] = [agent_finding(3, 'security', 'src/fs.rs', 300, 'fs.Scope.is_allowed', category='security')]
        self.assertEqual(cases.caught(rust, hit), [[f'{3:064x}']])
        case['expected'][0]['agent'] = 'reviewer'
        with self.assertRaises(ValueError):
            cases.validate_case(case)

    def test_bad_manifests_are_rejected(self):
        manifest = self.write_run()
        doc = e.read_json(manifest)
        doc['cases'][1]['case'] = 'cases/CT-POS-01.json'
        e.write_json(manifest, doc)
        with contextlib.redirect_stderr(io.StringIO()) as err:
            self.assertEqual(agents.main(['summarize', str(manifest), '--out', str(self.root / 'x.json')]), 2)
        self.assertIn('positive cases, and only they', err.getvalue())


class ShippedReferenceCases(unittest.TestCase):
    """The committed contracts and security cases are valid and name their agent."""

    def test_reference_cases_validate_and_cover_both_agents(self):
        loaded = cases.load_cases([REFERENCE])
        by_agent = {}
        for case, path in loaded:
            agents_named = {x.get('agent') for x in case['expected']}
            self.assertEqual(len(agents_named), 1, path)
            by_agent.setdefault(agents_named.pop(), []).append(case['id'])
            for x in case['expected']:
                self.assertTrue(any(loc['symbol_path'] for loc in x['locations']),
                                f'{path}: control registered at file plus symbol')
        self.assertGreaterEqual(len(by_agent.get('contracts', [])), 4)
        self.assertGreaterEqual(len(by_agent.get('security', [])), 4)


if __name__ == '__main__':
    unittest.main()

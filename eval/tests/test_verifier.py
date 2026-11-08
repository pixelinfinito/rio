"""Pinned verifier-versus-single-verifier comparison (task 1.1) on recorded fixtures."""
import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('verifier', Path(__file__).resolve().parents[1] / 'verifier.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


def agent_finding(fid, level='static_proven', blind=('none', 'none', 'none')):
    return {'id': fid, 'rule_id': f'agent/correctness/{fid}', 'source': {'agent': 'correctness'},
            'evidence_level': level, 'verification': {'blind_match': list(blind), 'agreeing': 1}}


def vote(fid, level='static_proven'):
    return {'hypothesis_id': fid, 'voter': 0, 'status': 'completed', 'validated_level': level,
            'answer': {'evidence': [{'kind': 'code', 'node_ids': ['actual-head-node']}]}}


class Fixture:
    """Writes recorded report/audit/verdict artifacts and returns pinned arm entries."""

    def __init__(self, root):
        self.root = root
        self.count = 0

    def arm(self, findings, verdicts, votes=None, cost=.001, head='head-sha', status='complete', incomplete=(),
            incomplete_votes=0):
        self.count += 1
        report = {'status': status, 'review': {'base': 'base-sha', 'head': head},
                  'findings': findings, 'risks': [], 'incomplete': list(incomplete)}
        if incomplete_votes:
            report['agent_audit'] = {'incomplete_votes': incomplete_votes}
        audit = {'votes': votes if votes is not None else [vote(f['id'], f['evidence_level']) for f in findings
                                                             if f['evidence_level'] != 'plausible'],
                 'usage': [{'phase': 'verify-blind', 'status': 'completed', 'input_tokens': 100,
                            'output_tokens': 20, 'cost_usd': cost}]}
        verdict_doc = {'reviewer': 'independent reviewer', 'findings': verdicts}
        run = {}
        for name, value in [('report', report), ('audit', audit), ('verdicts', verdict_doc)]:
            path = self.root / f'{name}-{self.count}.json'
            path.write_text(json.dumps(value))
            run[name] = path.name
            run[f'{name}_sha256'] = verifier.digest(path)
        return run


def tp(control=None):
    entry = {'verdict': 'true-positive', 'evidence': 'head graph path and regression command'}
    if control:
        entry['control_id'] = control
    return entry


def fp():
    return {'verdict': 'false-positive', 'evidence': 'oracle run shows the guarded path is unreachable'}


class Comparison(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.fx = Fixture(self.root)
        known = self.fx.arm([agent_finding('a')], {'a': tp('high-issue')})
        clean = self.fx.arm([], {})
        self.manifest = {'schema': 'rio-verifier-eval-v1', 'execution': 'recorded', 'cases': [
            {'id': 'known', 'generator_model': 'p/g', 'voter_model': 'p/v', 'profile_hash': 'pinned',
             'high_controls': ['high-issue'], 'independently_clean': False, 'single': known, 'quorum': known},
            {'id': 'clean', 'generator_model': 'p/g', 'voter_model': 'p/v', 'profile_hash': 'pinned',
             'high_controls': [], 'independently_clean': True, 'single': clean, 'quorum': clean}]}

    def test_tool_missing_skips_are_scorable_but_failures_and_lost_votes_are_not(self):
        skipped = [{'kind': 'typecheck', 'outcome': 'skipped', 'reason': 'tool_missing'},
                   {'kind': 'dependencies', 'outcome': 'skipped', 'reason': 'offline'}]
        self.assertTrue(verifier.scorable({'status': 'complete', 'incomplete': []}))
        self.assertTrue(verifier.scorable({'status': 'incomplete', 'incomplete': skipped}))
        self.assertFalse(verifier.scorable({'status': 'incomplete', 'incomplete': []}))
        self.assertFalse(verifier.scorable({'status': 'incomplete', 'incomplete': skipped + [
            {'kind': 'lint', 'outcome': 'failed', 'reason': None}]}))
        self.assertFalse(verifier.scorable({'status': 'incomplete', 'incomplete': skipped,
                                            'agent_audit': {'incomplete_votes': 1}}))
        self.assertFalse(verifier.scorable({'status': 'partial', 'incomplete': skipped}))
        hosted = self.fx.arm([agent_finding('a')], {'a': tp('high-issue')}, status='incomplete', incomplete=skipped)
        self.manifest['cases'][0]['single'] = self.manifest['cases'][0]['quorum'] = hosted
        comparison = verifier.compare(self.manifest, self.root)
        self.assertEqual(comparison['errors'], [])
        lost = self.fx.arm([agent_finding('a')], {'a': tp('high-issue')}, status='incomplete', incomplete=skipped,
                           incomplete_votes=2)
        self.manifest['cases'][0]['quorum'] = lost
        self.assertTrue(any('completed reviews' in err['error'] for err in verifier.compare(self.manifest, self.root)['errors']))

    def test_recorded_precision_never_claims_live_acceptance(self):
        result = verifier.compare(self.manifest, self.root)
        self.assertEqual(result['precision'], 1)
        self.assertFalse(result['accepted'])
        self.assertIn('recorded fixtures do not establish empirical model acceptance', result['reasons'])
        self.assertTrue(result['high_severity_recall_preserved'])
        self.assertEqual(result['cases'][0]['quorum']['blind_match']['none']['true-positive'], 1)
        self.assertEqual(result['cases'][0]['quorum']['by_evidence']['static_proven']['precision'], 1)
        self.assertIsNone(result['cases'][0]['quorum']['by_evidence']['reproduced']['precision'])
        self.assertEqual(result['arms']['quorum']['verification_tokens'], 240)
        self.assertAlmostEqual(result['arms']['quorum']['verification_cost_usd'], .002)
        self.assertEqual(result['arms']['single']['high_severity_recall'], 1)

    def test_live_comparison_meeting_every_gate_is_accepted(self):
        self.manifest['execution'] = 'live-model'
        result = verifier.compare(self.manifest, self.root)
        self.assertTrue(result['accepted'], result['reasons'])
        self.assertTrue(all(result['gates'].values()))

    def test_precision_below_gate_records_failure_with_cases(self):
        self.manifest['execution'] = 'live-model'
        findings = [agent_finding(f'h{i}', blind=('same',)) for i in range(17)]
        findings += [agent_finding(f'x{i}', level='plausible', blind=('related',)) for i in range(6)]
        verdicts = {f['id']: tp() for f in findings[:17]} | {f['id']: fp() for f in findings[17:]}
        verdicts['h0'] = tp('high-issue')
        self.manifest['cases'][0]['quorum'] = self.fx.arm(findings, verdicts)
        result = verifier.compare(self.manifest, self.root)
        self.assertAlmostEqual(result['precision'], 17 / 23)
        self.assertEqual(round(result['precision'], 2), .74)
        self.assertFalse(result['accepted'])
        self.assertFalse(result['gates']['precision'])
        reason = next(r for r in result['reasons'] if 'precision' in r)
        self.assertIn('0.74 did not reach 0.80', reason)
        self.assertIn('known/x0', reason)
        self.assertEqual(len(result['quorum_false_positives']), 6)
        self.assertEqual(result['arms']['quorum']['by_evidence']['plausible']['precision'], 0)
        self.assertEqual(result['arms']['quorum']['blind_match']['related']['false-positive'], 6)

    def test_quorum_missing_a_baseline_high_severity_issue_fails_and_names_it(self):
        self.manifest['execution'] = 'live-model'
        self.manifest['cases'][0]['quorum'] = self.fx.arm([], {})
        result = verifier.compare(self.manifest, self.root)
        self.assertFalse(result['accepted'])
        self.assertFalse(result['high_severity_recall_preserved'])
        self.assertEqual(result['lost_high_controls'], ['known/high-issue'])
        self.assertTrue(any('known/high-issue' in r for r in result['reasons']))
        self.assertEqual(result['arms']['quorum']['high_severity_recall'], 0)

    def test_votes_from_another_hypothesis_cannot_support_proof(self):
        self.manifest['execution'] = 'live-model'
        self.manifest['cases'][0]['quorum'] = self.fx.arm([agent_finding('a')], {'a': tp('high-issue')},
                                                          votes=[vote('another-hypothesis')])
        result = verifier.compare(self.manifest, self.root)
        self.assertFalse(result['accepted'])
        self.assertEqual(result['errors'][0]['id'], 'known')
        self.assertIn('artifact-backed votes', result['errors'][0]['error'])
        self.assertIsNone(result['gates']['high_severity_recall'])

    def test_changed_pins_are_kept_as_evidence_not_acceptance(self):
        self.manifest['execution'] = 'live-model'
        (self.root / self.manifest['cases'][0]['quorum']['report']).write_text('{}')
        result = verifier.compare(self.manifest, self.root)
        self.assertFalse(result['accepted'])
        self.assertIn('pinned artifact changed', result['errors'][0]['error'])

    def test_different_snapshots_are_rejected(self):
        self.manifest['cases'][0]['quorum'] = self.fx.arm([agent_finding('a')], {'a': tp('high-issue')}, head='other')
        result = verifier.compare(self.manifest, self.root)
        self.assertIn('identical selected snapshots', result['errors'][0]['error'])

    def test_missing_cost_or_clean_controls_never_accept(self):
        self.manifest['execution'] = 'live-model'
        self.manifest['cases'][0]['quorum'] = self.fx.arm([agent_finding('a')], {'a': tp('high-issue')}, cost=None)
        result = verifier.compare(self.manifest, self.root)
        self.assertFalse(result['accepted'])
        self.assertIsNone(result['arms']['quorum']['verification_cost_usd'])
        self.assertIn('verification cost is unavailable for at least one arm', result['reasons'])
        manifest = copy.deepcopy(self.manifest)
        manifest['cases'] = manifest['cases'][:1]
        manifest['cases'][0]['quorum'] = manifest['cases'][0]['single']
        result = verifier.compare(manifest, self.root)
        self.assertFalse(result['gates']['reference_set'])
        self.assertFalse(result['accepted'])

    def test_empty_or_duplicate_reference_sets_are_rejected(self):
        with self.assertRaises(ValueError):
            verifier.compare({'schema': 'rio-verifier-eval-v1', 'execution': 'live-model', 'cases': []}, self.root)
        self.manifest['cases'].append(copy.deepcopy(self.manifest['cases'][0]))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            verifier.compare(self.manifest, self.root)

    def test_cli_writes_failed_comparison_and_markdown_for_a_rejected_manifest(self):
        manifest = self.root / 'manifest.json'
        manifest.write_text(json.dumps({'schema': 'rio-verifier-eval-v1', 'execution': 'live-model', 'cases': []}))
        out, md = self.root / 'out/comparison.json', self.root / 'out/summary.md'
        self.assertEqual(verifier.main([str(manifest), '--out', str(out), '--markdown', str(md)]), 1)
        result = json.loads(out.read_text())
        self.assertFalse(result['accepted'])
        self.assertTrue(result['reasons'][0].startswith('manifest rejected'))
        self.assertIn('Accepted: **no**', md.read_text())
        manifest.write_text(json.dumps(self.manifest))
        self.assertEqual(verifier.main([str(manifest), '--out', str(out), '--markdown', str(md)]), 1)
        self.assertIn('| quorum | static_proven | 1 | 0 | 100.0% |', md.read_text())

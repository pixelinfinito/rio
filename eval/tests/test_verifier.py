import copy
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location('verifier', Path(__file__).resolve().parents[1] / 'verifier.py')
verifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(verifier)


class Comparison(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        report = {'status': 'complete', 'review': {'base': 'base-sha', 'head': 'head-sha'}, 'findings': [{'id': 'a', 'source': {'agent': 'correctness'}, 'evidence_level': 'static_proven', 'verification': {'blind_match': ['none', 'none', 'none']}}], 'risks': []}
        audit = {'votes': [{'hypothesis_id': 'a', 'voter': 0, 'status': 'completed', 'validated_level': 'static_proven', 'answer': {'evidence': [{'kind': 'code', 'node_ids': ['actual-head-node']}]}}], 'usage': [{'phase': 'verify-blind', 'status': 'completed', 'input_tokens': 100, 'output_tokens': 20, 'cost_usd': .001}]}
        verdicts = {'reviewer': 'independent reviewer', 'findings': {'a': {'verdict': 'true-positive', 'evidence': 'head graph path and regression command', 'control_id': 'high-issue'}}}
        run = {}
        for name, value in [('report', report), ('audit', audit), ('verdicts', verdicts)]:
            path = self.root / f'{name}.json'
            path.write_text(json.dumps(value))
            run[name] = path.name
            run[f'{name}_sha256'] = verifier.digest(path)
        self.manifest = {'schema': 'rio-verifier-eval-v1', 'execution': 'recorded', 'cases': [{'id': 'known', 'generator_model': 'p/g', 'voter_model': 'p/v', 'profile_hash': 'pinned', 'high_controls': ['high-issue'], 'single': run, 'quorum': run}]}

    def test_recorded_precision_never_claims_live_acceptance(self):
        result = verifier.compare(self.manifest, self.root)
        self.assertEqual(result['precision'], 1)
        self.assertFalse(result['accepted'])
        self.assertTrue(result['high_severity_recall_preserved'])
        self.assertEqual(result['cases'][0]['quorum']['blind_match']['none']['true-positive'], 1)
        self.assertEqual(result['cases'][0]['quorum']['by_evidence']['static_proven']['precision'], 1)
        self.assertIsNone(result['cases'][0]['quorum']['by_evidence']['reproduced']['precision'])

    def test_votes_from_another_hypothesis_cannot_support_proof(self):
        path = self.root / 'audit.json'
        audit = json.loads(path.read_text())
        audit['votes'][0]['hypothesis_id'] = 'another-hypothesis'
        path.write_text(json.dumps(audit))
        for arm in ['single', 'quorum']:
            self.manifest['cases'][0][arm]['audit_sha256'] = verifier.digest(path)
        with self.assertRaisesRegex(ValueError, 'artifact-backed votes'):
            verifier.compare(self.manifest, self.root)

    def test_pins_and_identical_cases_are_required(self):
        path = self.root / 'report.json'
        path.write_text('{}')
        with self.assertRaisesRegex(ValueError, 'pinned artifact changed'):
            verifier.compare(self.manifest, self.root)

    def test_empty_or_duplicate_reference_sets_are_rejected(self):
        with self.assertRaises(ValueError):
            verifier.compare({'schema': 'rio-verifier-eval-v1', 'cases': []}, self.root)
        self.manifest['cases'].append(copy.deepcopy(self.manifest['cases'][0]))
        with self.assertRaisesRegex(ValueError, 'duplicate'):
            verifier.compare(self.manifest, self.root)

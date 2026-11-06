"""Nightly noise workflow (8.3) structure and the credential scan it runs before upload."""
import base64
import contextlib
import gzip
import io
from pathlib import Path
import re
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import credscan  # noqa: E402
import evaluate as e  # noqa: E402

WORKFLOW = e.ROOT / '.github/workflows/noise.yml'

try:
    import yaml
except ImportError:  # PyYAML is optional; structural text checks still run.
    yaml = None


class Workflow(unittest.TestCase):
    def setUp(self):
        self.text = WORKFLOW.read_text()

    @unittest.skipIf(yaml is None, 'PyYAML not installed')
    def test_parses_with_schedule_dispatch_and_ordered_steps(self):
        doc = yaml.safe_load(self.text)
        triggers = doc[True] if True in doc else doc['on']  # YAML 1.1 reads `on` as true
        self.assertIn('schedule', triggers)
        self.assertIn('workflow_dispatch', triggers)
        self.assertEqual(doc['permissions'], {'contents': 'read'})
        job = doc['jobs']['noise']
        self.assertEqual(job['env']['RIO_NOISE_PROFILE'], 'rio/openrouter')
        names = [s.get('name', s.get('uses')) for s in job['steps']]
        self.assertLess(names.index('Run rio eval noise'), names.index('Credential scan of logs and artifact'))
        self.assertLess(names.index('Credential scan of logs and artifact'), names.index('Upload dated noise directory'))
        upload = job['steps'][names.index('Upload dated noise directory')]
        self.assertEqual(upload['with']['retention-days'], 90)
        self.assertIn("steps.scan.outcome == 'success'", upload['if'])
        self.assertEqual(upload['with']['path'], 'eval/runs/noise/${{ env.NOISE_DATE }}')
        run = job['steps'][names.index('Run rio eval noise')]['run']
        self.assertIn('target/release/rio" eval noise', run)
        self.assertIn('--profile "$RIO_NOISE_PROFILE"', run)

    def test_credentials_only_from_repository_secrets(self):
        for line in self.text.splitlines():
            match = re.match(r'\s*([A-Z_]*(?:KEY|TOKEN|SECRET)[A-Z_]*):\s*(.+)$', line)
            if match:
                self.assertRegex(match.group(2), r'^\$\{\{ secrets\.[A-Z_]+ \}\}$', line)
        self.assertEqual(credscan.scan([WORKFLOW]), [])
        self.assertIn('cron:', self.text)
        self.assertIn('retention-days: 90', self.text)


class CredentialScan(unittest.TestCase):
    def test_finds_exact_and_encoded_values_and_token_shapes_without_printing_them(self):
        secret = 'or-secret-value-123456'
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'clean.json').write_text('{"ok": true}')
            env = {'OPENROUTER_API_KEY': secret, 'SHORT': 'abc'}
            self.assertEqual(credscan.scan([root], ['OPENROUTER_API_KEY', 'SHORT', 'UNSET'], env), [])
            (root / 'logs').mkdir()
            (root / 'logs/noise.log').write_text(f'calling provider with {secret}\n')
            (root / 'report.json.gz').write_bytes(gzip.compress(base64.b64encode(secret.encode())))
            (root / 'stderr.log').write_text('token ghp_' + 'a' * 36)
            hits = credscan.scan([root], ['OPENROUTER_API_KEY'], env)
            self.assertIn((str(root / 'logs/noise.log'), '$OPENROUTER_API_KEY'), hits)
            self.assertIn((str(root / 'report.json.gz'), '$OPENROUTER_API_KEY (base64)'), hits)
            self.assertIn((str(root / 'stderr.log'), 'github-token'), hits)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(credscan.main(['--env', 'OPENROUTER_API_KEY', str(root)], env), 1)
            self.assertNotIn(secret, out.getvalue())
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(credscan.main([str(root / 'missing')], env), 2)


if __name__ == '__main__':
    unittest.main()

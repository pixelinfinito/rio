"""Local nightly noise job (8.3) and the credential scan it runs on every run."""
import base64
import contextlib
import gzip
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import credscan  # noqa: E402
import nightly  # noqa: E402

SECRET = 'or-secret-value-123456'


class FakeRio:
    """Records the command and writes a run directory like `rio eval noise`."""

    def __init__(self, leak=False, code=0):
        self.leak, self.code, self.calls = leak, code, []

    def __call__(self, command, env, stdout, stderr):
        self.calls.append((command, env))
        out = Path(command[command.index('--out-root') + 1]) / command[command.index('--date') + 1]
        out.mkdir(parents=True, exist_ok=True)
        (out / 'summary.json').write_text(json.dumps({'harmful': 0, 'unadjudicated': 0}))
        text = f'reviewing with {SECRET}\n' if self.leak else 'reviewed 2 PRs\n'
        return subprocess.CompletedProcess(command, self.code, stdout=text.encode())


class Nightly(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.config = {**nightly.DEFAULTS, 'repo': str(self.root / 'clone'),
                       'repository': 'acme/app', 'rio': '/opt/rio',
                       'store': str(self.root / 'store')}
        self.credentials = {'SAVED_0_OPENROUTER_API_KEY': SECRET}

    def tearDown(self):
        self.tmp.cleanup()

    def test_run_uses_saved_configuration_and_writes_a_private_dated_directory(self):
        rio = FakeRio()
        with contextlib.redirect_stdout(io.StringIO()):
            code, out = nightly.run(self.config, '2026-11-07', self.credentials, rio)
        self.assertEqual(code, 0)
        command, env = rio.calls[0]
        self.assertEqual(command[:3], ['/opt/rio', 'eval', 'noise'])
        self.assertIn('rio/openrouter', command)
        self.assertEqual(env['RIO_EVAL_DIR'], str(nightly.EVAL_DIR))
        # Secrets never travel on the command line; rio reads its saved config.
        self.assertFalse(any(SECRET in part for part in command))
        self.assertEqual(out, self.root / 'store' / '2026-11-07')
        self.assertEqual((out / 'logs' / 'noise.log').read_text(), 'reviewed 2 PRs\n')
        self.assertEqual((self.root / 'store').stat().st_mode & 0o777, 0o700)
        self.assertEqual(out.stat().st_mode & 0o777, 0o700)
        self.assertEqual((out / 'logs' / 'noise.log').stat().st_mode & 0o777, 0o600)

    def test_leaked_credential_quarantines_the_run_without_printing_it(self):
        err = io.StringIO()
        with contextlib.redirect_stderr(err):
            code, out = nightly.run(self.config, '2026-11-07', self.credentials, FakeRio(leak=True))
        self.assertEqual(code, 1)
        self.assertRegex(out.name, r'^2026-11-07\.quarantined-\d+$')
        self.assertFalse((self.root / 'store' / '2026-11-07').exists())
        self.assertIn('OPENROUTER_API_KEY', err.getvalue())
        self.assertNotIn(SECRET, err.getvalue())

    def test_failed_review_run_is_reported(self):
        with contextlib.redirect_stdout(io.StringIO()):
            code, _ = nightly.run(self.config, '2026-11-07', self.credentials, FakeRio(code=1))
        self.assertEqual(code, 1)

    def test_runs_older_than_the_window_are_pruned(self):
        store = self.root / 'store'
        for name in ('2026-07-01', '2026-08-01.quarantined-1', '2026-08-10', '2026-11-06', 'notes'):
            (store / name).mkdir(parents=True)
        with contextlib.redirect_stdout(io.StringIO()):
            code, _ = nightly.run(self.config, '2026-11-07', self.credentials, FakeRio())
        self.assertEqual(code, 0)
        self.assertEqual(sorted(p.name for p in store.iterdir()),
                         ['2026-08-10', '2026-11-06', '2026-11-07', 'notes'])

    def test_configuration_requires_a_reference_clone(self):
        path = self.root / 'noise.json'
        path.write_text('{}')
        with self.assertRaisesRegex(ValueError, '"repo"'):
            nightly.load_config(path)
        path.write_text(json.dumps({'repo': '/clone', 'limit': 0}))
        with self.assertRaisesRegex(ValueError, 'limit'):
            nightly.load_config(path)

    def test_saved_credentials_cover_secrets_files_and_client_token(self):
        (self.root / 'secrets-acct.json').write_text(json.dumps({'OPENROUTER_API_KEY': SECRET, 'n': 1}))
        (self.root / 'credentials').write_text('client-token-value-123\n')
        values = nightly.saved_credentials(self.root)
        self.assertEqual(sorted(values.values()), ['client-token-value-123', SECRET])

    def test_install_writes_user_timer_or_prints_cron(self):
        config = self.root / 'noise.json'
        config.write_text(json.dumps({'repo': '/clone'}))
        units = self.root / 'units'
        calls = []
        with contextlib.redirect_stdout(io.StringIO()):
            nightly.install(config, True, False, lambda args, check: calls.append(args), units)
        self.assertIn(f'run --config {config.resolve()}', (units / 'rio-noise.service').read_text())
        self.assertIn('OnCalendar=', (units / 'rio-noise.timer').read_text())
        self.assertEqual(calls[-1], ['systemctl', '--user', 'enable', '--now', 'rio-noise.timer'])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            nightly.install(config, False, True)
        self.assertRegex(out.getvalue(), r'^0 3 \* \* \* .*nightly\.py run --config ')

    def test_repository_has_no_noise_workflow_or_secret_references(self):
        root = Path(nightly.__file__).resolve().parents[1]
        self.assertFalse((root / '.github/workflows/noise.yml').exists())
        for workflow in (root / '.github/workflows').glob('*.yml'):
            self.assertNotIn('RIO_API_TOKEN', workflow.read_text(), workflow)


class CredentialScan(unittest.TestCase):
    def test_finds_exact_and_encoded_values_and_token_shapes_without_printing_them(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / 'clean.json').write_text('{"ok": true}')
            env = {'OPENROUTER_API_KEY': SECRET, 'SHORT': 'abc'}
            self.assertEqual(credscan.scan([root], ['OPENROUTER_API_KEY', 'SHORT', 'UNSET'], env), [])
            (root / 'logs').mkdir()
            (root / 'logs/noise.log').write_text(f'calling provider with {SECRET}\n')
            (root / 'report.json.gz').write_bytes(gzip.compress(base64.b64encode(SECRET.encode())))
            (root / 'stderr.log').write_text('token ghp_' + 'a' * 36)
            hits = credscan.scan([root], ['OPENROUTER_API_KEY'], env)
            self.assertIn((str(root / 'logs/noise.log'), '$OPENROUTER_API_KEY'), hits)
            self.assertIn((str(root / 'report.json.gz'), '$OPENROUTER_API_KEY (base64)'), hits)
            self.assertIn((str(root / 'stderr.log'), 'github-token'), hits)
            out = io.StringIO()
            with contextlib.redirect_stdout(out):
                self.assertEqual(credscan.main(['--env', 'OPENROUTER_API_KEY', str(root)], env), 1)
            self.assertNotIn(SECRET, out.getvalue())
            with contextlib.redirect_stderr(io.StringIO()):
                self.assertEqual(credscan.main([str(root / 'missing')], env), 2)


if __name__ == '__main__':
    unittest.main()

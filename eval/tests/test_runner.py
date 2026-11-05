"""Runner lifecycle against a local Git repository and a controlled Rio process."""
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

EVAL = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(EVAL))
import evaluate as e
import runner


class RunnerTests(unittest.TestCase):
    def test_lockfile_installers_do_not_fall_back_to_unlocked_installs(self):
        with tempfile.TemporaryDirectory() as tmp:
            p = Path(tmp)
            self.assertEqual(runner.default_install(p), [])
            (p / 'package-lock.json').write_text('{}')
            self.assertEqual(runner.default_install(p), [['npm', 'ci']])
            (p / 'yarn.lock').write_text('')
            (p / 'package.json').write_text('{"packageManager":"yarn@4.0.0"}')
            self.assertEqual(runner.default_install(p)[0][-1], '--immutable')
            (p / 'package.json').write_text('{"packageManager":"yarn@1.22.22"}')
            self.assertEqual(runner.default_install(p)[0][-1], '--frozen-lockfile')

    def test_end_to_end_pinned_run_preserves_evidence_and_removes_clones(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp); source = root / 'source'; source.mkdir()
            def git(*args):
                return subprocess.check_output(['git', *args], cwd=source, stderr=subprocess.DEVNULL).decode().strip()
            git('init'); git('config', 'user.name', 'Test'); git('config', 'user.email', 'test@example.test')
            (source / 'source.ts').write_text('let value = 1;\n')
            git('add', '.'); git('commit', '-m', 'base'); base = git('rev-parse', 'HEAD')
            (source / 'source.ts').write_text('let value = 2;\n')
            git('commit', '-am', 'head'); head = git('rev-parse', 'HEAD')
            report = e.read_json(e.ROOT / 'crates/rio-core/tests/fixtures/complete.json')
            report['review'].update(base=base, head=head)
            fixture = root / 'fixture.json'; e.write_json(fixture, report)
            binary = root / 'rio'
            binary.write_text('#!' + sys.executable + '\nimport sys\n'
                              'from pathlib import Path\n'
                              f'print(Path({str(fixture)!r}).read_text() if "review" in sys.argv else "{{}}")\n')
            binary.chmod(0o755)
            plan = root / 'plan.json'
            e.write_json(plan, {name: [[sys.executable, '-c', 'print("install recorded")']]
                               for name in ('base', 'head')})
            out = root / 'artifacts'
            real_run = subprocess.run
            def local_clone(argv, **kwargs):
                if argv[:3] == ['git', 'clone', '--no-checkout']:
                    argv = [*argv[:3], str(source), *argv[4:]]
                return real_run(argv, **kwargs)
            args = type('Args', (), dict(repository='owner/repo', pr=1, base=base, head=head,
                out=str(out), rio=str(binary), profile=None, install_plan=str(plan),
                temp_root=str(root), timeout=30, languages=['typescript'], case_id=None))()
            with patch.object(runner.subprocess, 'run', side_effect=local_clone):
                # The fixture intentionally has incomplete check evidence: preserve, do not score.
                code = runner.run(args)
            self.assertIn(code, (0, 1))
            metadata = e.read_json(out / 'commands.json')
            self.assertFalse(Path(metadata['disposable_directory']).exists())
            self.assertEqual(metadata['base_sha'], base)
            self.assertEqual(metadata['head_sha'], head)
            self.assertTrue(metadata['installations']['base']['succeeded'])
            self.assertTrue(metadata['installations']['head']['succeeded'])
            self.assertEqual(metadata['rio_binary_sha256'], runner.file_hash(binary))
            commands = [c['argv'] for c in metadata['commands']]
            self.assertIn([str(binary), 'review', '--base', base, '--format', 'json', '--offline',
                           '--profile', 'rio/base'], commands)
            self.assertTrue((out / 'report.json').exists())
            skeleton = e.read_json(out / 'verdicts.json')
            self.assertEqual(skeleton['reviewer'], 'TODO')
            self.assertTrue(all(f['verdict'] == 'TODO' for f in skeleton['findings'].values()))


if __name__ == '__main__':
    unittest.main()

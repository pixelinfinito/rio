"""Real standalone CLI plan, browser cells, scoped guidance and retained report."""
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]


@unittest.skipUnless(os.environ.get('RIO_TEST_QA_DOCKER') == '1', 'requires Docker and host firewall control')
class StandaloneIntegration(unittest.TestCase):
    def test_working_tree_run_executes_all_cells_and_retains_local_report(self):
        image = 'rio-qa-standalone-test:' + secrets.token_hex(6)
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            build = temporary / 'image'
            build.mkdir()
            shutil.copytree(ROOT / 'crates/rio-qa/controller/src', build / 'src')
            shutil.copytree(ROOT / 'schemas', build / 'schemas')
            shutil.copy(ROOT / 'crates/rio-qa/controller/tests/stubs/journey.mjs', build / 'journey.mjs')
            (build / 'Dockerfile').write_text(f'FROM {os.environ.get("RIO_QA_IMAGE", "rio-qa:0.1.0")}\nCOPY src /opt/rio-qa/src\nCOPY schemas /opt/rio-qa/schemas\nCOPY journey.mjs /opt/rio-qa/journey.mjs\nRUN chmod 755 /opt/rio-qa/journey.mjs && ln -sf /opt/rio-qa/journey.mjs /usr/local/bin/codex\n')
            subprocess.run(['docker', 'build', '-q', '-t', image, str(build)], check=True, capture_output=True)
            try:
                repo = temporary / 'repo'
                repo.mkdir()
                def write(path, value):
                    target = repo / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(json.dumps(value) if isinstance(value, dict) else value)
                subprocess.run(['git', 'init', '-q', str(repo)], check=True)
                write('.rio/qa.yaml', {'version': 1, 'app': {'packaging': 'static', 'directory': 'public', 'url': 'http://app.test:4173', 'ready': {'path': '/', 'status': 200}},
                      'personas': [{'name': 'visitor', 'description': 'Synthetic visitor'}], 'harness': {'auth': 'subscription'}})
                write('public/index.html', '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><h1>Profile</h1><button id="save" onclick="document.querySelector(\'output\').textContent=\'Saved\'">Save</button><output>Ready</output>')
                write('REVIEW.md', 'Keep entered data and confirm successful saves.\n')
                write('.rio/qa/seed/seed.yaml', {'version': 1, 'datastores': [], 'steps': [], 'users': [], 'paths': []})
                write('.rio/qa/fixtures/fixtures.yaml', {'version': 1, 'services': [], 'files': []})
                write('.rio/qa/journeys/checkout.yaml', {'version': 1, 'name': 'checkout', 'title': 'Save profile', 'persona': 'visitor', 'tags': ['smoke'],
                      'covers': {'paths': ['public/**'], 'routes': ['/']}, 'preconditions': [], 'goal': 'Save changes with confirmation',
                      'steps': [{'do': 'Save the profile', 'expect': 'Saved confirmation is visible'}], 'success': ['The save is confirmed'], 'ux_criteria': ['ux/task-efficiency']})
                subprocess.run(['git', '-C', str(repo), 'add', '.'], check=True)
                subprocess.run(['git', '-C', str(repo), '-c', 'user.name=QA', '-c', 'user.email=qa@example.test', 'commit', '-qm', 'fixture'], check=True)
                # The source under test is the captured working tree, not HEAD.
                write('public/uncommitted.txt', 'working tree input')
                auth = temporary / 'codex'
                auth.mkdir()
                (auth / 'auth.json').write_text(json.dumps({'auth_mode': 'chatgpt', 'tokens': {'access_token': 'synthetic-no-model-access'}}))
                env = {**os.environ, 'RIO_QA_IMAGE': image, 'CODEX_HOME': str(auth), 'RIO_CONFIG_DIR': str(temporary / 'config'), 'RIO_CACHE_DIR': str(temporary / 'cache')}
                env.pop('RIO_ENDPOINT_URL', None)
                binary = os.environ.get('RIO_TEST_BINARY', str(ROOT / 'target/debug/rio'))
                # Run the README quick-start commands in sequence with a
                # scripted harness. This verifies CLI behavior, not model quality.
                for arguments in [('validate',), ('seed', 'build'), ('init',)]:
                    command = subprocess.run([binary, 'qa', *arguments], cwd=repo, env=env, capture_output=True, timeout=180)
                    self.assertEqual(command.returncode, 0, command.stderr.decode())
                result = subprocess.run([binary, 'qa', '--full', '--format', 'json'], cwd=repo, env=env, capture_output=True, timeout=180)
                self.assertIn(result.returncode, (0, 1), result.stderr.decode())
                report = json.loads(result.stdout)
                qa = report['qa']
                self.assertEqual(report['review']['mode'], 'working-tree')
                self.assertTrue(report['review']['head'].startswith('snapshot:'))
                self.assertEqual(qa['journeys'][0]['name'], 'checkout')
                cells = qa['journeys'][0]['cells']
                self.assertEqual(len(cells), 4)
                self.assertTrue(all(cell['outcome'] == 'passed' for cell in cells), json.dumps(qa))
                self.assertEqual(len([row for row in qa['assessment'] if row['rule_id'] == 'ux/task-efficiency' and row['status'] == 'assessed']), 4)
                for step in ['checks', 'triage', 'agents', 'security']:
                    self.assertIn(step + ' skipped: standalone', report['footer']['notes'])
                self.assertTrue(any(row['step'] == 'verify' for row in report['deferred']))
                self.assertTrue(list((temporary / 'cache').rglob('*.png')))
                run = temporary / 'cache' / report['review']['id'] / 'runs' / report['review']['run_id']
                self.assertTrue((run / 'qa/result.json').is_file())
                metrics = json.loads((run / 'qa/result.json').read_text())['cell_metrics']
                self.assertEqual(len(metrics), 4)
                self.assertEqual(len({row['id'] for row in metrics}), 4)
                self.assertTrue(all(row['wall_time_ms'] > 0 and row['scope'] == 'browser_chain_cell' for row in metrics))
                self.assertTrue(all(row['tokens'] is None and row['usd'] is None for row in metrics), 'subscription usage and unknown pricing must not become zero')
                self.assertTrue((run / 'qa/outcomes.json').is_file())
                baseline = subprocess.run([binary, 'qa', '--journey', 'checkout', '--baseline', '--format', 'json'], cwd=repo, env=env, capture_output=True, timeout=240)
                self.assertIn(baseline.returncode, (0, 1), baseline.stderr.decode())
                compared = json.loads(baseline.stdout)
                base_run = temporary / 'cache' / compared['review']['id'] / 'runs' / compared['review']['run_id']
                baseline_record = json.loads((base_run / 'qa/baseline.json').read_text())
                self.assertTrue(all(row['outcome'] == 'passed' for row in baseline_record['journey_outcomes']))
                self.assertEqual(len(baseline_record['cell_metrics']), 4)
                sync = subprocess.run([binary, 'qa', 'sync', '--check'], cwd=repo, env=env, capture_output=True, timeout=60)
                # The uncommitted public file intentionally changes covered
                # source, so check mode must report a stale journey (exit 1).
                self.assertEqual(sync.returncode, 1, sync.stderr.decode())
                self.assertIn('checkout', json.loads(sync.stdout)['possibly_stale'])
            finally:
                subprocess.run(['docker', 'image', 'rm', image], capture_output=True, check=False)


if __name__ == '__main__':
    unittest.main()

"""Model-free CLI seed build/restore/force/export through a real isolated pod."""
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
class SeedCliIntegration(unittest.TestCase):
    def test_seed_commands_without_model_credentials(self):
        image = 'rio-qa-seed-test:' + secrets.token_hex(6)
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            build = temporary / 'image'
            build.mkdir()
            shutil.copytree(ROOT / 'crates/rio-qa/controller/src', build / 'src')
            (build / 'Dockerfile').write_text(f'FROM {os.environ.get("RIO_QA_IMAGE", "rio-qa:0.1.0")}\nCOPY src /opt/rio-qa/src\n')
            subprocess.run(['docker', 'build', '-q', '-t', image, str(build)], check=True, capture_output=True)
            try:
                repo = temporary / 'repo'
                repo.mkdir()
                subprocess.run(['git', 'init', '-q', str(repo)], check=True)
                def write(path, value):
                    target = repo / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(json.dumps(value) if isinstance(value, dict) else value)
                write('.rio/qa.yaml', {'version': 1, 'app': {'packaging': 'static', 'directory': 'public',
                      'url': 'http://app.test:4173', 'ready': {'path': '/', 'status': 200},
                      'env': {'DATABASE_URL': '/tmp/seed-shop.sqlite'}}, 'personas': [{'name': 'visitor', 'description': 'Synthetic visitor'}]})
                write('public/index.html', '<h1>Seed fixture</h1>')
                write('.rio/qa/seed/seed.yaml', {'version': 1,
                      'datastores': [{'name': 'shop', 'kind': 'sqlite', 'connection_env': 'DATABASE_URL'}],
                      'steps': [{'file': 'schema.sql', 'applies_to': ['shop']}], 'users': [], 'paths': []})
                write('.rio/qa/seed/schema.sql', "CREATE TABLE products (name TEXT); INSERT INTO products VALUES ('Synthetic product');")
                write('.rio/qa/fixtures/fixtures.yaml', {'version': 1, 'files': [{'name': 'contacts', 'generate': {'kind': 'csv', 'rows': 3}}], 'services': []})
                env = {**os.environ, 'RIO_QA_IMAGE': image, 'RIO_CONFIG_DIR': str(temporary / 'config'),
                       'RIO_CACHE_DIR': str(temporary / 'cache'), 'CODEX_HOME': str(temporary / 'no-auth')}
                for key in ['RIO_QA_MODEL_ROUTE', 'RIO_ENDPOINT_URL', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']:
                    env.pop(key, None)
                binary = os.environ.get('RIO_TEST_BINARY', str(ROOT / 'target/debug/rio'))
                def cli(*args):
                    result = subprocess.run([binary, 'qa', 'seed', *args], cwd=repo, env=env, capture_output=True, timeout=150)
                    self.assertEqual(result.returncode, 0, result.stderr.decode())
                    return json.loads(result.stdout)
                first = cli('build')
                self.assertEqual(first['seed']['status'], 'built')
                self.assertEqual(first['cache']['next'], 'restore')
                self.assertEqual(cli('build')['seed']['status'], 'restored')
                forced = cli('build', '--force')
                self.assertEqual(forced['seed']['status'], 'built')
                self.assertEqual(forced['cache']['fingerprint'], first['cache']['fingerprint'])
                destination = temporary / 'export'
                result = cli('export', str(destination))
                self.assertIn('shop.archive', result['exported'])
                self.assertTrue((destination / 'shop.archive').read_bytes().startswith(b'SQLite format 3'))
                manifest = json.loads((destination / 'manifest.json').read_text())
                self.assertTrue(any(archive['kind'] == 'files' for archive in manifest['archives']))
                self.assertEqual(cli('status', '--image', image)['next'], 'restore')
            finally:
                subprocess.run(['docker', 'image', 'rm', image], capture_output=True, check=False)


if __name__ == '__main__':
    unittest.main()

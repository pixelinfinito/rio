"""Init discovers a real blocked first-start host and restarts with its double."""
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
class InitDependenciesIntegration(unittest.TestCase):
    def test_failed_first_start_proposes_double_before_journeys(self):
        image = 'rio-qa-init-dependency-test:' + secrets.token_hex(6)
        base_image = os.environ.get('RIO_QA_IMAGE', 'rio-qa:0.1.0')
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            build = temporary / 'image'
            build.mkdir()
            shutil.copytree(ROOT / 'crates/rio-qa/controller/src', build / 'src')
            shutil.copytree(ROOT / 'schemas', build / 'schemas')
            shutil.copy(ROOT / 'crates/rio-qa/controller/tests/stubs/author.mjs', build / 'author.mjs')
            (build / 'Dockerfile').write_text(f'FROM {base_image}\nCOPY src /opt/rio-qa/src\nCOPY schemas /opt/rio-qa/schemas\nCOPY author.mjs /opt/rio-qa/author.mjs\nRUN chmod 755 /opt/rio-qa/author.mjs && ln -sf /opt/rio-qa/author.mjs /usr/local/bin/codex\n')
            subprocess.run(['docker', 'build', '-q', '-t', image, str(build)], check=True, capture_output=True)
            try:
                repo = temporary / 'repo'
                repo.mkdir()
                def write(path, value):
                    target = repo / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(json.dumps(value) if isinstance(value, dict) else value)
                subprocess.run(['git', 'init', '-q', str(repo)], check=True)
                write('.rio/qa.yaml', {'version': 1, 'app': {'packaging': 'vendored', 'start': 'node server.mjs', 'url': 'http://app.test:4173',
                      'ready': {'path': '/', 'status': 200, 'timeout': '5s'}, 'routes_from': {'map': [{'glob': 'src/checkout/**', 'route': '/checkout'}]}},
                      'personas': [{'name': 'shopper', 'description': 'Synthetic shopper'}], 'harness': {'auth': 'subscription'}})
                write('.rio/qa/seed/seed.yaml', {'version': 1, 'datastores': [], 'steps': [], 'users': [], 'paths': []})
                fixtures = {'version': 1, 'defaults': {'locale': 'en-US'}, 'services': [{'name': 'existing', 'kind': 'http-mock', 'claims': ['existing.example.test'],
                            'env': {}, 'recordings': 'recordings/existing', 'behaviors': ['ok']}]}
                write('.rio/qa/fixtures/fixtures.yaml', fixtures)
                write('.rio/qa/fixtures/recordings/existing/ok.json', {'behavior': 'ok', 'request': {'method': 'GET', 'path': '/'}, 'response': {'status': 200, 'body': {}}})
                write('src/checkout/REVIEW.md', 'Preserve the address after declined payment.\n')
                write('src/checkout/page.js', 'export const checkout = true;')
                write('server.mjs', """import { createServer } from 'node:http';
const catalog = await fetch('http://catalog.example.test/v1/catalog').then(response => response.json());
if (!catalog.ready) throw Error('Catalog unavailable');
createServer((request, response) => { response.setHeader('content-type','text/html'); response.end('<h1>Checkout</h1><label>Address<input></label><button>Retry payment</button>'); }).listen(4173, '0.0.0.0');
""")
                auth = temporary / 'codex'
                auth.mkdir()
                (auth / 'auth.json').write_text(json.dumps({'auth_mode': 'chatgpt', 'tokens': {'access_token': 'synthetic-no-model-access'}}))
                env = {**os.environ, 'RIO_QA_IMAGE': image, 'CODEX_HOME': str(auth), 'RIO_CONFIG_DIR': str(temporary / 'config'), 'RIO_CACHE_DIR': str(temporary / 'cache')}
                env.pop('RIO_ENDPOINT_URL', None)
                binary = os.environ.get('RIO_TEST_BINARY', str(ROOT / 'target/debug/rio'))
                result = subprocess.run([binary, 'qa', 'init'], cwd=repo, env=env, capture_output=True, timeout=240)
                diagnostics = []
                if result.returncode:
                    for manifest in (temporary / 'cache').rglob('manifest.json'):
                        diagnostics.append(json.dumps(json.loads(manifest.read_text()).get('notes', [])))
                    for transcript in (temporary / 'cache').rglob('*transcript*jsonl'):
                        diagnostics.extend(line for line in transcript.read_text().splitlines() if 'diagnostic' in line)
                self.assertEqual(result.returncode, 0, result.stderr.decode() + '\n' + '\n'.join(diagnostics))
                output = json.loads(result.stdout)
                self.assertEqual(output['discovered_dependencies'], ['catalog.example.test'])
                self.assertEqual(output['undoubled_dependencies'], [])
                self.assertIn('.rio/qa/fixtures/fixtures.yaml', output['setup_written'])
                after = json.loads((repo / '.rio/qa/fixtures/fixtures.yaml').read_text())
                self.assertEqual(after['defaults'], fixtures['defaults'])
                self.assertEqual(after['services'][0], fixtures['services'][0])
                self.assertEqual(after['services'][1]['claims'], ['catalog.example.test'])
                self.assertTrue((repo / '.rio/qa/journeys/checkout.yaml').is_file())
                self.assertTrue(list((temporary / 'cache').rglob('*.png')))
                self.assertTrue(list((temporary / 'cache/qa-seeds').glob('*/manifest.json')))
            finally:
                subprocess.run(['docker', 'image', 'rm', image], capture_output=True, check=False)


if __name__ == '__main__':
    unittest.main()

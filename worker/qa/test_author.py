"""Real CLI -> isolated pod -> scripted harness -> validated proposal writes."""
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
class AuthorIntegration(unittest.TestCase):
    def test_sync_walks_the_app_with_scoped_guidance_and_preserves_committed_journeys(self):
        image = 'rio-qa-author-test:' + secrets.token_hex(6)
        base_image = os.environ.get('RIO_QA_IMAGE', 'rio-qa:0.1.0')
        with tempfile.TemporaryDirectory() as directory:
            temporary = Path(directory)
            build = temporary / 'image'
            build.mkdir()
            shutil.copytree(ROOT / 'crates/rio-qa/controller/src', build / 'src')
            shutil.copytree(ROOT / 'schemas', build / 'schemas')
            shutil.copy(ROOT / 'crates/rio-qa/controller/tests/stubs/author.mjs', build / 'author.mjs')
            (build / 'Dockerfile').write_text(f'FROM {base_image}\nCOPY src /opt/rio-qa/src\nCOPY schemas /opt/rio-qa/schemas\nCOPY author.mjs /opt/rio-qa/author.mjs\nRUN chmod 755 /opt/rio-qa/author.mjs && ln -sf /opt/rio-qa/author.mjs /usr/local/bin/codex\n')
            subprocess.run(['docker', 'build', '-q', '-t', image, str(build)], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            try:
                repo = temporary / 'repo'
                repo.mkdir()
                def write(path, value):
                    target = repo / path
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text(json.dumps(value) if isinstance(value, dict) else value)
                def git(*args):
                    subprocess.run(['git', '-C', str(repo), *args], check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                git('init', '-q')
                write('.rio/qa.yaml', {'version': 1, 'app': {'packaging': 'static', 'directory': 'public', 'url': 'http://app.test:4173',
                      'ready': {'path': '/', 'status': 200}, 'routes_from': {'map': [{'glob': 'src/checkout/**', 'route': '/checkout'}]}},
                      'personas': [{'name': 'shopper', 'description': 'Synthetic shopper'}], 'harness': {'auth': 'subscription'}})
                write('public/index.html', '<!doctype html><meta name="viewport" content="width=device-width"><h1>Checkout</h1><label>Address<input></label><button>Retry payment</button>')
                write('src/checkout/page.js', 'export const checkout = true;')
                write('src/checkout/REVIEW.md', 'Keep entered addresses after failed payment.\n')
                write('src/admin/REVIEW.md', 'Unrelated admin requirements.\n')
                original = {}
                for name in ['cart', 'checkout']:
                    journey = {'version': 1, 'name': name, 'title': name, 'persona': 'shopper', 'tags': ['smoke'],
                               'covers': {'paths': ['src/checkout/**'], 'routes': ['/checkout']}, 'preconditions': [],
                               'steps': [{'do': 'Open checkout', 'expect': 'The checkout is visible'}], 'success': ['Complete checkout']}
                    journey.update({'after': ['cart']} if name == 'checkout' else {'resets': True})
                    write(f'.rio/qa/journeys/{name}.yaml', journey)
                    original[name] = (repo / f'.rio/qa/journeys/{name}.yaml').read_bytes()
                git('add', '.')
                git('-c', 'user.name=QA', '-c', 'user.email=qa@example.test', 'commit', '-qm', 'fixture')
                write('src/checkout/REVIEW.md', 'Preserve entered addresses after declines and let shoppers retry.\n')
                auth = temporary / 'codex'
                auth.mkdir()
                (auth / 'auth.json').write_text(json.dumps({'auth_mode': 'chatgpt', 'tokens': {'access_token': 'synthetic-no-model-access'}}))
                env = {**os.environ, 'RIO_QA_IMAGE': image, 'CODEX_HOME': str(auth), 'RIO_CONFIG_DIR': str(temporary / 'config'),
                       'RIO_CACHE_DIR': str(temporary / 'cache')}
                env.pop('RIO_ENDPOINT_URL', None)
                binary = os.environ.get('RIO_TEST_BINARY', str(ROOT / 'target/debug/rio'))
                result = subprocess.run([binary, 'qa', 'sync'], cwd=repo, env=env, capture_output=True, timeout=150)
                diagnostics = []
                if result.returncode:
                    for transcript in (temporary / 'cache').rglob('*transcript*jsonl'):
                        diagnostics.extend(line for line in transcript.read_text().splitlines() if 'diagnostic' in line)
                    for manifest in (temporary / 'cache').rglob('manifest.json'):
                        diagnostics.append(json.dumps(json.loads(manifest.read_text()).get('notes', [])))
                self.assertEqual(result.returncode, 0, result.stderr.decode() + '\n' + '\n'.join(diagnostics))
                output = json.loads(result.stdout)
                self.assertEqual(len(output['written']), 2)
                for name in original:
                    self.assertEqual((repo / f'.rio/qa/journeys/{name}.yaml').read_bytes(), original[name])
                    proposed = (repo / f'.rio/qa/journeys/{name}.proposed.yaml').read_text()
                    self.assertIn('The entered address remains available', proposed)
                    self.assertIn('src/checkout/REVIEW.md', proposed)
                    self.assertNotIn('admin', proposed)
                    self.assertEqual('resets: true' in proposed, name == 'cart')
                validation = subprocess.run([binary, 'qa', 'validate'], cwd=repo, env=env, capture_output=True, timeout=30)
                self.assertEqual(validation.returncode, 0, validation.stderr.decode())
                self.assertTrue(list((temporary / 'cache').rglob('*.png')), 'real browser screenshots must survive pod cleanup')
                # First generation uses the same immutable route guidance even
                # without committed journeys to establish source coverage.
                for path in (repo / '.rio/qa/journeys').glob('*.yaml'):
                    path.unlink()
                write('.rio/qa/seed/seed.yaml', {'version': 1, 'datastores': [{'name': 'records', 'kind': 'custom', 'capture': 'cat data/product.txt', 'restore': 'mkdir -p data; cat > data/product.txt'}], 'users': [], 'paths': [],
                      'steps': [{'command': 'mkdir -p data; echo synthetic > data/product.txt', 'applies_to': ['records']}]})
                for args in [('init',), ('init',), ('init', '--force')]:
                    existing = (repo / '.rio/qa/journeys/checkout.yaml').read_bytes() if (repo / '.rio/qa/journeys/checkout.yaml').exists() else None
                    result = subprocess.run([binary, 'qa', *args], cwd=repo, env=env, capture_output=True, timeout=150)
                    self.assertEqual(result.returncode, 0, result.stderr.decode())
                    output = json.loads(result.stdout)
                    if existing and '--force' not in args:
                        self.assertEqual((repo / '.rio/qa/journeys/checkout.yaml').read_bytes(), existing)
                        self.assertEqual(output['written'], ['.rio/qa/journeys/checkout.proposed.yaml'])
                    else:
                        self.assertEqual(output['written'], ['.rio/qa/journeys/checkout.yaml'])
                    self.assertTrue((repo / '.rio/qa/skills/rio-qa/SKILL.md').is_file())
                    self.assertTrue((repo / '.claude/skills/rio-qa').is_symlink())
                    self.assertIn('rio-qa:start', (repo / 'AGENTS.md').read_text())
                generated = (repo / '.rio/qa/journeys/checkout.yaml').read_text()
                self.assertIn('smoke', generated)
                self.assertIn('src/checkout/REVIEW.md', generated)
                self.assertNotIn('admin', generated)
                self.assertTrue(any(json.loads(path.read_text()).get('archives') for path in (temporary / 'cache/qa-seeds').glob('*/manifest.json')))
                # Model setup sees Prisma declarations and SDK names before app
                # startup, creates two synthetic accounts and a Stripe double.
                shutil.rmtree(repo / '.rio/qa/seed')
                shutil.rmtree(repo / '.rio/qa/fixtures')
                for path in (repo / '.rio/qa/journeys').glob('*.yaml'):
                    path.unlink()
                contract = json.loads((repo / '.rio/qa.yaml').read_text())
                contract['personas'] = [{'name': name, 'description': 'Synthetic ' + name,
                    'username_env': 'QA_' + name.upper() + '_EMAIL', 'password_env': 'QA_' + name.upper() + '_PASSWORD'} for name in ['shopper', 'admin']]
                write('.rio/qa.yaml', contract)
                write('prisma/schema.prisma', 'model User {\n id Int @id\n email String @unique\n password String\n}\n')
                write('src/checkout/payments.ts', "import Stripe from 'stripe';\nconst stripe = new Stripe(process.env.STRIPE_SECRET_KEY);\n")
                for name in ['SHOPPER', 'ADMIN']:
                    env['QA_' + name + '_EMAIL'] = name.lower() + '@example.test'
                    env['QA_' + name + '_PASSWORD'] = 'synthetic-' + name.lower() + '-password'
                result = subprocess.run([binary, 'qa', 'init'], cwd=repo, env=env, capture_output=True, timeout=240)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                output = json.loads(result.stdout)
                self.assertIn('.rio/qa/seed/seed.yaml', output['setup_written'])
                self.assertIn('.rio/qa/fixtures/fixtures.yaml', output['setup_written'])
                seed = json.loads((repo / '.rio/qa/seed/seed.yaml').read_text())
                self.assertEqual([row['persona'] for row in seed['users']], ['shopper', 'admin'])
                self.assertIn('api.stripe.com', (repo / '.rio/qa/fixtures/fixtures.yaml').read_text())
                self.assertIn('checkout.yaml', output['written'][0])
                self.assertEqual(output['evidence']['notes'], [])
                # An unknown layout saves a proposal without starting the app;
                # explicit acceptance on the next invocation enables setup.
                (repo / '.rio/qa.yaml').unlink()
                shutil.rmtree(repo / '.rio/qa/seed')
                shutil.rmtree(repo / '.rio/qa/fixtures')
                result = subprocess.run([binary, 'qa', 'init'], cwd=repo, env=env, capture_output=True, timeout=150)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertEqual(json.loads(result.stdout)['status'], 'confirmation_required')
                self.assertFalse((repo / '.rio/qa.yaml').exists())
                self.assertTrue((repo / '.rio/qa.proposed.yaml').is_file())
                for path in (repo / '.rio/qa/journeys').glob('*.yaml'):
                    path.unlink()
                result = subprocess.run([binary, 'qa', 'init', '--accept-contract'], cwd=repo, env=env, capture_output=True, timeout=240)
                self.assertEqual(result.returncode, 0, result.stderr.decode())
                self.assertTrue((repo / '.rio/qa.yaml').is_file())


            finally:
                subprocess.run(['docker', 'image', 'rm', image], stdout=subprocess.PIPE, stderr=subprocess.PIPE, check=False)


if __name__ == '__main__':
    unittest.main()

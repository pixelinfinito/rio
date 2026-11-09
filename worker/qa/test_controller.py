"""Real controller entrypoint, CLIs, remote Chromium and seed/file transfers."""
import io
import json
import os
from pathlib import Path
import secrets
import shutil
import signal
import time
import subprocess
import tarfile
import tempfile
import unittest

from pod import Pod, docker
from test_pod import archive_files


@unittest.skipUnless(os.environ.get('RIO_TEST_QA_DOCKER') == '1', 'requires Docker and host firewall control')
class ControllerTests(unittest.TestCase):
    def test_real_codex_and_pi_execute_named_tools_through_the_controller_entrypoint(self):
        root = Path(__file__).resolve().parents[2]
        image = os.environ.get('RIO_QA_IMAGE', 'rio-qa:0.1.0')
        username, password = 'synthetic-shopper@example.test', 'synthetic-login-password'
        application = """const http=require('node:http');http.createServer(async(q,r)=>{
if(q.url==='/login'&&q.method==='POST'){let body='';for await(const c of q)body+=c;const f=new URLSearchParams(body);
if(f.get('email')!=='synthetic-shopper@example.test'||f.get('password')!=='synthetic-login-password'){r.writeHead(401);r.end('Invalid');return}
r.writeHead(302,{location:'/shop','set-cookie':'session=synthetic-session; HttpOnly'});r.end();return}
r.setHeader('content-type','text/html');r.end('<meta name="viewport" content="width=device-width,initial-scale=1">'+(q.url==='/shop'?'<h1>Welcome shopper</h1><label>Contacts<input type="file" onchange="document.querySelector(\\'output\\').textContent=this.files[0].name"></label><output>Ready</output>':'<h1>Login</h1><form action="/login" method="post"><label>Email<input type="email" name="email"></label><label>Password<input type="password" name="password"></label><button>Sign in</button></form>'))
}).listen(4173,'127.0.0.1');"""
        contract = {'app': {'packaging': 'vendored', 'start': 'node app.cjs', 'url': 'http://127.0.0.1:4173', 'ready': {'path': '/', 'status': 200, 'timeout': '10s'}},
                    'personas': [{'name': 'shopper', 'username_env': 'QA_USER', 'password_env': 'QA_PASSWORD'}]}
        fixtures = {'files': [{'name': 'contacts', 'generate': {'kind': 'csv', 'rows': 20}}]}
        seed = {'datastores': [], 'steps': [], 'users': [], 'paths': []}
        fingerprint = {'version': 2, 'fingerprint': 'a' * 64, 'datastores': {}}
        cases = [('pi', False)] if os.environ.get('RIO_QA_TEST_WARM_ONLY') == '1' else [('codex', False), ('pi', False), ('codex', True)]
        for harness, interrupted in cases:
            with self.subTest(harness=harness, interrupted=interrupted), tempfile.TemporaryDirectory() as directory:
                socket, log = Path(directory) / 'model.sock', Path(directory) / 'requests.jsonl'
                model = subprocess.Popen(['node', str(Path(__file__).with_name('model-stub.mjs')), str(socket), str(log)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, env={**os.environ, 'RIO_QA_TEST_PAUSE_FINAL': '1' if interrupted else '0'})
                self.assertEqual(model.stdout.readline().strip(), b'ready')
                run_id = secrets.token_hex(8)
                pod = Pod(run_id, qa_image=image, app_image=image, hosted=False, model_socket=socket)
                try:
                    journey = {'name': 'import-contacts', 'persona': 'shopper', 'steps': [{'do': 'Log in and upload contacts', 'expect': 'Contacts are attached'}], 'success': ['Contacts are attached'], 'resets': True}
                    run = {'version': 1, 'review_id': 'controller-test', 'run_id': run_id, 'harness': harness, 'auth': 'gateway', 'model': 'qa-stub-model',
                           'budget': {'wall_ms': 90000, 'cell_wall_ms': 60000, 'tokens': 150000, 'evidence_bytes': 32 * 1024 ** 2},
                           'storage': {'kind': 'local'}, 'relay_token': 'synthetic-model-relay', 'seed': seed, 'seed_fingerprint': fingerprint,
                           'viewports': {'mobile': {'name': 'mobile', 'width': 390, 'height': 844, 'mobile': True, 'touch': True}}}
                    assets = {'run.json': run, 'contract.json': contract, 'fixtures.json': fixtures, 'journeys.json': {journey['name']: journey}, 'owner-guidance.json': {},
                              'plan.json': {'chains': [{'journeys': [journey['name']]}], 'cells': [{'viewport': 'mobile', 'color_scheme': 'light'}]}}
                    workspace = Path(directory) / 'runtime'
                    workspace.mkdir()
                    for name in ('runtime.py', 'pod.py', 'entrypoint.py'):
                        shutil.copyfile(Path(__file__).with_name(name), workspace / name)
                    shutil.copytree(root / 'crates/rio-qa/controller/src', workspace / 'hooks')
                    (workspace / 'snapshot.tar').write_bytes(archive_files({'app.cjs': application.encode()}).getvalue())
                    configuration = {'pod_id': run_id, 'qa_image': image, 'contract': contract, 'wall_ms': 90000,
                                     'model_socket': str(socket), 'local_cache': str(Path(directory) / 'cache'), 'seed_cache_bytes': 32 * 1024 ** 2}
                    for name, value in {'runtime': configuration, 'assets': assets, 'credentials': {'QA_USER': username, 'QA_PASSWORD': password}}.items():
                        (workspace / (name + '.json')).write_text(json.dumps(value))
                    for stage in ('prepare', 'run', 'recover'):
                        if stage == 'run' and interrupted:
                            process = subprocess.Popen(['python3', 'runtime.py', stage], cwd=workspace, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
                            try:
                                deadline = time.monotonic() + 90
                                while time.monotonic() < deadline and process.poll() is None:
                                    if log.exists() and len(log.read_text().splitlines()) >= 5:
                                        break
                                    time.sleep(0.1)
                                self.assertIsNone(process.poll(), 'controller finished before cancellation')
                                self.assertGreaterEqual(len(log.read_text().splitlines()), 5)
                                (workspace / 'cancel').write_text('interrupted')
                                stdout, stderr = process.communicate(timeout=45)
                            finally:
                                if process.poll() is None:
                                    process.kill(); process.communicate()
                            process = subprocess.CompletedProcess(process.args, process.returncode, stdout, stderr)
                        else:
                            process = subprocess.run(['python3', 'runtime.py', stage], cwd=workspace, capture_output=True, timeout=150)
                        self.assertEqual(process.returncode, 0, (stage, process.stderr, (workspace / 'runtime-error.json').read_text() if (workspace / 'runtime-error.json').exists() else ''))
                    result = json.loads((workspace / 'result.json').read_text())
                    if result['outcome'] != ('partial' if interrupted else 'complete'):
                        debug = Path(tempfile.mkdtemp(prefix='rio-controller-failure-'))
                        shutil.copytree(workspace, debug / 'runtime')
                        if log.exists(): shutil.copyfile(log, debug / 'requests.jsonl')
                        print('Synthetic controller diagnostics:', debug, flush=True)
                    self.assertEqual(result['outcome'], 'partial' if interrupted else 'complete', result)
                    if interrupted: self.assertEqual(result['runtime_reason'], 'interrupted')
                    if not interrupted:
                        self.assertEqual(result['journey_outcomes'][0]['outcome'], 'passed', result)
                        self.assertEqual(result['tokens'], 150)
                        context = result['journey_outcomes'][0]['verification_context']
                        self.assertEqual(context['journey'], journey)
                        self.assertTrue(any(rule['id'] == 'ux/task-efficiency' for rule in context['criteria']))
                        self.assertTrue(any(artifact['kind'] == 'screenshot' and 'step' not in artifact for artifact in result['evidence']['artifacts']))
                    dom = next(artifact for artifact in result['evidence']['artifacts'] if artifact['kind'] == 'dom')
                    snapshot = Path(dom['link']).read_text()
                    self.assertIn('Welcome shopper', snapshot)
                    self.assertIn('contacts.csv', snapshot)
                    requests = log.read_text()
                    self.assertNotIn(password, requests); self.assertNotIn(username, requests)
                    self.assertNotIn(password, json.dumps(result)); self.assertNotIn(username, json.dumps(result))
                    self.assertEqual(result['seed']['status'], 'built')
                    self.assertTrue((Path(directory) / 'cache/qa-seeds' / ('a' * 64) / 'manifest.json').is_file())
                    self.assertTrue(all(Path(artifact['link']).is_file() for artifact in result['evidence']['artifacts']))
                    manifest = Path(directory) / 'cache/controller-test/runs' / run_id / 'qa/manifest.json'
                    self.assertNotIn('/home/node/qa-evidence/', manifest.read_text())
                    self.assertNotEqual(docker('inspect', pod.containers['controller'], check=False).returncode, 0)
                    if harness == 'pi' and not interrupted:
                        # Reuse only retained events in a fresh seeded pod. No
                        # harness/model transport is present during replay.
                        recorded_log = next(row for row in result['evidence']['artifacts'] if row['kind'] == 'replay')
                        recorded_events = [json.loads(line) for line in Path(recorded_log['link']).read_text().splitlines()]
                        configuration['pod_id'] = secrets.token_hex(8)
                        configuration.pop('model_socket', None)
                        run['run_id'] = run_id + '-replay'
                        run['replay'] = {'events': recorded_events, 'artifacts': result['evidence']['artifacts'],
                                         'until': {'journey': journey['name'], 'step': 1}}
                        (workspace / 'runtime.json').write_text(json.dumps(configuration))
                        (workspace / 'assets.json').write_text(json.dumps(assets))
                        replayed = subprocess.run(['python3', 'runtime.py', 'run'], cwd=workspace, capture_output=True, timeout=150)
                        self.assertEqual(replayed.returncode, 0, replayed.stderr)
                        replay_result = json.loads((workspace / 'result.json').read_text())
                        self.assertEqual(replay_result['outcome'], 'recurred', replay_result)
                        self.assertEqual(replay_result['tokens'], 0)
                        self.assertEqual(log.read_text(), requests)
                        self.assertTrue(any(row['kind'] == 'trace' for row in replay_result['evidence']['artifacts']))
                        if os.environ.get('RIO_QA_RUNNER_BIN'):
                            replay_archive = Path(directory) / 'replay-snapshot.tar'
                            committed_contract = {**contract, 'version': 1,
                                'browser': {'viewports': [run['viewports']['mobile']], 'color_schemes': ['light']},
                                'personas': [{**persona, 'description': 'Synthetic shopper'} for persona in contract['personas']]}
                            committed_journey = {**journey, 'version': 1, 'title': 'Import contacts', 'tags': [], 'preconditions': [],
                                'covers': {'paths': ['app.cjs'], 'routes': ['/shop']}}
                            replay_archive.write_bytes(archive_files({'head/app.cjs': application.encode(),
                                'head/.rio/qa.yaml': json.dumps(committed_contract).encode(),
                                'head/.rio/qa/journeys/import-contacts.yaml': json.dumps(committed_journey).encode(),
                                'head/.rio/qa/fixtures/fixtures.yaml': json.dumps({**fixtures, 'version': 1}).encode()}).getvalue())
                            credentials_file = workspace / 'credentials.json'
                            cli_command = [os.environ['RIO_QA_RUNNER_BIN'], 'qa', '--image', image, 'replay',
                                '--archive', str(replay_archive), '--events', recorded_log['link'], '--manifest', str(manifest),
                                '--until', 'import-contacts:1', '--cache-dir', str(Path(directory) / 'cache')]
                            cli = subprocess.run(cli_command,
                                env={**os.environ, 'RIO_QA_CREDENTIALS_FILE': str(credentials_file)}, capture_output=True, timeout=180)
                            self.assertEqual(cli.returncode, 0, cli.stderr)
                            missing = json.loads(cli.stdout)
                            self.assertEqual(missing['outcome'], 'prerequisites_failed', cli.stdout)
                            # The direct-controller fixture above uses a synthetic
                            # fingerprint. Register its captured archives under the
                            # committed fixture's actual fingerprint for the CLI.
                            captured_seed = json.loads((Path(directory) / 'cache/qa-seeds' / ('a' * 64) / 'manifest.json').read_text())
                            captured_seed['fingerprint'] = missing['seed_fingerprint']
                            target_seed = Path(directory) / 'cache/qa-seeds' / missing['seed_fingerprint']['fingerprint']
                            target_seed.mkdir()
                            (target_seed / 'manifest.json').write_text(json.dumps(captured_seed))
                            cli = subprocess.run(cli_command,
                                env={**os.environ, 'RIO_QA_CREDENTIALS_FILE': str(credentials_file)}, capture_output=True, timeout=180)
                            self.assertEqual(cli.returncode, 0, cli.stderr)
                            self.assertEqual(json.loads(cli.stdout)['outcome'], 'recurred', cli.stdout)
                            self.assertEqual(log.read_text(), requests)
                        del run['replay']
                        configuration['model_socket'] = str(socket)
                        seed_manifest = Path(directory) / 'cache/qa-seeds' / ('a' * 64) / 'manifest.json'
                        before = json.loads(seed_manifest.read_text())
                        model.send_signal(signal.SIGHUP)
                        # A second pod receives a different immutable snapshot
                        # while executing the same selected journey and cell.
                        configuration['pod_id'] = secrets.token_hex(8)
                        run['snapshot_version'] = 'base'
                        run['run_id'] = run_id + '-base'
                        run['record_run_id'] = run_id
                        (workspace / 'snapshot.tar').write_bytes(archive_files({'app.cjs': application.replace('Welcome shopper', 'Welcome shopper on base').encode()}).getvalue())
                        (workspace / 'runtime.json').write_text(json.dumps(configuration))
                        (workspace / 'assets.json').write_text(json.dumps(assets))
                        repeated = subprocess.run(['python3', 'runtime.py', 'run'], cwd=workspace, capture_output=True, timeout=150)
                        self.assertEqual(repeated.returncode, 0, repeated.stderr)
                        warm = json.loads((workspace / 'result.json').read_text())
                        self.assertEqual(warm['outcome'], 'complete', warm)
                        self.assertEqual(warm['seed']['status'], 'restored', warm)
                        self.assertEqual(warm['journey_outcomes'][0]['outcome'], 'passed', warm)
                        self.assertEqual(json.loads(seed_manifest.read_text()), before)
                        base_dom = next(artifact for artifact in warm['evidence']['artifacts'] if artifact['kind'] == 'dom')
                        self.assertIn('Welcome shopper on base', Path(base_dom['link']).read_text())
                        self.assertNotIn('Welcome shopper on base', Path(dom['link']).read_text())
                        self.assertTrue(warm['probe_assessments'])
                        self.assertNotEqual(dom['id'], base_dom['id'])
                        self.assertNotEqual(dom['link'], base_dom['link'])
                        self.assertTrue(Path(base_dom['link']).is_relative_to(manifest.parent / 'baseline'))

                except Exception:
                    debug = Path(tempfile.mkdtemp(prefix='rio-controller-failure-'))
                    if 'workspace' in locals() and workspace.exists():
                        shutil.copytree(workspace, debug / 'runtime')
                    if log.exists(): shutil.copyfile(log, debug / 'requests.jsonl')
                    print('Synthetic controller diagnostics:', debug, flush=True)
                    raise
                finally:
                    try:
                        # The warm baseline run has its own pod identity. A
                        # timeout must clean that pod as well as the original.
                        if 'configuration' in locals() and configuration['pod_id'] != run_id:
                            Pod(configuration['pod_id'], qa_image=image, app_image=image).close()
                    finally:
                        try: pod.close()
                        finally:
                            model.terminate()
                            try: model.wait(timeout=5)
                            except subprocess.TimeoutExpired: model.kill(); model.wait()
                            model.stdout.close(); model.stderr.close()


if __name__ == '__main__':
    unittest.main()

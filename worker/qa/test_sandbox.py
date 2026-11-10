"""Run the deployment image's real Sandbox planner, supervisor and browser.

The local HTTP double stands in for the platform's scoped Worker interceptor;
Worker tests separately exercise authorization, D1/R2, leases and alarms.
"""
import io
import json
import os
from pathlib import Path
import secrets
import subprocess
import tarfile
import tempfile
import time
import unittest

ROOT = Path(__file__).resolve().parents[2]
GATEWAY = r'''
from http.server import BaseHTTPRequestHandler, HTTPServer
import json, uuid
manifests = {}
class Handler(BaseHTTPRequestHandler):
 def log_message(self,*args): pass
 def request(self):
  data=self.rfile.read(int(self.headers.get('content-length',0)))
  value={}; status=200
  if '/evidence/' in self.path:
   meta=json.loads(self.headers['rio-evidence-metadata'])
   formats={'screenshot':'png','video':'webm','trace':'zip','dom':'json','accessibility':'json','console':'jsonl','network':'jsonl','capture':'jsonl','probe':'json','replay':'jsonl','transcript':'jsonl'}
   step='cell' if 'step' not in meta else 'step-'+str(meta['step']).zfill(4)
   key='qa/test/review/run/'+meta['journey']+'/'+meta['cell']['viewport']+'-'+meta['cell']['color_scheme']+'/'+step+'-'+meta['kind']+'-'+meta['content_hash'][:16]+'.'+formats[meta['kind']]
   value={**meta,'storage':'hosted','key':key}
  elif self.path.endswith('/evidence'): value={'stored':True}
  elif self.path.endswith('/leases'): value={'id':str(uuid.uuid4())}
  elif '/manifests/' in self.path:
   if self.command=='PUT': manifests[self.path]=json.loads(data)
   elif self.command=='GET':
    value=manifests.get(self.path); status=200 if value else 404
  self.send_response(status);self.send_header('content-type','application/json');self.end_headers();self.wfile.write(json.dumps(value).encode())
 do_GET=request
 do_PUT=request
 do_POST=request
 do_PATCH=request
 do_DELETE=request
HTTPServer(('0.0.0.0',80),Handler).serve_forever()
'''


@unittest.skipUnless(os.environ.get('RIO_TEST_QA_DOCKER') == '1', 'requires the provisioned Sandbox image and Docker')
class SandboxIntegration(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.image = os.environ.get('RIO_QA_SANDBOX_IMAGE', 'rio-runner:qa-sandbox')
        cls.network = 'rio-sandbox-test-' + secrets.token_hex(5)
        cls.directory = tempfile.TemporaryDirectory()
        cls.path = Path(cls.directory.name)
        (cls.path / 'gateway.py').write_text(GATEWAY)
        cls.docker('network', 'create', '--internal', '--subnet', '198.18.0.0/24', '--gateway', '198.18.0.254', cls.network)
        cls.gateway = cls.network + '-gateway'
        cls.docker('run', '-d', '--user', '0', '--name', cls.gateway, '--network', cls.network, '--ip', '198.18.0.1', '-v', str(cls.path / 'gateway.py') + ':/tmp/gateway.py:ro', '--entrypoint', 'python3', cls.image, '/tmp/gateway.py')

    @classmethod
    def tearDownClass(cls):
        cls.docker('rm', '-f', cls.gateway)
        cls.docker('network', 'rm', cls.network)
        cls.directory.cleanup()

    @staticmethod
    def docker(*args, input=None):
        result = subprocess.run(['docker', *args], input=input, capture_output=True, timeout=180)
        if result.returncode:
            raise AssertionError(result.stderr.decode(errors='replace'))
        return result.stdout

    def run_case(self, packaging, *, start=None, files=None, cancel=False):
        name = self.network + '-' + secrets.token_hex(3)
        args = ['run', '-d', '--user', '0', '--name', name, '--network', self.network, '-e', 'RIO_CONTAINER=1', '--entrypoint', 'sleep',
                '-v', str(ROOT / 'crates/rio-qa/controller/src') + ':/opt/rio-qa/src:ro',
                '-v', str(ROOT / 'worker/qa/sandbox.py') + ':/opt/rio-qa/sandbox.py:ro',
                '-v', str(ROOT / 'crates/rio-qa/controller/tests/stubs/journey.mjs') + ':/opt/rio-qa/journey.mjs:ro', self.image, '180']
        self.docker(*args)
        self.addCleanup(lambda: self.docker('rm', '-f', name))
        self.docker('exec', name, 'cp', '/opt/rio-qa/journey.mjs', '/opt/rio-qa/scripted.mjs')
        self.docker('exec', name, 'chmod', '755', '/opt/rio-qa/scripted.mjs')
        self.docker('exec', name, 'ln', '-sf', '/opt/rio-qa/scripted.mjs', '/usr/local/bin/codex')
        app = {'packaging': packaging, 'url': 'http://app.test:4173', 'ready': {'path': '/', 'status': 200, 'timeout': '5s'}}
        if packaging == 'static': app['directory'] = 'public'
        if packaging == 'image': app['dockerfile'] = 'Dockerfile.qa'
        if start: app['start'] = start
        contract = {'version': 1, 'app': app, 'personas': [{'name': 'visitor', 'description': 'Test visitor'}],
                    'browser': {'viewports': ['mobile'], 'color_schemes': ['light']}}
        journey = {'version': 1, 'name': 'save', 'title': 'Save', 'persona': 'visitor', 'tags': ['smoke'],
                   'covers': {'paths': ['public/**'], 'routes': ['/']}, 'preconditions': [], 'steps': [{'do': 'Save', 'expect': 'Saved'}], 'success': ['Saved']}
        content = {'.rio/qa.yaml': json.dumps(contract), '.rio/qa/journeys/save.yaml': json.dumps(journey),
                   'REVIEW.md': 'Keep entered data and confirm successful saves.', 'Dockerfile.qa': 'FROM invalid\nRUN exit 1\n',
                   'public/index.html': '<button id="save" onclick="this.textContent=\'Saved\'">Save</button>'}
        content.update(files or {})
        archive = io.BytesIO()
        with tarfile.open(fileobj=archive, mode='w') as tar:
            for path, text in content.items():
                data = text.encode(); member = tarfile.TarInfo('head/' + path); member.mode = 0o644; member.size = len(data)
                tar.addfile(member, io.BytesIO(data))
        budget = {'wall_ms': 90000, 'cell_wall_ms': 30000, 'tokens': 50000, 'evidence_bytes': 20000000}
        job = {'kind': 'qa', 'network': 'qa', 'version': 'head', 'review_id': 'review', 'qa': {'run_id': 'run', 'harness_auth': 'gateway', 'harness': 'codex', 'model': 'scripted', 'budget': budget, 'options': {'sandbox': 'allow', 'mode': 'full'}, 'changed': []}}
        metadata = {'claim': {'qa': {'run_id': 'run', 'tenant': 'test', 'capability': 'synthetic-run-capability'}}, 'image_digest': 'sha256:' + 'a' * 64, 'credentials': {}}
        raw = (json.dumps(metadata) + '\n' + json.dumps(job) + '\n').encode() + archive.getvalue()
        plan = json.loads(self.docker('exec', '-i', name, 'rio-runner', 'qa', 'sandbox', 'plan', input=raw))
        if not plan['ready']:
            self.assertEqual(self.docker('exec', name, 'test', '!', '-e', '/work/repo'), b'')
            return plan['result']
        self.docker('exec', name, 'python3', '/opt/rio-qa/sandbox.py', 'launch')
        if cancel:
            self.docker('exec', name, 'python3', '/opt/rio-qa/sandbox.py', 'cancel')
        deadline = time.monotonic() + 110
        while time.monotonic() < deadline:
            status = json.loads(self.docker('exec', name, 'python3', '/opt/rio-qa/sandbox.py', 'status'))
            if status['done']: break
            time.sleep(0.5)
        self.assertTrue(status['done'], 'supervisor did not stop')
        processes = self.docker('exec', name, 'python3', '-c',
            "from pathlib import Path; print([p.name for p in Path('/proc').iterdir() if p.name.isdigit() and p.exists() and p.stat().st_uid == 1000 and 'State:\\tZ' not in (p/'status').read_text()])")
        self.assertEqual(processes.strip(), b'[]', 'runtime descendants survived shutdown')
        result = json.loads(self.docker('exec', name, 'rio-runner', 'qa', 'sandbox', 'finish'))
        return result

    def test_image_defers_without_launching_repository_dockerfile(self):
        result = self.run_case('image')
        self.assertEqual(result['deferred'], 'no_runtime')
        self.assertEqual(result['reason'], 'unsupported_packaging')

    def test_static_app_executes_browser_and_uploads_evidence(self):
        result = self.run_case('static')
        self.assertEqual(result['journey_outcomes'][0]['outcome'], 'passed', json.dumps(result))
        self.assertTrue(result['evidence']['artifacts'])

    def test_provisioned_vendored_server_executes_browser(self):
        server = "import {createServer} from 'node:http'; createServer((q,r)=>{r.setHeader('content-type','text/html');r.end(`<button id=save onclick=\"this.textContent='Saved'\">Save</button>`)}).listen(4173,'0.0.0.0');"
        result = self.run_case('vendored', start='node server.mjs', files={'server.mjs': server})
        self.assertEqual(result['journey_outcomes'][0]['outcome'], 'passed', json.dumps(result))

    def test_vendored_missing_dependency_is_named(self):
        result = self.run_case('vendored', start='node missing.mjs', files={'missing.mjs': "import 'dependency-not-provisioned';"})
        self.assertEqual(result['journey_outcomes'][0]['reason'], 'dependencies_unavailable', json.dumps(result))
        self.assertTrue(any(row['reason'] == 'startup_failure' for row in result['evidence']['notes']))

    def test_cancel_stops_and_retains_a_partial_result(self):
        result = self.run_case('vendored', start='node -e "setInterval(()=>{},1000)"', cancel=True)
        self.assertEqual(result['outcome'], 'partial')


if __name__ == '__main__':
    unittest.main()

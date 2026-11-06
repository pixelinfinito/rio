"""Opt-in integration test of the Rust runner's HTTP protocol and actual Docker isolation."""
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import subprocess
import threading
import unittest
import uuid


@unittest.skipUnless(os.getenv('RIO_TEST_DOCKER') == '1', 'set RIO_TEST_DOCKER=1 with a built runner image and binary')
class DockerRunner(unittest.TestCase):
    def test_graph_and_fork_static_analysis_use_the_trusted_rust_engine(self):
        image = os.getenv('RIO_RUNNER_IMAGE', 'rio-runner:0.2.0')
        base = {'app.py': {'mode': 0o100644, 'content': 'def result():\n    return 0\n'}}
        head = {'app.py': {'mode': 0o100644, 'content': 'def result():\n    return 1\n'}}
        profile = {'version': 1, 'name': 'runner-test', 'chain': [], 'modules': {}, 'engine_version': '0.2.0',
                   'posture_policy': {'defect_severity_floor': 'warning', 'render_plausible_risks': True, 'plausible_risk_limit': 5}}
        for kind in ['graph', 'static', 'checks']:
            analysis_profile = dict(profile)
            if kind == 'checks':
                analysis_profile['steps'] = [
                    {'id': 'prepare', 'uses': 'rio/prepare@0.1.0'},
                    {'id': 'checks', 'uses': 'rio/checks@0.1.0', 'needs': ['prepare'], 'with': {'secrets': True}},
                    {'id': 'graph', 'uses': 'rio/graph@0.1.0', 'needs': ['prepare']},
                    {'id': 'report', 'uses': 'rio/report@0.1.0', 'needs': ['checks', 'graph']},
                ]
            job = {'protocol': 1, 'network': False, 'kind': kind, 'job_id': uuid.uuid4().hex, 'attempt': 1, 'version': 'head',
                   'command': ['this-command-must-never-run'], 'snapshot': head, 'context': {'profile': analysis_profile, 'snapshot': {'base': base, 'head': head}},
                   'limits': {'wall_ms': 10000, 'output_bytes': 1048576}}
            name = f'rio-test-{job["job_id"]}'
            try:
                result = subprocess.run(['docker', 'run', '-i', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                                         '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '2048m', '--cpus', '2',
                                         '--tmpfs', '/tmp:rw,nosuid,nodev,size=1g,mode=1777', image, '/usr/bin/python3', '/opt/rio/execute.py'],
                                        input=json.dumps(job), capture_output=True, text=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                execution = json.loads(result.stdout)
                self.assertEqual(execution['exit_code'], 0, execution['stderr'])
                self.assertTrue(execution['artifact']['graphs']['head']['nodes'])
                checks = execution['artifact']['report']['checks']
                if kind == 'graph':
                    self.assertEqual(checks, [])
                elif kind == 'static':
                    self.assertTrue(any(c['kind'] == 'secrets' for c in checks))
                    self.assertTrue(all(c['outcome'] == 'skipped' for c in checks if c['kind'] != 'secrets'))
            finally:
                subprocess.run(['docker', 'rm', '--force', name], capture_output=True, timeout=10)

    def test_authenticated_claim_signed_completion_isolation_and_cleanup(self):
        root = Path(__file__).resolve().parents[3]
        binary = os.getenv('RIO_RUNNER_BIN', str(root / 'target/debug/rio-runner'))
        image = os.getenv('RIO_RUNNER_IMAGE', 'rio-runner:0.2.0')
        secret = 'local-test-runner-secret-32-characters'
        capability = 'local-test-scoped-job-capability-32-characters'
        job_id, review_id = uuid.uuid4().hex, uuid.uuid4().hex
        program = '''import json,os,socket
data={'uid':os.getuid(),'source':open('a.txt').read(),'secret':os.getenv('RIO_RUNNER_SECRET')}
try:
    open('/root-write-probe','w').close()
    data['readonly']=False
except OSError: data['readonly']=True
try:
    s=socket.socket(); s.settimeout(1); s.connect(('1.1.1.1',443)); data['network']=True
except OSError: data['network']=False
data['status']=[line.strip() for line in open('/proc/self/status') if line.startswith(('CapEff:','NoNewPrivs:'))]
data['memory']=open('/sys/fs/cgroup/memory.max').read().strip()
data['pids']=open('/sys/fs/cgroup/pids.max').read().strip()
print(json.dumps(data))
'''
        job = {'protocol': 1, 'review_id': review_id, 'job_id': job_id, 'attempt': 1,
               'kind': 'run', 'command': ['/usr/bin/python3', '-c', program], 'version': 'head',
               'snapshot': {'a.txt': {'mode': 0o100644, 'content': 'immutable snapshot'}},
               'limits': {'wall_ms': 10000, 'memory_mb': 2048, 'cpu': 2, 'output_bytes': 1048576}, 'network': False}
        completions, errors = [], []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_POST(self):
                content = self.rfile.read(int(self.headers.get('content-length', 0)))
                if self.path == '/v1/runner/claim':
                    if self.headers.get('authorization') != f'Bearer {secret}':
                        errors.append('claim authentication')
                    response = {'job': job, 'token': capability}
                else:
                    expected_path = f'/v1/runner/{review_id}/{job_id}/1/complete'
                    if self.path != expected_path or self.headers.get('authorization') != f'Bearer {capability}':
                        errors.append('completion scope')
                    expected = hmac.new(capability.encode(), content, hashlib.sha256).hexdigest()
                    if not hmac.compare_digest(expected, self.headers.get('rio-signature', '')):
                        errors.append('completion signature')
                    parsed = json.loads(content)
                    if json.dumps(parsed, sort_keys=True, separators=(',', ':'), ensure_ascii=False).encode() != content:
                        errors.append('canonical completion')
                    completions.append(parsed)
                    response = {'accepted': True}
                encoded = json.dumps(response).encode()
                self.send_response(200)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

        with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                result = subprocess.run([binary, 'serve', '--endpoint', f'http://127.0.0.1:{server.server_port}', '--image', image, '--once'],
                                        env={**os.environ, 'RIO_RUNNER_SECRET': secret}, capture_output=True, text=True, timeout=60)
                self.assertEqual(result.returncode, 0, result.stderr)
            finally:
                server.shutdown()
                thread.join(timeout=5)
        self.assertEqual(errors, [])
        self.assertEqual(len(completions), 1)
        self.assertEqual(completions[0]['exit_code'], 0)
        evidence = json.loads(completions[0]['stdout'])
        self.assertEqual(evidence['uid'], 10001)
        self.assertEqual(evidence['source'], 'immutable snapshot')
        self.assertIsNone(evidence['secret'])
        self.assertTrue(evidence['readonly'])
        self.assertFalse(evidence['network'])
        self.assertEqual(evidence['status'], ['CapEff:\t0000000000000000', 'NoNewPrivs:\t1'])
        self.assertEqual(evidence['memory'], str(2048 * 1024 * 1024))
        self.assertEqual(evidence['pids'], '128')
        remaining = subprocess.check_output(['docker', 'ps', '-aq', '--filter', f'name=^rio-{job_id}$'], text=True)
        self.assertEqual(remaining.strip(), '')

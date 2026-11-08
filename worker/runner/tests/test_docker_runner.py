"""Opt-in integration test of the Rust runner's HTTP protocol and actual Docker isolation."""
import hashlib
import hmac
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import io
import os
from pathlib import Path
import subprocess
import tarfile
import threading
import unittest
import uuid

# The image under test; CI builds it with this tag (.github/workflows/ci.yml).
IMAGE = os.getenv('RIO_RUNNER_IMAGE', 'rio-runner:0.3.0')


def executor_input(job, trees, links=None):
    """Header line (the job plus links) followed by the tar archive of the needed trees."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w', format=tarfile.PAX_FORMAT) as tar:
        for version, files in trees.items():
            for path, (content, mode) in sorted(files.items()):
                info = tarfile.TarInfo(f'{version}/{path}')
                info.size, info.mode = len(content), mode
                tar.addfile(info, io.BytesIO(content))
    header = dict(job, links=links or {version: {} for version in trees})
    return json.dumps(header).encode() + b'\n' + buffer.getvalue()


@unittest.skipUnless(os.getenv('RIO_TEST_DOCKER') == '1', 'set RIO_TEST_DOCKER=1 with a built runner image and binary')
class DockerRunner(unittest.TestCase):
    def test_graph_and_fork_static_analysis_use_the_trusted_rust_engine(self):
        image = IMAGE
        trees = {'base': {'app.py': (b'def result():\n    return 0\n', 0o644)},
                 'head': {'app.py': (b'def result():\n    return 1\n', 0o644)}}
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
                   'command': ['this-command-must-never-run'], 'snapshot_id': 'a' * 64, 'needs': ['base', 'head'], 'context': {'profile': analysis_profile},
                   'limits': {'wall_ms': 10000, 'output_bytes': 1048576, 'artifact_bytes': 12 * 1024 * 1024}}
            name = f'rio-test-{job["job_id"]}'
            try:
                result = subprocess.run(['docker', 'run', '-i', '--name', name, '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                                         '--security-opt', 'no-new-privileges', '--pids-limit', '128', '--memory', '2048m', '--cpus', '2',
                                         '--tmpfs', '/tmp:rw,nosuid,nodev,size=3g,mode=1777', image, '/usr/bin/python3', '/opt/rio/execute.py'],
                                        input=executor_input(job, trees, {'base': {}, 'head': {'link': 'YXBwLnB5'}}), capture_output=True, timeout=30)
                self.assertEqual(result.returncode, 0, result.stderr)
                execution = json.loads(result.stdout)
                self.assertEqual(execution['exit_code'], 0, execution['stderr'])
                self.assertTrue(execution['artifact']['graphs']['head']['nodes'])
                # The artifact is returned once, not echoed as command output.
                self.assertEqual(execution['stdout'], '')
                checks = execution['artifact']['report']['checks']
                if kind == 'graph':
                    self.assertEqual(checks, [])
                elif kind == 'static':
                    self.assertTrue(any(c['kind'] == 'secrets' for c in checks))
                    self.assertTrue(all(c['outcome'] == 'skipped' for c in checks if c['kind'] != 'secrets'))
            finally:
                subprocess.run(['docker', 'rm', '--force', name], capture_output=True, timeout=10)

    def serve(self, job, archive):
        """Runs one `serve --once` against a mock endpoint; returns completions and protocol errors."""
        root = Path(__file__).resolve().parents[3]
        binary = os.getenv('RIO_RUNNER_BIN', str(root / 'target/debug/rio-runner'))
        image = IMAGE
        secret = 'local-test-runner-secret-32-characters'
        capability = 'local-test-scoped-job-capability-32-characters'
        job_id, review_id = job['job_id'], job['review_id']
        completions, errors = [], []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def do_GET(self):
                # Only endpoint routes count; local tooling may probe a fresh port with `GET /`.
                expected = self.path == f'/v1/runner/{review_id}/{job_id}/1/archive' and self.headers.get('authorization') == f'Bearer {capability}'
                if self.path.startswith('/v1/') and not expected:
                    errors.append('archive scope')
                if archive is None or not expected:
                    self.send_response(404)
                    self.send_header('content-length', '0')
                    self.end_headers()
                    return
                self.send_response(200)
                self.send_header('content-type', 'application/octet-stream')
                self.send_header('content-length', str(len(archive)))
                self.end_headers()
                # Several writes exercise streaming across chunk boundaries.
                for start in range(0, len(archive), 65536):
                    self.wfile.write(archive[start:start + 65536])

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
        return completions, errors

    def job(self, command):
        return {'protocol': 1, 'review_id': uuid.uuid4().hex, 'job_id': uuid.uuid4().hex, 'attempt': 1,
                'kind': 'run', 'command': command, 'version': 'head', 'snapshot_id': 'a' * 64, 'needs': ['head'],
                'limits': {'wall_ms': 10000, 'memory_mb': 2048, 'cpu': 2, 'output_bytes': 1048576}, 'network': False}

    def test_authenticated_claim_signed_completion_isolation_and_cleanup(self):
        program = '''import json,os,socket
data={'uid':os.getuid(),'source':open('a.txt').read(),'mode':oct(os.stat('bin/tool').st_mode & 0o777),'big':len(open('big','rb').read()),'secret':os.getenv('RIO_RUNNER_SECRET')}
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
        job = self.job(['/usr/bin/python3', '-c', program])
        trees = {'head': {'a.txt': (b'immutable snapshot', 0o644), 'bin/tool': (b'#!/bin/sh\n', 0o755), 'big': (os.urandom(8 << 20), 0o644)}}
        completions, errors = self.serve(job, executor_input(job, trees))
        self.assertEqual(errors, [])
        self.assertEqual(len(completions), 1)
        self.assertEqual(completions[0]['exit_code'], 0)
        evidence = json.loads(completions[0]['stdout'])
        self.assertEqual(evidence['uid'], 10001)
        self.assertEqual(evidence['source'], 'immutable snapshot')
        self.assertEqual(evidence['mode'], '0o755')
        self.assertEqual(evidence['big'], 8 << 20)
        self.assertIsNone(evidence['secret'])
        self.assertTrue(evidence['readonly'])
        self.assertFalse(evidence['network'])
        self.assertEqual(evidence['status'], ['CapEff:\t0000000000000000', 'NoNewPrivs:\t1'])
        self.assertEqual(evidence['memory'], str(2048 * 1024 * 1024))
        self.assertEqual(evidence['pids'], '128')
        remaining = subprocess.check_output(['docker', 'ps', '-aq', '--filter', f'name=^rio-{job["job_id"]}$'], text=True)
        self.assertEqual(remaining.strip(), '')

    def test_unavailable_or_mismatched_archive_is_a_runner_failure(self):
        job = self.job(['/bin/true'])
        other = dict(job, job_id=uuid.uuid4().hex)
        for archive in [None, executor_input(other, {'head': {}})]:
            completions, errors = self.serve(job, archive)
            self.assertEqual(errors, [])
            self.assertEqual(len(completions), 1)
            self.assertEqual(completions[0]['outcome'], 'runner_failed')
            self.assertEqual(completions[0]['stderr'], 'runner could not download the job archive')


def git(root, *args):
    subprocess.run(['git', '-C', str(root), *args], check=True, capture_output=True)


GIT_SERVER = r"""
import base64, json, os, ssl, subprocess, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
TOKEN = sys.argv[1]
LOG = '/srv/log.jsonl'
def log(kind, value):
    with open(LOG, 'a') as f:
        f.write(json.dumps({'kind': kind, 'value': value}) + '\n')
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def do_DELETE(self):
        if self.path == '/installation/token':
            log('revoked', self.headers.get('authorization', ''))
        self.send_response(204)
        self.end_headers()
    def do_GET(self):
        self.backend()
    def do_POST(self):
        self.backend()
    def backend(self):
        expected = 'Basic ' + base64.b64encode(('x-access-token:' + TOKEN).encode()).decode()
        log('auth', self.headers.get('authorization', ''))
        if self.headers.get('authorization') != expected:
            self.send_response(401)
            self.send_header('www-authenticate', 'Basic realm="GitHub"')
            self.send_header('content-length', '0')
            self.end_headers()
            return
        path, _, query = self.path.partition('?')
        body = self.rfile.read(int(self.headers.get('content-length', 0) or 0))
        env = {'GIT_PROJECT_ROOT': '/srv', 'GIT_HTTP_EXPORT_ALL': '1', 'PATH_INFO': path, 'QUERY_STRING': query,
               'REQUEST_METHOD': self.command, 'CONTENT_TYPE': self.headers.get('content-type', ''),
               'GIT_PROTOCOL': self.headers.get('git-protocol', ''), 'PATH': '/usr/bin:/bin', 'HOME': '/tmp'}
        result = subprocess.run(['git', '-c', 'safe.directory=*', 'http-backend'], input=body, env=env, capture_output=True)
        head, _, payload = result.stdout.partition(b'\r\n\r\n')
        status, headers = 200, []
        for line in head.decode().split('\r\n'):
            name, _, value = line.partition(': ')
            if name.lower() == 'status':
                status = int(value.split()[0])
            elif name:
                headers.append((name, value))
        self.send_response(status)
        for name, value in headers:
            self.send_header(name, value)
        self.send_header('content-length', str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)
server = ThreadingHTTPServer(('0.0.0.0', 8443), Handler)
context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
context.load_cert_chain('/srv/cert.pem', '/srv/key.pem')
server.socket = context.wrap_socket(server.socket, server_side=True)
server.serve_forever()
"""


class GitServer:
    """Smart HTTP git over TLS (git http-backend) that requires the installation
    token, plus GitHub's token revocation route. It runs in a container on a
    test network, which the clone phase joins through RIO_RUNNER_CLONE_NETWORK."""

    def __init__(self, directory, token, image):
        self.directory, self.token = Path(directory), token
        self.network = f'rio-test-{uuid.uuid4().hex[:12]}'
        self.name = f'{self.network}-git'
        self.cert, self.key = self.directory / 'cert.pem', self.directory / 'key.pem'
        subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=git.rio.test',
                        '-addext', 'subjectAltName=DNS:git.rio.test', '-keyout', str(self.key), '-out', str(self.cert)],
                       check=True, capture_output=True)
        (self.directory / 'server.py').write_text(GIT_SERVER)
        for path in [self.directory, *self.directory.rglob('*')]:
            path.chmod(0o777 if path.is_dir() else 0o644)
        subprocess.run(['docker', 'network', 'create', self.network], check=True, capture_output=True)
        subprocess.run(['docker', 'run', '-d', '--name', self.name, '--network', self.network, '--network-alias', 'git.rio.test',
                        '-v', f'{self.directory}:/srv', image, 'python3', '/srv/server.py', token], check=True, capture_output=True)
        self.url = 'https://git.rio.test:8443'
        __import__('time').sleep(1)

    def entries(self, kind):
        log = self.directory / 'log.jsonl'
        if not log.exists():
            return []
        return [e['value'] for e in map(json.loads, log.read_text().splitlines()) if e['kind'] == kind]

    @property
    def auth(self):
        return self.entries('auth')

    @property
    def revoked(self):
        return self.entries('revoked')

    def close(self):
        subprocess.run(['docker', 'rm', '--force', self.name], capture_output=True)
        subprocess.run(['docker', 'network', 'rm', self.network], capture_output=True)


@unittest.skipUnless(os.getenv('RIO_TEST_DOCKER') == '1', 'set RIO_TEST_DOCKER=1 with a built runner image and binary')
class DockerPrepare(unittest.TestCase):
    """The self-hosted `prepare` job: networked clone with the token, then analysis without either."""

    def setUp(self):
        import tempfile
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.token = 'ghs_' + uuid.uuid4().hex
        source = root / 'source'
        source.mkdir()
        git(source, 'init', '-q', '-b', 'main')
        git(source, 'config', 'user.email', 'rio@example.invalid')
        git(source, 'config', 'user.name', 'Rio test')
        (source / 'app.py').write_text('def total():\n    return 1\n')
        git(source, 'add', '.')
        git(source, 'commit', '-q', '-m', 'base')
        self.base = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
        (source / 'app.py').write_text('def total():\n    return 2\n\ndef tax():\n    return total() * 2\n')
        git(source, 'commit', '-q', '-am', 'head')
        self.head = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
        subprocess.run(['git', 'clone', '-q', '--bare', str(source), str(root / 'acme/repo.git')], check=True)
        git(root / 'acme/repo.git', 'config', 'uploadpack.allowAnySHA1InWant', 'true')
        self.git = GitServer(root, self.token, IMAGE)

    def tearDown(self):
        self.git.close()
        self.temporary.cleanup()

    def run_prepare(self, github_token):
        root = Path(__file__).resolve().parents[3]
        binary = os.getenv('RIO_RUNNER_BIN', str(root / 'target/debug/rio-runner'))
        image = IMAGE
        secret = 'local-test-runner-secret-32-characters'
        capability = 'local-test-scoped-job-capability-32-characters'
        credential = 'rio_prepare_' + 'ab' * 32
        job = {'protocol': 1, 'review_id': uuid.uuid4().hex, 'job_id': uuid.uuid4().hex, 'attempt': 1, 'kind': 'prepare',
               'command': ['rio-internal', 'prepare'], 'version': 'head', 'snapshot_id': '', 'needs': [],
               'limits': {'wall_ms': 600000, 'memory_mb': 2048, 'cpu': 2, 'output_bytes': 1048576, 'artifact_bytes': 12 * 1024 * 1024},
               'network': 'clone',
               'prepare': {'repository': 'acme/repo', 'clone_url': f'{self.git.url}/acme/repo.git', 'number': 7,
                           'base_sha': self.base, 'head_sha': self.head, 'installation_id': 1}}
        received = {'completions': [], 'submissions': [], 'uploads': [], 'errors': []}

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_):
                pass

            def reply(self, status, value):
                encoded = json.dumps(value).encode()
                self.send_response(status)
                self.send_header('content-type', 'application/json')
                self.send_header('content-length', str(len(encoded)))
                self.end_headers()
                self.wfile.write(encoded)

            def do_PUT(self):
                body = self.rfile.read(int(self.headers.get('content-length', 0)))
                if self.headers.get('authorization') != f'Bearer {credential}':
                    received['errors'].append('upload credential')
                received['uploads'].append((self.path, len(body)))
                self.reply(201, {'chunk': 0, 'pack': 'p', 'contents': 1})

            def do_POST(self):
                content = self.rfile.read(int(self.headers.get('content-length', 0)))
                if self.path == '/v1/runner/claim':
                    self.reply(200, {'job': job, 'token': capability,
                                     'prepare': {'github_token': github_token, 'credential': credential}})
                elif self.path.endswith('/complete'):
                    received['completions'].append(json.loads(content))
                    self.reply(200, {'accepted': True})
                elif self.path == '/v1/contents/missing':
                    self.reply(200, {'missing': json.loads(content)['hashes']})
                elif self.path.endswith('/seal'):
                    self.reply(201, {'id': self.path.split('/')[3]})
                elif self.path == '/v1/reviews':
                    if self.headers.get('authorization') != f'Bearer {credential}':
                        received['errors'].append('submission credential')
                    received['submissions'].append(json.loads(content))
                    self.reply(202, {'id': job['review_id'], 'status': 'queued'})
                else:
                    received['errors'].append(self.path)
                    self.reply(404, {'error': 'not found'})

        with ThreadingHTTPServer(('127.0.0.1', 0), Handler) as server:
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                result = subprocess.run([binary, 'serve', '--endpoint', f'http://127.0.0.1:{server.server_port}', '--image', image, '--once'],
                                        env={**os.environ, 'RIO_RUNNER_SECRET': secret, 'RIO_GITHUB_API_URL': self.git.url,
                                             'RIO_RUNNER_GIT_CA': str(self.git.cert), 'RIO_RUNNER_CLONE_NETWORK': self.git.network},
                                        capture_output=True, text=True, timeout=600)
                self.assertEqual(result.returncode, 0, result.stderr)
            finally:
                server.shutdown()
                thread.join(timeout=5)
        remaining = subprocess.check_output(['docker', 'ps', '-aq', '--filter', f'name=rio-{job["job_id"]}'], text=True)
        self.assertEqual(remaining.strip(), '')
        return job, received

    def test_clone_with_the_token_then_analysis_without_route_or_token(self):
        job, received = self.run_prepare(self.token)
        self.assertEqual(received['errors'], [])
        self.assertEqual(len(received['completions']), 1)
        completion = received['completions'][0]
        self.assertEqual(completion['exit_code'], 0, completion['stderr'])
        self.assertEqual(completion['stdout'], job['review_id'])
        # The analysis container checked that it had no route and no token.
        self.assertEqual(completion['artifact'], {'isolation': {'network': False, 'token': False}})
        # The clone used the token; the clone container revoked it afterwards.
        self.assertTrue(any(a.startswith('Basic ') for a in self.git.auth))
        self.assertIn(f'Bearer {self.token}', self.git.revoked)
        [submission] = received['submissions']
        self.assertEqual(submission['report']['review']['base'], self.base)
        self.assertEqual(submission['report']['review']['head'], self.head)
        self.assertEqual([c['path'] for c in submission['changed']], ['app.py'])
        self.assertTrue(submission['snapshot_id'])
        self.assertTrue(any(path.startswith('/v1/manifests/') for path, _ in received['uploads']))
        # The token never reaches the endpoint.
        self.assertNotIn(self.token, json.dumps(received))

    def test_a_bad_token_fails_the_job_cleanly(self):
        job, received = self.run_prepare('ghs_' + 'f' * 32)
        self.assertEqual(received['errors'], [])
        self.assertEqual(received['submissions'], [])
        [completion] = received['completions']
        self.assertEqual(completion['outcome'], 'exited')
        self.assertEqual(completion['exit_code'], 1)
        self.assertTrue(completion['stderr'].startswith('clone failed: '), completion['stderr'])
        # Git reached the server with the rejected token, and the token was still revoked.
        self.assertTrue(self.git.auth)
        self.assertIn('Bearer ghs_' + 'f' * 32, self.git.revoked)


@unittest.skipUnless(os.getenv('RIO_TEST_DOCKER') == '1', 'set RIO_TEST_DOCKER=1 with a built runner image and binary')
class RunnerImage(unittest.TestCase):
    """Hosted checks run with the image's toolchains when dependencies are vendored and
    are skipped with the dependency rule's reason and hint when they are not."""

    def checks(self, files, every=False):
        image = IMAGE
        trees = {'base': {k: (v.replace(b'2', b'1'), 0o644) for k, v in files.items()}, 'head': {k: (v, 0o644) for k, v in files.items()}}
        profile = {'version': 1, 'name': 'image-test', 'chain': [], 'modules': {}, 'engine_version': '0.2.0',
                   'posture_policy': {'defect_severity_floor': 'warning', 'render_plausible_risks': True, 'plausible_risk_limit': 5},
                   'steps': [{'id': 'prepare', 'uses': 'rio/prepare@0.1.0'},
                             {'id': 'checks', 'uses': 'rio/checks@0.1.0', 'needs': ['prepare'],
                              'with': {'typecheck': True, 'lint': every, 'coverage': every, 'secrets': True, 'dependencies': every}},
                             {'id': 'graph', 'uses': 'rio/graph@0.1.0', 'needs': ['prepare']},
                             {'id': 'report', 'uses': 'rio/report@0.1.0', 'needs': ['checks', 'graph']}]}
        job = {'protocol': 1, 'network': False, 'kind': 'checks', 'job_id': uuid.uuid4().hex, 'attempt': 1, 'version': 'head',
               'command': ['x'], 'snapshot_id': 'a' * 64, 'needs': ['base', 'head'], 'context': {'profile': profile},
               'limits': {'wall_ms': 90000, 'output_bytes': 1048576, 'artifact_bytes': 12 * 1024 * 1024}}
        result = subprocess.run(['docker', 'run', '-i', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                                 '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev,size=3g,mode=1777',
                                 image, '/usr/bin/python3', '/opt/rio/execute.py'],
                                input=executor_input(job, trees), capture_output=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stderr)
        execution = json.loads(result.stdout)
        self.assertEqual(execution['exit_code'], 0, execution['stderr'])
        return execution['artifact']['report']['checks']

    def test_typecheck_runs_with_vendored_dependencies_and_is_skipped_without(self):
        package = b'{"name":"app","version":"1.0.0","dependencies":{"tiny":"1.0.0"}}'
        lock = (b'{"name":"app","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"app","version":"1.0.0",'
                b'"dependencies":{"tiny":"1.0.0"}},"node_modules/tiny":{"version":"1.0.0"}}}')
        installed = b'{"name":"app","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"node_modules/tiny":{"version":"1.0.0"}}}'
        vendored = {'package.json': package, 'package-lock.json': lock,
                    'tsconfig.json': b'{"compilerOptions":{"strict":true,"noEmit":true},"include":["src"]}',
                    'src/a.ts': b'import { tiny } from "tiny";\nexport const value: number = tiny(2);\n',
                    'node_modules/.package-lock.json': installed,
                    'node_modules/tiny/package.json': b'{"name":"tiny","version":"1.0.0","types":"index.d.ts","main":"index.js"}',
                    'node_modules/tiny/index.d.ts': b'export declare function tiny(n: number): number;\n',
                    'node_modules/tiny/index.js': b'exports.tiny = (n) => n;\n'}
        ran = [c for c in self.checks(vendored) if c['kind'] == 'typecheck' and c['version'] == 'head']
        self.assertEqual([c['outcome'] for c in ran], ['passed'], ran)
        # Without node_modules, with a linter and a test runner declared and a
        # lockfile the PR changes (the base side differs by the 1 -> 2 edit).
        package = (b'{"name":"app","version":"1.0.0","scripts":{"test":"vitest"},"dependencies":{"tiny":"1.0.2"},'
                   b'"devDependencies":{"vitest":"4.1.0","eslint":"9.39.1"}}')
        lock = (b'{"name":"app","version":"1.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"app","version":"1.0.0",'
                b'"dependencies":{"tiny":"1.0.2"}},"node_modules/tiny":{"version":"1.0.2"}}}')
        missing = {'package.json': package, 'package-lock.json': lock, 'tsconfig.json': vendored['tsconfig.json'],
                   'src/a.ts': vendored['src/a.ts'], 'eslint.config.js': b'export default [];\n',
                   'vitest.config.ts': b'export default {};\n',
                   'src/a.test.ts': b'import { test } from "vitest";\ntest("a", () => {});\n'}
        checks = {c['kind']: c for c in self.checks(missing, every=True) if c.get('version', 'head') == 'head'}
        for kind in ['typecheck', 'lint']:
            self.assertEqual((checks[kind]['outcome'], checks[kind]['reason']), ('skipped', 'dependency_mismatch'), kind)
            self.assertIn('node_modules/.package-lock.json is missing', checks[kind]['hint'])
        self.assertEqual((checks['coverage']['outcome'], checks['coverage']['reason']), ('skipped', 'tool_missing'))
        self.assertIn('vitest', checks['coverage']['hint'])
        # The audit needs its advisory service; the analysis has no network.
        self.assertEqual((checks['dependencies']['outcome'], checks['dependencies']['reason']), ('skipped', 'offline'))
        # Secrets still run when the dependency-bound checks cannot.
        self.assertEqual(checks['secrets']['outcome'], 'passed')

    def test_sandbox_prepare_builds_the_submission_from_the_snapshot_without_network(self):
        image = IMAGE
        base, head = 'a' * 40, 'b' * 40
        trees = {'base': {'app.py': (b'def total():\n    return 1\n', 0o644),
                          '.rio/profiles/default.yaml': (b'version: 1\nname: team\nextends: rio/base\npublish: ask\n', 0o644)},
                 'head': {'app.py': (b'def total():\n    return 2\n', 0o644),
                          # The PR's own profile change does not set its policy.
                          '.rio/profiles/default.yaml': (b'version: 1\nname: team\nextends: rio/base\npublish: auto\n', 0o644)}}
        job = {'protocol': 1, 'network': False, 'kind': 'prepare', 'job_id': uuid.uuid4().hex, 'attempt': 1, 'version': 'head',
               'command': ['rio-internal', 'prepare'], 'snapshot_id': 'a' * 64, 'needs': ['base', 'head'],
               'prepare': {'repository': 'acme/repo', 'clone_url': 'https://github.com/acme/repo.git', 'number': 3,
                           'base_sha': base, 'head_sha': head, 'installation_id': 1},
               'limits': {'wall_ms': 120000, 'output_bytes': 1048576, 'artifact_bytes': 12 * 1024 * 1024}}
        result = subprocess.run(['docker', 'run', '-i', '--rm', '--network', 'none', '--read-only', '--cap-drop', 'ALL',
                                 '--security-opt', 'no-new-privileges', '--tmpfs', '/tmp:rw,nosuid,nodev,size=3g,mode=1777',
                                 image, '/usr/bin/python3', '/opt/rio/execute.py'],
                                input=executor_input(job, trees), capture_output=True, timeout=180)
        self.assertEqual(result.returncode, 0, result.stderr)
        execution = json.loads(result.stdout)
        self.assertEqual(execution['exit_code'], 0, execution['stderr'])
        submission = execution['artifact']['submission']
        self.assertEqual(submission['report']['review']['base'], base)
        self.assertEqual(submission['report']['review']['head'], head)
        self.assertEqual(sorted(c['path'] for c in submission['changed']), ['.rio/profiles/default.yaml', 'app.py'])
        self.assertEqual(submission['profile']['name'], 'team')
        self.assertEqual(submission['profile']['publish'], 'ask')
        self.assertNotIn('snapshot_id', submission)

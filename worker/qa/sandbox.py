#!/usr/bin/python3
"""Supervisor inside the provisioned Sandbox image, never on the operator host.

Cloudflare disables internet and exposes one run-scoped Worker interceptor. All
app/browser/controller processes share this container, as the report declares.
"""
import json
import os
from pathlib import Path
import signal
import shutil
import subprocess
import sys
import tarfile
import time
from urllib.parse import urlsplit
from pod import fixture_network, fixture_certificate, safe_path

ROOT = Path('/run/rio-sandbox')
NODE_HOME = Path('/home/node')
POLICY = {'egress': 'provider_pinned (sandbox)', 'app_isolation': 'none'}


def write(path, value):
    temporary = path.with_suffix('.pending')
    with open(temporary, 'w') as output:
        os.chmod(temporary, 0o600)
        json.dump(value, output, separators=(',', ':'))
    os.replace(temporary, path)


def prepare():
    assets = json.loads((ROOT / 'assets.json').read_text())
    contract, fixtures = assets['contract.json'], assets['fixtures.json']
    if contract['app']['packaging'] not in ('static', 'vendored'):
        raise ValueError('unsupported_packaging')
    repo = Path('/work/repo')
    repo.mkdir(parents=True, exist_ok=False)
    # The planner produced this archive from validated regular-file snapshots.
    # Recheck before writing; no archive link or absolute path is materialized.
    with tarfile.open(ROOT / 'snapshot.tar') as archive:
        total = 0
        for member in archive:
            total += member.size
            if not member.isreg() or not safe_path(member.name) or member.mode not in (0o644, 0o755) or member.size > 64 * 1024**2 or total > 1024**3:
                raise ValueError('invalid_snapshot')
            path = repo / member.name
            path.parent.mkdir(parents=True, exist_ok=True)
            with open(path, 'xb') as output:
                shutil.copyfileobj(archive.extractfile(member), output)
            path.chmod(member.mode)
    app_port = urlsplit(contract['app']['url']).port or 80
    if app_port in (9222, 9223, 9224, 9225, 9226):
        raise ValueError('reserved_app_port')
    ports, claims, _ = fixture_network(fixtures, app_port, 9224)
    if any(port in (9223, 9225, 9226) for port in ports.values()):
        raise ValueError('reserved_fixture_port')
    with open('/etc/hosts', 'a') as output:
        output.write('\n127.0.0.1 app app.test browser controller ' + ' '.join(claims) + '\n')
    hooks = Path('/opt/rio-qa-app')
    shutil.copytree('/opt/rio-qa/src', hooks)
    env = {**os.environ, 'HOME': str(NODE_HOME), 'USER': 'node', 'LOGNAME': 'node',
           'RIO_QA_APP_CONTROL': 'http://127.0.0.1:9224', 'RIO_QA_BROWSER': 'http://127.0.0.1:9223',
           'RIO_QA_BROWSER_FILES': 'http://127.0.0.1:9226', 'NODE_EXTRA_CA_CERTS': '/etc/ssl/certs/ca-certificates.crt',
           'SSL_CERT_FILE': '/etc/ssl/certs/ca-certificates.crt', 'REQUESTS_CA_BUNDLE': '/etc/ssl/certs/ca-certificates.crt'}
    document = {'contract': contract, 'fixtures': fixtures, 'seed': assets['run.json']['seed'],
                'seed_fingerprint': assets['run.json']['seed_fingerprint'], 'seed_transfer': True, 'service_ports': ports}
    if claims:
        certificate = fixture_certificate(claims)
        (hooks / 'tls-key.pem').write_bytes(certificate['key'])
        (hooks / 'tls-cert.pem').write_bytes(certificate['cert'])
        Path('/usr/local/share/ca-certificates/rio-run.crt').write_bytes(certificate['ca'])
        subprocess.run(['update-ca-certificates'], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        env['RIO_QA_FIXTURE_SPKI'] = certificate['spki']
        document['fixture_tls'] = True
    write(hooks / 'runtime.json', document)
    shutil.copyfile(ROOT / 'credentials.json', hooks / 'credentials.json')
    NODE_HOME.mkdir(parents=True, exist_ok=True)
    for name, value in assets.items():
        if name not in ('contract.json', 'journeys.json', 'fixtures.json', 'owner-guidance.json', 'plan.json', 'run.json'):
            raise ValueError('invalid_asset')
        write(NODE_HOME / name, value)
    shutil.copyfile(ROOT / 'credentials.json', NODE_HOME / 'credentials.json')
    for tree in (repo, hooks, NODE_HOME):
        for directory, children, files in os.walk(tree, followlinks=False):
            os.chown(directory, 1000, 1000, follow_symlinks=False)
            for name in children + files:
                os.chown(os.path.join(directory, name), 1000, 1000, follow_symlinks=False)
    return env, assets['run.json']['budget']['wall_ms'] / 1000


def run():
    children = []
    interrupted = False
    def stop(*_):
        nonlocal interrupted
        interrupted = True
    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    try:
        env, wall = prepare()
        started = time.monotonic()
        for role, entry in [('app', 'app-entrypoint.mjs'), ('browser', 'browser-server.mjs'), ('controller', 'controller-entrypoint.mjs')]:
            path = '/opt/rio-qa-app' if role == 'app' else '/opt/rio-qa/src'
            child = subprocess.Popen(['node', f'{path}/{entry}'], env={**env, 'RIO_QA_CONTAINER': role}, cwd=NODE_HOME,
                                     user=1000, group=1000, extra_groups=[], start_new_session=True,
                                     stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            children.append(child)
        controller = children[-1]
        while controller.poll() is None:
            if interrupted or (ROOT / 'cancel').exists() or time.monotonic() - started >= wall:
                controller.send_signal(signal.SIGTERM)
                try: controller.wait(timeout=20)
                except subprocess.TimeoutExpired: controller.kill()
                break
            time.sleep(0.2)
        controller.wait()
    except Exception:
        # Never publish raw app output, credential files or exception strings.
        write(ROOT / 'failure.json', {'reason': 'sandbox_runtime_failed'})
    finally:
        for child in reversed(children):
            try: os.killpg(child.pid, signal.SIGTERM)
            except ProcessLookupError: pass
        for child in reversed(children):
            try: child.wait(timeout=5)
            except subprocess.TimeoutExpired:
                try: os.killpg(child.pid, signal.SIGKILL)
                except ProcessLookupError: pass
        # App commands and Chromium may create their own sessions. This is a
        # disposable container: every process under the runtime UID belongs to
        # this run, including detached descendants of an exited shell.
        for entry in Path('/proc').iterdir():
            if not entry.name.isdigit():
                continue
            try:
                if entry.stat().st_uid == 1000:
                    os.kill(int(entry.name), signal.SIGKILL)
            except (ProcessLookupError, FileNotFoundError):
                pass
        # Set completion only after descendants have been stopped. The DO reads
        # the sanitized checkpoint, finalizes it, then destroys this container.
        write(ROOT / 'done.json', {'done': True})


if __name__ == '__main__':
    if os.environ.get('RIO_CONTAINER') != '1' or os.geteuid() != 0:
        raise SystemExit('Sandbox supervisor requires the provisioned container')
    action = sys.argv[1]
    if action == 'launch':
        subprocess.Popen([sys.executable, __file__, 'run'], start_new_session=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        print(json.dumps({'started': True}))
    elif action == 'run':
        run()
    elif action == 'status':
        print(json.dumps({'done': (ROOT / 'done.json').is_file()}))
    elif action == 'cancel':
        (ROOT / 'cancel').touch()
        print(json.dumps({'cancelled': True}))
    else:
        raise SystemExit('Invalid Sandbox action')

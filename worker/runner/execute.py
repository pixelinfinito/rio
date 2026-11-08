#!/usr/bin/env python3
"""Trusted container entry point. Never run this on the host for untrusted jobs."""
import json
import base64
import os
from pathlib import Path
import re
import urllib.request
import selectors
import shutil
import signal
import stat
import subprocess
import sys
import tarfile
import tempfile
import time


HEADER_LIMIT = 16 * 1024 * 1024
# Rio's own analysis artifact (stdout of `rio-runner inside`) has its own bound; command
# output keeps `output_bytes`.
ARTIFACT_LIMIT = 12 * 1024 * 1024
RUNNER = '/usr/local/bin/rio-runner'
RIO = '/usr/local/bin/rio'
VERSIONS = ('base', 'head')
# A prepare job clones, snapshots and builds the graph within ten minutes.
PREPARE_WALL_MS = 600000
CLONE_URL = re.compile(r'^https://[A-Za-z0-9.-]+(:[0-9]{1,5})?/[A-Za-z0-9._-]+/[A-Za-z0-9._-]+?(\.git)?$')
SHA = re.compile(r'^[0-9a-f]{40}$')
WORK = Path('/work')


def safe_path(name):
    parts = name.split('/')
    return bool(name) and not name.startswith('/') and '\\' not in name and '\0' not in name and all(p not in ('', '.', '..') and p.lower() != '.git' for p in parts)


def write_member(tree, path, source, mode):
    # Nothing but directories and regular files is ever created, but check every component
    # without following links so a duplicate or file/directory overlap cannot escape.
    directory = tree
    for part in path.split('/')[:-1]:
        directory = directory / part
        if os.path.lexists(directory):
            assert stat.S_ISDIR(os.lstat(directory).st_mode), 'archive member overlaps a file'
        else:
            directory.mkdir()
    descriptor = os.open(tree / path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'wb') as target:
        shutil.copyfileobj(source, target, 1 << 20)
        os.fchmod(target.fileno(), mode)


def extract(stream, root, needs):
    """Stream-extract the job archive: only regular `base/<path>` or `head/<path>` members of
    needed versions with mode 0644 or 0755. Directory entries, links and every other member
    type abort the job; never use extractall on repository-controlled archives."""
    with tarfile.open(fileobj=stream, mode='r|', encoding='utf-8', errors='strict') as archive:
        for member in archive:
            assert member.isreg(), 'archive member is not a regular file'
            version, _, path = member.name.partition('/')
            assert version in needs and safe_path(path), 'unsafe archive member'
            assert member.mode in (0o644, 0o755), 'unsupported archive member mode'
            write_member(root / version, path, archive.extractfile(member), member.mode)


def execute(stream):
    header = stream.readline(HEADER_LIMIT + 1)
    assert header.endswith(b'\n'), 'missing or oversized job header'
    job = json.loads(header)
    assert job['protocol'] == 1 and job['network'] is False
    limits = job['limits']
    wall = PREPARE_WALL_MS if job['kind'] == 'prepare' else 120000
    assert 0 < limits['wall_ms'] <= wall and 0 < limits['output_bytes'] <= 1048576
    analysis = job['kind'] != 'run'
    artifact_bytes = limits.get('artifact_bytes', 0)
    assert (0 < artifact_bytes <= ARTIFACT_LIMIT) if analysis else not artifact_bytes, 'invalid artifact limit'
    needs = job['needs']
    assert isinstance(needs, list) and len(set(needs)) == len(needs) and set(needs) <= set(VERSIONS)
    if job['kind'] == 'run':
        assert job['version'] in needs
    else:
        # Analysis compares both trees; an absent one would silently look empty.
        assert set(needs) == set(VERSIONS)
    assert isinstance(job.get('links', {}), dict) and set(job.get('links', {})) <= set(needs)
    with tempfile.TemporaryDirectory(prefix='rio-') as directory:
        root = Path(directory)
        for version in VERSIONS:
            (root / version).mkdir()
        # Symbolic links stay in the header's `links`; they are never materialized.
        extract(stream, root, needs)
        command = job['command']
        assert isinstance(command, list) and 0 < len(command) <= 128 and all(isinstance(x, str) and len(x) <= 16000 for x in command)
        if job['kind'] in ('checks', 'graph', 'static', 'prepare'):
            command = [RUNNER, 'inside', job['kind'], '--base', str(root / 'base'), '--head', str(root / 'head')]
            cwd = root / 'head'
        else:
            assert job['kind'] == 'run'
            cwd = root / job['version']
        # Only a fixed environment reaches repository code; provider and API secrets stay outside.
        env = {'PATH': '/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin', 'HOME': directory, 'TMPDIR': directory, 'CI': 'true', 'RIO_CONTAINER': '1', 'CARGO_NET_OFFLINE': 'true', 'PIP_NO_INDEX': '1', 'npm_config_offline': 'true'}
        try:
            process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE if job['kind'] != 'run' else subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        except OSError:
            return dict(job_id=job['job_id'], attempt=job['attempt'], version=job['version'], exit_code=127, stdout='', stderr='command could not be started', timed_out=False, truncated=False, outcome='spawn_failed')
        if job['kind'] != 'run':
            process.stdin.write(header)
            process.stdin.close()
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ, 'stdout')
        selector.register(process.stderr, selectors.EVENT_READ, 'stderr')
        output = {'stdout': bytearray(), 'stderr': bytearray()}
        deadline = time.monotonic() + limits['wall_ms'] / 1000
        timed_out = truncated = False
        while selector.get_map():
            if time.monotonic() >= deadline:
                timed_out = True
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
            for key, _ in selector.select(timeout=0.05):
                chunk = os.read(key.fileobj.fileno(), 8192)
                if not chunk:
                    selector.unregister(key.fileobj)
                    continue
                if analysis and key.data == 'stdout':
                    room = artifact_bytes - len(output['stdout'])
                else:
                    room = limits['output_bytes'] - len(output['stderr']) - (0 if analysis else len(output['stdout']))
                output[key.data].extend(chunk[:max(0, room)])
                if len(chunk) > room:
                    truncated = True
                    os.killpg(process.pid, signal.SIGKILL)
            if timed_out or truncated:
                # Kill the whole group, including descendants that hold pipes open.
                break
        process.wait(timeout=5)
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        selector.close()
        process.stdout.close()
        process.stderr.close()
        streams = {k: v.decode('utf-8', errors='replace') for k, v in output.items()}
        if analysis:
            # The artifact is returned once, parsed, never echoed as command output.
            artifact = streams['stdout']
            streams['stdout'] = ''
        result = dict(outcome='exited', job_id=job['job_id'], attempt=job['attempt'], version=job['version'], exit_code=process.returncode, timed_out=timed_out, truncated=truncated, **streams)
        if analysis and process.returncode == 0 and not truncated:
            result['artifact'] = json.loads(artifact)
        return result


def git(args, env, timeout):
    """Runs git without a shell; output that could echo a credential is never returned."""
    result = subprocess.run(['/usr/bin/git', *args], cwd=WORK / 'repo', env=env, stdin=subprocess.DEVNULL,
                            capture_output=True, timeout=timeout)
    if result.returncode != 0:
        first = next((line.strip() for line in result.stderr.decode('utf-8', 'replace').splitlines()
                      if line.strip().startswith(('fatal:', 'error:', 'remote:'))), 'git failed')
        raise RuntimeError(first[:200])
    return result.stdout


def clone(spec):
    """Clone phase of a self-hosted prepare job: the only phase with network and the
    installation token. Fetches exactly the two commits, then revokes the token."""
    token = os.environ.pop('RIO_GITHUB_TOKEN', '')
    api = os.environ.pop('RIO_GITHUB_API_URL', 'https://api.github.com').rstrip('/')
    assert token, 'missing installation token'
    assert CLONE_URL.match(spec['clone_url']), 'invalid clone URL'
    assert SHA.match(spec['base_sha']) and SHA.match(spec['head_sha']), 'invalid commit'
    (WORK / 'repo').mkdir()
    header = base64.b64encode(f'x-access-token:{token}'.encode()).decode()
    # The credential reaches git through its environment only, never argv or a file.
    env = {'PATH': '/usr/bin:/bin', 'HOME': '/tmp', 'GIT_TERMINAL_PROMPT': '0', 'GIT_CONFIG_NOSYSTEM': '1',
           'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_COUNT': '1', 'GIT_CONFIG_KEY_0': 'http.extraHeader',
           'GIT_CONFIG_VALUE_0': f'Authorization: Basic {header}'}
    if spec.get('ca'):
        env['GIT_SSL_CAINFO'] = '/etc/rio/ca.pem'
    try:
        git(['init', '-q', '.'], env, 30)
        git(['remote', 'add', 'origin', spec['clone_url']], env, 30)
        git(['fetch', '-q', '--no-tags', '--depth=1', 'origin', spec['base_sha'], spec['head_sha']], env, 240)
        for sha in (spec['base_sha'], spec['head_sha']):
            git(['cat-file', '-e', f'{sha}^{{commit}}'], env, 30)
    finally:
        request = urllib.request.Request(f'{api}/installation/token', method='DELETE',
                                         headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json', 'User-Agent': 'rio-runner'})
        try:
            context = None
            if spec.get('ca'):
                import ssl
                context = ssl.create_default_context(cafile='/etc/rio/ca.pem')
            urllib.request.urlopen(request, timeout=10, context=context).close()
        except Exception:
            pass  # The host revokes it again; an expired token needs nothing.
    return {'cloned': True}


def isolated():
    """The analysis phase runs only without a route and without the token."""
    routes = [line.split()[0] for line in open('/proc/net/route').read().splitlines()[1:] if line.strip()]
    ipv6 = [line.split()[-1] for line in open('/proc/net/ipv6_route').read().splitlines() if line.split()[-1] != 'lo'] if os.path.exists('/proc/net/ipv6_route') else []
    return {'routes': [r for r in routes if r != 'lo'] + ipv6, 'token': any(k.startswith('RIO_GITHUB') for k in os.environ)}


def prepare(spec):
    """Analysis phase of a self-hosted prepare job: `rio prepare --output` over the clone."""
    isolation = isolated()
    assert not isolation['routes'] and not isolation['token'], 'analysis phase has a network route or the token'
    assert SHA.match(spec['base_sha']) and SHA.match(spec['head_sha']), 'invalid commit'
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin', 'HOME': '/tmp', 'TMPDIR': '/tmp', 'RIO_CONTAINER': '1'}
    result = subprocess.run([RIO, 'prepare', '--base', spec['base_sha'], '--head', spec['head_sha'], '--output', str(WORK / 'out')],
                            cwd=WORK / 'repo', env=env, stdin=subprocess.DEVNULL, capture_output=True, timeout=PREPARE_WALL_MS / 1000)
    if result.returncode != 0:
        raise RuntimeError(result.stderr.decode('utf-8', 'replace').strip().splitlines()[-1][:300] if result.stderr.strip() else 'rio prepare failed')
    return {'isolation': {'network': False, 'token': False}}


if __name__ == '__main__':
    try:
        mode = sys.argv[1] if len(sys.argv) > 1 else 'execute'
        if mode == 'clone':
            print(json.dumps(clone(json.loads(sys.stdin.buffer.read(65536)))))
            sys.exit(0)
        if mode == 'prepare':
            print(json.dumps(prepare(json.loads(sys.stdin.buffer.read(65536)))))
            sys.exit(0)
        print(json.dumps(execute(sys.stdin.buffer), separators=(',', ':')))
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)

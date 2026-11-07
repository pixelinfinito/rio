#!/usr/bin/env python3
"""Trusted container entry point. Never run this on the host for untrusted jobs."""
import json
import os
from pathlib import Path
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
VERSIONS = ('base', 'head')


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
    assert 0 < limits['wall_ms'] <= 120000 and 0 < limits['output_bytes'] <= 1048576
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
        if job['kind'] in ('checks', 'graph', 'static'):
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


if __name__ == '__main__':
    try:
        print(json.dumps(execute(sys.stdin.buffer), separators=(',', ':')))
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)

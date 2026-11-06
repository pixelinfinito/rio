#!/usr/bin/env python3
"""Trusted container entry point. Never run this on the host for untrusted jobs."""
import base64
import json
import os
from pathlib import Path, PurePosixPath
import selectors
import signal
import subprocess
import sys
import tempfile
import time


def execute(job):
    assert job['protocol'] == 1 and job['network'] is False
    limits = job['limits']
    assert 0 < limits['wall_ms'] <= 120000 and 0 < limits['output_bytes'] <= 1048576
    with tempfile.TemporaryDirectory(prefix='rio-') as directory:
        root = Path(directory)
        # Links are rejected, so no materialization order can escape the snapshot.
        for name, file in sorted(job['snapshot'].items()):
            path = PurePosixPath(name)
            assert name and not path.is_absolute() and all(p not in ('', '.', '..') for p in name.split('/')) and '\\' not in name and '\0' not in name
            assert file['mode'] in (0o100644, 0o100755, 0o120000)
            if file['mode'] == 0o120000:
                continue
            target = root / name
            target.parent.mkdir(parents=True, exist_ok=True)
            content = base64.b64decode(file['content'], validate=True) if file.get('encoding') == 'base64' else file['content'].encode()
            target.write_bytes(content)
            target.chmod(0o755 if file['mode'] == 0o100755 else 0o644)
        command = job['command']
        assert isinstance(command, list) and 0 < len(command) <= 128 and all(isinstance(x, str) and len(x) <= 16000 for x in command)
        if job['kind'] in ('checks', 'graph', 'static'):
            command = ['/usr/local/bin/rio-runner', 'inside', job['kind'], str(root)]
        else:
            assert job['kind'] == 'run'
        # Only a fixed environment reaches repository code; provider and API secrets stay outside.
        env = {'PATH': '/usr/local/cargo/bin:/usr/local/bin:/usr/bin:/bin', 'HOME': directory, 'TMPDIR': directory, 'CI': 'true', 'RIO_CONTAINER': '1', 'CARGO_NET_OFFLINE': 'true', 'PIP_NO_INDEX': '1', 'npm_config_offline': 'true'}
        try:
            process = subprocess.Popen(command, cwd=root, env=env, stdin=subprocess.PIPE if job['kind'] != 'run' else subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        except OSError:
            return dict(job_id=job['job_id'], attempt=job['attempt'], version=job['version'], exit_code=127, stdout='', stderr='command could not be started', timed_out=False, truncated=False, outcome='spawn_failed')
        if job['kind'] != 'run':
            process.stdin.write(json.dumps(job).encode())
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
                room = limits['output_bytes'] - sum(len(b) for b in output.values())
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
        result = dict(outcome='exited', job_id=job['job_id'], attempt=job['attempt'], version=job['version'], exit_code=process.returncode, timed_out=timed_out, truncated=truncated, **{k: v.decode('utf-8', errors='replace') for k, v in output.items()})
        if job['kind'] != 'run' and process.returncode == 0:
            result['artifact'] = json.loads(result['stdout'])
        return result


if __name__ == '__main__':
    try:
        print(json.dumps(execute(json.load(sys.stdin)), separators=(',', ':')))
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        sys.exit(1)

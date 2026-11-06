import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import unittest

spec = importlib.util.spec_from_file_location('executor', Path(__file__).resolve().parents[1] / 'execute.py')
executor = importlib.util.module_from_spec(spec)
spec.loader.exec_module(executor)


def archive(members, fmt=tarfile.PAX_FORMAT):
    """Builds a job archive from (name, content, mode) files or prepared TarInfo members."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode='w', format=fmt) as tar:
        for member in members:
            if isinstance(member, tarfile.TarInfo):
                tar.addfile(member, io.BytesIO(b'x' * member.size) if member.isreg() else None)
                continue
            name, content, mode = member
            info = tarfile.TarInfo(name)
            info.size, info.mode = len(content), mode
            tar.addfile(info, io.BytesIO(content))
    return buffer.getvalue()


def special(name, kind, target=''):
    info = tarfile.TarInfo(name)
    info.type, info.linkname, info.mode = kind, target, 0o644
    return info


class Executor(unittest.TestCase):
    def job(self, command, kind='run', needs=('head',)):
        return {'protocol': 1, 'network': False, 'kind': kind, 'review_id': 'review', 'job_id': 'test', 'attempt': 1, 'version': 'head',
                'snapshot_id': 'a' * 64, 'needs': list(needs), 'links': {}, 'command': command, 'limits': {'wall_ms': 1000, 'output_bytes': 4096}}

    def execute(self, job, members=(('head/a.txt', b'immutable', 0o644),)):
        return executor.execute(io.BytesIO(json.dumps(job).encode() + b'\n' + archive(members)))

    def test_materialization_and_fixed_secret_free_environment(self):
        result = self.execute(self.job(['/usr/bin/python3', '-c', 'import os; print(open("a.txt").read()); print(os.getenv("RIO_API_TOKEN")); print(os.getcwd())']))
        self.assertEqual(result['exit_code'], 0)
        self.assertIn('immutable\nNone\n', result['stdout'])
        self.assertTrue(result['stdout'].strip().endswith('/head'))
        self.assertFalse(result['timed_out'])

    def test_archive_contents_and_modes_are_reproduced_exactly(self):
        long_name = '/'.join(['directory'] * 20) + '/' + 'f' * 120 + '.txt'
        files = {
            'head/tool.sh': (bytes(range(256)) * 300, 0o755),
            'head/src/ünïcödé ✓.txt': ('ünïcödé\n'.encode(), 0o644),
            f'head/{long_name}': (b'long\n', 0o644),
            'head/empty': (b'', 0o644),
            'base/tool.sh': (b'#!/bin/sh\n', 0o644),
        }
        program = '''import hashlib, json, os, stat
out = {}
for version in ("base", "head"):
    for directory, _, names in os.walk(os.path.join("..", version)):
        for name in names:
            path = os.path.join(directory, name)
            info = os.lstat(path)
            assert stat.S_ISREG(info.st_mode)
            out[os.path.relpath(path, "..")] = [hashlib.sha256(open(path, "rb").read()).hexdigest(), stat.S_IMODE(info.st_mode)]
print(json.dumps(out))'''
        job = self.job(['/usr/bin/python3', '-c', program], needs=('base', 'head'))
        job['limits']['output_bytes'] = 1048576
        for fmt in (tarfile.PAX_FORMAT, tarfile.USTAR_FORMAT):
            members = [(name, *value) for name, value in files.items()]
            if fmt == tarfile.USTAR_FORMAT:
                members = [m for m in members if len(m[0]) < 100 and m[0].isascii()]
            with self.subTest(format=fmt):
                result = executor.execute(io.BytesIO(json.dumps(job).encode() + b'\n' + archive(members, fmt)))
                self.assertEqual(result['exit_code'], 0, result['stderr'])
                self.assertEqual(json.loads(result['stdout']), {name: [hashlib.sha256(content).hexdigest(), mode] for name, content, mode in members})

    def test_unsafe_members_abort_the_job(self):
        cases = {
            'symlink': special('head/link', tarfile.SYMTYPE, '/etc/passwd'),
            'hardlink': special('head/hard', tarfile.LNKTYPE, 'head/a.txt'),
            'character device': special('head/tty', tarfile.CHRTYPE),
            'block device': special('head/disk', tarfile.BLKTYPE),
            'fifo': special('head/fifo', tarfile.FIFOTYPE),
            'directory': special('head/dir', tarfile.DIRTYPE),
            'absolute': ('/head/abs', b'bad', 0o644),
            'absolute path in version': ('head//etc/passwd', b'bad', 0o644),
            'traversal': ('head/../escape', b'bad', 0o644),
            'nested traversal': ('head/a/../../escape', b'bad', 0o644),
            'dot': ('head/./a', b'bad', 0o644),
            'backslash': ('head/a\\b', b'bad', 0o644),
            'git metadata': ('head/.git/config', b'bad', 0o644),
            'unknown version': ('other/a', b'bad', 0o644),
            'bare version': ('head', b'bad', 0o644),
            'version not needed': ('base/a', b'bad', 0o644),
            'setuid mode': ('head/s', b'bad', 0o4755),
            'writable mode': ('head/w', b'bad', 0o666),
            'duplicate': ('head/a.txt', b'again', 0o644),
            'file under file': ('head/a.txt/b', b'bad', 0o644),
        }
        for label, member in cases.items():
            with self.subTest(label):
                with self.assertRaises(AssertionError if label != 'duplicate' else FileExistsError):
                    self.execute(self.job(['/bin/true']), [('head/a.txt', b'ok', 0o644), member])
        with self.assertRaises(tarfile.ReadError):
            executor.execute(io.BytesIO(json.dumps(self.job(['/bin/true'])).encode() + b'\n' + b'not a tar archive' * 64))

    def test_header_validation(self):
        with self.assertRaises(AssertionError):
            executor.execute(io.BytesIO(json.dumps(self.job(['/bin/true'])).encode()))
        job = self.job(['/bin/true'], needs=('base',))
        with self.assertRaises(AssertionError):
            self.execute(job, [])
        job = self.job(['/bin/true'], needs=('head', 'other'))
        with self.assertRaises(AssertionError):
            self.execute(job, [])
        job = self.job(['/bin/true'], kind='static')
        with self.assertRaises(AssertionError):
            self.execute(job, [])
        job = self.job(['/bin/true'])
        job['links'] = {'base': {'l': 'dGFyZ2V0'}}
        with self.assertRaises(AssertionError):
            self.execute(job, [])

    def test_links_are_never_materialized(self):
        job = self.job(['/usr/bin/python3', '-c', 'import os; print(os.listdir("."))'])
        job['links'] = {'head': {'link': 'L2V0Yy9wYXNzd2Q='}}
        self.assertEqual(self.execute(job)['stdout'].strip(), "['a.txt']")

    def test_timeout_and_output_bounds_kill_process_groups(self):
        job = self.job(['/usr/bin/python3', '-c', 'import time; time.sleep(3)'])
        job['limits']['wall_ms'] = 100
        self.assertTrue(self.execute(job)['timed_out'])
        job = self.job(['/usr/bin/python3', '-c', 'print("x" * 100000)'])
        result = self.execute(job)
        self.assertTrue(result['truncated'])
        self.assertLessEqual(len(result['stdout']) + len(result['stderr']), 4096)

    def test_network_enabled_protocol_is_rejected_before_spawning(self):
        job = self.job(['/bin/true'])
        job['network'] = True
        with self.assertRaises(AssertionError):
            self.execute(job)

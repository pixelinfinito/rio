import io
import json
import fcntl
import os
from pathlib import Path
import tarfile
import tempfile
import subprocess
import sys
import time
import unittest
from unittest.mock import patch

from pod import PodError
from runtime import controller_archive, export_directory, export_seeds, seed_cache_lock, SeedCacheLease


def archive(members):
    stream = io.BytesIO()
    with tarfile.open(fileobj=stream, mode='w') as output:
        for path, kind, data in members:
            member = tarfile.TarInfo(path)
            member.type = kind
            if kind == tarfile.REGTYPE:
                member.size = len(data)
            output.addfile(member, io.BytesIO(data) if kind == tarfile.REGTYPE else None)
    stream.seek(0)
    return tarfile.open(fileobj=stream)


class ExportTests(unittest.TestCase):
    def test_host_seed_lease_renews_and_is_released_when_the_run_closes(self):
        with tempfile.TemporaryDirectory() as directory:
            lease = SeedCacheLease(Path(directory), 'a' * 64, ttl=1, interval=0.01).start()
            try:
                initial = json.loads(lease.path.read_bytes())
                deadline = time.monotonic() + 5
                while time.monotonic() < deadline:
                    renewed = json.loads(lease.path.read_bytes())
                    if renewed['expires_at_ms'] > initial['expires_at_ms']:
                        break
                    time.sleep(0.01)
                self.assertEqual(renewed['fingerprint'], 'a' * 64)
                self.assertGreater(renewed['expires_at_ms'], initial['expires_at_ms'])
                self.assertFalse(lease.failed.is_set())
            finally:
                lease.close()
            self.assertFalse(lease.path.exists())

    def test_seed_export_commits_parts_before_manifest_and_does_not_copy_private_leases(self):
        fingerprint, part = 'a' * 64, 'b' * 64
        manifest = {'fingerprint': {'fingerprint': fingerprint}, 'archives': [{'parts': [{'hash': part, 'bytes': 4}]}]}
        # Deliberately put the manifest first in the wire stream.
        members = [(f'qa-seeds/{fingerprint}/manifest.json', tarfile.REGTYPE, json.dumps(manifest).encode()),
                   ('qa-seeds/leases/private.json', tarfile.REGTYPE, b'{}'),
                   (f'qa-seeds/objects/{part}', tarfile.REGTYPE, b'seed')]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'qa-seeds'
            replace = os.replace
            published = []
            def observed(source, target):
                if Path(target) == root / fingerprint / 'manifest.json':
                    self.assertEqual((root / 'objects' / part).read_bytes(), b'seed')
                    published.append(True)
                replace(source, target)
            with archive(members) as source, patch('runtime.controller_archive', side_effect=lambda _, __, consume: consume(source)), patch('runtime.os.replace', side_effect=observed):
                export_seeds('controller', root, 10000)
            self.assertEqual(published, [True])
            self.assertEqual(json.loads((root / fingerprint / 'manifest.json').read_bytes()), manifest)
            self.assertFalse((root / 'leases').exists())

    def test_incomplete_seed_export_preserves_previous_manifest_and_parts(self):
        fingerprint, part = 'a' * 64, 'b' * 64
        manifest = {'fingerprint': {'fingerprint': fingerprint}, 'archives': [{'parts': [{'hash': part, 'bytes': 4}]}]}
        members = [(f'qa-seeds/{fingerprint}/manifest.json', tarfile.REGTYPE, json.dumps(manifest).encode())]
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'qa-seeds'
            (root / fingerprint).mkdir(parents=True)
            (root / fingerprint / 'manifest.json').write_text('previous manifest')
            with archive(members) as source, patch('runtime.controller_archive', side_effect=lambda _, __, consume: consume(source)):
                with self.assertRaises(PodError):
                    export_seeds('controller', root, 10000)
            self.assertEqual((root / fingerprint / 'manifest.json').read_text(), 'previous manifest')
            self.assertFalse((root / 'objects' / part).exists())
            self.assertEqual(list(root.glob('.export-*')), [])

    def test_seed_transfer_lock_is_shared_with_pruning_and_released_after_failure(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaisesRegex(RuntimeError, 'interrupted'):
                with seed_cache_lock(root):
                    with (root / '.lock').open('r+') as other:
                        with self.assertRaises(BlockingIOError):
                            fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    raise RuntimeError('interrupted')
            with (root / '.lock').open('r+') as other:
                fcntl.flock(other, fcntl.LOCK_EX | fcntl.LOCK_NB)

    def test_stalled_archive_stream_is_terminated_before_consumption_completes(self):
        child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(60)'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
        started = time.monotonic()
        with patch('runtime.subprocess.Popen', return_value=child):
            with self.assertRaises((tarfile.ReadError, PodError)):
                controller_archive('controller', '/home/node/qa-result.json', lambda archive: list(archive), timeout=0.05)
        self.assertLess(time.monotonic() - started, 5)
        self.assertIsNotNone(child.poll())

    def export(self, root, members, limit=100):
        with archive(members) as source, patch('runtime.controller_archive', side_effect=lambda _, __, consume: consume(source)):
            export_directory('controller', '/home/node/qa-evidence', root, limit)

    def test_regular_evidence_is_retained_atomically_with_private_permissions(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / 'qa'
            self.export(root, [('qa-evidence/journey/screen.png', tarfile.REGTYPE, b'evidence')])
            result = root / 'journey/screen.png'
            self.assertEqual(result.read_bytes(), b'evidence')
            self.assertEqual(result.stat().st_mode & 0o777, 0o600)

    def test_links_paths_quota_and_existing_symlink_parents_are_rejected(self):
        for member in [('qa-evidence/link', tarfile.SYMTYPE, b''), ('qa-evidence/../escape', tarfile.REGTYPE, b'x'),
                       ('different/name', tarfile.REGTYPE, b'x'), ('qa-evidence/too-large', tarfile.REGTYPE, b'x' * 101)]:
            with self.subTest(member=member[0]), tempfile.TemporaryDirectory() as directory:
                with self.assertRaises(PodError):
                    self.export(Path(directory) / 'qa', [member])
        with tempfile.TemporaryDirectory() as directory:
            root, outside = Path(directory) / 'qa', Path(directory) / 'outside'
            root.mkdir(); outside.mkdir(); (root / 'link').symlink_to(outside, target_is_directory=True)
            with self.assertRaises(PodError):
                self.export(root, [('qa-evidence/link/child', tarfile.DIRTYPE, b'')])
            self.assertFalse((outside / 'child').exists())


class LiveSyncTests(unittest.TestCase):
    def test_control_is_copied_in_once_per_change_and_progress_out(self):
        from runtime import LiveSync
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            sent = []
            def fake_docker(*args, **kwargs):
                with tarfile.open(fileobj=io.BytesIO(kwargs['data'])) as archive:
                    member = archive.getmembers()[0]
                    sent.append((args[-1], member.name, member.mode, member.uid, json.load(archive.extractfile(member))))
            progress = {'events': [{'seq': 1, 'journey': 'checkout', 'viewport': 'mobile', 'color_scheme': 'dark', 'step': 2, 'outcome': 'running'}, 'junk']}
            def fake_archive(container, path, consume, timeout=30):
                self.assertEqual(path, '/home/node/qa-progress.json')
                return consume(archive([('qa-progress.json', tarfile.REGTYPE, json.dumps(progress).encode())]))
            with patch('runtime.docker', fake_docker), patch('runtime.controller_archive', fake_archive):
                live = LiveSync(root, 'rio-qa-controller', interval=0)
                live()
                self.assertEqual(sent, [])
                (root / 'control.json').write_text(json.dumps({'paused': True, 'cancel': [
                    {'journey': 'checkout', 'viewport': 'mobile', 'color_scheme': 'dark', 'extra': 1}, {'journey': 3}]}))
                live(); live()
                self.assertEqual(sent, [('rio-qa-controller:/home/node', 'qa-control.json', 0o400, 1000,
                                         {'paused': True, 'cancel': [{'journey': 'checkout', 'viewport': 'mobile', 'color_scheme': 'dark'}]})])
                self.assertEqual(json.loads((root / 'progress.json').read_text()), {'events': progress['events'][:1]})

    def test_failed_copies_never_fail_the_run(self):
        from runtime import LiveSync
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'control.json').write_text('{"paused": true}')
            def broken(*args, **kwargs):
                raise PodError('docker operation failed')
            with patch('runtime.docker', broken), patch('runtime.controller_archive', broken):
                live = LiveSync(root, 'rio-qa-controller', interval=0)
                live()
                self.assertIsNone(live.sent)
                self.assertFalse((root / 'progress.json').exists())


if __name__ == '__main__':
    unittest.main()

"""Local release contracts: python3 -m unittest discover -s tests/release -v."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tarfile
import tempfile
import unittest
import zipfile

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / 'scripts/package-release.py'
PUBLISH = ROOT / 'scripts/publish-release.py'
TARGETS = [
    'x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl',
    'x86_64-apple-darwin', 'aarch64-apple-darwin',
    'x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc',
]


class ReleaseTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.server = self.root / 'server'
        self.server.mkdir()
        self.state_path = self.server / 'state.json'
        self.state_path.write_text(json.dumps({'release': None, 'next_id': 0, 'latest': 'v0.0.9', 'calls': []}))
        bin_dir = self.root / 'bin'
        bin_dir.mkdir()
        gh = bin_dir / 'gh'
        gh.write_text(f'#!{sys.executable}\n' + (Path(__file__).with_name('fake_gh.py')).read_text())
        gh.chmod(0o755)
        self.env = {key: value for key, value in os.environ.items() if not key.startswith(('RIO_', 'FAKE_GH_'))}
        self.env.update(PATH=str(bin_dir) + os.pathsep + self.env['PATH'], FAKE_GH_ROOT=str(self.server), GITHUB_REPOSITORY='example/release-contract-test')
        self.workspace = self.root / 'work'
        self.workspace.mkdir()
        (self.workspace / 'LICENSE').write_text('Apache-2.0 fixture')
        (self.workspace / 'README.md').write_text('Fixture release readme')
        self.dist = self.workspace / 'dist'
        self.tag = 'v0.1.0'
        self.assemble()

    def assemble(self):
        for target in TARGETS:
            binary = self.workspace / 'target' / target / 'release' / ('rio.exe' if target.endswith('windows-msvc') else 'rio')
            binary.parent.mkdir(parents=True, exist_ok=True)
            binary.write_bytes(b'fixture binary for ' + target.encode())
            binary.chmod(0o755)
            result = subprocess.run([sys.executable, str(PACKAGE), self.tag[1:], target], cwd=self.workspace, env=self.env, capture_output=True, text=True)
            self.assertEqual(result.returncode, 0, result.stderr)
        self.archives = sorted([*self.dist.glob('*.tar.gz'), *self.dist.glob('*.zip')])
        for archive in self.archives:
            (self.dist / (archive.name + '.intoto.jsonl')).write_text('{"fixture":"local-only-attestation"}\n')
        (self.dist / 'install.sh').write_text('#!/bin/sh\n')
        (self.dist / 'install.ps1').write_text('# fixture installer\n')

    def state(self):
        return json.loads(self.state_path.read_text())

    def publish(self, success=True, **environment):
        result = subprocess.run([sys.executable, str(PUBLISH), self.tag, str(self.dist)], env=dict(self.env, **environment), text=True, capture_output=True, timeout=30)
        self.assertEqual(result.returncode == 0, success, result.stdout + result.stderr)
        return result

    def assert_draft_unpublished(self):
        state = self.state()
        self.assertTrue(state['release']['draft'])
        self.assertEqual(state['latest'], 'v0.0.9')
        self.assertFalse(any(call.get('method') == 'PATCH' for call in state['calls']))
        return state

    def test_package_all_targets_contains_only_public_files_and_complete_checksums(self):
        self.assertEqual(len(self.archives), 6)
        self.assertEqual(len(list(self.dist.iterdir())), 15)
        for archive in self.archives:
            windows = archive.suffix == '.zip'
            binary = 'rio.exe' if windows else 'rio'
            if windows:
                with zipfile.ZipFile(archive) as contents:
                    self.assertEqual(set(contents.namelist()), {binary, 'LICENSE', 'README.md'})
                    self.assertTrue(contents.read(binary).startswith(b'fixture binary for '))
            else:
                with tarfile.open(archive) as contents:
                    self.assertEqual(set(contents.getnames()), {binary, 'LICENSE', 'README.md'})
                    self.assertEqual(contents.getmember(binary).mode & 0o111, 0o111)
        sums = dict(line.split()[::-1] for line in (self.dist / 'SHA256SUMS').read_text().splitlines())
        self.assertEqual(set(sums), {archive.name for archive in self.archives})
        for archive in self.archives:
            self.assertEqual(sums[archive.name], hashlib.sha256(archive.read_bytes()).hexdigest())

    def test_forced_upload_failure_leaves_draft_and_rerun_replaces_it(self):
        self.assertIn('release remains a draft', self.publish(False, RIO_FORCE_UPLOAD_FAILURE='1').stderr)
        failed = self.assert_draft_unpublished()
        self.assertEqual(len(failed['release']['assets']), 3)
        failed_id = failed['release']['id']
        self.publish()
        complete = self.state()
        self.assertFalse(complete['release']['draft'])
        self.assertNotEqual(complete['release']['id'], failed_id)
        self.assertEqual(complete['latest'], self.tag)
        calls = complete['calls']
        delete = next(index for index, call in enumerate(calls) if call.get('method') == 'DELETE')
        creates = [index for index, call in enumerate(calls) if call.get('method') == 'POST']
        self.assertLess(creates[0], delete)
        self.assertLess(delete, creates[1])
        self.assertEqual(len(complete['release']['assets']), 15)

    def test_refuses_to_edit_published_release(self):
        self.publish()
        before = self.state()
        result = self.publish(False)
        self.assertIn('Refusing to modify a published release', result.stderr)
        after = self.state()
        self.assertEqual(after['release'], before['release'])
        self.assertEqual(len(after['calls']), len(before['calls']) + 1)
        self.assertEqual(after['calls'][-1]['method'], 'GET')

    def test_download_corruption_prevents_publish(self):
        result = self.publish(False, FAKE_GH_CORRUPT_DOWNLOAD=self.archives[0].name)
        self.assertIn('Download verification failed', result.stderr)
        self.assert_draft_unpublished()

    def test_bad_checksum_prevents_publish(self):
        sums = self.dist / 'SHA256SUMS'
        lines = sums.read_text().splitlines()
        lines[0] = '0' * 64 + '  ' + self.archives[0].name
        sums.write_text('\n'.join(lines) + '\n')
        self.assertIn('SHA256SUMS mismatch', self.publish(False).stderr)
        self.assert_draft_unpublished()

    def test_duplicate_checksum_entries_cannot_omit_other_archives(self):
        sums = self.dist / 'SHA256SUMS'
        sums.write_text((sums.read_text().splitlines()[0] + '\n') * 6)
        self.assertIn('SHA256SUMS', self.publish(False).stderr)
        self.assert_draft_unpublished()

    def test_attestation_failure_prevents_publish(self):
        self.publish(False, FAKE_GH_ATTESTATION_FAILURE='1')
        state = self.assert_draft_unpublished()
        self.assertTrue(any(call['args'][:2] == ['attestation', 'verify'] for call in state['calls']))

    def test_count_correct_missing_installer_is_rejected_before_draft(self):
        (self.dist / 'install.sh').rename(self.dist / 'unrelated.txt')
        self.publish(False)
        self.assertIsNone(self.state()['release'])
        self.assertEqual(self.state()['calls'], [])

    def test_successful_prerelease_is_never_latest(self):
        self.tag = 'v0.1.0-rc.1'
        # Rename archives and bundles to the actual prerelease version, then regenerate sums.
        for path in list(self.dist.iterdir()):
            if path.name.startswith('rio-0.1.0-'):
                path.rename(path.with_name(path.name.replace('rio-0.1.0-', 'rio-0.1.0-rc.1-', 1)))
        subprocess.run([sys.executable, str(PACKAGE), '--checksums', str(self.dist)], check=True, capture_output=True)
        self.publish()
        state = self.state()
        self.assertFalse(state['release']['draft'])
        self.assertTrue(state['release']['prerelease'])
        self.assertEqual(state['latest'], 'v0.0.9')
        payloads = [call['payload'] for call in state['calls'] if call.get('method') in ['POST', 'PATCH']]
        self.assertEqual(len(payloads), 2)
        self.assertTrue(payloads[0]['draft'])
        self.assertFalse(payloads[1]['draft'])
        self.assertTrue(all(payload['prerelease'] and payload['make_latest'] == 'false' for payload in payloads))
        patch = next(index for index, call in enumerate(state['calls']) if call.get('method') == 'PATCH')
        verified = [index for index, call in enumerate(state['calls']) if call['args'][:2] == ['attestation', 'verify']]
        self.assertEqual(len(verified), 6)
        self.assertGreater(patch, max(verified))


if __name__ == '__main__':
    unittest.main()

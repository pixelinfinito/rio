#!/usr/bin/env python3
"""Publish only after draft download, checksum and provenance verification."""
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
import time

TAG, DIRECTORY = sys.argv[1], Path(sys.argv[2])
if not re.fullmatch(r'v\d+\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?', TAG): sys.exit('Invalid release tag')
REPO = os.environ['GITHUB_REPOSITORY']

def gh(*args, check=True):
    return subprocess.run(['gh', *args], check=check, text=True, capture_output=True)

def api(path, payload):
    with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as body:
        json.dump(payload, body); body.flush()
        return json.loads(gh('api', '-X', 'POST', path, '--input', body.name).stdout)

assets = sorted(path for path in DIRECTORY.iterdir() if path.is_file())
archives = [path for path in assets if path.name.endswith(('.tar.gz', '.zip'))]
targets = [
    'x86_64-unknown-linux-musl', 'aarch64-unknown-linux-musl',
    'x86_64-apple-darwin', 'aarch64-apple-darwin',
    'x86_64-pc-windows-msvc', 'aarch64-pc-windows-msvc',
]
archive_names = {
    f'rio-{TAG[1:]}-{target}' + ('.zip' if target.endswith('windows-msvc') else '.tar.gz')
    for target in targets
}
expected_assets = archive_names | {name + '.intoto.jsonl' for name in archive_names} | {'SHA256SUMS', 'install.sh', 'install.ps1'}
if {path.name for path in assets} != expected_assets:
    sys.exit('Expected all six target archives, their attestation bundles, SHA256SUMS and both installers')
existing = json.loads(gh('api', '--paginate', '--slurp', f'repos/{REPO}/releases?per_page=100').stdout)
# GitHub's tag lookup may return 404 for an authenticated caller's draft.
# The paginated release list includes drafts and also prevents duplicate drafts.
matching = [release for page in existing for release in page if release['tag_name'] == TAG]
if any(not release['draft'] for release in matching):
    sys.exit('Refusing to modify a published release')
for release in matching:
    gh('api', '-X', 'DELETE', f'repos/{REPO}/releases/{release["id"]}')
prerelease = '-' in TAG.split('+')[0]
release = api(f'repos/{REPO}/releases', {'tag_name': TAG, 'name': TAG, 'body': 'Rio local CLI. See README.md for installation, verification, supported tools and exit codes.', 'draft': True, 'prerelease': prerelease, 'make_latest': 'false'})
for index, asset in enumerate(assets):
    for attempt in range(3):
        if os.environ.get('RIO_FORCE_UPLOAD_FAILURE') == '1' and index == 3:
            result = subprocess.CompletedProcess([], 1, '', 'Forced upload failure for lifecycle validation')
        else:
            result = gh('release', 'upload', TAG, str(asset), '--repo', REPO, '--clobber', check=False)
        if result.returncode == 0: break
        if attempt == 2: sys.exit(f'Upload failed; release remains a draft: {asset.name}: {result.stderr}')
        time.sleep(2 ** attempt)
metadata = json.loads(gh('api', f'repos/{REPO}/releases/{release["id"]}').stdout)
if not metadata['draft'] or {asset['name'] for asset in metadata['assets']} != {path.name for path in assets}: sys.exit('Draft asset list mismatch')
with tempfile.TemporaryDirectory() as temporary:
    downloaded = Path(temporary)
    gh('release', 'download', TAG, '--repo', REPO, '--dir', str(downloaded))
    # Compare every downloaded byte, including installers and provenance bundles.
    for asset in assets:
        if hashlib.sha256(asset.read_bytes()).digest() != hashlib.sha256((downloaded / asset.name).read_bytes()).digest(): sys.exit(f'Download verification failed: {asset.name}')
    checksums = {}
    for line in (downloaded / 'SHA256SUMS').read_text().splitlines():
        fields = line.split()
        if len(fields) != 2:
            sys.exit('Malformed SHA256SUMS entry')
        expected, name = fields
        if name not in archive_names or name in checksums or not re.fullmatch(r'[0-9a-fA-F]{64}', expected):
            sys.exit(f'Invalid or duplicate SHA256SUMS entry: {name}')
        checksums[name] = expected.lower()
    if set(checksums) != archive_names:
        sys.exit('SHA256SUMS must list every target archive exactly once')
    for name, expected in checksums.items():
        if hashlib.sha256((downloaded / name).read_bytes()).hexdigest() != expected:
            sys.exit(f'SHA256SUMS mismatch: {name}')
    for archive in archives:
        gh('attestation', 'verify', str(downloaded / archive.name), '--repo', REPO, '--bundle', str(downloaded / (archive.name + '.intoto.jsonl')))
# PATCH is the only point at which a public release appears.
with tempfile.NamedTemporaryFile(mode='w', suffix='.json') as body:
    json.dump({'draft': False, 'prerelease': prerelease, 'make_latest': 'false' if prerelease else 'true'}, body); body.flush()
    published = json.loads(gh('api', '-X', 'PATCH', f'repos/{REPO}/releases/{release["id"]}', '--input', body.name).stdout)
print(published['html_url'])

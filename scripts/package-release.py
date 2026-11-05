#!/usr/bin/env python3
"""Deterministically name release archives; package only the public artifacts."""
import hashlib
import os
from pathlib import Path
import sys
import tarfile
import zipfile

def checksums(directory):
    archives = sorted([*directory.glob('*.tar.gz'), *directory.glob('*.zip')])
    text = ''.join(f'{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n' for path in archives)
    (directory / 'SHA256SUMS').write_text(text)

if sys.argv[1] == '--checksums':
    checksums(Path(sys.argv[2]))
else:
    version, target = sys.argv[1:]
    windows = target.endswith('windows-msvc')
    binary = 'rio.exe' if windows else 'rio'
    source = Path('target') / target / 'release' / binary
    directory = Path('dist'); directory.mkdir(exist_ok=True)
    name = f'rio-{version}-{target}' + ('.zip' if windows else '.tar.gz')
    members = [(source, binary), (Path('LICENSE'), 'LICENSE'), (Path('README.md'), 'README.md')]
    if windows:
        with zipfile.ZipFile(directory / name, 'w', zipfile.ZIP_DEFLATED) as archive:
            for path, leaf in members: archive.write(path, leaf)
    else:
        with tarfile.open(directory / name, 'w:gz') as archive:
            for path, leaf in members: archive.add(path, leaf, recursive=False)
    checksums(directory)
    if 'GITHUB_OUTPUT' in os.environ:
        with open(os.environ['GITHUB_OUTPUT'], 'a') as output: output.write(f'archive={name}\n')
    print(name)

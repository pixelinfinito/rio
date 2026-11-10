#!/usr/bin/python3
"""Deterministic regular-file seed archives. Never uses tar.extract/extractall.

Directory metadata is an ordinary JSON member, not filesystem instructions.
Validate the entire archive before replacing the app's data directory. Archives
are uncompressed so even repetitive synthetic fixtures satisfy the 8x expansion
limit. Hosted storage chunks/hashes this byte stream independently.
"""
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import stat
import sys
import tarfile
import tempfile

LIMIT = 2 * 1024 * 1024 * 1024


def safe(name):
    return (isinstance(name, str) and bool(name) and '\\' not in name and '\0' not in name
            and not name.startswith('/') and ':' not in name.split('/')[0]
            and all(part not in ('', '.', '..', '.git') for part in name.split('/')))


def target(root, path):
    root, path = Path(root).resolve(strict=True), Path(path)
    if not path.is_absolute() or path == root or not path.is_relative_to(root):
        raise ValueError('seed_corrupt')
    for parent in [path, *path.parents]:
        if parent == root:
            break
        if parent.is_symlink():
            raise ValueError('seed_corrupt')
    if not path.resolve().is_relative_to(root):
        raise ValueError('seed_corrupt')
    return path


def member(archive, name, content, mode=0o644):
    import io
    entry = tarfile.TarInfo(name)
    entry.size, entry.mode, entry.uid, entry.gid, entry.mtime = len(content), mode, 1000, 1000, 0
    archive.addfile(entry, io.BytesIO(content))


def capture(root, path, destination):
    path = target(root, path)
    dirs, files, total = [], [], 0
    for current, children, names in os.walk(path, followlinks=False):
        for name in sorted(children + names):
            item = Path(current) / name
            relative = item.relative_to(path).as_posix()
            if not safe(relative) or item.is_symlink():
                raise ValueError('seed_corrupt')
            metadata = item.stat(follow_symlinks=False)
            if stat.S_ISDIR(metadata.st_mode):
                dirs.append(relative)
            elif stat.S_ISREG(metadata.st_mode):
                total += metadata.st_size
                if total > LIMIT or len(files) >= 100000:
                    raise ValueError('seed_too_large')
                files.append((relative, item, metadata))
            else:
                raise ValueError('seed_corrupt')
    with tarfile.open(destination, 'w', format=tarfile.USTAR_FORMAT) as archive:
        member(archive, 'manifest.json', json.dumps({'version': 1, 'directories': sorted(dirs)}, separators=(',', ':')).encode())
        for relative, item, metadata in sorted(files):
            entry = tarfile.TarInfo('files/' + relative)
            entry.size, entry.mode, entry.uid, entry.gid, entry.mtime = metadata.st_size, 0o755 if metadata.st_mode & 0o111 else 0o644, 1000, 1000, 0
            with item.open('rb') as source:
                archive.addfile(entry, source)


def restore(root, path, source, validate_only=False):
    path = target(root, path)
    with tarfile.open(source, 'r:*') as archive:
        names, files, total, directories = set(), [], 0, None
        for entry in archive:
            total += entry.size
            if (not entry.isreg() or entry.issym() or entry.islnk() or entry.size < 0 or not safe(entry.name)
                    or entry.name in names or total > LIMIT * 8 or total > Path(source).stat().st_size * 8 or len(names) >= 100001):
                raise ValueError('seed_corrupt')
            names.add(entry.name)
            if entry.name == 'manifest.json':
                if entry.size > 16 * 1024 * 1024:
                    raise ValueError('seed_corrupt')
                manifest = json.load(archive.extractfile(entry))
                if manifest.get('version') != 1 or set(manifest) != {'version', 'directories'}:
                    raise ValueError('seed_corrupt')
                directories = manifest['directories']
                if not isinstance(directories, list) or len(directories) > 100000 or any(not safe(name) for name in directories):
                    raise ValueError('seed_corrupt')
            elif entry.name.startswith('files/') and safe(entry.name[6:]) and entry.mode in (0o644, 0o755):
                files.append(entry)
            else:
                raise ValueError('seed_corrupt')
        if directories is None:
            raise ValueError('seed_corrupt')
        filepaths = {entry.name[6:] for entry in files}
        for name in [*filepaths, *directories]:
            if any(str(parent) in filepaths for parent in PurePosixPath(name).parents) or name in directories and name in filepaths:
                raise ValueError('seed_corrupt')
        if validate_only:
            return
        with tempfile.TemporaryDirectory(prefix='.rio-seed-', dir=path.parent) as staging:
            payload = Path(staging) / 'data'
            payload.mkdir(mode=0o700)
            for name in directories:
                (payload / name).mkdir(parents=True, exist_ok=True)
            for entry in files:
                output = payload / entry.name[6:]
                output.parent.mkdir(parents=True, exist_ok=True)
                with output.open('xb') as handle, archive.extractfile(entry) as data:
                    shutil.copyfileobj(data, handle)
                output.chmod(entry.mode)
            target(root, path)  # Check again immediately before the replacement.
            backup = Path(staging) / 'previous'
            if path.exists():
                path.rename(backup)
            try:
                payload.rename(path)
            except OSError:
                if backup.exists():
                    backup.rename(path)
                raise


if __name__ == '__main__':
    try:
        operation, root, path, archive = sys.argv[1:5]
        if len(sys.argv) == 6:
            LIMIT = int(sys.argv[5])
            if not 1 <= LIMIT <= 2 ** 53 - 1:
                raise ValueError('seed_corrupt')
        elif len(sys.argv) != 5:
            raise ValueError('seed_corrupt')
        {'capture': capture, 'restore': restore, 'validate': lambda *args: restore(*args, validate_only=True)}[operation](root, path, archive)
    except (OSError, ValueError, KeyError, tarfile.TarError) as error:
        too_large = isinstance(error, ValueError) and str(error) == 'seed_too_large'
        print('seed_too_large' if too_large else 'seed_corrupt', file=sys.stderr)
        sys.exit(2 if too_large else 1)

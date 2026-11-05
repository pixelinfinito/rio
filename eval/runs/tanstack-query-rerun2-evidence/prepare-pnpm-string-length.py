#!/usr/bin/env python3
"""Expose installed pnpm packages at Rio's fallback max-length=120 paths.

pnpm 11.9.0 serializes virtualStoreDirMaxLength as a JSON string. Rio
f6e4f87e4c65 reads only numeric values and falls back to 120. Add aliases to
the unchanged installed content; do not edit manifests, locks or metadata.
"""
from pathlib import Path
import hashlib
import json
import re


def filename(key, limit):
    raw = re.sub(r'[\\/:*?"<>|#]', '+', key.lstrip('/'))
    if '(' in raw:
        raw = raw[:-1] if raw.endswith(')') else raw
        raw = raw.replace(')(', '_').replace('(', '_').replace(')', '_')
    if len(raw.encode()) > limit or (raw != raw.lower() and not raw.startswith('file+')):
        return raw[:max(0, limit - 33)] + '_' + hashlib.sha256(raw.encode()).hexdigest()[:32]
    return raw


root = Path.cwd()
modules = json.loads((root / 'node_modules/.modules.yaml').read_text())
actual_limit = int(modules['virtualStoreDirMaxLength'])
store = root / 'node_modules' / modules['virtualStoreDir']
snapshots = False
aliases = []
missing = []
for line in (store / 'lock.yaml').read_text().splitlines():
    if line == 'snapshots:':
        snapshots = True
        continue
    if not snapshots or not re.match(r'^  \S.*:$', line):
        continue
    key = line[2:-1].strip('\'"')
    actual = filename(key, actual_limit)
    expected = filename(key, 120)
    if not (store / actual).is_dir():
        missing.append(key)
        continue
    alias = store / expected
    if not alias.exists():
        alias.symlink_to(actual, target_is_directory=True)
        aliases.append({'key': key, 'rio_fallback_120': expected, 'installed_250': actual})
print(json.dumps({'modules_value': modules['virtualStoreDirMaxLength'],
                  'modules_value_type': type(modules['virtualStoreDirMaxLength']).__name__,
                  'aliases': aliases, 'missing_installed_keys': missing}, indent=2))

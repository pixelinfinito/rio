#!/usr/bin/env python3
"""Fail when logs or artifacts contain a credential.

Usage: python3 -I eval/credscan.py [--env NAME ...] PATH [PATH ...]

Scans every file under PATH (gzip files are decompressed) for:
  * the exact values, and their base64 encodings, of the named environment
    variables (values shorter than 8 characters are ignored);
  * common provider and GitHub token shapes (OpenRouter, Anthropic, OpenAI, GitHub,
    AWS access keys, PEM private keys).
Matches are reported by file and kind only; secret values are never printed.
Exit codes: 0 clean, 1 credential found, 2 usage error.
"""
import argparse
import base64
import gzip
import os
from pathlib import Path
import re
import sys

PATTERNS = {
    'openrouter-key': re.compile(rb'sk-or-v1-[A-Za-z0-9]{32,}'),
    'anthropic-key': re.compile(rb'sk-ant-[A-Za-z0-9_-]{32,}'),
    'openai-key': re.compile(rb'sk-(?:proj-)?[A-Za-z0-9_-]{40,}'),
    'github-token': re.compile(rb'(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})'),
    'aws-access-key': re.compile(rb'(?:AKIA|ASIA)[0-9A-Z]{16}'),
    'private-key': re.compile(rb'-----BEGIN [A-Z ]*PRIVATE KEY-----'),
}


def needles(names, environ=None):
    environ = os.environ if environ is None else environ
    found = {}
    for name in names:
        value = environ.get(name, '')
        if len(value) < 8:
            continue
        raw = value.encode()
        found[f'${name}'] = raw
        found[f'${name} (base64)'] = base64.b64encode(raw).rstrip(b'=')
    return found


def read(path):
    data = path.read_bytes()
    if path.suffix == '.gz':
        try:
            data += gzip.decompress(data)
        except (OSError, EOFError):
            pass
    return data


def scan(paths, names=(), environ=None):
    values = needles(names, environ)
    hits = []
    for root in map(Path, paths):
        if not root.exists():
            raise ValueError(f'{root} does not exist')
        files = sorted(p for p in root.rglob('*') if p.is_file()) if root.is_dir() else [root]
        for path in files:
            data = read(path)
            hits += [(str(path), kind) for kind, value in values.items() if value in data]
            hits += [(str(path), kind) for kind, pattern in PATTERNS.items() if pattern.search(data)]
    return hits


def main(argv=None, environ=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--env', action='append', default=[], metavar='NAME',
                        help='environment variable holding a secret value to look for (repeatable)')
    parser.add_argument('paths', nargs='+')
    args = parser.parse_args(argv)
    try:
        hits = scan(args.paths, args.env, environ)
    except (ValueError, OSError) as error:
        print(f'credscan error: {error}', file=sys.stderr)
        return 2
    for path, kind in hits:
        print(f'credential found: {kind} in {path}')
    print('Credential scan: ' + ('FAILED' if hits else 'clean') + f' ({len(hits)} finding(s))')
    return 1 if hits else 0


if __name__ == '__main__':
    sys.exit(main())

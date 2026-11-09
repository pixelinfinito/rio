#!/usr/bin/python3
"""Trusted controller bootstrap for a host subscription file, mounted read-only.

The mount may belong to root under rootless Docker's user mapping. Copy only
subscription fields to a private tmpfs, then irreversibly drop uid and groups.
The harness uses its own clean CODEX_HOME and a link to that ephemeral auth file.
"""
import json
import os
from pathlib import Path
import sys


def subscription(document):
    if (not isinstance(document, dict) or document.get('auth_mode', 'chatgpt') != 'chatgpt'
            or document.get('OPENAI_API_KEY') is not None
            or not isinstance(document.get('tokens'), dict)
            or not isinstance(document['tokens'].get('access_token'), str)
            or not document['tokens']['access_token'].strip()):
        raise ValueError('subscription unavailable')
    # Drop unknown fields, including future provider key/config fields.
    tokens = {key: value for key, value in document['tokens'].items()
              if key in ('access_token', 'refresh_token', 'id_token', 'account_id') and isinstance(value, str)}
    return {'auth_mode': 'chatgpt', 'OPENAI_API_KEY': None, 'tokens': tokens,
            **({'last_refresh': document['last_refresh']} if isinstance(document.get('last_refresh'), str) else {})}


def main():
    if os.geteuid() != 0 or not sys.argv[1:]:
        raise ValueError('invalid bootstrap')
    source = Path('/run/rio/subscription.json')
    with source.open('rb') as handle:
        content = handle.read(1024 * 1024 + 1)
    if len(content) > 1024 * 1024:
        raise ValueError('subscription too large')
    auth = subscription(json.loads(content))
    destination = Path('/run/rio/auth/auth.json')
    descriptor = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o400)
    with os.fdopen(descriptor, 'w') as handle:
        json.dump(auth, handle)
    os.chown(destination, 1000, 1000)
    os.chown(destination.parent, 1000, 1000)
    # Docker may assign root ownership to copied inputs when this bootstrap is
    # configured as root. Admit only the runner's fixed controller input names.
    for name in ('contract', 'journeys', 'fixtures', 'owner-guidance', 'plan', 'run', 'credentials'):
        path = Path('/home/node') / (name + '.json')
        if path.exists():
            if path.is_symlink() or not path.is_file():
                raise ValueError('invalid controller input')
            os.chown(path, 1000, 1000)
    seeds = Path('/home/node/qa-seeds')
    if seeds.exists():
        if seeds.is_symlink() or not seeds.is_dir():
            raise ValueError('invalid seed cache')
        for directory, folders, files in os.walk(seeds, topdown=False, followlinks=False):
            for name in folders + files:
                path = Path(directory) / name
                if path.is_symlink():
                    raise ValueError('invalid seed cache')
                os.chown(path, 1000, 1000, follow_symlinks=False)
            os.chown(directory, 1000, 1000, follow_symlinks=False)
    os.setgroups([])
    os.setgid(1000)
    os.setuid(1000)
    os.execvp(sys.argv[1], sys.argv[1:])


if __name__ == '__main__':
    try:
        main()
    except (OSError, ValueError):
        print('QA subscription bootstrap failed; refresh the host subscription or use gateway authentication', file=sys.stderr)
        sys.exit(125)

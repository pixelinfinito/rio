#!/usr/bin/python3
"""Apply runner-owned bootstrap data before dropping privileges.

The pod runner mounts /run/rio/bootstrap.json and the public run CA read-only.
Neither path comes from the repository snapshot. This entrypoint never invokes
repository code while privileged.
"""
import json
import os
import pwd
from pathlib import Path
import re
import subprocess
import sys

BOOTSTRAP = Path('/run/rio/bootstrap.json')
CA = Path('/run/rio/ca.crt')


def claims(document):
    if not isinstance(document, dict) or set(document) - {'claims'}:
        raise ValueError('Invalid QA bootstrap')
    names = document.get('claims', [])
    if not isinstance(names, list) or len(names) > 256:
        raise ValueError('Invalid QA host claims')
    for name in names:
        if not isinstance(name, str) or len(name) > 253 or not re.fullmatch(r'[a-zA-Z0-9](?:[a-zA-Z0-9.-]*[a-zA-Z0-9])?', name):
            raise ValueError('Invalid QA host claim')
        if name.lower() in {'localhost', 'app', 'app.test', 'browser', 'controller', 'host.docker.internal', 'gateway.docker.internal'}:
            raise ValueError('Reserved QA host claim')
    return sorted(set(names))


def main():
    args = sys.argv[1:]
    if not args:
        raise ValueError('QA image requires a controller command')
    privileged = os.geteuid() == 0
    if BOOTSTRAP.exists():
        if not privileged:
            raise ValueError('Host claims require privileged bootstrap before dropping privileges')
        if BOOTSTRAP.stat().st_size > 64 * 1024:
            raise ValueError('QA bootstrap exceeds limit')
        names = claims(json.loads(BOOTSTRAP.read_text()))
        with open('/etc/hosts', 'a', encoding='utf8') as hosts:
            for name in names:
                hosts.write(f'\n127.0.0.1 {name}\n')
    if CA.exists():
        if not privileged or CA.stat().st_size > 64 * 1024:
            raise ValueError('Run CA requires bounded privileged bootstrap')
        # Parse only a public certificate; never install a repository-provided key.
        target = Path('/usr/local/share/ca-certificates/rio-run.crt')
        subprocess.run(['openssl', 'x509', '-in', str(CA), '-out', str(target)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['update-ca-certificates'], check=True, stdout=subprocess.DEVNULL)
    if privileged:
        if os.environ.get('RIO_QA_CONTAINER') == 'app':
            # docker cp into a root-starting container can assign root ownership
            # despite numeric tar owners. Fix only runner-materialized trees,
            # before any repository process exists; never follow symlinks.
            account = pwd.getpwnam('node')
            for tree in ('/work/repo', '/opt/rio-qa-app'):
                for directory, children, files in os.walk(tree, topdown=False, followlinks=False):
                    for name in children + files:
                        os.chown(os.path.join(directory, name), account.pw_uid, account.pw_gid, follow_symlinks=False)
                    os.chown(directory, account.pw_uid, account.pw_gid, follow_symlinks=False)
        # runuser sets the account's normal login environment and drops groups/uid.
        os.execvp('runuser', ['runuser', '-u', 'node', '--', *args])
    os.execvp(args[0], args)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError):
        print('QA bootstrap failed: invalid bootstrap or unavailable provisioning tool', file=sys.stderr)
        sys.exit(125)

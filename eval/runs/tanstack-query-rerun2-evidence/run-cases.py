#!/usr/bin/env python3
"""Run the three preregistered cases without changing the evaluation harness.

Bound the optional clean-tree doctor externally at 120 seconds; retain its
termination evidence. The runner's review/install timeout remains 900 seconds.
"""
import hashlib
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[3]
OUT = Path(__file__).resolve().parent
RETRY = '--retry' in sys.argv
EXECUTION = 'execution-attempt2.json' if RETRY else 'execution.json'
CASES = [
    ('11293', 'tanstack-query-11293', '/dev/shm/rio-tanstack-work/maintainer-mirror'),
    ('11392', 'tanstack-query-11392-attempt3', '/dev/shm/rio-tanstack-work/negative-head'),
    ('11522-seeded', 'tanstack-query-11522-seeded-attempt2', '/dev/shm/rio-tanstack-work/seed-head'),
]


def write(name, value):
    (OUT / name).write_text(json.dumps(value, indent=2) + '\n')


def children(pid):
    path = Path(f'/proc/{pid}/task/{pid}/children')
    return path.read_text().split() if path.exists() else []


def main():
    binary = '/home/ubuntu/rio/target/release/rio'
    version = subprocess.check_output([binary, '--version'], text=True).strip()
    if version != 'rio 0.1.0 x86_64-unknown-linux-gnu f6e4f87e4c65':
        sys.exit(f'Unexpected binary: {version}')
    env = dict(os.environ)
    env.update(PATH='/dev/shm/rio-tanstack-tools/node-v24.16.0-linux-x64/bin:' + env['PATH'],
               COREPACK_HOME='/dev/shm/rio-tanstack-tools/corepack-cache',
               NODE_DISABLE_COMPILE_CACHE='1', TMPDIR='/dev/shm/rio-tanstack-work',
               GIT_CONFIG_COUNT='1', GIT_CONFIG_VALUE_0='https://github.com/TanStack/query.git')
    provenance = {'binary_version': version, 'binary_sha256': hashlib.sha256(Path(binary).read_bytes()).hexdigest(),
                  'date_utc': datetime.now(timezone.utc).isoformat(),
                  'environment': {k: env[k] for k in ('PATH', 'COREPACK_HOME', 'NODE_DISABLE_COMPILE_CACHE', 'TMPDIR')},
                  'doctor_limit_seconds': 120, 'command_timeout_seconds': 900, 'cases': []}
    for argv in (['node', '--version'], ['corepack', 'prepare', 'pnpm@11.9.0', '--activate'], ['corepack', 'pnpm', '--version']):
        result = subprocess.run(argv, env=env, text=True, capture_output=True, check=True)
        provenance.setdefault('toolchain', []).append({'argv': argv, 'stdout': result.stdout, 'stderr': result.stderr})
    cases = CASES[1:] + CASES[:1] if RETRY else CASES
    for case, previous, mirror in cases:
        old = ROOT / 'eval/runs' / previous
        pins = json.loads((old / 'commands.json').read_text())
        suffix = '-attempt2' if RETRY else ''
        target = ROOT / 'eval/runs' / f'tanstack-query-{case}-rerun2{suffix}'
        plan = OUT / f'{case}-install-plan-attempt2.json' if RETRY else old / 'install-plan.json'
        # The old absolute helper path still exists and is byte-identical.
        helper = Path(json.loads(plan.read_text())['base'][1][1])
        local_helper = ROOT / 'eval/runs/tanstack-query-11392-evidence/prepare-installation-02.py'
        assert helper.read_bytes() == local_helper.read_bytes()
        env['GIT_CONFIG_KEY_0'] = f'url.{mirror}.insteadOf'
        argv = ['python3', 'eval/runner.py', '--repository', 'TanStack/query', '--pr', case.split('-')[0],
                '--base', pins['base_sha'], '--head', pins['head_sha'], '--languages', 'typescript',
                '--rio', binary, '--out', str(target), '--install-plan', str(plan), '--timeout', '900']
        if case.endswith('seeded'):
            argv.extend(['--case-id', '11522-seeded-transaction-type-20261105'])
            patch = subprocess.check_output(['git', '-C', mirror, 'diff', pins['base_sha'], pins['head_sha'], '--binary'])
            assert hashlib.sha256(patch).hexdigest() == '2765417edba59265b5a80ba4a4c2d4ae9513939b59bafdbb751cc1796709dc4f'
        item = {'case': case, 'previous': previous, 'base_sha': pins['base_sha'], 'head_sha': pins['head_sha'],
                'argv': argv, 'git_environment': {k: env[k] for k in ('GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0')},
                'install_plan_sha256': hashlib.sha256(plan.read_bytes()).hexdigest(),
                'helper_sha256': hashlib.sha256(helper.read_bytes()).hexdigest(), 'doctor_interruptions': [],
                'started_utc': datetime.now(timezone.utc).isoformat()}
        provenance['cases'].append(item)
        write(EXECUTION, provenance)
        print(f'START {case}: {target}', flush=True)
        started = time.monotonic()
        with (OUT / f'{case}{suffix}-runner.stdout.log').open('wb') as stdout, (OUT / f'{case}{suffix}-runner.stderr.log').open('wb') as stderr:
            proc = subprocess.Popen(argv, cwd=ROOT, env=env, stdout=stdout, stderr=stderr)
            doctor_started = {}
            terminated = set()
            while proc.poll() is None:
                for child in children(proc.pid):
                    try:
                        cmd = Path(f'/proc/{child}/cmdline').read_bytes().split(b'\0')
                    except FileNotFoundError:
                        continue
                    if b'doctor' in cmd and cmd[0] == binary.encode():
                        since = doctor_started.setdefault(child, time.monotonic())
                        if child not in terminated and time.monotonic() - since >= 120:
                            os.kill(int(child), signal.SIGTERM)
                            terminated.add(child)
                            item['doctor_interruptions'].append({'pid': int(child), 'signal': 'SIGTERM',
                                'observed_seconds': time.monotonic() - since, 'utc': datetime.now(timezone.utc).isoformat(),
                                'argv': [p.decode() for p in cmd if p]})
                            write(EXECUTION, provenance)
                            print(f'BOUND doctor {case} after 120 seconds', flush=True)
                time.sleep(1)
        item.update(exit_code=proc.returncode, elapsed_seconds=time.monotonic() - started,
                    finished_utc=datetime.now(timezone.utc).isoformat())
        write(EXECUTION, provenance)
        print(f'END {case}: exit {proc.returncode}, {item["elapsed_seconds"]:.1f}s', flush=True)


if __name__ == '__main__':
    main()

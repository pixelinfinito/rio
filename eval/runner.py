#!/usr/bin/env python3
"""Evaluate one pinned public GitHub PR in disposable base/head checkouts.

Raw reports and an editable verdict skeleton go in --out. No verdicts are inferred.
All subprocess argv, cwd, environment overrides, exit codes and durations are logged.
"""
import argparse
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen

import evaluate as e


def default_install(checkout):
    """Choose a frozen installer; never synthesize a lockfile."""
    if (checkout / 'pnpm-lock.yaml').exists():
        return [['corepack', 'pnpm', 'install', '--frozen-lockfile']]
    if (checkout / 'yarn.lock').exists():
        manifest = e.read_json(checkout / 'package.json')
        manager = manifest.get('packageManager', 'yarn@1')
        flag = '--frozen-lockfile' if manager.startswith('yarn@1') else '--immutable'
        return [['corepack', 'yarn', 'install', flag]]
    if (checkout / 'package-lock.json').exists() or (checkout / 'npm-shrinkwrap.json').exists():
        return [['npm', 'ci']]
    if (checkout / 'uv.lock').exists():
        return [['uv', 'sync', '--locked', '--all-groups', '--all-extras']]
    return []


def file_hash(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def run(args):
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', args.repository) or args.pr <= 0:
        raise ValueError('expected public GitHub owner/repo and positive PR number')
    if bool(args.base) != bool(args.head):
        raise ValueError('--base and --head must be supplied together')
    for sha in (args.base, args.head):
        if sha and not re.fullmatch(r'[a-f0-9]{40,64}', sha):
            raise ValueError('pinned commits must be full hex SHAs')
    out = Path(args.out).resolve()
    out.mkdir(parents=True, exist_ok=False)
    rio = shutil.which(args.rio)
    if rio is None:
        raise ValueError(f'Rio executable not found: {args.rio}')
    rio = str(Path(rio).resolve())
    metadata = {'schema': 'rio-eval-runner-v1', 'repository': args.repository,
                'pr': f'https://github.com/{args.repository}/pull/{args.pr}',
                'started_utc': datetime.now(timezone.utc).isoformat(),
                'rio_binary': rio, 'rio_binary_sha256': file_hash(rio), 'commands': [],
                'installations': {}, 'failures': [], 'network':
                'Installers may use network; Rio review uses --offline. Subprocesses are not isolated.'}
    profile = Path(args.profile).resolve() if args.profile else None
    if profile:
        shutil.copyfile(profile, out / 'profile.yaml')
        metadata['profile_sha256'] = file_hash(profile)
        profile = out / 'profile.yaml'
    plan = e.read_json(args.install_plan) if args.install_plan else None
    if plan is not None:
        if set(plan) != {'base', 'head'} or any(not isinstance(plan[k], list) for k in plan):
            raise ValueError('install plan must map base and head to arrays of argv arrays')
        if any(not isinstance(cmd, list) or not cmd or any(not isinstance(x, str) for x in cmd)
               for cmds in plan.values() for cmd in cmds):
            raise ValueError('every install command must be a nonempty argv array of strings')
        e.write_json(out / 'install-plan.json', plan)

    def command(argv, cwd, overrides=None, stdout=None, required=True):
        number = len(metadata['commands']) + 1
        stdout = stdout or out / f'{number:02d}-stdout.log'
        stderr = out / f'{number:02d}-stderr.log'
        started = time.monotonic()
        item = {'argv': list(map(str, argv)), 'cwd': str(cwd),
                'environment': overrides or {}, 'stdout': str(stdout), 'stderr': str(stderr)}
        metadata['commands'].append(item)
        try:
            with open(stdout, 'wb') as so, open(stderr, 'wb') as se:
                proc = subprocess.run(argv, cwd=cwd, env={**os.environ, **(overrides or {})},
                                      stdout=so, stderr=se, timeout=args.timeout, check=False)
            code = proc.returncode
        except (OSError, subprocess.TimeoutExpired) as error:
            stderr.write_text(stderr.read_text(errors='replace') + '\n' + str(error))
            code = 124 if isinstance(error, subprocess.TimeoutExpired) else 127
        item.update(exit_code=code, wall_time_ms=int((time.monotonic() - started) * 1000))
        e.write_json(out / 'commands.json', metadata)
        if required and code:
            raise ValueError(f'command {number} failed ({code}); see {stderr}')
        return Path(stdout).read_text(errors='replace'), code

    try:
        if not args.base:
            url = f'https://api.github.com/repos/{args.repository}/pulls/{args.pr}'
            with urlopen(Request(url, headers={'Accept': 'application/vnd.github+json',
                                               'User-Agent': 'rio-evaluation'}), timeout=60) as response:
                upstream = json.load(response)
            e.write_json(out / 'upstream-pr.json', upstream)
            requested_base, head = upstream['base']['sha'], upstream['head']['sha']
            metadata['resolution'] = {'url': url, 'base_sha': requested_base, 'head_sha': head}
        else:
            requested_base, head = args.base, args.head
            metadata['resolution'] = {'base_sha': requested_base, 'head_sha': head, 'source': 'pinned argv'}
        with tempfile.TemporaryDirectory(prefix='rio-eval-', dir=args.temp_root) as temporary:
            temp = Path(temporary)
            metadata['disposable_directory'] = temporary
            head_dir, base_dir = temp / 'head', temp / 'base'
            command(['git', 'clone', '--no-checkout', f'https://github.com/{args.repository}.git', str(head_dir)], temp)
            command(['git', 'fetch', 'origin', requested_base, head], head_dir)
            merged, _ = command(['git', 'merge-base', requested_base, head], head_dir)
            base = merged.strip()
            metadata.update(base_sha=base, head_sha=head)
            command(['git', 'checkout', '--detach', head], head_dir)
            command(['git', 'clone', '--no-hardlinks', '--no-checkout', str(head_dir), str(base_dir)], temp)
            # Fetched PR heads may not have remote refs, but base is reachable from HEAD.
            command(['git', 'checkout', '--detach', base], base_dir)
            for name, directory in [('base', base_dir), ('head', head_dir)]:
                commands = plan[name] if plan is not None else default_install(directory)
                install = {'commands': commands, 'succeeded': bool(commands), 'lockfiles': {}}
                for filename in ('pnpm-lock.yaml', 'yarn.lock', 'package-lock.json', 'npm-shrinkwrap.json', 'uv.lock'):
                    if (directory / filename).is_file():
                        install['lockfiles'][filename] = file_hash(directory / filename)
                for argv in commands:
                    _, code = command(argv, directory, required=False)
                    if code:
                        install['succeeded'] = False
                        metadata['failures'].append(f'{name} dependency installation failed ({code})')
                        break
                if not commands:
                    metadata['failures'].append(f'{name}: no supported lockfile; supply a pinned --install-plan')
                tracked, _ = command(['git', 'status', '--porcelain', '--untracked-files=no'], directory)
                if tracked.strip():
                    raise ValueError(f'{name} installation modified tracked files; fix install plan')
                metadata['installations'][name] = install
            config = temp / 'config'
            config.mkdir()
            # Avoid machine-level settings silently changing this cohort.
            metadata['removed_environment_keys'] = sorted(k for k in os.environ if k.startswith('RIO_'))
            # Empty RIO_* values can be invalid; strip inherited machine overrides.
            saved = {k: os.environ.pop(k) for k in list(os.environ) if k.startswith('RIO_')}
            overrides = {'RIO_CONFIG_DIR': str(config), 'RIO_CACHE_DIR': str(temp / 'cache')}
            try:
                command([rio, '--version'], head_dir, overrides, out / 'rio-version.txt')
                for executable in ('node', 'npm', 'corepack', 'python3', 'uv'):
                    if shutil.which(executable):
                        command([executable, '--version'], head_dir, overrides, required=False)
                selected_profile = str(profile) if profile else 'rio/base'
                command([rio, 'profile', 'show', selected_profile], head_dir, overrides,
                        out / 'resolved-profile.txt')
                metadata['resolved_profile_sha256'] = file_hash(out / 'resolved-profile.txt')
                command([rio, 'doctor', '--format', 'json'], head_dir, overrides, out / 'doctor.json', required=False)
                argv = [rio, 'review', '--base', base, '--format', 'json', '--offline',
                        '--profile', selected_profile]
                _, code = command(argv, head_dir, overrides, out / 'report.json', required=False)
            finally:
                os.environ.update(saved)
            metadata['review_exit_code'] = code
            raw = e.read_json(out / 'report.json')
            e.validate(raw, e.ROOT / 'schemas/report-v1.json')
            if raw['review'].get('base') != base or raw['review'].get('head') != head:
                raise ValueError('Rio reviewed different commits than the pinned change')
            env = e.environment(raw)
            metadata['environment'] = {k: v for k, v in env.items() if k != 'checks'}
            if not env['eligible']:
                metadata['failures'].append('Baseline/setup ineligible; fix before scoring')
            verdicts = e.skeleton(raw, args.repository, metadata['pr'], args.languages, args.case_id)
            verdicts['commands'] = [f'cwd={c["cwd"]} argv={json.dumps(c["argv"])}'
                                    for c in metadata['commands']]
            verdicts['notes'] = [f'Runner provenance: {out / "commands.json"}; '
                                 f'Rio binary SHA-256: {metadata["rio_binary_sha256"]}']
            e.write_json(out / 'verdicts.json', verdicts)
    except (OSError, ValueError, KeyError) as error:
        metadata['failures'].append(str(error))
        raise
    finally:
        metadata['finished_utc'] = datetime.now(timezone.utc).isoformat()
        e.write_json(out / 'commands.json', metadata)
    print(f'Raw report and verdict skeleton: {out}')
    return 1 if metadata['failures'] else 0


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repository', required=True, help='public GitHub owner/repo')
    parser.add_argument('--pr', type=int, required=True)
    parser.add_argument('--base', help='optional pinned full base SHA (requires --head)')
    parser.add_argument('--head', help='optional pinned full head SHA (requires --base)')
    parser.add_argument('--languages', nargs='+', choices=['typescript', 'python'], required=True)
    parser.add_argument('--case-id', help='stable unique ID, especially for seeded controls')
    parser.add_argument('--rio', default='rio', help='built binary path or PATH executable')
    parser.add_argument('--profile'); parser.add_argument('--install-plan')
    parser.add_argument('--out', required=True, help='new artifact directory outside disposable clones')
    parser.add_argument('--temp-root', help='parent for disposable directory')
    parser.add_argument('--timeout', type=int, default=1200, help='per-command timeout seconds')
    return run(parser.parse_args())


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, OSError, KeyError) as error:
        sys.exit(f'runner error: {error}')

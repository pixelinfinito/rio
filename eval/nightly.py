#!/usr/bin/env python3
"""Run the noise measurement nightly on this machine, never in public CI.

Usage:
  python3 -I eval/nightly.py run [--config PATH] [--date YYYY-MM-DD]
  python3 -I eval/nightly.py install [--config PATH] [--enable | --print-cron]

`run` calls `rio eval noise` with the pinned profile. Rio reads the endpoint URL
and API token already saved in ~/.config/rio, so nothing secret is passed on the
command line or stored in the repository. The dated run directory and its log are
written to a private store outside the repository (default
~/.local/share/rio/noise), scanned for every saved credential, quarantined on a
match, and runs older than the retention window are pruned.

The configuration file (default ~/.config/rio/noise.json) holds no secrets:
  {"repo": "/path/to/reference/clone", "repository": "owner/name",
   "profile": "rio/openrouter", "limit": 10,
   "rio": "/path/to/rio", "store": "~/.local/share/rio/noise", "retention_days": 90}
Only "repo" is required.

Exit codes: 0 success, 1 the run or credential scan failed, 2 usage/configuration.
"""
import argparse
from datetime import date, datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import credscan  # noqa: E402

EVAL_DIR = Path(__file__).resolve().parent
DATED = re.compile(r'^(\d{4}-\d{2}-\d{2})(?:\.quarantined-\d+)?$')
DEFAULTS = {
    'profile': 'rio/openrouter',
    'limit': 10,
    'rio': 'rio',
    'store': '~/.local/share/rio/noise',
    'retention_days': 90,
}


def config_dir():
    base = os.environ.get('XDG_CONFIG_HOME') or str(Path.home() / '.config')
    return Path(base) / 'rio'


def load_config(path):
    path = Path(path).expanduser()
    try:
        config = {**DEFAULTS, **json.loads(path.read_text())}
    except FileNotFoundError:
        raise ValueError(f'{path} not found; create it with at least {{"repo": "/path/to/clone"}}')
    except json.JSONDecodeError as error:
        raise ValueError(f'{path} is not valid JSON: {error}')
    if not isinstance(config.get('repo'), str) or not config['repo']:
        raise ValueError(f'{path} must name the reference clone in "repo"')
    for key in ('profile', 'rio', 'store'):
        if not isinstance(config[key], str) or not config[key]:
            raise ValueError(f'"{key}" must be a non-empty string')
    for key in ('limit', 'retention_days'):
        if not isinstance(config[key], int) or config[key] < 1:
            raise ValueError(f'"{key}" must be a positive integer')
    return config


def saved_credentials(directory):
    """Every secret value saved for this machine, keyed by a neutral name."""
    values = {}
    for path in sorted(Path(directory).glob('secrets-*.json')):
        try:
            data = json.loads(path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        for key, value in data.items():
            if isinstance(value, str) and value:
                values[f'SAVED_{len(values)}_{key}'] = value
    token = Path(directory) / 'credentials'
    if token.is_file():
        values[f'SAVED_{len(values)}_RIO_API_TOKEN'] = token.read_text().strip()
    return values


def private_dir(path):
    path.mkdir(parents=True, exist_ok=True)
    path.chmod(0o700)
    return path


def prune(store, today, days):
    """Remove dated runs (including quarantined ones) older than the window."""
    removed = []
    cutoff = today - timedelta(days=days)
    for entry in sorted(Path(store).iterdir()):
        match = DATED.match(entry.name)
        if entry.is_dir() and match and date.fromisoformat(match.group(1)) < cutoff:
            shutil.rmtree(entry)
            removed.append(entry.name)
    return removed


def run(config, run_date, credentials, execute=subprocess.run, now=None):
    store = private_dir(Path(config['store']).expanduser())
    out = store / run_date
    command = [
        config['rio'], 'eval', 'noise',
        '--repo', str(Path(config['repo']).expanduser()),
        '--rio', config['rio'],
        '--profile', config['profile'],
        '--limit', str(config['limit']),
        '--date', run_date,
        '--out-root', str(store),
    ]
    if config.get('repository'):
        command += ['--repository', config['repository']]
    environ = {**os.environ, 'RIO_EVAL_DIR': str(EVAL_DIR)}
    result = execute(command, env=environ, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    private_dir(out)
    private_dir(out / 'logs')
    log = out / 'logs' / 'noise.log'
    log.write_bytes(result.stdout or b'')
    log.chmod(0o600)
    hits = credscan.scan([out], names=list(credentials), environ=credentials)
    if hits:
        stamp = int((now or datetime.now(timezone.utc)).timestamp())
        quarantined = out.with_name(f'{run_date}.quarantined-{stamp}')
        out.rename(quarantined)
        quarantined.chmod(0o700)
        kinds = sorted({kind.split('_', 2)[-1] if kind.startswith('$SAVED_') else kind for _, kind in hits})
        print(f'credential found in the noise run ({", ".join(kinds)}); quarantined {quarantined}',
              file=sys.stderr)
        return 1, quarantined
    removed = prune(store, date.fromisoformat(run_date), config['retention_days'])
    if removed:
        print(f'pruned {len(removed)} run(s) older than {config["retention_days"]} days')
    print(f'noise run written to {out} (rio exit {result.returncode})')
    return (0 if result.returncode == 0 else 1), out


SERVICE = """[Unit]
Description=Rio nightly noise measurement

[Service]
Type=oneshot
ExecStart={python} -I {script} run --config {config}
"""
TIMER = """[Unit]
Description=Run the Rio noise measurement nightly

[Timer]
OnCalendar=*-*-* 03:00:00
RandomizedDelaySec=900
Persistent=true

[Install]
WantedBy=timers.target
"""


def install(config_path, enable, print_cron, execute=subprocess.run, unit_dir=None):
    script = Path(__file__).resolve()
    config_path = Path(config_path).expanduser().resolve()
    load_config(config_path)
    if print_cron:
        print(f'0 3 * * * {sys.executable} -I {script} run --config {config_path}')
        return 0
    base = os.environ.get('XDG_CONFIG_HOME') or str(Path.home() / '.config')
    units = Path(unit_dir or Path(base) / 'systemd' / 'user')
    units.mkdir(parents=True, exist_ok=True)
    (units / 'rio-noise.service').write_text(
        SERVICE.format(python=sys.executable, script=script, config=config_path))
    (units / 'rio-noise.timer').write_text(TIMER)
    print(f'wrote {units / "rio-noise.service"} and {units / "rio-noise.timer"}')
    if enable:
        for args in (['daemon-reload'], ['enable', '--now', 'rio-noise.timer']):
            execute(['systemctl', '--user', *args], check=True)
        print('enabled rio-noise.timer; run `loginctl enable-linger` so it also fires while logged out')
    return 0


def main(argv=None, execute=subprocess.run):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    default = str(config_dir() / 'noise.json')
    p = sub.add_parser('run')
    p.add_argument('--config', default=default)
    p.add_argument('--date', help='run directory name (default: today UTC)')
    p = sub.add_parser('install')
    p.add_argument('--config', default=default)
    group = p.add_mutually_exclusive_group()
    group.add_argument('--enable', action='store_true', help='also enable the systemd user timer')
    group.add_argument('--print-cron', action='store_true', help='print a crontab line instead')
    args = parser.parse_args(argv)
    try:
        if args.command == 'install':
            return install(args.config, args.enable, args.print_cron, execute)
        config = load_config(args.config)
        run_date = args.date or datetime.now(timezone.utc).date().isoformat()
        date.fromisoformat(run_date)
        code, _ = run(config, run_date, saved_credentials(config_dir()), execute)
        return code
    except ValueError as error:
        print(f'nightly: {error}', file=sys.stderr)
        return 2


if __name__ == '__main__':
    sys.exit(main())

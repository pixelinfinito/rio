#!/usr/bin/env python3
"""Retain execve provenance without changing the runner's original ledger."""
import gzip
import json
from pathlib import Path
import re
import sys

source, destination = map(Path, sys.argv[1:])
destination.mkdir(parents=True, exist_ok=True)
raw = source.read_bytes()
with gzip.open(destination / 'execve.log.gz', 'wb') as f:
    f.write(raw)
commands = []
pending = {}
ordered = []
for index, line in enumerate(raw.decode(errors='replace').splitlines()):
    m = re.match(r'^(\d+)\s+execve\((".*?"), (\[.*\]), ', line)
    if m:
        try:
            command = {'pid': int(m[1]), 'program': json.loads(m[2]), 'argv': json.loads(m[3])}
            if line.endswith('= 0'):
                ordered.append((index, command))
            elif line.endswith('<unfinished ...>'):
                pending[int(m[1])] = (index, command)
        except ValueError:
            pass
    resumed = re.match(r'^(\d+)\s+<\.\.\. execve resumed>.*= 0$', line)
    if resumed and int(resumed[1]) in pending:
        ordered.append(pending.pop(int(resumed[1])))
commands = [command for _, command in sorted(ordered)]
(destination / 'commands.json').write_text(json.dumps({
    'source': 'Successful execve calls observed with strace -f -e trace=execve -s 8192 around the unmodified eval/runner.py; original runner commands.json is unchanged.',
    'commands': commands,
}, indent=2) + '\n')
print('Captured', len(commands), 'successful execve calls')

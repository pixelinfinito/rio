#!/usr/bin/env python3
"""Read /proc for commands below one runner; never read process environments."""
import json
from pathlib import Path
import sys
import time

root = int(sys.argv[1])
out = Path(sys.argv[2])
out.parent.mkdir(parents=True, exist_ok=True)
known = {root}
seen = set()
commands = []
while Path(f'/proc/{root}').exists():
    children = {}
    for p in Path('/proc').iterdir():
        if not p.name.isdigit():
            continue
        try:
            stat = (p / 'stat').read_text().rsplit(')', 1)[1].split()
            children[int(p.name)] = int(stat[1])
        except (OSError, ValueError, IndexError):
            pass
    for _ in range(8):
        known.update(pid for pid, parent in children.items() if parent in known)
    for pid in known & children.keys():
        try:
            p = Path(f'/proc/{pid}')
            argv = [v.decode(errors='replace') for v in (p / 'cmdline').read_bytes().split(b'\0') if v]
            cwd = str((p / 'cwd').resolve())
            key = (pid, tuple(argv), cwd)
            if argv and key not in seen:
                seen.add(key)
                commands.append({'pid': pid, 'parent_pid': children[pid], 'argv': argv, 'cwd': cwd})
                out.write_text(json.dumps({'source': 'Observed /proc cmdline and cwd; short-lived processes may be absent', 'runner_pid': root, 'commands': commands}, indent=2) + '\n')
        except (OSError, ValueError):
            pass
    time.sleep(0.1)

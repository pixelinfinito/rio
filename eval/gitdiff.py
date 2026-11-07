"""Minimal unified-diff parsing shared by the noise and incident tools (standard library only)."""
import re
import subprocess

HUNK = re.compile(r'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')


def _strip(path):
    path = path.strip()
    if path == '/dev/null':
        return None
    if path.startswith('"') and path.endswith('"'):
        # C-quoted names (tabs, quotes, newlines) are rare; keep the literal text.
        path = path[1:-1]
    return path[2:] if path[:2] in ('a/', 'b/') else path


def parse(text):
    """Return [{'old': path|None, 'new': path|None, 'hunks': [(old_start, old_len, new_start, new_len)]}].

    Hunk bodies are skipped by count so content lines starting with '---' are not
    mistaken for headers.
    """
    files, current, old_left, new_left = [], None, 0, 0
    for line in text.splitlines():
        if line.startswith('diff --git '):  # body lines always start with ' ', '+', '-' or '\\'
            old_left = new_left = 0
        if old_left > 0 or new_left > 0:
            tag = line[:1]
            if tag == '-':
                old_left -= 1
            elif tag == '+':
                new_left -= 1
            elif tag == '\\':
                pass
            else:
                old_left -= 1
                new_left -= 1
            continue
        if line.startswith('diff --git '):
            current = {'old': None, 'new': None, 'hunks': []}
            files.append(current)
            match = re.match(r'diff --git (?:a/)?(.+?) (?:b/)?(\1)$', line[len('diff --git '):]) or \
                re.match(r'(?:a/)?(.+) (?:b/)(.+)$', line[len('diff --git '):])
            if match:
                current['old'], current['new'] = match.group(1), match.group(2)
            continue
        if current is None:
            continue
        if line.startswith('--- '):
            current['old'] = _strip(line[4:])
        elif line.startswith('+++ '):
            current['new'] = _strip(line[4:])
        elif line.startswith('new file mode'):
            current['old'] = None
        elif line.startswith('deleted file mode'):
            current['new'] = None
        elif line.startswith('rename from '):
            current['old'] = line[len('rename from '):]
        elif line.startswith('rename to '):
            current['new'] = line[len('rename to '):]
        else:
            match = HUNK.match(line)
            if match:
                os_, ol, ns, nl = match.groups()
                hunk = (int(os_), 1 if ol is None else int(ol), int(ns), 1 if nl is None else int(nl))
                current['hunks'].append(hunk)
                old_left, new_left = hunk[1], hunk[3]
    return files


def paths(files):
    """Every path a diff touches (old and new names)."""
    return {p for f in files for p in (f['old'], f['new']) if p}


def git(repo, *args, check=True):
    proc = subprocess.run(['git', '-c', 'core.quotePath=false', *args], cwd=repo,
                          capture_output=True, text=True, check=False)
    if check and proc.returncode:
        raise ValueError(f'git {" ".join(args)} failed: {proc.stderr.strip()}')
    return proc.stdout


def diff(repo, old, new):
    return parse(git(repo, 'diff', '-U0', '--no-renames', '--no-color', '--no-ext-diff', old, new))

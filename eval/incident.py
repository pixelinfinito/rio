#!/usr/bin/env python3
"""Turn a revert or fix-forward PR into a labeled `incident` eval case.

Usage (what `rio eval import-incident` executes):
  python3 -I eval/incident.py <pr> <fix-pr> [--caught-by ci|human|none] [--repo PATH]
      [--gh-repo OWNER/REPO] [--repository NAME] [--trigger TEXT] [--force]

The original PR is the case input (its base and head); the expected finding is
located at the symbols enclosing the fix PR's hunks in files both PRs changed, and
its trigger is taken from the fix PR's description (edit it in the written case).
The case is written to <repo>/eval/cases/incident-<pr>-<fix-pr>.json and nothing is
sent anywhere; contributing it to a shared set is a separate, explicit step.

Enclosing-symbol heuristic (documented, deliberately simple): for each fix hunk,
read the fix's base version of the file and walk upward from the hunk's first old
line to the nearest line declaring `def`, `fn`, `function` or `class` (optionally
preceded by `export`, `default`, `pub`, `pub(...)`, `async`); its name is the
symbol. When no such line exists, or the file is unavailable, the expectation is
file-level (empty symbol_path). Line numbers are in the fix's base coordinates.

Exit codes: 0 case written; 1 refused (no file overlap, or the case exists without
--force); 2 usage, fetch or validation error.
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent))
import cases  # noqa: E402
import evaluate as e  # noqa: E402
import gitdiff  # noqa: E402

SYMBOL = re.compile(r'^\s*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?'
                    r'(?:def|fn|function|class)\s*\*?\s*([A-Za-z_$][\w$]*)')
HEURISTIC = ('nearest preceding def/fn/function/class line in the fix base file; '
             'file-level when none (eval/incident.py)')
CATCHES = ('ci', 'human', 'none')


class Refused(Exception):
    """Import refused; nothing written."""


class GhFetcher:
    """Default fetcher: PR metadata and diffs via the `gh` CLI, file contents from the
    local clone (`git show`), falling back to the GitHub contents API through `gh api`."""

    def __init__(self, repo, gh_repo=None):
        self.repo, self.gh_repo = Path(repo), gh_repo

    def _gh(self, *args):
        argv = ['gh', *args]
        proc = subprocess.run(argv, cwd=self.repo, capture_output=True, text=True, check=False)
        if proc.returncode:
            raise ValueError(f'{" ".join(argv)} failed: {proc.stderr.strip()}')
        return proc.stdout

    def _r(self):
        return ['-R', self.gh_repo] if self.gh_repo else []

    def pr(self, number):
        fields = 'number,title,body,url,baseRefName,baseRefOid,headRefName,headRefOid'
        raw = json.loads(self._gh('pr', 'view', str(number), '--json', fields, *self._r()))
        meta = {'number': raw['number'], 'title': raw['title'], 'body': raw.get('body') or '',
                'url': raw.get('url'), 'base': {'ref': raw.get('baseRefName'), 'sha': raw['baseRefOid']},
                'head': {'ref': raw.get('headRefName'), 'sha': raw['headRefOid']}}
        # `gh pr diff` is relative to the merge base; read file contents there.
        meta['diff_base'] = self._merge_base(meta['base']['sha'], meta['head']['sha'])
        return meta

    def _merge_base(self, base, head):
        proc = subprocess.run(['git', 'merge-base', base, head], cwd=self.repo,
                              capture_output=True, text=True, check=False)
        if proc.returncode == 0 and proc.stdout.strip():
            return proc.stdout.strip()
        try:
            name = self.gh_repo or json.loads(self._gh('repo', 'view', '--json', 'nameWithOwner'))['nameWithOwner']
            return self._gh('api', f'repos/{name}/compare/{base}...{head}',
                            '--jq', '.merge_base_commit.sha').strip() or base
        except ValueError:
            return base

    def diff(self, number):
        return self._gh('pr', 'diff', str(number), *self._r())

    def file(self, sha, path):
        proc = subprocess.run(['git', 'show', f'{sha}:{path}'], cwd=self.repo,
                              capture_output=True, text=True, check=False)
        if proc.returncode == 0:
            return proc.stdout
        try:
            name = self.gh_repo or json.loads(self._gh('repo', 'view', '--json', 'nameWithOwner'))['nameWithOwner']
            return self._gh('api', f'repos/{name}/contents/{path}?ref={sha}',
                            '-H', 'Accept: application/vnd.github.raw')
        except ValueError:
            return None


def enclosing_symbol(text, line):
    """(name, line) of the nearest declaration at or above `line` (1-based), else (None, None)."""
    if text is None:
        return None, None
    lines = text.splitlines()
    for number in range(min(line, len(lines)), 0, -1):
        match = SYMBOL.match(lines[number - 1])
        if match:
            return match.group(1), number
    return None, None


def expected_locations(fix_files, overlap, fetcher, fix_base):
    """One location per (path, enclosing symbol) over fix hunks in overlapping files."""
    merged = {}
    for entry in fix_files:
        path = entry['old'] or entry['new']
        if path not in overlap and entry['new'] not in overlap:
            continue
        text = fetcher.file(fix_base, entry['old']) if entry['old'] else None
        hunks = entry['hunks'] or [(1, 0, 1, 0)]
        for old_start, old_len, _, _ in hunks:
            start = max(old_start, 1)
            end = start + max(old_len, 1) - 1
            name, symbol_line = enclosing_symbol(text, start)
            key = (path, name or '')
            loc = merged.setdefault(key, {'path': path, 'line_start': start, 'line_end': end,
                                          'symbol_path': name or '', 'symbol_line': symbol_line})
            loc['line_start'], loc['line_end'] = min(loc['line_start'], start), max(loc['line_end'], end)
    return sorted(merged.values(), key=lambda l: (l['path'], l['line_start']))


def trigger_from(meta):
    body = re.sub(r'<!--.*?-->', '', meta.get('body') or '', flags=re.S).strip()
    for block in re.split(r'\n\s*\n', body):
        text = ' '.join(line.strip() for line in block.splitlines()
                        if line.strip() and not line.lstrip().startswith('#')).strip()
        if text:
            return text[:500], 'fix-pr-description'
    return meta['title'].strip() or f'Fixed by PR {meta["number"]}', 'fix-pr-title'


def repository_name(meta, repo):
    match = re.match(r'https://[^/]+/([^/]+/[^/]+)/pull/\d+', meta.get('url') or '')
    return match.group(1) if match else Path(repo).resolve().name


def build_case(pr, fix_pr, caught_by, fetcher, repo, repository=None, trigger=None, now=None):
    if caught_by not in CATCHES:
        raise ValueError(f'--caught-by must be one of {", ".join(CATCHES)}')
    original, fix = fetcher.pr(pr), fetcher.pr(fix_pr)
    original_files, fix_files = gitdiff.parse(fetcher.diff(pr)), gitdiff.parse(fetcher.diff(fix_pr))
    changed, fixed = gitdiff.paths(original_files), gitdiff.paths(fix_files)
    overlap = sorted(changed & fixed)
    if not overlap:
        raise Refused(overlap_report(pr, fix_pr, changed, fixed))
    locations = expected_locations(fix_files, set(overlap), fetcher, fix.get('diff_base') or fix['base']['sha'])
    text, source = (trigger, 'manual') if trigger else trigger_from(fix)
    case = {
        'schema': 'rio-eval-case-v1', 'id': f'incident-{pr}-{fix_pr}', 'label': 'incident',
        'repository': repository or repository_name(original, repo),
        'input': {'pr': pr, 'url': original.get('url'), 'base': original['base'],
                  'head': original['head'], 'files': sorted(changed)},
        'expected': [{'locations': locations, 'trigger': text, 'trigger_source': source,
                      'rule_id': None, 'category': None, 'severity': None}],
        'counterfactual_catch': caught_by,
        'provenance': {'source': 'import-incident',
                       'created_at': (now or datetime.now(timezone.utc)).isoformat().replace('+00:00', 'Z'),
                       'tool': 'eval/incident.py',
                       'fix': {'pr': fix_pr, 'url': fix.get('url'), 'base': fix['base'], 'head': fix['head'],
                               'files': sorted(fixed)},
                       'overlap': overlap, 'location_heuristic': HEURISTIC,
                       'notes': ['Edit expected[].trigger if the fix description does not state the trigger.']},
    }
    return cases.validate_case(case)


def overlap_report(pr, fix_pr, changed, fixed):
    return (f'refused: PR {fix_pr} changes no file changed by PR {pr} (overlap: none)\n'
            f'  PR {pr} files: {", ".join(sorted(changed)) or "(none)"}\n'
            f'  PR {fix_pr} files: {", ".join(sorted(fixed)) or "(none)"}')


def write_case(case, repo, force=False):
    path = Path(repo) / 'eval' / 'cases' / f'{case["id"]}.json'
    if path.exists() and not force:
        raise Refused(f'refused: {path} exists; pass --force to overwrite')
    e.write_json(path, case)
    return path


def ask_caught_by():
    while True:
        answer = input('Would CI or a human have caught this without Rio? [ci/human/none]: ').strip()
        if answer in CATCHES:
            return answer


def main(argv=None, fetcher=None, stdin_isatty=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('pr', type=int, help='original PR (the case input)')
    parser.add_argument('fix_pr', type=int, metavar='fix-pr', help='revert or fix-forward PR')
    parser.add_argument('--caught-by', choices=CATCHES,
                        help='counterfactual_catch; asked interactively when omitted on a terminal')
    parser.add_argument('--repo', default='.', help='repository checkout; the case goes to its eval/cases/')
    parser.add_argument('--gh-repo', help='OWNER/REPO for gh when the checkout has no GitHub remote')
    parser.add_argument('--repository', help='repository name recorded in the case (default from the PR URL)')
    parser.add_argument('--trigger', help='override the trigger taken from the fix PR description')
    parser.add_argument('--force', action='store_true', help='overwrite an existing case file')
    args = parser.parse_args(argv)
    if args.pr <= 0 or args.fix_pr <= 0 or args.pr == args.fix_pr:
        parser.error('expected two different positive PR numbers')
    caught_by = args.caught_by
    if caught_by is None:
        if not (sys.stdin.isatty() if stdin_isatty is None else stdin_isatty):
            parser.error('--caught-by ci|human|none is required when not running interactively')
        caught_by = ask_caught_by()
    try:
        case = build_case(args.pr, args.fix_pr, caught_by, fetcher or GhFetcher(args.repo, args.gh_repo),
                          args.repo, args.repository, args.trigger)
        path = write_case(case, args.repo, args.force)
    except Refused as refusal:
        print(refusal, file=sys.stderr)
        return 1
    except (ValueError, KeyError, OSError, json.JSONDecodeError) as error:
        print(f'import-incident error: {error}', file=sys.stderr)
        return 2
    print(f'Wrote incident case {path} (counterfactual_catch: {caught_by}); '
          'review expected[].trigger and locations before use.')
    return 0


if __name__ == '__main__':
    sys.exit(main())

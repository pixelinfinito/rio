#!/usr/bin/env python3
"""Noise measurement on known-clean PRs, adjudication summaries and the noise release check.

`rio eval noise ARGS` executes `python3 -I eval/noise.py run ARGS`.

  run       select known-clean merged PRs from a local repository, review each with
            `rio review --base <base> --format json` in a detached worktree at the PR
            head, and write eval/runs/noise/<date>/ with one unlabeled adjudication
            skeleton per PR plus summary.json
  select    print the selection only (no reviews)
  summarize recompute <run-dir>/summary.json from the (edited) adjudication files
  validate  validate adjudication files or a run directory; lists unadjudicated findings
  check     release check: fail on any unadjudicated finding, a failed PR run, or a
            harmful count above the previous release's summary

Known-clean selection (deliberately conservative; the harmful count is a lower bound):
  * PRs are first-parent commits on the default branch whose subject is GitHub's
    `Merge pull request #N from ...` (base = merge base of the parents, head = second
    parent) or ends with `(#N)` (squash: base = parent, head = the commit).
  * Excluded when any later commit on the branch says `This reverts commit <sha>` for
    one of the PR's commits or is titled `Revert "<PR title>"` (at any time).
  * Excluded when a later first-parent commit within --window-days (default 90) of the
    landing changes, deletes or inserts directly next to a line range the PR changed;
    ranges are carried forward through intervening commits.
  * Excluded when the window has not yet elapsed (cleanliness is not established),
    when the PR diff is empty, or by an explicit --exclude N=REASON.

Labels are only ever written by a human adjudicator: harmful (acting on the finding
would introduce a bug or remove intended behavior), neutral or useful, each with the
adjudicator and a rationale. Skeleton entries start with null label; they are reported
as unadjudicated and never counted as neutral.
"""
import argparse
from collections import Counter
from datetime import date, datetime, timedelta, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parent))
import evaluate as e  # noqa: E402
import gitdiff  # noqa: E402

ADJUDICATION_SCHEMA = e.SCHEMA / 'noise-adjudication-v1.json'
SUMMARY_SCHEMA = e.SCHEMA / 'noise-summary-v1.json'
LABELS = ('harmful', 'neutral', 'useful')
MERGE = re.compile(r'^Merge pull request #(\d+) from \S+')
SQUASH = re.compile(r'\(#(\d+)\)\s*$')
REVERTS = re.compile(r'This reverts commit ([0-9a-f]{7,64})')
LOWER_BOUND_NOTE = ('Lower bound: only adjudicated findings on PRs selected as known-clean are counted, '
                    'and the selection can include changes whose defects were never fixed.')


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def iso(timestamp):
    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace('+00:00', 'Z')


def default_branch(repo):
    ref = gitdiff.git(repo, 'symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD', check=False).strip()
    return ref or gitdiff.git(repo, 'rev-parse', '--abbrev-ref', 'HEAD').strip()


def log(repo, *args):
    out = gitdiff.git(repo, 'log', '--format=%H%x1f%P%x1f%ct%x1f%s%x1f%b%x1e', *args)
    commits = []
    for record in out.split('\x1e'):
        record = record.strip('\n')
        if not record:
            continue
        sha, parents, ct, subject, body = record.split('\x1f', 4)
        commits.append({'sha': sha, 'parents': parents.split(), 'time': int(ct),
                        'subject': subject, 'body': body})
    return commits


def identify(commit, repo):
    """Return the PR this first-parent commit landed, or None."""
    merge, squash = MERGE.match(commit['subject']), SQUASH.search(commit['subject'])
    if merge and len(commit['parents']) >= 2:
        first, second = commit['parents'][:2]
        title = commit['body'].strip().splitlines()[0] if commit['body'].strip() else commit['subject']
        members = gitdiff.git(repo, 'rev-list', f'{first}..{second}').split()
        return {'number': int(merge.group(1)), 'kind': 'merge', 'title': title,
                'base': gitdiff.git(repo, 'merge-base', first, second).strip(), 'head': second,
                'landed': commit['sha'], 'landed_parent': first, 'commits': members + [commit['sha']]}
    if squash and len(commit['parents']) == 1:
        return {'number': int(squash.group(1)), 'kind': 'squash',
                'title': SQUASH.sub('', commit['subject']).strip(), 'base': commit['parents'][0],
                'head': commit['sha'], 'landed': commit['sha'], 'landed_parent': commit['parents'][0],
                'commits': [commit['sha']]}
    return None


def tracked_ranges(files):
    """PR-changed line ranges in the landed tree, per path; None means file-level."""
    tracked = {}
    for f in files:
        if f['new'] is None:
            continue
        if not f['hunks']:
            tracked[f['new']] = None
            continue
        ranges = [[max(ns, 1), max(ns, 1) + max(nl, 1) - 1] for _, _, ns, nl in f['hunks']]
        tracked.setdefault(f['new'], [])
        if tracked[f['new']] is not None:
            tracked[f['new']] += ranges
    return tracked


def touches(hunk, start, end):
    old_start, old_len = hunk[0], hunk[1]
    if old_len == 0:  # insertion after old_start: adjacent insertions count as touching
        return start - 1 <= old_start <= end
    return old_start <= end and old_start + old_len - 1 >= start


def advance(tracked, files):
    """Carry tracked ranges through one later commit; return the touched path or None."""
    for f in files:
        path = f['old']
        if path is None or path not in tracked:
            continue
        ranges = tracked[path]
        if ranges is None or not f['hunks']:
            return path
        for start, end in ranges:
            if any(touches(h, start, end) for h in f['hunks']):
                return path
        shifted = []
        for start, end in ranges:
            delta = sum(nl - ol for os_, ol, _, nl in f['hunks']
                        if (os_ + ol - 1 < start if ol else os_ < start - 1))
            shifted.append([start + delta, end + delta])
        tracked[path] = shifted
    return None


def select(repo, branch=None, window_days=90, now=None, since=None, limit=None, only=(), exclude=None):
    """Classify merged PRs on the default branch; return the selection document."""
    repo = Path(repo).resolve()
    branch = branch or default_branch(repo)
    now = now or datetime.now(timezone.utc)
    window = window_days * 86400
    exclude = exclude or {}
    mainline = log(repo, '--first-parent', '--reverse', branch)
    entries = []
    for index, commit in enumerate(mainline):
        pr = identify(commit, repo)
        if pr is None or (only and pr['number'] not in only):
            continue
        if since and datetime.fromtimestamp(commit['time'], timezone.utc).date() < since:
            continue
        reasons = []
        if pr['number'] in exclude:
            reasons.append(f'excluded: {exclude[pr["number"]]}')
        later_all = log(repo, f'{commit["sha"]}..{branch}')
        prefixes = pr['commits']
        for later in later_all:
            reverted = [s for s in REVERTS.findall(later['body']) if any(c.startswith(s) for c in prefixes)]
            if reverted or later['subject'].strip() in (f'Revert "{pr["title"]}"', f'Revert "{commit["subject"]}"'):
                reasons.append(f'reverted by {later["sha"]}')
                break
        if commit['time'] + window > now.timestamp():
            reasons.append(f'window not elapsed: landed {iso(commit["time"])}, {window_days}-day window')
        files = gitdiff.diff(repo, pr['landed_parent'], pr['landed'])
        if not files:
            reasons.append('empty diff')
        tracked = tracked_ranges(files)
        for later in mainline[index + 1:]:
            if later['time'] > commit['time'] + window:
                break
            touched = advance(tracked, gitdiff.diff(repo, later['parents'][0], later['sha']))
            if touched:
                reasons.append(f'hunk in {touched} touched by {later["sha"]} on {iso(later["time"])}')
                break
        entries.append({'case_id': f'pr-{pr["number"]}', 'pr': pr['number'], 'kind': pr['kind'],
                        'title': pr['title'], 'base': pr['base'], 'head': pr['head'],
                        'landed': pr['landed'], 'landed_at': iso(commit['time']),
                        'files': sorted(gitdiff.paths(files)),
                        'status': 'excluded' if reasons else 'clean', 'reasons': reasons})
    clean = [x for x in entries if x['status'] == 'clean']
    if limit is not None:
        dropped = clean[:-limit] if limit else clean
        for x in dropped:
            x['status'], x['reasons'] = 'not-selected', [f'beyond --limit {limit} (most recent first)']
    return {'schema': 'rio-noise-selection-v1', 'repository_path': str(repo), 'branch': branch,
            'window_days': window_days, 'evaluated_at': now.isoformat().replace('+00:00', 'Z'),
            'policy': 'merged PRs with no later revert and no same-hunk touch within the window',
            'entries': entries}


class RioRunner:
    """Run the pipeline: `rio review --base <base> --format json` in a worktree at the head."""

    def __init__(self, rio='rio', profile=None, extra=(), timeout=3600):
        found = shutil.which(rio)
        if found is None:
            raise ValueError(f'Rio executable not found: {rio}')
        self.rio, self.profile, self.extra, self.timeout = str(Path(found).resolve()), profile, list(extra), timeout

    def identity(self):
        return {'binary': self.rio, 'sha256': sha256(self.rio), 'profile': self.profile}

    def __call__(self, repo, entry, out):
        with tempfile.TemporaryDirectory(prefix='rio-noise-') as temp:
            worktree = Path(temp) / 'head'
            gitdiff.git(repo, 'worktree', 'add', '--detach', str(worktree), entry['head'])
            try:
                argv = [self.rio, 'review', '--base', entry['base'], '--format', 'json',
                        *(['--profile', self.profile] if self.profile else []), *self.extra]
                with open(out / 'report.json', 'wb') as so, open(out / 'rio-stderr.log', 'wb') as se:
                    proc = subprocess.run(argv, cwd=worktree, stdout=so, stderr=se,
                                          timeout=self.timeout, check=False)
                return {'argv': argv, 'exit_code': proc.returncode}
            finally:
                gitdiff.git(repo, 'worktree', 'remove', '--force', str(worktree), check=False)


class RecordedRunner:
    """Replay recorded reports: DIR/<case_id>.json or DIR/<pr>.json (tests, re-adjudication)."""

    def __init__(self, directory, profile=None):
        self.directory, self.profile = Path(directory), profile

    def identity(self):
        return {'binary': f'recorded:{self.directory}', 'sha256': None, 'profile': self.profile}

    def __call__(self, repo, entry, out):
        for name in (f'{entry["case_id"]}.json', f'{entry["pr"]}.json'):
            if (self.directory / name).is_file():
                shutil.copyfile(self.directory / name, out / 'report.json')
                return {'argv': ['recorded', str(self.directory / name)], 'exit_code': 0}
        raise ValueError(f'no recorded report for {entry["case_id"]} in {self.directory}')


def all_findings(report):
    return report.get('findings', []) + report.get('risks', []) + report.get('security', [])


def skeleton(entry, report, repository, report_name='report.json', report_digest=None):
    findings = {}
    for f in all_findings(report):
        source = f.get('source', {})
        findings[f['id']] = {
            'finding': {'rule_id': f['rule_id'], 'category': f['category'], 'severity': f['severity'],
                        'evidence_level': f['evidence_level'],
                        'source': source.get('agent') or f'tool:{source.get("tool", "unknown")}',
                        'path': f['location']['path'], 'line_start': f['location']['line_start'],
                        'message': f['message']},
            'adjudication': {'label': None, 'adjudicator': None, 'rationale': None}}
    return {'schema': 'rio-noise-adjudication-v1', 'repository': repository, 'case_id': entry['case_id'],
            'pr': entry['pr'], 'title': entry['title'], 'base': entry['base'], 'head': entry['head'],
            'report': report_name, 'report_sha256': report_digest, 'findings': findings}


def validate_adjudication(doc, report=None):
    """Schema-validate and return the IDs left unadjudicated. Never infers a label."""
    e.validate(doc, ADJUDICATION_SCHEMA)
    for fid, entry in doc['findings'].items():
        adj = entry['adjudication']
        if adj['label'] is not None and (adj['adjudicator'].startswith('TODO') or adj['rationale'].startswith('TODO')):
            raise ValueError(f'{doc["case_id"]}/{fid}: replace TODO adjudicator/rationale')
    if report is not None and {f['id'] for f in all_findings(report)} != set(doc['findings']):
        raise ValueError(f'{doc["case_id"]}: adjudication entries must match the report findings exactly')
    return sorted(fid for fid, entry in doc['findings'].items() if entry['adjudication']['label'] is None)


def summarize(run_dir):
    run_dir = Path(run_dir)
    meta = e.read_json(run_dir / 'run.json')
    prs, failures, harmful, unadjudicated = [], list(meta.get('failures', [])), [], []
    totals = Counter()
    for item in meta['prs']:
        row = {'case_id': item['case_id'], 'pr': item['pr'], 'status': item['status'],
               'findings': 0, **{label: 0 for label in LABELS}, 'unadjudicated': 0}
        if item['status'] == 'ran':
            directory = run_dir / item['case_id']
            report_path = directory / 'report.json'
            doc = e.read_json(directory / 'adjudication.json')
            if doc['report_sha256'] != sha256(report_path):
                raise ValueError(f'{item["case_id"]}: report.json changed after the skeleton was written')
            missing = validate_adjudication(doc, e.read_json(report_path))
            for fid, entry in sorted(doc['findings'].items()):
                adj, finding = entry['adjudication'], entry['finding']
                ref = {'case_id': item['case_id'], 'pr': item['pr'], 'finding_id': fid,
                       'rule_id': finding['rule_id'], 'path': finding['path'], 'line_start': finding['line_start']}
                if adj['label'] is None:
                    unadjudicated.append(ref)
                else:
                    row[adj['label']] += 1
                    if adj['label'] == 'harmful':
                        harmful.append({**ref, 'adjudicator': adj['adjudicator'], 'rationale': adj['rationale']})
            row.update(findings=len(doc['findings']), unadjudicated=len(missing))
        else:
            row['error'] = item.get('error', 'review did not complete')
        for key in ('findings', *LABELS, 'unadjudicated'):
            totals[key] += row[key]
        prs.append(row)
    summary = {'schema': 'rio-noise-summary-v1', 'date': meta['date'], 'repository': meta['repository'],
               'branch': meta['branch'], 'window_days': meta['window_days'], 'rio': meta['rio'],
               'profile': meta['rio']['profile'], 'selection': meta['selection'], 'prs': prs,
               'pr_count': len(prs), 'findings': totals['findings'],
               'harmful': totals['harmful'], 'harmful_is_lower_bound': True, 'harmful_note': LOWER_BOUND_NOTE,
               'neutral': totals['neutral'], 'useful': totals['useful'],
               'unadjudicated': totals['unadjudicated'], 'harmful_findings': harmful,
               'unadjudicated_findings': unadjudicated, 'failures': failures}
    e.validate(summary, SUMMARY_SCHEMA)
    return summary


def run(repo, out_root, run_date, runner, selection, repository):
    out = Path(out_root) / run_date
    if out.exists():
        raise ValueError(f'{out} exists; noise runs are append-only (adjudications live there)')
    out.mkdir(parents=True)
    e.write_json(out / 'selection.json', selection)
    selected = [x for x in selection['entries'] if x['status'] == 'clean']
    meta = {'schema': 'rio-noise-run-v1', 'date': run_date, 'repository': repository,
            'branch': selection['branch'], 'window_days': selection['window_days'], 'rio': runner.identity(),
            'selection': {'path': 'selection.json', 'considered': len(selection['entries']),
                          'selected': len(selected)}, 'prs': [], 'failures': []}
    if not selected:
        meta['failures'].append('no known-clean PR selected')
    for entry in selected:
        directory = out / entry['case_id']
        directory.mkdir()
        item = {'case_id': entry['case_id'], 'pr': entry['pr'], 'base': entry['base'], 'head': entry['head']}
        try:
            item.update(runner(repo, entry, directory))
            report = e.read_json(directory / 'report.json')
            e.validate(report, e.ROOT / 'schemas/report-v1.json')
            if report['status'] in ('error', 'no_changes'):
                raise ValueError(f'review status {report["status"]}')
            head = report['review'].get('head', '')
            if re.fullmatch(r'[0-9a-f]{40,64}', head) and head != entry['head']:
                raise ValueError(f'Rio reviewed {head}, expected {entry["head"]}')
            item['status'] = 'ran'
            e.write_json(directory / 'adjudication.json',
                         skeleton(entry, report, repository, report_digest=sha256(directory / 'report.json')))
        except (ValueError, OSError, KeyError, json.JSONDecodeError, subprocess.TimeoutExpired) as error:
            item.update(status='failed', error=str(error))
            meta['failures'].append(f'{entry["case_id"]}: {error}')
        meta['prs'].append(item)
    e.write_json(out / 'run.json', meta)
    summary = summarize(out)
    e.write_json(out / 'summary.json', summary)
    return out, summary


def load_summary(path):
    path = Path(path)
    if path.is_dir():
        return summarize(path)
    summary = e.read_json(path)
    e.validate(summary, SUMMARY_SCHEMA)
    return summary


def check(candidate, previous=None):
    """Noise release check. Missing data never passes."""
    reasons = []
    if candidate['unadjudicated']:
        names = ', '.join(f'{f["case_id"]}/{f["finding_id"]}' for f in candidate['unadjudicated_findings'])
        reasons.append(f'{candidate["unadjudicated"]} unadjudicated finding(s): {names}')
    if candidate['failures']:
        reasons.append('noise run incomplete: ' + '; '.join(candidate['failures']))
    if previous is None:
        notes = ['no previous release summary supplied (--first-release); harmful regression not compared']
    else:
        notes = []
        if previous['profile'] != candidate['profile']:
            reasons.append(f'provider profile differs from the previous release '
                           f'({candidate["profile"]!r} vs {previous["profile"]!r}); counts are not comparable')
        if candidate['harmful'] > previous['harmful']:
            names = ', '.join(f'{f["case_id"]}/{f["finding_id"]}' for f in candidate['harmful_findings'])
            reasons.append(f'harmful findings rose from {previous["harmful"]} to {candidate["harmful"]}: {names}')
    return {'schema': 'rio-noise-check-v1', 'passed': not reasons, 'reasons': reasons, 'notes': notes,
            'candidate': {'date': candidate['date'], 'harmful': candidate['harmful'],
                          'unadjudicated': candidate['unadjudicated'], 'profile': candidate['profile']},
            'previous': None if previous is None else {'date': previous['date'], 'harmful': previous['harmful'],
                                                       'profile': previous['profile']}}


def parse_exclusions(values):
    result = {}
    for value in values or []:
        number, sep, reason = value.partition('=')
        if not sep or not number.isdigit() or not reason.strip():
            raise ValueError(f'--exclude expects N=REASON, got {value!r}')
        result[int(number)] = reason.strip()
    return result


def add_selection_args(p):
    p.add_argument('--repo', default='.', help='local clone with full default-branch history')
    p.add_argument('--branch', help='default branch ref (default: origin/HEAD, else current branch)')
    p.add_argument('--window-days', type=int, default=90)
    p.add_argument('--now', help='ISO timestamp treated as now (reproducible selection)')
    p.add_argument('--since', type=date.fromisoformat, help='only PRs landed on/after YYYY-MM-DD')
    p.add_argument('--limit', type=int, help='keep the N most recently landed clean PRs')
    p.add_argument('--pr', type=int, action='append', default=[], help='restrict to these PR numbers')
    p.add_argument('--exclude', action='append', help='N=REASON: exclude a PR with a recorded reason')


def selection_from(args):
    now = datetime.fromisoformat(args.now.replace('Z', '+00:00')) if args.now else None
    if now is not None and now.tzinfo is None:
        now = now.replace(tzinfo=timezone.utc)
    return select(args.repo, args.branch, args.window_days, now, args.since, args.limit,
                  set(args.pr), parse_exclusions(args.exclude))


def main(argv=None, runner=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest='command', required=True)
    p = sub.add_parser('run', help='select, review and write the dated noise directory')
    add_selection_args(p)
    p.add_argument('--rio', default=os.environ.get('RIO_BIN', 'rio'), help='Rio binary (default $RIO_BIN or rio)')
    p.add_argument('--profile', help='pinned provider profile, e.g. rio/openrouter')
    p.add_argument('--rio-arg', action='append', default=[], help='extra argument for rio review (repeatable)')
    p.add_argument('--recorded', help='replay recorded reports from DIR instead of running Rio')
    p.add_argument('--repository', help='repository name recorded in outputs (default: directory name)')
    p.add_argument('--out-root', default='eval/runs/noise')
    p.add_argument('--date', help='run directory name (default: today UTC, YYYY-MM-DD)')
    p.add_argument('--timeout', type=int, default=3600, help='per-review timeout seconds')
    p = sub.add_parser('select', help='print the known-clean selection as JSON')
    add_selection_args(p)
    p = sub.add_parser('summarize', help='recompute summary.json from adjudication files')
    p.add_argument('run_dir')
    p = sub.add_parser('validate', help='validate adjudications; list unadjudicated findings')
    p.add_argument('paths', nargs='+', help='adjudication.json files or run directories')
    p = sub.add_parser('check', help='noise release check')
    p.add_argument('--candidate', required=True, help='candidate run directory or summary.json')
    group = p.add_mutually_exclusive_group(required=True)
    group.add_argument('--previous', help="previous release's run directory or summary.json")
    group.add_argument('--first-release', action='store_true', help='no previous release exists')
    p.add_argument('--out', help='also write the check result JSON here')
    args = parser.parse_args(argv)

    if args.command == 'select':
        print(json.dumps(selection_from(args), indent=2))
        return 0
    if args.command == 'run':
        repo = Path(args.repo).resolve()
        if runner is None:
            runner = (RecordedRunner(args.recorded, args.profile) if args.recorded
                      else RioRunner(args.rio, args.profile, args.rio_arg, args.timeout))
        run_date = args.date or datetime.now(timezone.utc).date().isoformat()
        if not re.fullmatch(r'\d{4}-\d{2}-\d{2}', run_date):
            raise ValueError('--date must be YYYY-MM-DD')
        out, summary = run(repo, args.out_root, run_date, runner, selection_from(args),
                           args.repository or repo.name)
        print(f'Noise run: {out} — {summary["pr_count"]} PR(s), {summary["findings"]} finding(s), '
              f'harmful >= {summary["harmful"]} (lower bound), {summary["unadjudicated"]} unadjudicated')
        return 1 if summary['failures'] else 0
    if args.command == 'summarize':
        summary = summarize(args.run_dir)
        e.write_json(Path(args.run_dir) / 'summary.json', summary)
        print(json.dumps({k: summary[k] for k in ('harmful', 'neutral', 'useful', 'unadjudicated')}))
        return 0
    if args.command == 'validate':
        missing = []
        for path in map(Path, args.paths):
            if path.is_dir():
                missing += [f'{f["case_id"]}/{f["finding_id"]}' for f in summarize(path)['unadjudicated_findings']]
            else:
                doc = e.read_json(path)
                report = path.parent / doc['report']
                ids = validate_adjudication(doc, e.read_json(report) if report.is_file() else None)
                missing += [f'{doc["case_id"]}/{fid}' for fid in ids]
        for name in missing:
            print(f'unadjudicated: {name}')
        print(f'Valid; {len(missing)} unadjudicated finding(s)')
        return 1 if missing else 0
    candidate = load_summary(args.candidate)
    previous = None if args.first_release else load_summary(args.previous)
    result = check(candidate, previous)
    if args.out:
        e.write_json(args.out, result)
    print(json.dumps(result, indent=2))
    return 0 if result['passed'] else 1


if __name__ == '__main__':
    try:
        sys.exit(main())
    except (ValueError, KeyError, OSError) as error:
        sys.exit(f'noise error: {error}')

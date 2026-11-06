"""Noise measurement (8.1) and the noise release check (8.2) on fixture Git repositories."""
import contextlib
import copy
from datetime import datetime, timedelta, timezone
import io
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import evaluate as e  # noqa: E402
import noise  # noqa: E402

FIXTURES = e.ROOT / 'crates/rio-core/tests/fixtures'
DAY0 = datetime(2026, 1, 1, tzinfo=timezone.utc)
NOW = DAY0 + timedelta(days=300)


class Repo:
    def __init__(self, path):
        self.path = path
        path.mkdir()
        self.git('init', '-q', '-b', 'main')
        self.git('config', 'user.name', 'Test')
        self.git('config', 'user.email', 'test@example.test')
        self.git('config', 'commit.gpgsign', 'false')

    def git(self, *args, day=0):
        when = (DAY0 + timedelta(days=day)).strftime('%Y-%m-%dT%H:%M:%S+00:00')
        env = {**os.environ, 'GIT_AUTHOR_DATE': when, 'GIT_COMMITTER_DATE': when}
        return subprocess.check_output(['git', *args], cwd=self.path, env=env, stderr=subprocess.DEVNULL).decode().strip()

    def write(self, name, lines):
        path = self.path / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(''.join(f'{line}\n' for line in lines))

    def commit(self, message, day, *extra):
        self.git('add', '-A')
        self.git('commit', '-q', '-m', message, *extra, day=day)
        return self.git('rev-parse', 'HEAD')


def build_repo(root, clean_prs=10):
    """main with: `clean_prs` clean squash PRs, one PR whose hunk is touched within the
    window, one touched only after it, a reverted merge-commit PR, and a recent PR."""
    repo = Repo(root / 'repo')
    base_lines = [f'line {i}' for i in range(1, 21)]
    repo.write('app.py', base_lines)
    for i in range(clean_prs):
        repo.write(f'mod{i}.py', ['a', 'b', 'c'])
    repo.commit('initial', 0)
    for i in range(clean_prs):
        repo.write(f'mod{i}.py', ['a', f'b changed {i}', 'c'])
        repo.commit(f'Change module {i} (#{i + 1})', 1 + i * 0.1)
    # PR 20 changes app.py line 5; a later commit edits the same line on day 30.
    lines = list(base_lines)
    lines[4] = 'line 5 by pr 20'
    repo.write('app.py', lines)
    repo.commit('Touch five (#20)', 3)
    # PR 21 changes app.py line 15; a day-20 commit inserts lines above it (shift only)
    # and the day-200 edit of the same line lands outside the 90-day window.
    lines[14] = 'line 15 by pr 21'
    repo.write('app.py', lines)
    repo.commit('Touch fifteen (#21)', 4)
    # Merge-commit PR 22 on a feature branch, reverted later.
    repo.git('checkout', '-q', '-b', 'feature')
    repo.write('other.py', ['x = 1'])
    feature = repo.commit('Add other module', 5)
    repo.git('checkout', '-q', 'main')
    repo.git('merge', '-q', '--no-ff', 'feature', '-m', 'Merge pull request #22 from acme/feature',
             '-m', 'Add other module', day=6)
    # Same-line edit of PR 20 within its window; also shifts PR 21's line by two.
    lines[4] = 'line 5 edited again'
    lines = ['# header', '# header 2'] + lines
    repo.write('app.py', lines)
    repo.commit('Follow-up edit', 30)
    repo.git('revert', '--no-edit', '-m', '1', 'HEAD~1', day=40)
    lines[16] = 'line 15 edited much later'
    repo.write('app.py', lines)
    repo.commit('Late edit', 200)
    # A recent PR whose window has not elapsed.
    repo.write('late.py', ['late'])
    repo.commit('Recent (#23)', 295)
    return repo, feature


def finding(index, path='src/a.ts'):
    f = e.read_json(FIXTURES / 'finding.json')
    f.update(id=f'{index:064x}', rule_id=f'agent/correctness/r{index}', category='risk',
             evidence_level='plausible', source={'agent': 'correctness'}, message=f'Possible issue {index}')
    f['location'].update(path=path, line_start=index, line_end=index)
    f['locations'] = [copy.deepcopy(f['location'])]
    return f


def report_for(entry, findings):
    r = e.read_json(FIXTURES / 'complete.json')
    r['findings'], r['risks'] = [], findings
    r['review'].update(base=entry['base'], head=entry['head'], mode='branch')
    return r


class FakeRunner:
    """Injected pipeline: returns a recorded report per case (two findings each by default)."""

    def __init__(self, per_case=None, fail=()):
        self.per_case, self.fail, self.calls = per_case or {}, set(fail), []

    def identity(self):
        return {'binary': 'recorded:test', 'sha256': None, 'profile': 'rio/openrouter'}

    def __call__(self, repo, entry, out):
        self.calls.append(entry['case_id'])
        if entry['case_id'] in self.fail:
            raise ValueError('rio review exited 2')
        number = entry['pr']
        findings = self.per_case.get(entry['case_id'], [finding(number * 10 + 1), finding(number * 10 + 2)])
        e.write_json(out / 'report.json', report_for(entry, findings))
        return {'argv': ['recorded'], 'exit_code': 0}


class Selection(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.temp = tempfile.TemporaryDirectory()
        cls.root = Path(cls.temp.name)
        cls.repo, cls.feature = build_repo(cls.root)
        cls.selection = noise.select(cls.repo.path, 'main', 90, NOW)
        cls.by_pr = {x['pr']: x for x in cls.selection['entries']}

    @classmethod
    def tearDownClass(cls):
        cls.temp.cleanup()

    def test_clean_prs_are_selected(self):
        clean = sorted(x['pr'] for x in self.selection['entries'] if x['status'] == 'clean')
        self.assertEqual(clean, list(range(1, 11)) + [21])
        pr1 = self.by_pr[1]
        self.assertEqual(pr1['kind'], 'squash')
        self.assertEqual(pr1['head'], pr1['landed'])
        self.assertEqual(pr1['files'], ['mod0.py'])

    def test_same_hunk_touch_within_window_excludes(self):
        self.assertEqual(self.by_pr[20]['status'], 'excluded')
        self.assertIn('hunk in app.py touched by', self.by_pr[20]['reasons'][0])
        # Shifted by the day-30 insertion and edited only on day 200: still clean.
        self.assertEqual(self.by_pr[21]['status'], 'clean')

    def test_reverted_merge_pr_is_excluded(self):
        pr = self.by_pr[22]
        self.assertEqual(pr['kind'], 'merge')
        self.assertEqual(pr['head'], self.feature)
        self.assertEqual(pr['title'], 'Add other module')
        self.assertEqual(pr['status'], 'excluded')
        self.assertTrue(any(r.startswith('reverted by') for r in pr['reasons']))

    def test_unelapsed_window_limit_and_explicit_exclusion(self):
        self.assertTrue(self.by_pr[23]['reasons'][0].startswith('window not elapsed'))
        limited = noise.select(self.repo.path, 'main', 90, NOW, limit=2, exclude={21: 'flaky fixture'})
        status = {x['pr']: x['status'] for x in limited['entries']}
        self.assertEqual([n for n, s in status.items() if s == 'clean'], [9, 10])
        self.assertEqual(status[21], 'excluded')
        self.assertEqual(status[1], 'not-selected')
        # A longer window reaches the day-200 edit of PR 21's line.
        longer = {x['pr']: x for x in noise.select(self.repo.path, 'main', 250, NOW + timedelta(days=200))['entries']}
        self.assertEqual(longer[21]['status'], 'excluded')

    def test_range_tracking(self):
        tracked = {'a.py': [[10, 12]]}
        self.assertIsNone(noise.advance(tracked, [{'old': 'a.py', 'new': 'a.py', 'hunks': [(1, 0, 1, 3)]}]))
        self.assertEqual(tracked['a.py'], [[13, 15]])
        self.assertIsNone(noise.advance(tracked, [{'old': 'a.py', 'new': 'a.py', 'hunks': [(20, 2, 20, 0)]}]))
        self.assertEqual(noise.advance(tracked, [{'old': 'a.py', 'new': 'a.py', 'hunks': [(15, 0, 16, 1)]}]), 'a.py')
        self.assertEqual(noise.advance({'b.bin': None}, [{'old': 'b.bin', 'new': 'b.bin', 'hunks': []}]), 'b.bin')


class NoiseRun(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.repo, _ = build_repo(self.root)
        self.out_root = self.root / 'eval/runs/noise'

    def run_noise(self, runner='fake', date='2026-10-28', extra=()):
        argv = ['run', '--repo', str(self.repo.path), '--branch', 'main', '--now', NOW.isoformat(),
                '--out-root', str(self.out_root), '--date', date, '--repository', 'acme/shop',
                '--profile', 'rio/openrouter', *extra]
        with contextlib.redirect_stdout(io.StringIO()):
            return noise.main(argv, runner=FakeRunner() if runner == 'fake' else runner)

    def label_all(self, run_dir, harmful=(), skip=()):
        for path in sorted(run_dir.glob('pr-*/adjudication.json')):
            doc = e.read_json(path)
            for fid, entry in doc['findings'].items():
                if (doc['case_id'], fid) in skip:
                    continue
                label = 'harmful' if (doc['case_id'], fid) in harmful else 'neutral'
                entry['adjudication'] = {'label': label, 'adjudicator': 'maintainer@example.test',
                                         'rationale': 'acting on it would remove the intended fallback'
                                         if label == 'harmful' else 'no behavior change if applied'}
            e.write_json(path, doc)

    def test_run_writes_unlabeled_skeletons_and_dated_summary(self):
        self.assertEqual(self.run_noise(), 0)
        run_dir = self.out_root / '2026-10-28'
        self.assertTrue((run_dir / 'selection.json').is_file())
        summary = e.read_json(run_dir / 'summary.json')
        e.validate(summary, noise.SUMMARY_SCHEMA)
        self.assertEqual(summary['pr_count'], 11)
        self.assertEqual(summary['findings'], 22)
        self.assertEqual(summary['harmful'], 0)
        self.assertEqual(summary['neutral'], 0, 'skeleton entries must never count as neutral')
        self.assertEqual(summary['unadjudicated'], 22)
        self.assertTrue(summary['harmful_is_lower_bound'])
        self.assertEqual(summary['profile'], 'rio/openrouter')
        doc = e.read_json(run_dir / 'pr-21/adjudication.json')
        self.assertEqual({tuple(x['adjudication'].values()) for x in doc['findings'].values()}, {(None, None, None)})
        noise.validate_adjudication(doc)

    def test_noise_summary_scenario_one_harmful_none_unadjudicated(self):
        # Ten known-clean PRs (spec scenario): restrict to PRs 1-10.
        self.run_noise(extra=[x for n in range(1, 11) for x in ('--pr', str(n))])
        run_dir = self.out_root / '2026-10-28'
        harmful = ('pr-3', f'{31:064x}')
        self.label_all(run_dir, harmful={harmful})
        with contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(noise.main(['summarize', str(run_dir)]), 0)
        summary = e.read_json(run_dir / 'summary.json')
        self.assertEqual(summary['pr_count'], 10)
        self.assertEqual((summary['harmful'], summary['unadjudicated'], summary['neutral']), (1, 0, 19))
        self.assertTrue(summary['harmful_is_lower_bound'])
        self.assertIn('Lower bound', summary['harmful_note'])
        self.assertEqual(summary['harmful_findings'][0]['finding_id'], harmful[1])

    def test_unlabeled_entry_stays_unadjudicated(self):
        self.run_noise()
        run_dir = self.out_root / '2026-10-28'
        left = ('pr-21', f'{211:064x}')
        self.label_all(run_dir, skip={left})
        summary = noise.summarize(run_dir)
        self.assertEqual(summary['unadjudicated'], 1)
        self.assertEqual(summary['neutral'], 21)
        self.assertEqual(summary['unadjudicated_findings'][0]['finding_id'], left[1])
        out = io.StringIO()
        with contextlib.redirect_stdout(out):
            self.assertEqual(noise.main(['validate', str(run_dir / 'pr-21/adjudication.json')]), 1)
        self.assertIn(f'unadjudicated: pr-21/{left[1]}', out.getvalue())

    def test_labels_need_adjudicator_rationale_and_known_values(self):
        self.run_noise()
        path = self.out_root / '2026-10-28/pr-1/adjudication.json'
        doc = e.read_json(path)
        entry = next(iter(doc['findings'].values()))
        entry['adjudication'] = {'label': 'harmful', 'adjudicator': None, 'rationale': None}
        with self.assertRaisesRegex(ValueError, 'adjudicator'):
            noise.validate_adjudication(doc)
        entry['adjudication'] = {'label': 'bad', 'adjudicator': 'x', 'rationale': 'y'}
        with self.assertRaisesRegex(ValueError, 'invalid enum'):
            noise.validate_adjudication(doc)
        # The record schema carries the same definition for per-finding records.
        e.validate({'label': 'useful', 'adjudicator': 'x', 'rationale': 'y'},
                   e.SCHEMA / 'record-v2.json', '/$defs/noise_adjudication')

    def test_tampered_report_is_rejected(self):
        self.run_noise()
        report = self.out_root / '2026-10-28/pr-1/report.json'
        report.write_text(report.read_text() + ' ')
        with self.assertRaisesRegex(ValueError, 'changed after the skeleton'):
            noise.summarize(self.out_root / '2026-10-28')

    def test_failed_review_is_recorded_and_existing_runs_are_not_overwritten(self):
        self.assertEqual(self.run_noise(FakeRunner(fail={'pr-2'})), 1)
        summary = e.read_json(self.out_root / '2026-10-28/summary.json')
        self.assertEqual(summary['failures'], ['pr-2: rio review exited 2'])
        self.assertEqual(next(p for p in summary['prs'] if p['case_id'] == 'pr-2')['status'], 'failed')
        with self.assertRaisesRegex(ValueError, 'exists'):
            self.run_noise()

    def test_default_runner_executes_rio_review_in_a_head_worktree(self):
        fake = self.root / 'fake-rio'
        template = report_for({'base': 'B', 'head': 'H'}, [finding(1)])
        fake.write_text(f'#!{sys.executable}\n'
                        'import json, subprocess, sys\n'
                        f'report = json.loads({json.dumps(json.dumps(template))})\n'
                        "assert sys.argv[1:3] == ['review', '--base'] and sys.argv[4:8] == ['--format', 'json', '--profile', 'rio/openrouter'], sys.argv\n"
                        "report['review']['base'] = sys.argv[3]\n"
                        "report['review']['head'] = subprocess.check_output(['git', 'rev-parse', 'HEAD']).decode().strip()\n"
                        'print(json.dumps(report))\n')
        fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
        self.assertEqual(self.run_noise(runner=None, extra=['--rio', str(fake), '--pr', '21']), 0)
        summary = e.read_json(self.out_root / '2026-10-28/summary.json')
        self.assertEqual((summary['pr_count'], summary['findings'], summary['failures']), (1, 1, []))
        self.assertEqual(summary['rio']['binary'], str(fake.resolve()))
        self.assertEqual(len(self.repo.git('worktree', 'list').splitlines()), 1, 'temporary worktree removed')


class ReleaseCheck(unittest.TestCase):
    def summary(self, harmful=0, unadjudicated=0, profile='rio/openrouter', failures=()):
        def ref(kind, i):
            i += 1
            return {'case_id': f'pr-{i}', 'pr': i, 'finding_id': f'{kind}{i}', 'rule_id': 'r', 'path': 'a.py',
                    'line_start': 1}
        value = {'schema': 'rio-noise-summary-v1', 'date': '2026-10-28', 'repository': 'acme/shop',
                 'branch': 'main', 'window_days': 90,
                 'rio': {'binary': 'rio', 'sha256': None, 'profile': profile}, 'profile': profile,
                 'selection': {'path': 'selection.json', 'considered': 10, 'selected': 10}, 'prs': [],
                 'pr_count': 10, 'findings': harmful + unadjudicated, 'harmful': harmful,
                 'harmful_is_lower_bound': True, 'harmful_note': noise.LOWER_BOUND_NOTE, 'neutral': 0, 'useful': 0,
                 'unadjudicated': unadjudicated,
                 'harmful_findings': [{**ref('h', i), 'adjudicator': 'a', 'rationale': 'r'} for i in range(harmful)],
                 'unadjudicated_findings': [ref('u', i) for i in range(unadjudicated)], 'failures': list(failures)}
        e.validate(value, noise.SUMMARY_SCHEMA)
        return value

    def test_unadjudicated_noise_blocks_release_and_names_findings(self):
        result = noise.check(self.summary(unadjudicated=2), self.summary())
        self.assertFalse(result['passed'])
        self.assertEqual(result['reasons'], ['2 unadjudicated finding(s): pr-1/u1, pr-2/u2'])

    def test_noise_regression_blocks_release_and_names_findings(self):
        result = noise.check(self.summary(harmful=2), self.summary(harmful=0))
        self.assertFalse(result['passed'])
        self.assertEqual(result['reasons'], ['harmful findings rose from 0 to 2: pr-1/h1, pr-2/h2'])

    def test_passing_run(self):
        result = noise.check(self.summary(harmful=1), self.summary(harmful=1))
        self.assertTrue(result['passed'], result['reasons'])
        self.assertTrue(noise.check(self.summary(), None)['passed'])

    def test_incomplete_or_incomparable_runs_fail(self):
        self.assertFalse(noise.check(self.summary(failures=['pr-2: boom']), self.summary())['passed'])
        result = noise.check(self.summary(), self.summary(profile='rio/anthropic'))
        self.assertIn('not comparable', result['reasons'][0])

    def test_cli_check_requires_previous_or_first_release(self):
        with tempfile.TemporaryDirectory() as tmp:
            cand, prev = Path(tmp) / 'c.json', Path(tmp) / 'p.json'
            e.write_json(cand, self.summary(harmful=2))
            e.write_json(prev, self.summary())
            with contextlib.redirect_stdout(io.StringIO()):
                self.assertEqual(noise.main(['check', '--candidate', str(cand), '--previous', str(prev)]), 1)
                self.assertEqual(noise.main(['check', '--candidate', str(prev), '--previous', str(prev)]), 0)
                self.assertEqual(noise.main(['check', '--candidate', str(prev), '--first-release']), 0)
            with self.assertRaises(SystemExit), contextlib.redirect_stderr(io.StringIO()):
                noise.main(['check', '--candidate', str(cand)])


if __name__ == '__main__':
    unittest.main()

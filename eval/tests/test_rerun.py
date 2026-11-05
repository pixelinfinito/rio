"""Reproduce the published rerun metrics directly from canonical raw evidence."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import evaluate as e
import rerun_v01 as rerun


class RerunTests(unittest.TestCase):
    def test_published_cohort_matches_raw_reports_and_explains_rescoring(self):
        paths = ['eval/runs/' + p for p in e.read_json(rerun.SELECTION)]
        records = [e.read_json(e.ROOT / p) for p in paths]
        historical = []
        for record, path in zip(records, paths):
            report_path = e.ROOT / record['report_path']
            verdict_path = e.ROOT / Path(path).with_name('verdicts.json')
            self.assertEqual(record, e.build_record(e.read_json(report_path),
                             e.read_json(verdict_path), record['report_path']))
            old = e.ROOT / Path(path).with_name('record.json')
            if not old.exists():
                old = old.with_name('excluded-record.json')
            original = e.read_json(old)
            historical.append(original)
            if record['repository'] in {'sindresorhus/ky', 'hynek/structlog', 'pydantic/pydantic'}:
                self.assertEqual(e.current_record(original), record)
        summary = e.read_json(rerun.DIRECTORY / 'summary.json')
        self.assertEqual(summary, e.aggregate(records, paths,
                         select='eval/runs/v0.1-rerun-selection.json'))
        self.assertEqual(summary['eligible']['eligible_prs'], 16)
        self.assertEqual(summary['verified_only']['eligible_prs'], 11)
        for view in ('eligible', 'verified_only'):
            self.assertEqual(summary[view]['cause_counts']['false-positive'], 1)
        self.assertEqual(summary['eligible']['positive_control_detected'], 6)
        self.assertEqual(summary['eligible']['positive_control_expected'], 7)
        self.assertEqual(summary['verified_only']['positive_control_detected'], 5)
        self.assertEqual(summary['verified_only']['positive_control_expected'], 5)
        self.assertEqual(summary['eligible']['useful_prs'], 14)
        self.assertEqual(summary['verified_only']['useful_prs'], 10)
        trusted = [r for r in records if r['environment']['dependency_state'] == 'trusted'
                   and r['environment']['eligible']]
        self.assertEqual(len(trusted), 5)
        narrative = rerun.narrative(records, summary, historical)
        self.assertEqual(narrative, (rerun.DIRECTORY / 'narrative.md').read_text())
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / 'document.md'
            real_link = e.link
            with patch.object(e, 'link', side_effect=lambda p, _: real_link(p, rerun.DOCUMENT)):
                e.render(records, paths, summary, 'v0.1 rerun', output, narrative)
            text = output.read_text()
            self.assertEqual(text, rerun.DOCUMENT.read_text())
            self.assertIn('| All eligible | 16 | 6 | 1 |', text)
            self.assertIn('become informational `pre-existing-hidden`', text)
            self.assertIn('structlog / 811-seeded-assignment', text)
            self.assertIn('sindresorhus/ky / 578', text)


if __name__ == '__main__':
    unittest.main()

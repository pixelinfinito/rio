"""Guard the preserved historical observations and the new exclusion boundary."""
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import evaluate as e


class HistoricalTests(unittest.TestCase):
    def test_checked_in_summary_matches_records_and_preserved_reports(self):
        directory = e.ROOT / 'docs/evaluation/v0.1-rescored'
        summary = e.read_json(directory / 'summary.json')
        records = [e.read_json(e.ROOT / path) for path in summary['records']]
        self.assertEqual(e.aggregate(records, summary['records']), summary)
        self.assertEqual(summary['attempts'], 10)
        self.assertEqual(summary['eligible']['eligible_prs'], 0)
        self.assertEqual(len(summary['environment_failures']), 10)
        self.assertEqual(summary['observed_raw_counts']['pre-existing-shown'], 4430)
        self.assertEqual(summary['observed_raw_counts']['false-positive'], 4)
        self.assertEqual(len(summary['agent_layer_backlog']), 2)
        self.assertEqual(summary['deterministic_misses'], 0)
        self.assertIsNone(summary['eligible']['precision'])
        self.assertIsNone(summary['eligible']['positive_control_recall'])
        for record in records:
            report = e.read_json(e.ROOT / record['report_path'])
            self.assertEqual([f['finding'] for f in record['findings']], report['findings'] + report['risks'])
            self.assertEqual(record['base_sha'], report['review']['base'])
            self.assertEqual(record['head_sha'], report['review']['head'])
            self.assertFalse(record['environment']['baseline_classification_ran'])


if __name__ == '__main__':
    unittest.main()

from pathlib import Path
import unittest

from normalization.incremental import append_incremental_observations
from normalization.monitoring import import_monitor_report


class IncrementalImport(unittest.TestCase):
    def test_partial_today_run_imports_only_verified_quotes(self):
        root = Path(__file__).resolve().parents[2]
        baseline = root / 'scripts/monitoring/reports/20260927/prices.json'
        today = root / 'assets/m/20260928/prices.json'
        dataset = import_monitor_report(baseline)
        added = append_incremental_observations(dataset, today)
        self.assertEqual(added, 94)
        new_rows = [r for r in dataset['records'] if r.get('run_id') == 'incremental-20260928']
        self.assertEqual(len(new_rows), 94)
        self.assertTrue(all(r['observed_at'].startswith('2026-09-28') for r in new_rows))
        self.assertEqual(len(dataset['coverage']['incremental']['failures']), 2)
        self.assertTrue(all(e.get('snapshot_exists') for e in dataset['evidence'][-94:]))


if __name__ == '__main__':
    unittest.main()

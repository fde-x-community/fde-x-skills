import json
from datetime import date
from pathlib import Path
import tempfile
import unittest
from dashboard import render_dashboard
from skill.run import validate_input, resolve_input


class Inputs(unittest.TestCase):
    def test_default_and_leap_boundary(self):
        s = validate_input({'products': 'Vooglam Okinawa'}, date(2024, 3, 1))
        self.assertEqual((s['period_start'], s['period_end']), ('2024-01-31', '2024-02-29'))
        self.assertEqual(s['market'], 'US')

    def test_invalid_inputs(self):
        for raw in ({}, {'products': ['X'], 'market': 'UK'},
                    {'products': ['X'], 'period': {'start': '2026-09-27', 'end': '2026-09-28'}}):
            with self.assertRaises(ValueError):
                validate_input(raw, date(2026, 9, 27))

    def test_ambiguity(self):
        dataset = {'records': [{'entity_type': 'product', 'product_id': 'a', 'brand': 'V', 'market': 'US', 'name': 'Spine'},
                               {'entity_type': 'product', 'product_id': 'b', 'brand': 'V', 'market': 'US', 'name': 'Spine'}]}
        self.assertEqual(resolve_input({'products': ['V Spine']}, dataset)['status'], 'needs_clarification')

    def test_script_escape(self):
        with tempfile.TemporaryDirectory() as t:
            render_dashboard({'records': [], 'evidence': []}, {}, {'products': ['</script><script>alert(1)</script>']}, t)
            source = (Path(t) / 'index.html').read_text(encoding='utf-8')
            self.assertNotIn('</script><script>alert(1)', source)
            self.assertEqual(source.count('id="page'), 5)


if __name__ == '__main__':
    unittest.main()

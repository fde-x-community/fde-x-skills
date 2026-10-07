import unittest

from analytics.alerts import build_alert_inputs


class AlertInputs(unittest.TestCase):
    def test_price_uses_observed_days_and_same_configuration(self):
        base = dict(entity_type='price_observation', status='ok', product_id='p',
                    variant_id='v', lens_config_id='l', market='US', currency='USD',
                    source_kind='public_observation', price_basis='subtotal',
                    history_group_key='same', evidence_id='e')
        rows = [dict(base, record_id='r1', observed_at='2026-09-25T10:00:00', quoted_subtotal='100'),
                dict(base, record_id='r2', observed_at='2026-09-27T10:00:00', quoted_subtotal='115'),
                dict(base, record_id='r3', observed_at='2026-09-28T10:00:00',
                     lens_config_id='other', quoted_subtotal='200')]
        result = build_alert_inputs({'records': rows})
        self.assertEqual(len(result['price_changes']), 1)
        self.assertEqual(result['price_changes'][0]['change']['value'], '15.00')
        self.assertEqual(result['price_changes'][0]['baseline_at'][:10], '2026-09-25')

    def test_stockout_requires_consecutive_observed_days(self):
        base = dict(entity_type='variant', product_id='p', variant_id='v', market='US',
                    evidence_id='e', availability='out_of_stock')
        days = ['25', '26', '28', '29', '30']
        rows = [dict(base, record_id='v' + day, observed_at='2026-09-' + day + 'T10:00:00')
                for day in days]
        result = build_alert_inputs({'records': rows})
        self.assertEqual([r['days'] for r in result['stockout_runs']], [2, 3])
        self.assertEqual(result['stock_observation_count'], 5)

    def test_no_stock_evidence_is_unknown(self):
        result = build_alert_inputs({'records': []})
        self.assertEqual(result['stock_observation_count'], 0)
        self.assertEqual(result['defaults'], {'price_change_percent': 10,
                                               'stockout_consecutive_days': 3})


if __name__ == '__main__':
    unittest.main()

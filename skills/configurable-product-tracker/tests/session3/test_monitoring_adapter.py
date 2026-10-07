from collections import Counter
import json
from pathlib import Path
import unittest

from analytics import analyze
from normalization.monitoring import import_monitor_report


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'scripts/monitoring/reports/20260927/prices.json'


class MonitoringImport(unittest.TestCase):
    @unittest.skipUnless(SOURCE.is_file(), 'archived monitor report unavailable')
    def test_real_history_and_evidence(self):
        source = json.loads(SOURCE.read_text(encoding='utf-8'))
        dataset = import_monitor_report(SOURCE)
        prices = [r for r in dataset['records'] if r['entity_type'] == 'price_observation']
        self.assertEqual(len(prices), len(source['history']))
        self.assertEqual(Counter(r['observed_at'][:10] for r in prices),
                         Counter(r['observed_at'][:10] for r in source['history']))
        self.assertEqual(len([r for r in dataset['records'] if r['entity_type'] == 'product']), 5)
        self.assertEqual({r['product_id']: r['frame_style'] for r in dataset['records']
                          if r['entity_type'] == 'product'},
                         {'vooglam:9999': 'Rectangle', 'vooglam:10003': 'Cat eye',
                          'vooglam:9990': 'Geometric', 'vooglam:9253': 'Geometric',
                          'vooglam:9630': 'Square'})
        self.assertTrue(all(r['complete_pair_price'] is None and r['tax_included'] is None for r in prices))
        self.assertTrue(all(e['snapshot_exists'] for e in dataset['evidence']))
        self.assertFalse(dataset['quality_flags'])
        result = analyze(dataset)
        self.assertEqual(result['metrics'][0]['value'], 5)
        self.assertTrue(any(f['code'] == 'no_comparable_history' for f in result['quality_flags']))

    def test_rejects_bad_arithmetic_without_inventing_price(self):
        import tempfile
        source = {'generated_at': '2026-09-27T22:00:00+08:00', 'scope': 'test',
                  'products': [{'product_id': '1', 'name': 'A', 'sku': 'SKU', 'url': 'https://example.invalid/1'}],
                  'history': [{'product_id': '1', 'sku': 'SKU', 'observed_at': '2026-09-27T21:00:00+08:00',
                               'frame_price': '10', 'lens_price': '20', 'total': '99', 'currency': 'USD'}]}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'prices.json'
            path.write_text(json.dumps(source), encoding='utf-8')
            dataset = import_monitor_report(path)
        self.assertFalse(dataset['records'])
        self.assertEqual(dataset['quality_flags'][0]['code'], 'price_arithmetic_mismatch')

    def test_fresh_run_finds_product_and_cart_screenshots(self):
        import tempfile
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            product_dir = root / 'scripts' / 'vooglam_products' / '1' / 'identity_20260928_100000'
            product_dir.mkdir(parents=True)
            image = product_dir / 'product.png'
            image.write_bytes(b'product screenshot')
            (product_dir / 'product.html').write_text(
                '<p class="detail-label">Frame Shape</p><p class="detail-value">Round</p>', encoding='utf-8')
            cart = root / 'cart.png'
            cart.write_bytes(b'cart screenshot')
            report = {'generated_at': '2026-09-28T10:00:00+08:00', 'today': '2026-09-28',
                      'scope': 'test', 'products': [{'product_id': '1', 'name': 'A', 'sku': 'SKU',
                                                    'url': 'https://example.invalid/1'}],
                      'history': [{'product_id': '1', 'sku': 'SKU', 'observed_at': '2026-09-28T10:00:00+08:00',
                                   'frame_price': '10', 'lens_price': '20', 'total': '30',
                                   'currency': 'USD', 'evidence': 'cart.png'}]}
            source = root / 'prices.json'
            source.write_text(json.dumps(report), encoding='utf-8')
            dataset = import_monitor_report(source)
            product = next(r for r in dataset['records'] if r['entity_type'] == 'product')
            self.assertEqual(product['thumbnail_ref'], str(image))
            self.assertEqual(product['frame_style'], 'Round')
            self.assertTrue(dataset['evidence'][0]['snapshot_exists'])


if __name__ == '__main__':
    unittest.main()

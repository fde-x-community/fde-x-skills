import json
from datetime import datetime, timedelta
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from skill.verified_to_dashboard import convert
from skill.request_input import load_request
from normalization.monitoring import import_monitor_report
from analytics.run_monitoring import main as build_dashboard


class LivePipeline(unittest.TestCase):
    def test_shared_request_accepts_brand_name_strings(self):
        with tempfile.TemporaryDirectory() as temporary:
            request = Path(temporary) / 'request.json'
            request.write_text(json.dumps({'products': ['Vooglam Okinawa'], 'market': 'US',
                'period': {'start': '2026-08-28', 'end': '2026-09-26'}}), encoding='utf-8')
            parsed = load_request(request)
            self.assertEqual(parsed['products'], [{'merchant': 'Vooglam', 'product': 'Okinawa'}])
            self.assertEqual(parsed['monitoring_period']['end'], '2026-09-26')

    def test_verified_cart_evidence_reaches_dashboard_adapter(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            source = root / 'scripts' / 'vooglam_products' / 'verified_prices.json'
            source.parent.mkdir(parents=True)
            screenshot = source.parent / '9999' / 'cart.png'
            screenshot.parent.mkdir()
            screenshot.write_bytes(b'cart screenshot')
            (screenshot.parent / 'cart.txt').write_text('cart evidence', encoding='utf-8')
            row = {'product_id': '9999', 'sku': 'SKU1', 'source_url': 'https://www.vooglam.com/goods-detail/9999',
                   'observed_at': datetime.now().astimezone().isoformat(), 'frame_price': '110',
                   'lens_price': '10', 'total': '120', 'currency': 'USD',
                   'evidence': '9999/cart.png', 'evidence_text': '9999/cart.txt',
                   'lens_path': 'Standard Lenses', 'technology': 'Standard Lenses',
                   'material': '未经过材料页', 'cart_configuration': 'Standard Lenses'}
            source.write_text(json.dumps({'scope': 'single vision zero',
                'products': [{'product_id': '9999', 'name': 'Okinawa', 'sku': 'SKU1',
                              'url': row['source_url']}], 'observations': [row]}), encoding='utf-8')
            destination = root / 'prices.json'
            result = convert(source, destination)
            self.assertEqual(result['history_count'], 1)
            imported = import_monitor_report(destination)
            prices = [item for item in imported['records'] if item['entity_type'] == 'price_observation']
            self.assertEqual(len(prices), 1)
            self.assertEqual(prices[0]['quoted_subtotal'], '120')
            self.assertTrue(imported['evidence'][0]['snapshot_exists'])
            report = root / 'dashboard'
            with patch('sys.argv', ['run_monitoring', str(destination), str(report),
                                    '--mode', 'live_observation']):
                build_dashboard()
            manifest = json.loads((report / 'run_manifest.json').read_text(encoding='utf-8'))
            self.assertEqual(manifest['period_end'], (datetime.now().astimezone().date() - timedelta(days=1)).isoformat())
            self.assertTrue((report / 'index.html').is_file())
            screenshot.unlink()
            with self.assertRaisesRegex(ValueError, 'Missing verified evidence'):
                convert(source, destination)


if __name__ == '__main__':
    unittest.main()

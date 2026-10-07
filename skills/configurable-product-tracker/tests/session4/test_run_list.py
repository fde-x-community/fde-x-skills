import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import subprocess
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts'))
from skill.run_list import read_products, resolve_products, preflight, result_status, CATALOG
from skill.monitor_cache import find_reusable, write_reused_source
from skill.live import COLLECTORS
from monitoring.history import archive, SCENARIO


class RunListTest(unittest.TestCase):
    def test_brand_name_list_resolves_known_official_urls(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'products.txt'
            path.write_text('Vooglam - Okinawa\nFirmoo - S939\n', encoding='utf-8')
            products = read_products(path)
        resolved, questions = resolve_products(products, json.loads(CATALOG.read_text(encoding='utf-8')))
        self.assertEqual(questions, [])
        self.assertEqual([p['merchant'] for p in resolved], ['Vooglam', 'Firmoo'])
        self.assertTrue(resolved[1]['url'].startswith('https://www.firmoo.com/'))

    def test_unknown_product_requires_identity_confirmation(self):
        unresolved, questions = resolve_products(
            [{'merchant': 'Vooglam', 'product': 'Unknown', 'market': 'US', 'url': None}], [])
        self.assertEqual(unresolved, [])
        self.assertIn('未找到唯一的已核验官网链接', questions[0]['reason'])

    def test_rejects_wrong_market_url(self):
        products = [{'merchant': 'Firmoo', 'product': 'S939', 'market': 'UK',
                     'url': 'https://www.firmoo.com/eyeglasses-p-4611.html'}]
        resolved, questions = resolve_products(products, [])
        self.assertEqual(resolved, [])
        self.assertEqual(len(questions), 1)

    def test_dry_run_leaves_output_available_for_live_run(self):
        with tempfile.TemporaryDirectory() as folder:
            request = Path(folder) / 'products.txt'
            output = Path(folder) / 'result'
            request.write_text('Vooglam - Okinawa\n', encoding='utf-8')
            result = subprocess.run([sys.executable, '-m', 'skill.run_list', '--input', str(request),
                                     '--output', str(output), '--dry-run'],
                                    cwd=str(Path(__file__).resolve().parents[2] / 'scripts'),
                                    capture_output=True, text=True, encoding='utf-8',
                                    env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(output.exists())
            parsed = json.loads(result.stdout)
            self.assertIn('runtime_issues', parsed)
            self.assertFalse(parsed['period_user_specified'])

    def test_explicit_period_stays_explicit(self):
        with tempfile.TemporaryDirectory() as folder:
            request = Path(folder) / 'request.json'
            output = Path(folder) / 'result'
            request.write_text(json.dumps({'products': [{'merchant': 'Vooglam', 'product': 'Okinawa'}],
                                           'monitoring_period': {'start': '2026-08-01', 'end': '2026-08-31'}}), encoding='utf-8')
            result = subprocess.run([sys.executable, '-m', 'skill.run_list', '--input', str(request),
                                     '--output', str(output), '--dry-run'],
                                    cwd=str(Path(__file__).resolve().parents[2] / 'scripts'),
                                    capture_output=True, text=True, encoding='utf-8',
                                    env={**os.environ, 'PYTHONIOENCODING': 'utf-8'})
            self.assertEqual(result.returncode, 0, result.stderr)
            parsed = json.loads(result.stdout)
            self.assertTrue(parsed['period_user_specified'])
            self.assertEqual(parsed['monitoring_period']['end'], '2026-08-31')

    def test_preflight_detects_incomplete_package(self):
        with patch('skill.run_list.find_spec', return_value=object()), \
             patch('skill.run_list.ROOT', Path('missing-package')):
            issues = preflight([{'merchant': 'Vooglam'}])
        self.assertIn('vooglam_classic_seeds.json', ' '.join(issues))
        self.assertIn('vooglam_classic_seeds.json', COLLECTORS)

    def test_zero_verified_prices_is_failure_even_if_steps_exit_zero(self):
        self.assertEqual(result_status(0, [{'exit_code': 0}]), 'failed')
        self.assertEqual(result_status(2, [{'exit_code': 1}]), 'partial')
        self.assertEqual(result_status(2, [{'exit_code': 0}]), 'completed')

    def test_today_monitor_cache_requires_all_classic_paths_and_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            monitor = root / 'monitoring'
            monitor.mkdir()
            (root / 'vooglam_classic_seeds.json').write_text(json.dumps([
                {'lens_type': name} for name in ('Standard Lenses', 'Blue Light Blocking', 'Driving Lenses')]), encoding='utf-8')
            product = {'product_id': '123', 'name': 'Example', 'sku': 'SKU-1',
                       'url': 'https://www.vooglam.com/goods-detail/123',
                       'jobs': [{'lens_type': name, 'technology': 'Standard Lenses', 'material': 'auto'}
                                for name in ('Standard Lenses', 'Blue Light Blocking', 'Driving Lenses')]}
            (monitor / 'config.json').write_text(json.dumps({'products': [product]}), encoding='utf-8')
            screenshot, body = root / 'cart.png', root / 'cart.txt'
            screenshot.write_bytes(b'image')
            body.write_text('cart', encoding='utf-8')
            rows = [dict(product_id='123', sku='SKU-1', currency='USD', source_url=product['url'],
                         lens_path=name, technology='Standard Lenses', material='未经过材料页',
                         cart_configuration=name, frame_price='50', lens_price='10', total='60',
                         observed_at='2026-09-29T11:00:00+08:00', evidence=str(screenshot),
                         evidence_text=str(body)) for name in ('Standard Lenses', 'Blue Light Blocking', 'Driving Lenses')]
            request = [{'merchant': 'Vooglam', 'product': 'Example', 'url': product['url']}]
            archive(monitor / 'history.sqlite3', rows[:2], SCENARIO, 'first')
            self.assertEqual(find_reusable(request, 'classic', monitor, '2026-09-29')[0], {})
            archive(monitor / 'history.sqlite3', rows[2:], SCENARIO, 'second')
            cached, warnings = find_reusable(request, 'classic', monitor, '2026-09-29')
            self.assertFalse(warnings)
            self.assertEqual(len(cached[product['url']]['today_rows']), 3)
            exported = write_reused_source(cached, root / 'reused.json', '2026-09-29')
            self.assertEqual(exported['history'][0]['observed_at'], '2026-09-29T11:00:00+08:00')
            self.assertTrue((root / exported['history'][0]['evidence']).is_file())
            self.assertEqual(find_reusable(request, 'classic', monitor, '2026-09-30')[0], {})
            self.assertEqual(find_reusable(request, 'full', monitor, '2026-09-29')[0], {})
            screenshot.unlink()
            self.assertEqual(find_reusable(request, 'classic', monitor, '2026-09-29')[0], {})


if __name__ == '__main__':
    unittest.main()

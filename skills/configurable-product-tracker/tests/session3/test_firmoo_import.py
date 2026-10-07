from pathlib import Path
import unittest

from normalization.firmoo import import_firmoo_prices


ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / 'scripts/firmoo_secondary_prices/firmoo_prices.json'


@unittest.skipUnless(SOURCE.is_file(), 'Firmoo verified export unavailable')
class FirmooImport(unittest.TestCase):
    def test_verified_market_currency_and_evidence(self):
        result = import_firmoo_prices(SOURCE)
        prices = [r for r in result['records'] if r['entity_type'] == 'price_observation']
        self.assertEqual(len(prices), 55)
        self.assertEqual({(r['market'],r['currency']) for r in prices}, {('US','USD'),('UK','GBP')})
        self.assertTrue(all(r['complete_pair_price'] is None for r in prices))
        self.assertTrue(all(e['snapshot_exists'] for e in result['evidence']))
        self.assertEqual({e['source_type'] for e in result['evidence']},
                         {'product_screenshot', 'configuration_screenshot', 'cart_screenshot'})
        products = [r for r in result['records'] if r['entity_type'] == 'product']
        self.assertEqual(len({r['product_id'] for r in products}), 3)
        self.assertTrue(all(Path(r['thumbnail_ref']).name == 'product_frame.png' and
                            Path(r['thumbnail_ref']).is_file() for r in products))
        self.assertEqual([flag['code'] for flag in result['quality_flags']],
                         ['invalid_cart_or_product', 'invalid_cart_or_product'])


if __name__ == '__main__':
    unittest.main()

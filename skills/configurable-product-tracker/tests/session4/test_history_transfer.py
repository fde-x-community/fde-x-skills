import json
from contextlib import closing
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts' / 'monitoring'))
from history import archive, SCENARIO
from transfer_history import export_bundle, import_bundle


class HistoryTransferTest(unittest.TestCase):
    def test_import_merges_existing_history_and_copies_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            old, new = root / 'old', root / 'new'
            old.mkdir()
            new.mkdir()
            screenshot, body = old / 'cart.png', old / 'cart.txt'
            screenshot.write_bytes(b'cart screenshot')
            body.write_text('cart price', encoding='utf-8')

            def row(pid, date):
                return {'product_id': pid, 'sku': 'SKU-' + pid, 'currency': 'USD',
                        'lens_path': 'Standard Lenses', 'technology': 'Standard Lenses',
                        'material': '未经过材料页', 'cart_configuration': 'Standard Lenses',
                        'frame_price': '50', 'lens_price': '10', 'total': '60',
                        'observed_at': date + 'T11:00:00+08:00',
                        'evidence': str(screenshot), 'evidence_text': str(body)}

            archive(old / 'history.sqlite3', [row('111', '2026-09-27')], SCENARIO, 'old')
            archive(new / 'history.sqlite3', [row('222', '2026-09-29')], SCENARIO, 'new')
            (old / 'config.json').write_text(json.dumps({'products': [{'product_id': '111'}]}), encoding='utf-8')
            (new / 'config.json').write_text('new monitoring config', encoding='utf-8')
            bundle = root / 'transfer.zip'
            self.assertEqual(export_bundle(old / 'history.sqlite3', bundle, old / 'config.json')['observations'], 1)
            screenshot.unlink()
            body.unlink()
            result = import_bundle(bundle, new / 'history.sqlite3')
            self.assertEqual(result['imported'], 1)
            self.assertTrue(Path(result['history_view_config']).is_file())
            self.assertEqual((new / 'config.json').read_text(encoding='utf-8'), 'new monitoring config')
            with closing(sqlite3.connect(new / 'history.sqlite3')) as db:
                saved = [json.loads(item[0]) for item in db.execute('SELECT payload FROM prices')]
            self.assertEqual({item['product_id'] for item in saved}, {'111', '222'})
            imported = next(item for item in saved if item['product_id'] == '111')
            self.assertTrue(Path(imported['evidence']).is_file())
            self.assertEqual(import_bundle(bundle, new / 'history.sqlite3')['duplicates'], 1)


if __name__ == '__main__':
    unittest.main()

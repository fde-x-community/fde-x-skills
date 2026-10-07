import unittest
from pathlib import Path

from normalization import import_five_product_prices
from analytics import analyze


SOURCE = Path(__file__).resolve().parents[2] / "scripts" / "vooglam_products" / "five_product_prices.json"


class VooglamImportTests(unittest.TestCase):
    def test_real_export_counts_arithmetic_and_evidence(self):
        dataset = import_five_product_prices(SOURCE)
        bundle = analyze(dataset)
        metrics = {m["metric"]: m for m in bundle["metrics"]}
        self.assertEqual(metrics["observed_product_count"]["value"], 3)
        self.assertEqual(metrics["public_variant_count"]["value"], 3)
        self.assertEqual(metrics["observed_quoted_configuration_count"]["value"], 81)
        self.assertEqual(metrics["observed_min_quoted_subtotal"]["value"], "90.00")
        self.assertEqual(metrics["observed_max_quoted_subtotal"]["value"], "330.00")
        self.assertFalse(any(f["code"] in {"price_arithmetic_mismatch", "evidence_file_missing", "missing_evidence"}
                             for f in dataset["quality_flags"]))
        prices = [r for r in dataset["records"] if r["entity_type"] == "price_observation"]
        self.assertEqual(len(prices), 81)
        self.assertTrue(all(r["complete_pair_price"] is None for r in prices))
        self.assertEqual(len(dataset["coverage"]["excluded"]), 2)
        self.assertTrue(all(m["evidence_ids"] for m in bundle["metrics"]))


if __name__ == "__main__":
    unittest.main()

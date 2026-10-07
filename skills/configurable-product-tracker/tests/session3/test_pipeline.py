import tempfile
import unittest

from normalization import normalize
from analytics import analyze, compare_prices, percent_change, percentage_point_change
from storage import SnapshotStore


class Session3Tests(unittest.TestCase):
    def test_normalize_and_analyze_synthetic(self):
        envelope = {"brand": "Example", "market": "US", "source_kind": "synthetic_fixture",
                    "source_url_or_ref": "fixture:session3", "evidence_id": "ev1",
                    "observed_at": "2026-09-25T00:00:00Z", "status": "ok"}
        batch = {"records": [dict(envelope, record_id="p1", entity_type="product", product_id="p"),
                             dict(envelope, record_id="v1", entity_type="variant", variant_id="v")],
                 "evidence": [{"evidence_id": "ev1", "source_url_or_ref": "fixture:session3"}],
                 "coverage": {"requested_scope": "one synthetic product", "observed_scope": "one"}}
        result = analyze(normalize(batch))
        self.assertEqual([m["value"] for m in result["metrics"]], [1, 1, 0])
        self.assertEqual(result["findings"], [])

    def test_price_comparison_boundaries(self):
        base = {"product_id": "p", "variant_id": "v", "lens_config_id": "l", "market": "US",
                "currency": "USD", "eligibility": "public", "pair_basis": "pair",
                "tax_included": False, "shipping_included": False, "source_kind": "synthetic_fixture",
                "status": "ok", "complete_pair_price": "100", "evidence_id": "old"}
        new = dict(base, complete_pair_price="125", evidence_id="new")
        self.assertEqual(compare_prices(new, base)["value"], "25.00")
        self.assertEqual(compare_prices(dict(new, eligibility="member"), base)["status"], "incomparable")
        self.assertEqual(compare_prices(new, None)["reason"], "no_comparable_history")
        self.assertEqual(percent_change("5", "0")["reason"], "zero_baseline")
        self.assertEqual(percentage_point_change("35", "30")["value"], "5")

    def test_snapshots_preserve_revisions_and_separate_synthetic(self):
        with tempfile.TemporaryDirectory() as temp:
            store = SnapshotStore(temp)
            record = {"record_id": "a", "observed_at": "2026-09-25T00:00:00Z",
                      "source_kind": "synthetic_fixture", "product_id": "p"}
            self.assertEqual(store.append(record)["revision"], 1)
            self.assertEqual(store.append(record)["revision"], 2)
            self.assertEqual(len(store.query(kind="synthetic_fixture", product_id="p")), 2)
            self.assertEqual(store.query(kind="public_observation"), [])


if __name__ == "__main__":
    unittest.main()

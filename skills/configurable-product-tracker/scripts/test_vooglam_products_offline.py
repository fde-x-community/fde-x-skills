"""Product isolation and identity extraction, no browser or network."""
import ast
import json
from pathlib import Path
import re
import tempfile
import unittest
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent


def functions(filename, names, namespace):
    tree = ast.parse((ROOT / filename).read_text(encoding="utf-8"))
    exec(compile(ast.Module(body=[n for n in tree.body if isinstance(n, ast.FunctionDef)
                                 and n.name in names], type_ignores=[]), filename, "exec"), namespace)


class ProductChecks(unittest.TestCase):
    def test_product_caches_are_separate_and_identity_checked(self):
        with tempfile.TemporaryDirectory() as directory:
            ns = {"Path": Path, "re": re, "json": json, "urlsplit": urlsplit,
                  "__file__": str(Path(directory) / "collector.py")}
            functions("vooglam_lens_tree.py", {"configure_product", "load_master"}, ns)
            first = "https://www.vooglam.com/goods-detail/9999"
            second = "https://www.vooglam.com/goods-detail/9990"
            ns["configure_product"](first)
            first_path = ns["MASTER_PATH"]
            first_path.write_text(json.dumps({"product_url": first}), encoding="utf-8")
            ns["configure_product"](second)
            self.assertNotEqual(first_path, ns["MASTER_PATH"])
            self.assertEqual(ns["load_master"]()["product_url"], second)
            ns["MASTER_PATH"] = first_path
            with self.assertRaises(ValueError):
                ns["load_master"]()
            with self.assertRaises(ValueError):
                ns["configure_product"]("https://example.org/goods-detail/9999")

    def test_real_identity_prices_and_scopes(self):
        ns = {"Path": Path, "re": re}
        functions("vooglam_product_probe.py", {"enrich_identity"}, ns)
        for pid, mode, amount, category in (("9999", "select_lenses", "110.00", "eyeglasses"),
                                            ("9990", "select_lenses", "100.00", "eyeglasses"),
                                            ("10002", "ready_made", "100.00", "sunglasses"),
                                            ("10003", "select_lenses", "80.00", "eyeglasses"),
                                            ("10262", "ready_made", "90.00", "sunglasses")):
            with self.subTest(product=pid):
                master = json.loads((ROOT / "vooglam_products" / pid / "vooglam_lens_tree_master.json").read_text(encoding="utf-8"))
                identity = ns["enrich_identity"](master["product_identity"])
                self.assertEqual(identity["purchase_mode"], mode)
                self.assertEqual(identity["product_page_price"]["amount"], amount)
                self.assertTrue(identity["product_page_price"]["matches_visible_headline"])
                self.assertEqual(identity["product_type"], category)
                self.assertEqual(identity["scope_status"],
                                 "unsupported_product_type" if category == "sunglasses" else "in_scope")

    def test_report_rows_have_local_cart_evidence(self):
        from urllib.parse import unquote
        from vooglam_five_product_report import OUT, collect
        report = collect()
        self.assertEqual(len(report["products"]), 3)
        self.assertEqual({p["product_id"] for p in report["excluded_products"]}, {"10002", "10262"})
        self.assertTrue(report["observations"])
        for row in report["observations"]:
            with self.subTest(product=row["product_id"], path=row["lens_path"]):
                self.assertIsNotNone(row["evidence"])
                self.assertTrue((OUT / unquote(row["evidence"])).is_file())
                self.assertIsNotNone(row["evidence_text"])
                self.assertTrue((OUT / unquote(row["evidence_text"])).is_file())
        excluded_ids = {p["product_id"] for p in report["excluded_products"]}
        self.assertFalse(excluded_ids.intersection(row["product_id"] for row in report["observations"]))


if __name__ == "__main__":
    unittest.main()

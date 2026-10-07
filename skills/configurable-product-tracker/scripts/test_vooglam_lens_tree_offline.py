"""Offline regression checks; no browser import or network required."""
import ast
from copy import deepcopy
from decimal import Decimal
from pathlib import Path
import re
import unittest

SCRIPT = Path(__file__).with_name("vooglam_lens_tree.py")
tree = ast.parse(SCRIPT.read_text(encoding="utf-8"))
namespace = {"deepcopy": deepcopy, "Decimal": Decimal, "re": re}
names = {"clean", "parse_cart_item_prices", "preserve_observation", "parse_material_options"}
exec(compile(ast.Module(body=[node for node in tree.body
                            if isinstance(node, ast.FunctionDef) and node.name in names],
                        type_ignores=[]), str(SCRIPT), "exec"), namespace)


class RegressionTests(unittest.TestCase):
    def test_failed_attempt_preserves_verified_price(self):
        existing = {"Advanced Lenses": {"technology": "Advanced Lenses",
                                       "success": True, "lens_price": "30.00"}}
        namespace["preserve_observation"](existing, {
            "technology": "Advanced Lenses", "success": False, "error": "timeout"})
        self.assertTrue(existing["Advanced Lenses"]["success"])
        self.assertEqual(existing["Advanced Lenses"]["lens_price"], "30.00")
        self.assertEqual(len(existing["Advanced Lenses"]["failed_attempts"]), 1)

    def test_real_cart_evidence_not_loading_summary(self):
        path = SCRIPT.parent / "vooglam_lens_tree/run_20260925_115040/single_vision__photochromic__standard_photochromic__standard_lenses.txt"
        result = namespace["parse_cart_item_prices"](path.read_text(encoding="utf-8"))
        self.assertEqual(result["cart_price_status"], "ok")
        self.assertEqual(result["frame_price"], "65.00")
        self.assertEqual(result["lens_price"], "55.00")
        self.assertEqual(result["item_total_before_coupon"], "120.00")

    def test_missing_cart_not_zero_price(self):
        self.assertEqual(namespace["parse_cart_item_prices"]("Order Summary\n$0.00")[
            "cart_price_status"], "unavailable")

    def test_cart_without_parsed_price_does_not_replace_verified_total(self):
        existing = {"Advanced Lenses": {"technology": "Advanced Lenses", "success": True,
                    "reached_stage": "Cart", "item_total_before_coupon": "140.00"}}
        namespace["preserve_observation"](existing, {"technology": "Advanced Lenses",
            "success": True, "reached_stage": "Cart", "cart_price_status": "unavailable"})
        self.assertEqual(existing["Advanced Lenses"]["item_total_before_coupon"], "140.00")
        self.assertEqual(len(existing["Advanced Lenses"]["incomplete_attempts"]), 1)

    def test_new_success_preserves_history(self):
        existing = {"Standard Lenses": {"technology": "Standard Lenses",
                                       "success": True, "lens_price": "55.00"}}
        namespace["preserve_observation"](existing, {
            "technology": "Standard Lenses", "success": True, "lens_price": "60.00"})
        self.assertEqual(existing["Standard Lenses"]["history"][0]["lens_price"], "55.00")

    def test_material_variants_are_kept_separately(self):
        existing = {}
        for material, price in (("Standard Material", "140.00"), ("MR™ Pro", "160.00")):
            namespace["preserve_observation"](existing, {
                "technology": "Advanced Lenses", "success": True,
                "selected_material": {"name": material}, "item_total_before_coupon": price})
        variants = existing["Advanced Lenses"]["material_variants"]
        self.assertEqual(variants["Standard Material"]["item_total_before_coupon"], "140.00")
        self.assertEqual(variants["MR™ Pro"]["item_total_before_coupon"], "160.00")

    def test_no_inferred_material_prices(self):
        self.assertEqual(namespace["parse_material_options"]("Select Material\nMR™ Pro\nUnknown"), [])

    def test_real_material_prices_are_path_specific(self):
        path = SCRIPT.parent / "vooglam_lens_tree/run_20260925_115913/single_vision__photochromic__standard_photochromic__advanced_lenses__material.txt"
        options = namespace["parse_material_options"](path.read_text(encoding="utf-8"))
        self.assertEqual({item["name"]: item["additional_price"] for item in options},
                         {"MR™ Pro": "20.00", "Standard Material": "0.00"})

    def test_real_material_cart_totals(self):
        for run, lens, total in (("135025", "75.00", "140.00"),
                                 ("135133", "95.00", "160.00")):
            with self.subTest(run=run):
                path = SCRIPT.parent / f"vooglam_lens_tree/run_20260925_{run}/single_vision__photochromic__standard_photochromic__advanced_lenses.txt"
                result = namespace["parse_cart_item_prices"](path.read_text(encoding="utf-8"))
                self.assertEqual(result["cart_price_status"], "ok")
                self.assertEqual(result["lens_price"], lens)
                self.assertEqual(result["item_total_before_coupon"], total)


if __name__ == "__main__":
    unittest.main()

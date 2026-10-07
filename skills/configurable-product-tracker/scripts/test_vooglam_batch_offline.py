"""Offline batch cache boundaries and evidence/price consistency checks."""
import ast
from decimal import Decimal
import json
from pathlib import Path
import unittest

ROOT = Path(__file__).resolve().parent
parsed = ast.parse((ROOT / "vooglam_incremental_batch.py").read_text(encoding="utf-8"))
ns = {"json": json}
exec(compile(ast.Module(body=[n for n in parsed.body if isinstance(n, ast.FunctionDef)
                             and n.name in ("node_for_job", "complete", "observed_jobs")], type_ignores=[]),
             "batch-cache-test", "exec"), ns)


class BatchChecks(unittest.TestCase):
    def test_requested_but_unoffered_technology_is_not_an_observed_option(self):
        master = {"branches": {"Single Vision": {"details": {"Standard Lenses": {
            "lens_technology_options": [{"name": "Standard Lenses"}],
            "technology_observations": [{"technology": "Not Offered", "success": False, "price": None}]
        }}}}}
        jobs = ns["observed_jobs"](master, [{"lens_type": "Standard Lenses"}])
        self.assertEqual(jobs, [{"lens_type": "Standard Lenses", "technology": "Standard Lenses", "material": "auto"}])

    def test_observed_planner_finds_failed_siblings_after_default_is_complete(self):
        default = {"technology": "Standard Lenses", "success": True, "cart_price_status": "ok", "selected_material": None}
        failed = {"technology": "Advanced Lenses", "success": False,
                  "material_options": [{"name": "Standard Material"}, {"name": "MR™ Pro"}]}
        master = {"branches": {"Single Vision": {"details": {"Photochromic": {"children": {
            "Child": {"technology_options": [{"name": "Standard Lenses"}, {"name": "Advanced Lenses"}],
                      "technology_observations": [default, failed]}}}}}}}
        seeds = [{"lens_type": "Photochromic", "child": "Child"}, {"lens_type": "Unobserved"}]
        jobs = ns["observed_jobs"](master, seeds)
        remaining = [j for j in jobs if not ns["complete"](master, j)]
        self.assertEqual(len(remaining), 4)
        self.assertEqual({j["material"] for j in remaining if j.get("technology") == "Advanced Lenses"},
                         {"auto", "Standard Material", "MR™ Pro"})
        self.assertIn({"lens_type": "Unobserved", "material": "auto"}, remaining)
        self.assertEqual(len(jobs), len({json.dumps(j, sort_keys=True) for j in jobs}))

    def test_retry_can_skip_success_that_did_not_traverse_material(self):
        obs = {"technology": "Standard Lenses", "success": True, "cart_price_status": "ok",
               "selected_material": None}
        master = {"branches": {"Single Vision": {"details": {"Standard Lenses": {
            "technology_observations": [obs]}}}}}
        self.assertTrue(ns["complete"](master, {"lens_type": "Standard Lenses", "technology": "Standard Lenses"}))

    def test_cache_does_not_confuse_materials(self):
        # Synthetic fixture used only for cache behavior, never live data.
        obs = {"technology": "Advanced Lenses", "success": True, "cart_price_status": "ok",
               "selected_material": {"name": "MR™ Pro"}}
        master = {"branches": {"Single Vision": {"details": {"Photochromic": {
            "children": {"Child": {"technology_options": [{"name": "Advanced Lenses"}],
                                   "technology_observations": [obs]}}}}}}}
        job = {"lens_type": "Photochromic", "child": "Child", "technology": "Advanced Lenses"}
        self.assertFalse(ns["complete"](master, job))
        obs["material_variants"] = {"Standard Material": {
            "success": True, "cart_price_status": "ok", "selected_material": {"name": "Standard Material"}}}
        self.assertTrue(ns["complete"](master, job))
        self.assertFalse(ns["complete"](master, {**job, "material": "MR™ Pro"}))

    def test_real_successes_reconcile_and_have_evidence(self):
        count = 0
        for path in (ROOT / "vooglam_lens_tree").glob("batch_*/path_*/final_result.json"):
            result = json.loads(path.read_text(encoding="utf-8"))
            for detail in result.get("data", {}).get("details", []):
                for obs in detail.get("child_technology_observations", []) + detail.get("technology_observations", []):
                    if obs.get("cart_price_status") != "ok":
                        continue
                    with self.subTest(path=str(path)):
                        count += 1
                        self.assertEqual(obs["reached_stage"], "Cart")
                        material = Decimal(obs.get("selected_material", {}).get("additional_price", "0"))
                        self.assertEqual(Decimal(str(obs["price"])) + material, Decimal(obs["lens_price"]))
                        self.assertEqual(Decimal(obs["frame_price"]) + Decimal(obs["lens_price"]),
                                         Decimal(obs["item_total_before_coupon"]))
                        self.assertTrue(Path(obs["evidence"]["screenshot"]).is_file())
                        self.assertTrue(Path(obs["evidence"]["text"]).is_file())
        self.assertGreater(count, 0)


if __name__ == "__main__":
    unittest.main()

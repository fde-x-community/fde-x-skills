import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from contextlib import closing
from history import archive, config_key
import os
import sys
import time
from monitor import command_run
from unittest.mock import patch
import setup_config
from build_report import build


def row(at, total="120.00", lens="10.00", material="未经过材料页"):
    return {"product_id": "9999", "sku": "silver-sku", "lens_path": "Standard Lenses",
            "technology": "Standard Lenses", "material": material, "cart_configuration": "1.56 clear",
            "currency": "USD", "observed_at": at, "frame_price": "110.00", "lens_price": lens,
            "total": total, "evidence": "cart.png", "evidence_text": "cart.txt"}


class MonitorTests(unittest.TestCase):
    def test_child_timeout_and_failed_exit_are_task_failures(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            started = time.monotonic()
            with self.assertRaisesRegex(RuntimeError, "超时"):
                command_run([sys.executable, "-c", "import time;time.sleep(10)"], root,
                            root / "timeout.log", 0.2, dict(os.environ))
            self.assertLess(time.monotonic() - started, 5)
            with self.assertRaisesRegex(RuntimeError, "退出码 7"):
                command_run([sys.executable, "-c", "raise SystemExit(7)"], root,
                            root / "failure.log", 10, dict(os.environ))

    def test_new_time_is_history_even_when_price_unchanged_and_replay_deduplicated(self):
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / "history.db"
            a, b = row("2026-09-25T11:00:00+08:00"), row("2026-09-27T11:00:00+08:00")
            self.assertEqual(archive(database, [a], {"rx": "zero"}, "one")[0]["status"], "no_comparable_history")
            result = archive(database, [b], {"rx": "zero"}, "two")[0]
            self.assertEqual(result["difference"], "0.00")
            archive(database, [b], {"rx": "zero"}, "two_retry")
            with closing(sqlite3.connect(database)) as db:
                self.assertEqual(db.execute("SELECT count(*) FROM prices").fetchone()[0], 2)

    def test_material_or_prescription_change_cannot_match_baseline(self):
        a = row("2026-09-25T11:00:00+08:00")
        self.assertNotEqual(config_key(a, {"rx": "zero"}), config_key(a, {"rx": "minus1"}))
        b = row("2026-09-27T11:00:00+08:00", material="MR Pro")
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / "history.db"
            archive(database, [a], {}, "one")
            self.assertEqual(archive(database, [b], {}, "two")[0]["status"], "no_comparable_history")

    def test_price_change_and_arithmetic_validation(self):
        with tempfile.TemporaryDirectory() as folder:
            database = Path(folder) / "history.db"
            archive(database, [row("2026-09-25T11:00:00+08:00")], {}, "one")
            result = archive(database, [row("2026-09-27T11:00:00+08:00", "132.00", "22.00")], {}, "two")[0]
            self.assertEqual(result["difference"], "12.00")
            self.assertEqual(result["change_percent"], "10.0")
            with self.assertRaises(ValueError):
                archive(database, [row("2026-09-28T11:00:00+08:00", "999.00")], {}, "bad")

    def test_fixed_list_has_no_sunglasses(self):
        config = json.loads(Path(__file__).with_name("config.example.json").read_text(encoding="utf-8"))
        self.assertEqual({p["product_id"] for p in config["products"]}, {"9999", "9990", "10003"})
        self.assertEqual(sum(len(p["jobs"]) for p in config["products"]), 81)
        self.assertEqual(config["retry_minutes"], 30)

    def test_append_requires_consent_and_preserves_existing_monitoring(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            evidence = root / "cart.txt"
            evidence.write_text("verified cart", encoding="utf-8")
            old = {"product_id": "9999", "name": "Okinawa", "sku": "silver-sku", "url": "old-url", "jobs": [{"lens_type": "Standard Lenses"}]}
            initial = {"products": [old], "daily_time": "11:00", "browser_channel": "chrome"}
            (root / "config.json").write_text(json.dumps(initial), encoding="utf-8")
            observed = {**row("2026-09-27T11:00:00+08:00"), "product_id": "9253", "evidence": "cart.txt", "evidence_text": "cart.txt"}
            source = root / "new.json"
            source.write_text(json.dumps({"products": [{"product_id": "9253", "name": "Spine", "sku": "silver-sku", "url": "new-url", "purchase_mode": "select_lenses"}], "observations": [observed]}), encoding="utf-8")
            argv = ["setup_config.py", "--source", str(source), "--append"]
            with patch.object(setup_config, "ROOT", root), patch.object(sys, "argv", argv):
                with self.assertRaises(SystemExit):
                    setup_config.main()
            self.assertFalse((root / "history.sqlite3").exists())
            with patch.object(setup_config, "ROOT", root), patch.object(sys, "argv", argv + ["--consent"]):
                setup_config.main()
            result = json.loads((root / "config.json").read_text(encoding="utf-8"))
            self.assertEqual(result["products"][0], old)
            self.assertEqual(result["browser_channel"], "chrome")
            self.assertEqual(result["products"][1]["product_id"], "9253")

    def test_report_compares_previous_day_and_preserves_evidence(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            evidence = root / "cart.txt"
            evidence.write_text("verified cart", encoding="utf-8")
            records = [{**row(at), "product": "Okinawa", "evidence": str(evidence), "evidence_text": str(evidence)}
                       for at in ("2026-09-25T11:00:00+08:00", "2026-09-27T11:00:00+08:00", "2026-09-27T12:00:00+08:00")]
            archive(root / "history.sqlite3", records, {}, "test")
            config = root / "config.json"
            config.write_text(json.dumps({"products": [{"product_id": "9999", "name": "Okinawa", "sku": "silver-sku", "url": "product-url", "jobs": [{}]}]}), encoding="utf-8")
            data = build(config, root / "history.sqlite3", root / "report")
            latest = data["observations"][0]
            self.assertEqual(latest["previous_day_observation"]["observed_at"], records[0]["observed_at"])
            self.assertEqual(data["history_count"], 3)
            self.assertTrue((root / "report" / latest["evidence"]).is_file())


if __name__ == "__main__":
    unittest.main()

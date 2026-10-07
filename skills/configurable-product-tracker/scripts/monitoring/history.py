"""Append-only, configuration-bound price observations; no browser dependency."""
import hashlib
import json
import sqlite3
from contextlib import closing
from decimal import Decimal
from pathlib import Path


SCENARIO = {"market": "US", "vision": "Single Vision", "od_sph": "0.00", "od_cyl": "0.00",
            "os_sph": "0.00", "os_cyl": "0.00", "pd": "66.00", "price_basis": "pre_discount",
            "color_policy": "original_verified_default"}


def config_key(row, scenario):
    fields = {key: row.get(key) for key in ("product_id", "sku", "lens_path", "technology",
                                           "material", "cart_configuration", "currency")}
    fields["scenario"] = scenario
    return hashlib.sha256(json.dumps(fields, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def archive(database, rows, scenario, run_id):
    Path(database).parent.mkdir(parents=True, exist_ok=True)
    comparisons = []
    with closing(sqlite3.connect(database)) as db, db:
        db.execute("CREATE TABLE IF NOT EXISTS prices (observation_id TEXT PRIMARY KEY, config_key TEXT, "
                   "observed_at TEXT, run_id TEXT, total TEXT, payload TEXT)")
        db.execute("CREATE INDEX IF NOT EXISTS config_time ON prices(config_key, observed_at)")
        for row in rows:
            if not row.get("observed_at") or not row.get("evidence"):
                raise ValueError("Historical observation requires original time and evidence")
            total = Decimal(row["total"])
            if Decimal(row["frame_price"]) + Decimal(row["lens_price"]) != total:
                raise ValueError("Price components do not match")
            key = config_key(row, scenario)
            identity = {"key": key, "observed_at": row["observed_at"],
                        "frame": row["frame_price"], "lens": row["lens_price"], "total": row["total"]}
            oid = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
            prior = db.execute("SELECT observed_at,total,payload FROM prices WHERE config_key=? "
                               "AND observed_at < ? ORDER BY observed_at DESC LIMIT 1",
                               (key, row["observed_at"])).fetchone()
            comparison = {"config_key": key, "product_id": row["product_id"],
                          "lens_path": row["lens_path"], "technology": row["technology"],
                          "material": row["material"], "observed_at": row["observed_at"],
                          "current_total": row["total"], "price_basis": "quoted_pre_discount_subtotal"}
            if prior:
                old = Decimal(prior[1])
                comparison.update(baseline_at=prior[0], baseline_total=prior[1],
                                  difference=str(total-old),
                                  change_percent=str((total-old)/old*100) if old else None,
                                  status="ok" if old else "zero_baseline",
                                  baseline_evidence=json.loads(prior[2]).get("evidence"))
            else:
                comparison.update(status="no_comparable_history")
            db.execute("INSERT OR IGNORE INTO prices VALUES (?,?,?,?,?,?)",
                       (oid, key, row["observed_at"], run_id, row["total"],
                        json.dumps(row, ensure_ascii=False, sort_keys=True)))
            comparisons.append(comparison)
    return comparisons

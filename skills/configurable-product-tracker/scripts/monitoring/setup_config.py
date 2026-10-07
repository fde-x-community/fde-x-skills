"""Build an explicitly enabled fixed monitor list from verified cart observations."""
from datetime import datetime
import argparse
import json
from pathlib import Path
from history import archive
from monitor import SCENARIO

ROOT = Path(__file__).resolve().parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--source", required=True, type=Path, help="Verified real collection prices JSON, not a replay substitute")
    parser.add_argument("--consent", action="store_true", help="Only pass after user agreed to monitoring")
    parser.add_argument("--append", action="store_true", help="Add verified jobs after new monitoring consent; preserve existing jobs")
    parser.add_argument("--channel", choices=("chromium", "chrome", "msedge"), default="chromium")
    args = parser.parse_args()
    if not args.consent:
        parser.error("Monitoring consent is required; no task or config was created")
    source = args.source.resolve()
    target = ROOT / "config.json"
    if target.exists() and not args.append:
        raise RuntimeError("Existing monitor configuration is preserved; edit it explicitly")
    if args.append and not target.exists():
        raise RuntimeError("No existing monitor configuration to append to")
    data = json.loads(source.read_text(encoding="utf-8"))
    products, baseline = [], []
    for product in data["products"]:
        if product["purchase_mode"] != "select_lenses":
            continue
        rows = [r for r in data["observations"] if r["product_id"] == product["product_id"]]
        jobs = []
        for row in rows:
            components = row["lens_path"].split(" → ", 1)
            job = {"lens_type": components[0], "technology": row["technology"],
                   "material": "auto" if row["material"] == "未经过材料页" else row["material"]}
            if len(components) == 2:
                job["child"] = components[1]
            if job not in jobs:
                jobs.append(job)
            original = dict(row)
            from urllib.parse import unquote
            original["evidence"] = str(source.parent / unquote(row["evidence"]))
            original["evidence_text"] = str(source.parent / unquote(row["evidence_text"]))
            if not Path(original["evidence"]).is_file() or not Path(original["evidence_text"]).is_file():
                raise ValueError("Baseline evidence is missing for " + row["product_id"])
            baseline.append(original)
        if jobs:
            products.append({"product_id": product["product_id"], "name": product["name"],
                             "sku": product["sku"], "url": product["url"], "jobs": jobs})
            if product.get("bestseller_source"):
                products[-1]["bestseller_source"] = product["bestseller_source"]
    if not products or not baseline:
        raise ValueError("No supported verified eyeglasses configurations in source")
    config = {"enabled_by_user_request_at": datetime.now().astimezone().isoformat(),
              "source_prices": str(source), "browser_channel": args.channel,
              "daily_time": "11:00", "timezone": "Windows local time (Asia/Shanghai expected)",
              "retry_minutes": 30, "retry_count": 3, "identity_timeout_seconds": 240,
              "product_timeout_seconds": 1800, "products": products}
    if args.append:
        config = json.loads(target.read_text(encoding="utf-8"))
        for product in products:
            existing = next((p for p in config["products"] if p["product_id"] == product["product_id"]), None)
            if existing:
                if any(existing[k] != product[k] for k in ("name", "sku", "url")):
                    raise ValueError("Existing product identity differs: " + product["product_id"])
                for job in product["jobs"]:
                    if job not in existing["jobs"]:
                        existing["jobs"].append(job)
                if product.get("bestseller_source"):
                    existing["bestseller_source"] = product["bestseller_source"]
            else:
                config["products"].append(product)
        config.setdefault("monitoring_authorizations", []).append({
            "consented_at": datetime.now().astimezone().isoformat(), "source_prices": str(source),
            "product_ids": [p["product_id"] for p in products]})
    archive(ROOT / "history.sqlite3", baseline, SCENARIO, "baseline_import")
    temporary = target.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(config, ensure_ascii=False, indent=2), encoding="utf-8")
    temporary.replace(target)
    print("Monitoring products:", len(config["products"]), "fixed configurations:", sum(len(p["jobs"]) for p in config["products"]))


if __name__ == "__main__":
    main()

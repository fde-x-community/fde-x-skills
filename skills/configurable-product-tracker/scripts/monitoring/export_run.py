"""Export verified script output for monitor enrollment or append-only history."""
import argparse
from datetime import datetime
import importlib.util
import json
from pathlib import Path
from history import archive
from monitor import SCENARIO

ROOT = Path(__file__).resolve().parent


def export(run_dir, save_history=False):
    spec = importlib.util.spec_from_file_location("verified_report", run_dir / "vooglam_five_product_report.py")
    report = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(report)
    selection_path = run_dir / "selection.json"
    selection = json.loads(selection_path.read_text(encoding="utf-8")) if selection_path.exists() else {}
    products, rows, excluded = [], [], []
    for master_path in sorted((run_dir / "vooglam_products").glob("*/vooglam_lens_tree_master.json")):
        master = json.loads(master_path.read_text(encoding="utf-8"))
        identity = master.get("product_identity", {})
        offer = identity.get("product_page_price", {})
        if identity.get("status") != "observed" or not offer.get("matches_visible_headline"):
            excluded.append({"product_id": master_path.parent.name, "reason": "Identity or visible page price not verified"})
            continue
        if identity.get("scope_status") != "in_scope" or identity.get("purchase_mode") != "select_lenses":
            excluded.append({"product_id": master_path.parent.name, "reason": "Unsupported product or purchase mode"})
            continue
        product_rows = report.verified_rows(master, identity)
        if any(not r.get("observed_at") or not r.get("evidence") or not r.get("evidence_text") for r in product_rows):
            raise ValueError("Missing original observation time or cart evidence: " + master_path.parent.name)
        products.append({"product_id": identity["product_id"], "name": identity["name"],
            "sku": identity["product_code"], "url": identity["requested_url"],
            "purchase_mode": identity["purchase_mode"], "color": identity.get("default_color"),
            "page_price": offer["amount"], "verified_configurations": len(product_rows),
            "observed_at": identity["observed_at"],
            "page_evidence": report.relative_evidence(identity["evidence"]["screenshot"])})
        if identity["product_id"] in selection.get("selected_ids", []):
            products[-1]["bestseller_source"] = selection.get("source_url")
        rows.extend(product_rows)
    data = {"generated_at": datetime.now().astimezone().isoformat(), "scope": SCENARIO,
            "products": products, "excluded_products": excluded, "observations": rows, "selection": selection}
    output = run_dir / "vooglam_products" / "verified_prices.json"
    output.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    if save_history:
        from urllib.parse import unquote
        durable = []
        for row in rows:
            durable.append({**row, "evidence": str(output.parent / unquote(row["evidence"])),
                            "evidence_text": str(output.parent / unquote(row["evidence_text"]))})
        archive(ROOT / "history.sqlite3", durable, SCENARIO, run_dir.name)
    print(json.dumps({"output": str(output), "verified_configurations": len(rows),
                      "products": [{"name": p["name"], "count": p["verified_configurations"]} for p in products],
                      "excluded": excluded}, ensure_ascii=False))
    return data


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-dir", required=True, type=Path)
    parser.add_argument("--archive", action="store_true", help="Append verified observations to local history")
    args = parser.parse_args()
    export(args.run_dir.resolve(), args.archive)

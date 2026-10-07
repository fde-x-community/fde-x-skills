"""Rebuild Firmoo multi-product report and audit second-level coverage."""
import argparse
import json
from pathlib import Path
from firmoo_lens_tree import render_report, scoped_children, write_json


def choice_key(path):
    return json.dumps([(step["stage"], step["label"]) for step in path[:2]], ensure_ascii=False)


def restore_interrupted(root):
    """Restore paths saved before restarting an older collector version."""
    candidates = json.loads((root / "restart_paths.json").read_text(encoding="utf-8"))
    repaired = 0
    for name, path in candidates.items():
        master = Path(name)
        batch = json.loads(master.read_text(encoding="utf-8"))
        represented = batch["pending"] + [item["path"] for item in batch["nodes"] + batch["records"] + batch["errors"]]
        if path not in represented:
            batch["pending"].insert(0, path)
            batch["coverage"]["pending_paths"] = len(batch["pending"])
            write_json(master, batch)
            repaired += 1
    return repaired


def build(root, product_id=None):
    root = root.resolve()
    records, products = [], []
    stem = "firmoo_prices" + (f"_{product_id}" if product_id else "")
    previous_path = root / f"{stem}.json"
    previous_products = {}
    if previous_path.is_file():
        previous = json.loads(previous_path.read_text(encoding="utf-8"))
        previous_products = {(p["market"], str(p["product_id"])): p for p in previous.get("products", [])}
    def rebase_proof(proof):
        if not isinstance(proof, dict):
            return
        for field in ("screenshot", "text", "html"):
            old = proof.get(field)
            if not old or Path(old).is_file():
                continue
            parts = Path(old).parts
            if root.name in parts:
                candidate = root.joinpath(*parts[parts.index(root.name) + 1:])
                if candidate.is_file():
                    proof[field] = str(candidate)
    for master in sorted(root.glob("*/*/firmoo_lens_tree_master.json")):
        if product_id and master.parent.name != product_id:
            continue
        batch = json.loads(master.read_text(encoding="utf-8"))
        for item in batch.get("records", []) + batch.get("nodes", []) + batch.get("errors", []):
            proofs = item.get("evidence") or []
            for proof in proofs if isinstance(proofs, list) else [proofs]:
                rebase_proof(proof)
        mode = batch.get("coverage_mode", "all")
        expected = {choice_key(node["path"] + [option])
                    for node in batch["nodes"] if len(node["path"]) == 1
                    for option in scoped_children(node["path"], node["options"], mode)}
        verified = {choice_key(record["path"]) for record in batch["records"]
                    if record["cart_price_status"] == "ok"}
        expected_primary = ({batch["requested_lens_type"]} if batch.get("requested_lens_type") else
                            {option["label"] for node in batch["nodes"] if not node["path"]
                             for option in scoped_children([], node["options"], mode)})
        verified_primary = {record["path"][0]["label"] for record in batch["records"] if record["cart_price_status"] == "ok"}
        coverage = {"market": batch["market"], "product_id": batch["product_id"], "url": batch["url"],
                    "product_name": next((r.get("cart_product_name") for r in batch["records"]), None),
                    "currency": batch["currency"], "coverage_mode": mode,
                    "primary_categories": batch["coverage"]["observed_root_options"],
                    "missing_primary_categories": sorted(expected_primary - verified_primary),
                    "secondary_choices_discovered": len(expected), "secondary_choices_verified": len(expected & verified),
                    "missing_secondary_choices": sorted(expected - verified), "coverage": batch["coverage"]}
        coverage["product_evidence"] = (batch.get("product_evidence") or
                                        previous_products.get((batch["market"], str(batch["product_id"])), {}).get("product_evidence"))
        products.append(coverage)
        records.extend(batch["records"])
        render_report(master.parent / "firmoo_prices.html", batch)
    missing_markets = [{"product_id": product_id, "market": market} for product_id in {p["product_id"] for p in products}
                       for market in ("us", "uk") if not any(p["product_id"] == product_id and p["market"] == market for p in products)]
    summary = {"schema_version": "1.0", "products": products, "records": records,
               "coverage": {"products": len(products), "records": len(records),
                            "verified_records": sum(r["cart_price_status"] == "ok" for r in records),
                            "missing_markets": missing_markets,
                            "complete": bool(products) and not missing_markets and all(p["coverage"]["complete"] and not p["missing_secondary_choices"] and not p["missing_primary_categories"] for p in products)},
               "selection_policy": "Every first and second level option; downstream choices explicitly recorded. Tax, shipping and coupon eligibility not verified."}
    write_json(root / f"{stem}.json", summary)
    render_report(root / f"{stem}.html", summary)
    return summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=Path(__file__).resolve().parent / "firmoo_secondary_prices")
    parser.add_argument("--product-id", help="Build a report for one product ID across markets")
    args = parser.parse_args()
    summary = build(args.input, args.product_id)
    print(json.dumps({"coverage": summary["coverage"], "products": summary["products"]}, ensure_ascii=True))


if __name__ == "__main__":
    main()

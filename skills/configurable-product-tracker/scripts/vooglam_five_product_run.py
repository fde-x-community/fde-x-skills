"""Run isolated product collectors with a small bounded worker pool, no AI calls."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
import json
from pathlib import Path
import subprocess
import sys
from vooglam_product_probe import enrich_identity

ROOT = Path(__file__).resolve().parent


def run_product(url, args):
    product_id = url.rstrip('/').rsplit('/', 1)[-1]
    directory = ROOT / "vooglam_products" / product_id
    directory.mkdir(parents=True, exist_ok=True)
    master_path = directory / "vooglam_lens_tree_master.json"
    if master_path.exists():
        master = json.loads(master_path.read_text(encoding="utf-8"))
        if master.get("product_identity", {}).get("status") != "observed":
            return {"url": url, "status": "identity_not_verified", "master": str(master_path)}
        master["product_identity"] = enrich_identity(master["product_identity"])
        master_path.write_text(json.dumps(master, ensure_ascii=False, indent=2), encoding="utf-8")
    else:
        return {"url": url, "status": "identity_missing"}
    if master["product_identity"].get("scope_status") != "in_scope":
        return {"url": url, "status": master["product_identity"].get("scope_status", "needs_review"),
                "product_type": master["product_identity"].get("product_type"), "master": str(master_path)}
    if master["product_identity"].get("purchase_mode") != "select_lenses":
        return {"url": url, "status": "unsupported_purchase_flow", "master": str(master_path)}
    manifests = sorted((directory / "vooglam_lens_tree").glob("batch_*/batch_manifest.json"))
    command = [sys.executable, "-u", str(ROOT / "vooglam_incremental_batch.py"),
               "--url", url, "--max-paths", str(args.max_paths)]
    previous = json.loads(manifests[-1].read_text(encoding="utf-8")) if manifests else None
    same_scope = (previous and previous.get("pending") and
                  Path(previous.get("seed_file") or "").name == args.seed_file.name and
                  previous.get("no_expand", False) == args.no_expand)
    command += (["--resume", str(manifests[-1])] if same_scope else
                ["--seed-file", str(args.seed_file.resolve())])
    if args.no_expand:
        command.append("--no-expand")
    log = directory / datetime.now().strftime("collector_%Y%m%d_%H%M%S.log")
    print("PRODUCT START", product_id, flush=True)
    with log.open("w", encoding="utf-8") as stream:
        process = subprocess.run(command, cwd=str(ROOT), stdout=stream, stderr=subprocess.STDOUT)
    manifests = sorted((directory / "vooglam_lens_tree").glob("batch_*/batch_manifest.json"))
    result = {"url": url, "exit_code": process.returncode, "log": str(log),
              "manifest": str(manifests[-1]) if manifests else None}
    if manifests:
        batch = json.loads(manifests[-1].read_text(encoding="utf-8"))
        result.update(attempted=len(batch["attempted"]), pending=len(batch["pending"]),
                      price_success=sum(any(o.get("cart_price_status") == "ok" for o in a.get("outcomes", []))
                                        for a in batch["attempted"]))
    print("PRODUCT END", json.dumps(result), flush=True)
    return result


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--workers", type=int, choices=(1, 2, 3), default=2)
    parser.add_argument("--max-paths", type=int, default=60)
    parser.add_argument("--urls", type=Path, default=ROOT / "vooglam_five_urls.json")
    parser.add_argument("--seed-file", type=Path, default=ROOT / "vooglam_comparison_seeds.json")
    parser.add_argument("--no-expand", action="store_true")
    args = parser.parse_args()
    if not args.seed_file.is_file():
        parser.error(f"Seed file not found: {args.seed_file}")
    urls = json.loads(args.urls.read_text(encoding="utf-8"))
    summary = {"started_at": datetime.now().astimezone().isoformat(), "requested_urls": urls,
               "scope": "Single Vision default frame color; selected seed branches" +
                        (" with one selected technology/material each" if args.no_expand else
                         " with observed technologies/materials expanded") +
                        "; excludes Color Tint and other prescriptions",
               "results": []}
    target = ROOT / "vooglam_products" / "five_product_run.json"
    target.parent.mkdir(exist_ok=True)
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [pool.submit(run_product, url, args) for url in urls]
        for future in as_completed(futures):
            summary["results"].append(future.result())
            target.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    summary["finished_at"] = datetime.now().astimezone().isoformat()
    target.write_text(json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8")
    print("DONE", target, flush=True)


if __name__ == "__main__":
    main()

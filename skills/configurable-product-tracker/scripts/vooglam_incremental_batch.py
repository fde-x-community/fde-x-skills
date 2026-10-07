"""Sequential, bounded exploration of observed options using the existing collector.

No checkout. Fresh browser context per configuration. Each result is persisted
before scheduling the next observed option; complete cart paths are skipped.
"""
import argparse
import os
from datetime import datetime
import json
from pathlib import Path
import vooglam_lens_tree as tree


def node_for_job(master, job):
    detail = master.get("branches", {}).get("Single Vision", {}).get("details", {}).get(job["lens_type"], {})
    if job.get("child"):
        detail = detail.get("children", {}).get(job["child"], {})
    return detail


def complete(master, job):
    node = node_for_job(master, job)
    options = node.get("technology_options", node.get("lens_technology_options", []))
    technology = job.get("technology") or (options[0]["name"] if options else None)
    for obs in node.get("technology_observations", []):
        if technology != obs.get("technology"):
            continue
        material = job.get("material", "auto")
        if material == "auto":
            candidate = obs.get("material_variants", {}).get("Standard Material", obs)
            if (candidate.get("selected_material") or {}).get("name") not in (None, "Standard Material"):
                continue
        else:
            candidate = obs.get("material_variants", {}).get(material, {})
        if candidate.get("success") and candidate.get("cart_price_status") == "ok":
            return True
    return False


def observed_jobs(master, seeds):
    """Plan only observed technology/material options; retain unobserved seed probes."""
    jobs, seen = [], set()

    def add(job):
        key = json.dumps(job, sort_keys=True)
        if key not in seen:
            seen.add(key)
            jobs.append(job)

    for seed in seeds:
        node = node_for_job(master, seed)
        options = node.get("technology_options", node.get("lens_technology_options", []))
        observations = node.get("technology_observations", [])
        names = list(dict.fromkeys([o["name"] for o in options] +
            [o["technology"] for o in observations
             if o.get("price") is not None or o.get("cart_price_status") == "ok"]))
        if not names:
            add({**seed, "material": seed.get("material", "auto")})
        for technology in names:
            job = {**seed, "technology": technology, "material": "auto"}
            add(job)
            for observation in observations:
                if observation["technology"] != technology:
                    continue
                records = [observation, *observation.get("material_variants", {}).values()]
                for record in records:
                    for material in record.get("material_options", []):
                        add({**job, "material": material["name"]})
    return jobs


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-paths", type=int, default=20)
    parser.add_argument("--channel", default=os.environ.get("VOOGLAM_BROWSER_CHANNEL", "chrome"))
    parser.add_argument("--resume", type=Path, help="Resume an existing batch_manifest.json")
    parser.add_argument("--url", default=tree.URL)
    parser.add_argument("--seed-file", type=Path, help="Explicit configuration jobs, not prices")
    parser.add_argument("--no-expand", action="store_true", help="Monitor only the supplied fixed configurations")
    parser.add_argument("--plan-remaining", type=Path, help="Write unfinished observed jobs from --seed-file; no browser launch")
    args = parser.parse_args()
    if args.max_paths < 0:
        parser.error('--max-paths must be non-negative; 0 traverses the queued scope')
    tree.configure_product(args.url)
    if args.plan_remaining:
        if not args.seed_file:
            parser.error("--plan-remaining requires --seed-file")
        master = tree.load_master()
        seeds = json.loads(args.seed_file.read_text(encoding="utf-8"))
        pending = [j for j in observed_jobs(master, seeds) if not complete(master, j)]
        args.plan_remaining.write_text(json.dumps(pending, ensure_ascii=False, indent=2), encoding="utf-8")
        print("Unfinished observed jobs:", len(pending), "plan:", args.plan_remaining)
        return
    root = (args.resume.resolve().parent if args.resume else
            tree.MASTER_PATH.parent / "vooglam_lens_tree" / datetime.now().strftime("batch_%Y%m%d_%H%M%S"))
    root.mkdir(parents=True, exist_ok=True)
    master = tree.load_master()
    queue = [
        {"lens_type": "Photochromic", "child": "Standard Photochromic", "technology": "Premium Lenses"},
        {"lens_type": "Photochromic", "child": "Photochromic Blue Light Blocking"},
        *({"lens_type": "Transitions®", "child": child} for child in
          ("Transitions® GEN S™", "Transitions® XTRActive®", "Transitions® XTRActive® Polarized™")),
        *({"lens_type": name} for name in ("Blue Light Blocking", "Polarized Lenses", "Driving Lenses")),
    ]
    attempted, skipped, seen = [], [], set()
    if args.seed_file:
        queue = json.loads(args.seed_file.read_text(encoding="utf-8"))
    if args.resume:
        previous = json.loads(args.resume.read_text(encoding="utf-8"))
        if previous.get("product_url", "https://www.vooglam.com/goods-detail/9667") != tree.URL:
            raise ValueError("Resume manifest belongs to a different product")
        if previous.get("no_expand", False) != args.no_expand:
            raise ValueError("Resume expansion scope differs from saved run")
        queue = previous["pending"]
        attempted, skipped = previous["attempted"], previous["skipped_complete"]
        seen = {json.dumps(item["job"], sort_keys=True) for item in attempted}
        seen.update(json.dumps(job, sort_keys=True) for job in skipped)

    def persist():
        (root / "batch_manifest.json").write_text(json.dumps({
            "script_version": tree.SCRIPT_VERSION, "scope": "Single Vision selected incremental branches",
            "product_url": tree.URL,
            "seed_file": str(args.seed_file) if args.seed_file else
                         (previous.get("seed_file") if args.resume else None),
            "no_expand": args.no_expand,
            "attempted": attempted, "skipped_complete": skipped, "pending": queue,
            "max_paths": args.max_paths,
        }, ensure_ascii=False, indent=2), encoding="utf-8")

    with tree.sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel=args.channel)
        while queue and (not args.max_paths or len(attempted) < args.max_paths):
            job = queue.pop(0)
            job.setdefault("material", "auto")
            key = json.dumps(job, sort_keys=True)
            if key in seen:
                continue
            seen.add(key)
            if complete(master, job):
                skipped.append(job)
                persist()
                continue
            tree.OUT_DIR = root / f"path_{len(attempted)+1:03d}"
            # A stopped run may leave an uncommitted path directory; retry that slot.
            tree.OUT_DIR.mkdir(exist_ok=True)
            context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="en-US")
            page = context.new_page()
            result = {"job": job, "evidence_dir": str(tree.OUT_DIR),
                      "started_at": datetime.now().astimezone().isoformat()}
            print("BATCH START", len(attempted)+1, json.dumps(job, ensure_ascii=False), flush=True)
            try:
                data = tree.crawl_lens_types(page, "Single Vision", focus=job["lens_type"],
                    technology=job.get("technology"), child=job.get("child"),
                    material=job["material"], inspect_material=True,
                    on_detail=lambda name, types, detail: tree.merge_detail(master, name, types, detail))
                result["data"] = data
                for detail in data.get("details", []):
                    options = detail.get("child_lens_technology_options" if job.get("child") else "lens_technology_options", [])
                    obs_list = detail.get("child_technology_observations" if job.get("child") else "technology_observations", [])
                    for option in ([] if args.no_expand else options):
                        queue.append({**job, "technology": option["name"], "material": "auto"})
                    for obs in ([] if args.no_expand else obs_list):
                        for material in obs.get("material_options", []):
                            queue.append({**job, "technology": obs["technology"], "material": material["name"]})
                    result["outcomes"] = [{k: o.get(k) for k in
                        ("technology", "success", "reached_stage", "selected_material", "lens_price",
                         "item_total_before_coupon", "cart_price_status", "error")} for o in obs_list]
            except Exception as exc:
                result["error"] = str(exc)
                try:
                    tree.screenshot(page, "batch_error.png")
                    tree.dump_text(page, "batch_error.txt")
                except Exception:
                    pass
            finally:
                context.close()
            result["finished_at"] = datetime.now().astimezone().isoformat()
            tree.save_json(result, "final_result.json")
            attempted.append({k: v for k, v in result.items() if k != "data"})
            persist()
            print("BATCH END", len(attempted), json.dumps(result.get("outcomes", result.get("error")), ensure_ascii=False), flush=True)
        browser.close()
    persist()
    print("BATCH MANIFEST", root / "batch_manifest.json", flush=True)


if __name__ == "__main__":
    main()

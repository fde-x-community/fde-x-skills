"""Click through Firmoo non-prescription lenses, keeping markets and evidence separate.

No prices are inferred from advertised option prices. Terminal configurations
are verified in a fresh shopping cart; partial runs keep their pending queue.
"""
import argparse
import csv
import hashlib
import html
import json
import os
import re
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from urllib.parse import urlsplit

VERSION = "3-20260928"
SITES = {"us": ("www.firmoo.com", "USD"), "uk": ("www.firmoo.co.uk", "GBP")}
DEFAULT_URLS = {key: f"https://{host}/eyeglasses-p-4611.html?color=21101" for key, (host, _) in SITES.items()}


class ProductIdentityMismatch(ValueError):
    pass


class OptionNotSelectable(ValueError):
    pass


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def validate_url(url, market):
    parts = urlsplit(url)
    match = re.fullmatch(r"/eyeglasses-p-(\d+)\.html", parts.path)
    if parts.scheme != "https" or parts.netloc != SITES[market][0] or not match:
        raise ValueError(f"Expected an eyeglasses product URL on {SITES[market][0]}")
    return match.group(1)


def parse_summary(text, currency):
    # Restrict to the lens sidebar, never the promotional banner or order total.
    frame = re.search(r"\n[$£]\s*([\d.]+)\s*\nLens Price", text)
    lens = re.search(r"Lens Price\s*\n[$£]\s*([\d.]+)", text)
    total = re.search(r"Subtotal:\s*\n?[$£]\s*([\d.]+)", text, re.I)
    if not all((frame, lens, total)):
        raise ValueError("Lens sidebar price layout not recognized")
    values = [Decimal(x.group(1)) for x in (frame, lens, total)]
    if values[0] + values[1] != values[2]:
        raise ValueError("Frame plus lenses differs from configuration subtotal")
    if (currency == "GBP" and "£" not in text) or (currency == "USD" and "USD" not in text):
        raise ValueError("Unexpected currency for requested market")
    return dict(zip(("frame_price", "lens_price", "item_total"), map(str, values)), currency=currency)


def parse_cart(text, currency):
    if not re.search(r"My Shopping (?:Cart|Bag)\s*\(1\)", text, re.I):
        raise ValueError("Expected exactly one item in a fresh shopping cart")
    item = re.search(r"Frame:\s*(.*?)\n[$£]\s*([\d.]+).*?Lens Details[^\n]*\n[$£]\s*([\d.]+).*?\nRemove\s*\nSubtotal\s*\n[$£]\s*([\d.]+)", text, re.S)
    if not item:
        raise ValueError("Cart product row layout not recognized")
    frame, lenses, subtotal = [Decimal(item.group(i)) for i in (2, 3, 4)]
    if frame + lenses != subtotal:
        raise ValueError("Cart frame plus lenses differs from item subtotal")
    if (currency == "USD" and "USD($)" not in text) or (currency == "GBP" and "GBP(£)" not in text):
        raise ValueError("Cart currency does not match requested market")
    return {"frame_price": str(frame), "lens_price": str(lenses), "item_total": str(subtotal),
            "cart_product_name": item.group(1), "currency": currency}


def close_overlays(page):
    for node in page.locator(".messagePopup .onCloseCustom:visible").all():
        node.click(timeout=3000)
    for node in page.locator(".ant-modal-close:visible").all():
        node.click(timeout=3000)
    for label in ("Reject all", "Reject All", "全部拒绝", "Accept Cookies", "Accept All", "Accept all cookies", "I Agree"):
        loc = page.get_by_text(label, exact=True)
        if loc.count() and loc.first.is_visible():
            loc.first.click(timeout=3000)


def open_flow(page, url, product_evidence_dir=None):
    for attempt in range(3):
        try:
            page.goto(url, wait_until="domcontentloaded", timeout=60000)
            break
        except Exception:
            if attempt == 2:
                raise
            page.wait_for_timeout(1000 * (attempt + 1))
    page.get_by_text(re.compile("select lenses", re.I)).first.wait_for(timeout=30000)
    page.wait_for_timeout(1200)
    close_overlays(page)
    if product_evidence_dir is not None:
        product_evidence = evidence(page, product_evidence_dir, "product")
        product_id = re.fullmatch(r"/eyeglasses-p-(\d+)\.html", urlsplit(url).path).group(1)
        capture_frame_preview(page, product_id, product_evidence_dir, product_evidence)
    else:
        product_evidence = None
    page.get_by_text(re.compile("select lenses", re.I)).first.click()
    if urlsplit(url).netloc == "www.firmoo.co.uk":
        loc = page.get_by_text("Non-Prescription", exact=True)
    else:
        loc = page.get_by_text(re.compile(r"need non[- ]prescription lenses", re.I))
    loc.first.wait_for(timeout=20000)
    close_overlays(page)
    loc.first.click()
    page.locator(".lens-type-name:visible").first.wait_for(timeout=20000)
    return product_evidence


def sidebar_model(text):
    match = re.search(r"(?m)^([^\n]+)\(C[\w-]+\)\s*$", text)
    if not match:
        raise ProductIdentityMismatch("Product model is missing from the lens summary")
    return match.group(1).strip()


def require_model(observed, expected, market):
    if expected and observed != expected:
        raise ProductIdentityMismatch(f"Requested {expected}, but {market} URL shows {observed}")


def options(page):
    right = page.locator(".lens-right-content")
    colors = right.locator(".color-container:visible")
    if colors.count():
        result = []
        for i, node in enumerate(colors.all()):
            node.click()
            page.wait_for_timeout(150)
            label = right.locator(".color-select-list").first.inner_text().strip()
            result.append({"stage": "color", "selector": ".color-container:visible", "index": i,
                           "label": label, "text": "", "style": node.locator(".color-item").get_attribute("style")})
        return result
    # Precedence prevents re-selecting parent cards on thickness/coating screens.
    for selector, label in ((".select-tag-coating:visible", "coating"),
                            (".thickness-item-container:visible", "index"),
                            ("[data-track-event='lens_subtype_select']:visible", "subtype"),
                            ("[data-track-event='lens_color_select']:visible", "color"),
                            (".lens-type-name:visible", "type")):
        nodes = right.locator(selector)
        if nodes.count():
            result = []
            for i, node in enumerate(nodes.all()):
                text = node.inner_text().strip()
                attrs = node.evaluate("e=>Object.fromEntries(Array.from(e.attributes).filter(a=>a.name.startsWith('data-track-lens-')).map(a=>[a.name,a.value]))")
                if label == "index":
                    attrs.pop("data-track-lens-coating", None)
                result.append({"stage": label, "selector": selector, "index": i,
                               "label": re.sub(r"\s*-\s*[$£].*$", "", text.splitlines()[0]), "text": text,
                               "identity": attrs})
            return result
    return []


def click_step(page, step):
    close_overlays(page)
    node = page.locator(".lens-right-content").locator(step["selector"]).nth(step["index"])
    identity = step.get("identity")
    matches = (all(node.get_attribute(key) == value for key, value in identity.items()) if identity else
               node.inner_text().strip() == step["text"])
    if not matches:
        raise ValueError("Options changed during traversal; refusing to select a different configuration")
    target_selector = {"index": ".tag-name", "subtype": ".lens-type-name", "coating": ".coating-name"}.get(step["stage"])
    target = node.locator(target_selector).first if target_selector and node.locator(target_selector).count() else node
    target.click()
    page.wait_for_timeout(300)
    if step["stage"] == "index":
        try:
            page.locator(".active-package:visible, .select-tag-coating:visible, .pc-add-cart-content:visible").first.wait_for(timeout=15000)
        except Exception as exc:
            raise OptionNotSelectable(f"Thickness option {step['label']} did not become selectable") from exc
    if step["stage"] == "color":
        if node.locator(".color-item").get_attribute("style") != step["style"]:
            raise ValueError("Lens color palette changed")
        page.get_by_role("button", name="Confirm", exact=True).click()
        page.wait_for_timeout(300)


def scoped_children(path, children, coverage_mode):
    """Apply the chosen scope to options actually displayed at this stage."""
    if coverage_mode == "classic":
        if not path:
            return [step for step in children if step["label"] in
                    {"Clear", "Blue-light Blocking", "Driving"}]
        return children[:1]
    return children[:1] if coverage_mode == "subtypes" and len(path) >= 2 else children


def evidence(page, directory, prefix):
    directory.mkdir(parents=True, exist_ok=True)
    page.screenshot(path=str(directory / f"{prefix}.png"), full_page=True)
    (directory / f"{prefix}.txt").write_text(page.locator("body").inner_text(), encoding="utf-8")
    (directory / f"{prefix}.html").write_text(page.content(), encoding="utf-8")
    return {"url": page.url, "captured_at": datetime.now(timezone.utc).isoformat(),
            "screenshot": str(directory / f"{prefix}.png"), "text": str(directory / f"{prefix}.txt"),
            "html": str(directory / f"{prefix}.html")}


def capture_frame_preview(page, product_id, directory, proof):
    """Select the first actual frame photo in Firmoo's product gallery."""
    gallery = page.locator(".product-banner-control .product-control-item")
    for item in gallery.all():
        picture = item.locator("img").first
        if not picture.count():
            continue
        src = picture.get_attribute("src") or ""
        filename = urlsplit(src).path.rsplit("/", 1)[-1]
        if f"/p/{product_id}/" not in src or "model" in filename.lower():
            continue
        try:
            item.click(timeout=5000)
            page.wait_for_function("""id => {
                const image = document.querySelector('.slick-slide.slick-current img');
                const src = image?.currentSrc || image?.src || '';
                return image && src.includes('/p/' + id + '/') &&
                    !src.split('/').pop().toLowerCase().includes('model') &&
                    image.complete && image.naturalWidth > 0;
            }""", arg=product_id, timeout=10000)
            # The welcome offer can appear after the gallery image has loaded.
            page.wait_for_timeout(1500)
            selected = page.locator(".slick-slide.slick-current img").first
            for _ in range(3):
                close_overlays(page)
                unobscured = selected.evaluate("""image => {
                    const box = image.getBoundingClientRect();
                    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
                    return hit === image || image.contains(hit);
                }""")
                if unobscured:
                    break
                page.wait_for_timeout(500)
            else:
                raise RuntimeError("Frame photo is obscured by a page overlay")
            directory.mkdir(parents=True, exist_ok=True)
            target = directory / "product_frame.png"
            selected.screenshot(path=str(target))
            proof.update(frame_preview=str(target), frame_image_url=selected.get_attribute("src"),
                         frame_preview_status="ok")
            return proof
        except Exception as exc:
            proof["frame_preview_status"] = "unavailable"
            proof["frame_preview_reason"] = str(exc)
            return proof
    proof["frame_preview_status"] = "not_found"
    return proof


def verify_cart(page):
    close_overlays(page)
    page.get_by_role("button", name=re.compile(r"^ADD TO CART$", re.I)).click()
    try:
        page.wait_for_url(re.compile(r"/(?:cart|basket|shopping-cart)"), timeout=25000)
    except Exception:
        pass
    # Some markets show an intermediate confirmation rather than redirecting.
    view = page.get_by_text(re.compile(r"^(View|Go to) (Shopping )?(Cart|Bag)$", re.I))
    if view.count() and view.first.is_visible():
        view.first.click()
    page.wait_for_timeout(1000)
    return page.locator("body").inner_text()


def render_report(path, batch):
    path = path.resolve()
    rows = []
    for record in batch["records"]:
        values = [record["market"], record.get("cart_product_name", record["product_id"]), " / ".join(s["label"] for s in record["path"]),
                  record.get("frame_price", ""), record.get("lens_price", ""),
                  record.get("item_total", ""), record["currency"], record["cart_price_status"]]
        proof = record["evidence"][-1]
        reference = Path(proof["text"]).relative_to(path.parent).as_posix()
        rows.append("<tr>" + "".join(f"<td>{html.escape(str(v))}</td>" for v in values) +
                    f'<td><a href="{html.escape(reference, quote=True)}">Evidence</a></td></tr>')
    path.write_text("<!doctype html><meta charset='utf-8'><title>Firmoo lens prices</title>"
                    "<style>body{font:14px system-ui;margin:32px}td,th{padding:8px;border:1px solid #ddd}table{border-collapse:collapse}</style>"
                    "<h1>Firmoo non-prescription lenses</h1><p>Currency and markets are separate. Tax, shipping and coupon eligibility are not verified.</p>"
                    + "<p>Coverage: " + html.escape(json.dumps(batch.get("coverage", {}), ensure_ascii=False)) + "</p>"
                    "<table><tr><th>Market</th><th>Product</th><th>Configuration</th><th>Frame</th><th>Lenses</th><th>Item total</th><th>Currency</th><th>Cart verification</th><th>Evidence</th></tr>"
                    + "".join(rows) + "</table>", encoding="utf-8")
    with path.with_suffix(".csv").open("w", encoding="utf-8-sig", newline="") as output:
        fields = ("market", "product_id", "lens_type", "lens_subtype", "configuration", "frame_price", "lens_price", "item_total", "currency", "cart_price_status")
        writer = csv.DictWriter(output, fieldnames=fields)
        writer.writeheader()
        for record in batch["records"]:
            row = {field: record.get(field, "") for field in fields}
            row["configuration"] = " / ".join(step["label"] for step in record["path"])
            writer.writerow(row)


def collect(browser, market, url, root, limit=0, resume=False, lens_type=None, retry_errors=False, coverage_mode="all", expected_model=None):
    product_id = validate_url(url, market)
    directory = root / market / product_id
    master_path = directory / "firmoo_lens_tree_master.json"
    batch = (json.loads(master_path.read_text(encoding="utf-8")) if resume and master_path.exists() else
             {"schema_version": "1.0", "script_version": VERSION, "brand": "Firmoo", "market": market,
              "currency": SITES[market][1], "product_id": product_id, "url": url, "branch": "Non-Prescription",
              "requested_lens_type": lens_type,
              "coverage_mode": coverage_mode,
              "records": [], "nodes": [], "errors": [], "pending": [[]]})
    if batch["url"] != url:
        raise ValueError("Resume URL differs from saved product/color")
    if batch.get("requested_lens_type") != lens_type:
        raise ValueError("Resume lens-type scope differs from saved run")
    if batch.get("coverage_mode", "all") != coverage_mode:
        raise ValueError("Resume coverage scope differs from saved run")
    conflicts = [record for record in batch["records"] if record.get("cart_product_name") and
                 expected_model and record["cart_product_name"] != expected_model]
    if not conflicts:
        # Older runs may have lacked a cart model because navigation failed.
        # That is an unverified price, not proof of a different product.
        for record in batch["records"]:
            if record["cart_price_status"] == "product_identity_mismatch" and not record.get("cart_product_name"):
                record["cart_price_status"] = "needs_review"
                record["missing_reason"] = "Cart product model unavailable; retry the cart"
        batch["errors"] = [error for error in batch["errors"] if not
                           (error["code"] == "product_identity_mismatch" and
                            error.get("reason") == f"Saved {market} cart contains a different model than {expected_model}")]
    if conflicts:
        for record in batch["records"]:
            if record in conflicts:
                record["cart_price_status"] = "product_identity_mismatch"
                record["missing_reason"] = f"Expected {expected_model}, observed {record.get('cart_product_name')}"
        batch.setdefault("errors", []).append({"path": [], "code": "product_identity_mismatch",
                                                "reason": f"Saved {market} cart contains a different model than {expected_model}",
                                                "retryable": False})
        batch["coverage"]["verified_records"] = sum(record["cart_price_status"] == "ok" for record in batch["records"])
        batch["coverage"]["complete"] = False
        write_json(master_path, batch)
        render_report(directory / "firmoo_prices.html", batch)
        raise ProductIdentityMismatch(f"Saved {market} cart contains a different model than {expected_model}")
    if retry_errors:
        batch["pending"] += [error["path"] for error in batch["errors"]]
        batch["errors"] = []
        unverified = [record for record in batch["records"] if record["cart_price_status"] != "ok"]
        batch["pending"] += [record["path"] for record in unverified]
        if unverified:
            batch.setdefault("previous_observations", []).extend(unverified)
            batch["records"] = [record for record in batch["records"] if record["cart_price_status"] == "ok"]
    run_dir = directory / datetime.now().strftime("run_%Y%m%d_%H%M%S")
    completed = 0
    context = None
    current_path = None
    while batch["pending"] and (not limit or completed < limit):
        path = batch["pending"].pop(0)
        key = hashlib.sha256(json.dumps(path, sort_keys=True).encode()).hexdigest()[:16]
        if context is None:
            context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="en-US" if market == "us" else "en-GB")
            page = context.new_page()
        attempted_cart = False
        try:
            if current_path is None or path[:len(current_path)] != current_path:
                product_proof = open_flow(page, url, run_dir / "product_page" if not batch.get("product_evidence") else None)
                if product_proof:
                    batch["product_evidence"] = product_proof
                observed_model = sidebar_model(page.locator(".lens-left-content").inner_text())
                batch["observed_model"] = observed_model
                require_model(observed_model, expected_model, market)
                current_path = []
            for step in path[len(current_path):]:
                click_step(page, step)
            current_path = path
            proof = evidence(page, run_dir / key, "configuration")
            add = page.get_by_role("button", name=re.compile(r"^ADD TO CART$", re.I))
            terminal = path and (path[-1]["stage"] == "coating" or
                                 (path[-1]["stage"] == "index" and not page.locator(".select-tag-coating:visible").count()))
            children = [] if terminal else options(page)
            if add.count() and add.first.is_visible() and (terminal or not children):
                record = {"market": market, "currency": batch["currency"], "product_id": product_id,
                          "lens_type": path[0]["label"],
                          "lens_subtype": next((step["label"] for step in path if step["stage"] == "subtype"), None),
                          "selection_policy": coverage_mode,
                          "path": path, "evidence": [proof], "cart_price_status": "unverified"}
                record.update(parse_summary(page.locator(".lens-left-content").inner_text(), batch["currency"]))
                attempted_cart = True
                cart_text = verify_cart(page)
                record["evidence"].append(evidence(page, run_dir / key, "cart"))
                record["price_scope"] = "one cart item; tax, shipping and coupon eligibility not verified"
                try:
                    cart_prices = parse_cart(cart_text, batch["currency"])
                    if not all(cart_prices[field] == record[field] for field in ("frame_price", "lens_price", "item_total")):
                        raise ValueError("Cart prices differ from selected configuration")
                    record.update(cart_prices)
                    record["cart_price_status"] = "ok"
                except ValueError as exc:
                    record["cart_price_status"] = "needs_review"
                    record["missing_reason"] = str(exc)
                batch["records"].append(record)
                completed += 1
            elif children and len(path) < 8:
                batch["nodes"].append({"path": path, "options": children, "evidence": proof})
                if not path and lens_type:
                    children = [step for step in children if step["label"] == lens_type]
                    if not children:
                        raise ValueError("Requested lens type not offered")
                # Cover every immediate option under each primary category. For
                # later color/index/coating steps, one explicit displayed option
                # supplies a complete priced configuration per secondary choice.
                children = scoped_children(path, children, coverage_mode)
                batch["pending"][0:0] = [path + [step] for step in children]
            else:
                raise ValueError("Unrecognized lens step; see saved page evidence")
        except KeyboardInterrupt:
            batch["pending"].insert(0, path)
            raise
        except Exception as exc:
            current_path = None
            identity_error = isinstance(exc, ProductIdentityMismatch)
            error_code = ("product_identity_mismatch" if identity_error else
                          "option_not_selectable" if isinstance(exc, OptionNotSelectable) else "collection_failed")
            error = {"path": path, "code": error_code,
                     "reason": str(exc), "retryable": not identity_error}
            try:
                error["evidence"] = evidence(page, run_dir / key, "error")
            except Exception:
                pass
            batch["errors"].append(error)
            if identity_error:
                batch["pending"].clear()
            print(market, "ERROR", str(exc), flush=True)
        finally:
            if attempted_cart or current_path is None:
                context.close()
                context = None
                current_path = None
            batch["coverage"] = {"observed_root_options": len(batch["nodes"][0]["options"]) if batch["nodes"] else 0,
                                 "scope": coverage_mode,
                                 "lower_options_policy": ("all" if coverage_mode == "all" else
                                                          "first displayed secondary and downstream option per classic category" if coverage_mode == "classic" else
                                                          "every secondary choice; first displayed downstream option"),
                                 "records": len(batch["records"]), "pending_paths": len(batch["pending"]),
                                 "verified_records": sum(r["cart_price_status"] == "ok" for r in batch["records"]),
                                 "errors": len(batch["errors"]), "complete": not batch["pending"] and not batch["errors"] and all(r["cart_price_status"] == "ok" for r in batch["records"])}
            write_json(master_path, batch)
            write_json(run_dir / "batch_manifest.json", batch)
            render_report(directory / "firmoo_prices.html", batch)
            print(market, "path", [s["label"] for s in path], batch["coverage"], flush=True)
    if context is not None:
        context.close()
    return batch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--market", choices=("us", "uk", "both"), default="both")
    parser.add_argument("--us-url", default=DEFAULT_URLS["us"])
    parser.add_argument("--uk-url", default=DEFAULT_URLS["uk"])
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "firmoo_products")
    parser.add_argument("--channel", choices=("chrome", "msedge"), default="msedge")
    parser.add_argument("--headless", action="store_true")
    parser.add_argument("--max-paths", type=int, default=0, help="Limit terminal configurations per market; 0 traverses all")
    parser.add_argument("--resume", action="store_true")
    parser.add_argument("--retry-errors", action="store_true", help="With --resume, retry saved failed paths")
    parser.add_argument("--lens-type", help="Optional exact displayed lens category; default explores all")
    parser.add_argument("--expected-model", help="Required model name for an individual market; both-market runs infer this from the first verified US cart")
    parser.add_argument("--tier", choices=("classic", "medium", "full"),
                        help="classic: three common categories; medium: six categories and every second-level choice; full: all visible combinations")
    parser.add_argument("--coverage", choices=("all", "subtypes", "classic"),
                        help="Legacy explicit scope; use --tier for a new collection")
    args = parser.parse_args()
    if args.max_paths < 0:
        parser.error("--max-paths must be non-negative")
    if args.retry_errors and not args.resume:
        parser.error("--retry-errors requires --resume")
    if args.tier and args.coverage:
        parser.error("Choose either --tier or --coverage")
    if not args.tier and not args.coverage:
        parser.error("Choose --tier after confirming the collection scope with the user")
    coverage_mode = {"classic": "classic", "medium": "subtypes", "full": "all"}.get(args.tier, args.coverage)
    # Capture the fonts actually rendered; a stalled third-party font must not
    # abort a valid business state. Supported by this bundled Playwright runtime.
    os.environ.setdefault("PW_TEST_SCREENSHOT_NO_FONTS_READY", "1")
    from playwright.sync_api import sync_playwright
    with sync_playwright() as p:
        browser = p.chromium.launch(channel=args.channel, headless=args.headless)
        had_errors = False
        try:
            expected_model = args.expected_model
            for market in (SITES if args.market == "both" else [args.market]):
                batch = collect(browser, market, getattr(args, f"{market}_url"), args.output.resolve(), args.max_paths, args.resume, args.lens_type, args.retry_errors, coverage_mode, expected_model)
                had_errors = had_errors or bool(batch["errors"])
                if args.market == "both" and market == "us":
                    verified = [record for record in batch["records"] if record["cart_price_status"] == "ok"]
                    if not verified:
                        raise ProductIdentityMismatch("US cart did not verify a model; cannot validate the UK equivalent")
                    expected_model = verified[0]["cart_product_name"]
        finally:
            browser.close()
    if had_errors:
        raise SystemExit(2)


if __name__ == "__main__":
    main()

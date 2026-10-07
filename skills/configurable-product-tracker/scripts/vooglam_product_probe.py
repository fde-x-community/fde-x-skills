"""Script-only product identity/evidence check before price-path collection."""
import argparse
import os
from datetime import datetime
import json
import re
from pathlib import Path
import vooglam_lens_tree as tree


def enrich_identity(record):
    """Derive only values present in saved public product evidence."""
    if record.get("status") != "observed":
        return record
    text = Path(record["evidence"]["text"]).read_text(encoding="utf-8")
    heading = record.get("headings", [""])[0]
    segment = text.split(heading, 1)[1][:500] if heading and heading in text else ""
    record["name"] = heading.splitlines()[0] if heading else None
    category_text = " ".join((record.get("title") or "", heading))
    record["product_type"] = ("sunglasses" if re.search(r"\b(?:sunglasses|shades)\b", category_text, re.I)
                              else "eyeglasses" if re.search(r"\b(?:eyeglasses|glasses)\b", category_text, re.I)
                              else "unknown")
    record["scope_status"] = ("unsupported_product_type" if record["product_type"] == "sunglasses"
                              else "in_scope" if record["product_type"] == "eyeglasses" else "needs_review")
    record["purchase_mode"] = ("select_lenses" if "SELECT LENSES" in segment else
                               "ready_made" if "ADD TO BAG" in segment else "unknown")
    colorway = re.search(r"Colorway:\s*\n([^\n]+)", segment)
    if colorway:
        record["default_colorway"] = colorway.group(1).strip()
    # Product pages may place a promotion badge between the heading and price.
    # Limit the search to nearby standalone price lines to avoid cart totals.
    heading_name = heading.splitlines()[0].strip() if heading else ""
    visible_prices = []
    if heading_name:
        for match in re.finditer(rf"(?m)^{re.escape(heading_name)}\s*$", text):
            nearby = text[match.end():match.end() + 240]
            displayed = re.search(r"(?m)^\s*\$([\d,.]+)\s*$", nearby)
            if displayed:
                visible_prices.append(displayed.group(1).replace(",", ""))
    for node in record.get("structured_data", []):
        if node.get("@type") != "Product" or node.get("url") != record["requested_url"]:
            continue
        offer = node.get("offers", {})
        record["product_page_price"] = {
            "amount": offer.get("price"), "currency": offer.get("priceCurrency"),
            "strikethrough_amount": offer.get("priceSpecification", {}).get("price"),
            "availability": offer.get("availability"),
            "matches_visible_headline": str(offer.get("price")) in visible_prices,
            "scope": "frame price" if record["purchase_mode"] == "select_lenses" else "ready-made pair price"}
    return record


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--urls", type=Path, default=Path(__file__).with_name("vooglam_five_urls.json"))
    parser.add_argument("--channel", default=os.environ.get("VOOGLAM_BROWSER_CHANNEL", "chrome"))
    args = parser.parse_args()
    with tree.sync_playwright() as p:
        browser = p.chromium.launch(headless=True, channel=args.channel)
        for url in json.loads(args.urls.read_text(encoding="utf-8")):
            product_id = tree.configure_product(url)
            master = tree.load_master()
            directory = tree.MASTER_PATH.parent / datetime.now().strftime("identity_%Y%m%d_%H%M%S")
            directory.mkdir()
            context = browser.new_context(viewport={"width": 1440, "height": 1000}, locale="en-US")
            page = context.new_page()
            record = {"product_id": product_id, "requested_url": url,
                      "observed_at": datetime.now().astimezone().isoformat(), "source_kind": "public_observation"}
            try:
                page.goto(url, wait_until="domcontentloaded", timeout=60000)
                page.locator("button.goods-detail-button.primary:visible").first.wait_for(state="visible", timeout=25000)
                tree.accept_cookies_if_present(page)
                page.wait_for_timeout(700)
                text = page.locator("body").inner_text()
                (directory / "product.txt").write_text(text, encoding="utf-8")
                (directory / "product.html").write_text(page.content(), encoding="utf-8")
                page.screenshot(path=str(directory / "product.png"))
                headings = page.locator("h1:visible").all_inner_texts()
                ld = page.locator('script[type="application/ld+json"]').all_text_contents()
                structured = []
                for item in ld:
                    try:
                        structured.append(json.loads(item))
                    except ValueError:
                        pass
                code = re.search(r"Product Code\s*\n\s*([^\n]+)", text)
                color = re.search(r"Frame Color:\s*\n?\s*([^\n]+)", text)
                color_options = page.locator(".goods-detail-relations-item a[href*='/goods-detail/']").evaluate_all("""anchors =>
                    Array.from(new Map(anchors.map(a => [a.href, {
                        url: a.href, label: a.getAttribute('aria-label'),
                        selected: a.getAttribute('aria-current') === 'page',
                        image: a.querySelector('img')?.currentSrc || a.querySelector('img')?.src || null,
                        image_alt: a.querySelector('img')?.alt || null
                    }])).values())""")
                record.update(status="observed", page_url=page.url, title=page.title(),
                    headings=headings, product_code=code.group(1).strip() if code else None,
                    default_color=color.group(1).strip() if color else None,
                    color_options=color_options,
                    structured_data=structured,
                    evidence={"text": str(directory / "product.txt"),
                              "screenshot": str(directory / "product.png"),
                              "html": str(directory / "product.html")})
                if not page.url.rstrip('/').endswith('/' + product_id):
                    record.update(status="ambiguous", error="Redirect changed product URL")
            except Exception as exc:
                record.update(status="unavailable", error=str(exc))
                try:
                    (directory / "error.txt").write_text(page.locator("body").inner_text(), encoding="utf-8")
                    page.screenshot(path=str(directory / "error.png"))
                except Exception:
                    pass
            master["product_identity"] = enrich_identity(record)
            tree.persist_master(master)
            context.close()
            print(json.dumps({k: v for k, v in record.items() if k not in ("structured_data", "evidence")}, ensure_ascii=False), flush=True)
        browser.close()


if __name__ == "__main__":
    main()

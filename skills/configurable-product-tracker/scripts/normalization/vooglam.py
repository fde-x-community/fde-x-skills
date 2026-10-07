"""Import the verified Vooglam five-URL result without inventing missing fields."""

import hashlib
import json
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .core import normalize


def _id(prefix, *parts):
    value = json.dumps(parts, ensure_ascii=False, separators=(",", ":"))
    return prefix + ":" + hashlib.sha256(value.encode("utf-8")).hexdigest()[:20]


def _money(value):
    try:
        return Decimal(str(value))
    except (InvalidOperation, TypeError, ValueError):
        return None


def import_five_product_prices(path):
    """Convert Session 1's current export into the provisional acquisition envelope."""
    path = Path(path).resolve()
    source = json.loads(path.read_text(encoding="utf-8"))
    root = path.parent
    run_id = _id("vooglam-run", str(path), source.get("generated_at"))
    records, evidence, errors, flags = [], [], [], []
    product_by_id = {p["product_id"]: p for p in source.get("products", [])}
    base = {"run_id": run_id, "brand": "Vooglam", "market": "US", "market_status": "assumed_from_usd_export",
            "source_kind": "public_observation", "source_timezone": "not_specified",
            "granularity": "instant", "schema_version": "0.1-provisional",
            "parser_version": "vooglam-five-products-v1", "status": "ok", "data_period_start": None,
            "data_period_end": None, "missing_reason": None,
            "raw_payload_ref": str(path)}

    def add_evidence(ref, url, captured_at, evidence_type):
        evidence_id = _id("ev", run_id, ref)
        full = root / ref
        evidence.append({"evidence_id": evidence_id, "source_url_or_ref": url,
                         "source_type": evidence_type, "captured_at": captured_at,
                         "data_date": captured_at[:10] if captured_at else None,
                         "scope": "five_requested_urls", "snapshot_ref": ref,
                         "snapshot_exists": full.is_file(), "access_status": "public"})
        if not full.is_file():
            flags.append({"code": "evidence_file_missing", "snapshot_ref": ref})
        return evidence_id

    for p in source.get("products", []):
        url = p["url"]
        ev = add_evidence(p["page_evidence"], url, p["observed_at"], "product_screenshot")
        product_id = "vooglam:" + p["product_id"]
        common = dict(base, product_id=product_id, source_product_id=p["product_id"],
                      source_url_or_ref=url, observed_at=p["observed_at"], evidence_id=ev)
        records.append(dict(common, record_id=_id("product", product_id), entity_type="product",
                            name=p["name"], product_url=url, product_type="prescription_frames",
                            frame_style=None, frame_style_status="undisclosed", scope="requested_list"))
        # One actually observed color/SKU; size and other color coverage remain unknown.
        records.append(dict(common, record_id=_id("variant", product_id, p["sku"], p["color"]),
                            entity_type="variant", variant_id=_id("variant", product_id, p["sku"], p["color"]),
                            source_sku=p["sku"], color=p["color"], size=None,
                            size_status="undisclosed", availability=p["availability"],
                            variant_coverage="observed_default_only"))
        records.append(dict(common, record_id=_id("frame-price", product_id, p["observed_at"]),
                            entity_type="frame_price_observation", currency="USD",
                            frame_price=p.get("page_price"), price_scope=p.get("page_price_scope"),
                            strikethrough_price=p.get("strikethrough_price")))

    for row_number, o in enumerate(source.get("observations", []), 1):
        p = product_by_id.get(o.get("product_id"))
        if not p:
            errors.append({"source": "vooglam", "stage": "normalize", "code": "unknown_product",
                           "message": str(o.get("product_id")), "retryable": False, "evidence_ref": o.get("evidence")})
            continue
        product_id = "vooglam:" + o["product_id"]
        variant_id = _id("variant", product_id, o["sku"], p["color"])
        # The cart label is part of the identity: it distinguishes index/color/pro options.
        config_id = _id("lens", product_id, variant_id, "single_vision", o["lens_path"],
                        o["technology"], o["material"], o["cart_configuration"], source.get("scope"))
        ev = add_evidence(o["evidence"], o["source_url"], o["observed_at"], "cart_screenshot")
        text_ev = add_evidence(o["evidence_text"], o["source_url"], o["observed_at"], "cart_text")
        common = dict(base, product_id=product_id, variant_id=variant_id, lens_config_id=config_id,
                      source_url_or_ref=o["source_url"], observed_at=o["observed_at"], evidence_id=ev,
                      supporting_evidence_ids=[text_ev], raw_row_number=row_number)
        records.append(dict(common, record_id=_id("lens-record", run_id, config_id),
                            entity_type="lens_configuration", vision_type="single_vision",
                            original_labels={"lens_path": o["lens_path"], "technology": o["technology"],
                                             "material": o["material"], "cart_configuration": o["cart_configuration"]},
                            material=None if o["material"] == "未经过材料页" else o["material"],
                            material_status="not_traversed" if o["material"] == "未经过材料页" else "observed",
                            prescription_scenario=source.get("scope"), selection_path=o["lens_path"],
                            compatibility_status="verified_selected_path"))
        frame, lens, subtotal = (_money(o.get(k)) for k in ("frame_price", "lens_price", "total"))
        if None in (frame, lens, subtotal) or frame + lens != subtotal:
            flags.append({"code": "price_arithmetic_mismatch", "row_number": row_number})
        records.append(dict(common, record_id=_id("price-record", run_id, config_id),
                            entity_type="price_observation", currency=o["currency"],
                            base_frame_price=o["frame_price"], lens_surcharge=o["lens_price"],
                            quoted_subtotal=o["total"], complete_pair_price=None,
                            price_basis=o["price_basis"], price_status="quoted_pre_discount_subtotal",
                            eligibility="public_unverified", pair_basis="unverified",
                            tax_included=None, shipping_included=None, promotion_status="unverified"))

    for excluded in source.get("excluded_products", []):
        add_evidence(excluded["evidence"], excluded["url"], source.get("generated_at"), "excluded_product_screenshot")

    coverage = {"requested_scope": "five_specified_vooglam_urls", "observed_scope": "three_prescription_products_default_variants_single_vision",
                "requested_product_count": len(source.get("products", [])) + len(source.get("excluded_products", [])),
                "included_product_count": len(source.get("products", [])),
                "excluded": source.get("excluded_products", []),
                "observed_quoted_configuration_count": len(source.get("observations", [])),
                "collection": {p["product_id"]: p.get("collection", {}) for p in source.get("products", [])},
                "unpriced_seed_paths": {p["product_id"]: p.get("unpriced_seed_paths", []) for p in source.get("products", [])},
                "completeness": "partial", "generated_at": source.get("generated_at"),
                "prescription_scenario": source.get("scope")}
    result = normalize({"records": records, "evidence": evidence, "coverage": coverage, "errors": errors})
    result["quality_flags"].extend(flags)
    return result

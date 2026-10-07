"""Import Firmoo's verified secondary-choice cart rows with market isolation."""
import json
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .core import normalize
from .monitoring import _id


def import_firmoo_prices(path):
    path = Path(path).resolve()
    source = json.loads(path.read_text(encoding='utf-8'))
    products = {(p['market'].upper(), str(p['product_id'])): p for p in source['products']}
    records, evidence, flags, errors = [], [], [], []
    seen_products, seen_variants, seen_lenses = set(), set(), set()
    product_evidence_ids = {}
    for product in source['products']:
        proof = product.get('product_evidence') or {}
        screenshot = Path(proof['screenshot']) if proof.get('screenshot') else None
        if not screenshot or not screenshot.is_file():
            continue
        pid = 'firmoo:' + product['market'].lower() + ':' + str(product['product_id'])
        ev_id = _id('ev-product', str(path), pid)
        product_evidence_ids[pid] = ev_id
        evidence.append({'evidence_id': ev_id, 'source_url_or_ref': proof.get('url') or product['url'],
                         'source_type': 'product_screenshot', 'captured_at': proof.get('captured_at'),
                         'data_date': (proof.get('captured_at') or '')[:10] or None,
                         'scope': 'one_observed_product_color', 'snapshot_ref': str(screenshot),
                         'snapshot_exists': True, 'access_status': 'public'})
    for index, row in enumerate(source['records']):
        market = row['market'].upper()
        product = products.get((market, str(row['product_id'])))
        proofs = row.get('evidence') or []
        proof = proofs[-1] if proofs else {}
        when = proof.get('captured_at')
        try:
            stamp = datetime.fromisoformat(when)
            frame, lens, total = (Decimal(str(row[k])) for k in ('frame_price','lens_price','item_total'))
        except (ValueError, TypeError, InvalidOperation, KeyError):
            flags.append({'code': 'invalid_cart_observation', 'row': index})
            continue
        if not product or row.get('cart_price_status') != 'ok' or frame+lens != total or stamp.tzinfo is None:
            flags.append({'code': 'invalid_cart_or_product', 'row': index})
            continue
        pid = 'firmoo:' + market.lower() + ':' + str(row['product_id'])
        variant = _id('variant', pid, product['url'])
        route = tuple((step.get('stage'),step.get('label')) for step in row.get('path', []))
        lens_id = _id('lens', variant, route)
        ev_id = _id('ev', str(path), index)
        screenshot = Path(proof['screenshot']) if proof.get('screenshot') else None
        evidence.append({'evidence_id': ev_id, 'source_url_or_ref': proof.get('url') or product['url'],
                         'source_type': 'cart_screenshot', 'captured_at': when,
                         'data_date': stamp.date().isoformat(), 'scope': row.get('price_scope'),
                         'snapshot_ref': str(screenshot) if screenshot else None,
                         'snapshot_exists': bool(screenshot and screenshot.is_file()), 'access_status': 'public'})
        if not screenshot or not screenshot.is_file():
            flags.append({'code': 'evidence_file_missing', 'row': index})
        config_proof = next((item for item in proofs if Path(item.get('screenshot', '')).name == 'configuration.png'), None)
        config_id = None
        if config_proof:
            config_screenshot = Path(config_proof['screenshot'])
            if config_screenshot.is_file():
                config_id = _id('ev-configuration', str(path), index)
                evidence.append({'evidence_id': config_id, 'source_url_or_ref': config_proof.get('url'),
                                 'source_type': 'configuration_screenshot',
                                 'captured_at': config_proof.get('captured_at'),
                                 'data_date': (config_proof.get('captured_at') or '')[:10] or None,
                                 'scope': row.get('price_scope'), 'snapshot_ref': str(config_screenshot),
                                 'snapshot_exists': True, 'access_status': 'public'})
        base = dict(run_id=_id('firmoo-run', str(path)), brand='Firmoo', market=market, currency=row['currency'],
                    source_kind='public_observation', source_timezone=stamp.strftime('%z'), granularity='instant',
                    schema_version='0.1-provisional', parser_version='firmoo-secondary-v1', status='ok',
                    data_period_start=None, data_period_end=None, missing_reason=None,
                    raw_payload_ref=str(path), product_id=pid, source_product_id=str(row['product_id']),
                    source_url_or_ref=product['url'], observed_at=when, evidence_id=ev_id)
        if pid not in seen_products:
            if pid not in product_evidence_ids:
                flags.append({'code': 'product_screenshot_missing', 'product_id': pid})
            product_base = dict(base, evidence_id=product_evidence_ids.get(pid, ev_id))
            page_proof = product.get('product_evidence') or {}
            frame_preview = Path(page_proof['frame_preview']) if page_proof.get('frame_preview') else None
            if page_proof.get('frame_preview_status') != 'ok' or not frame_preview or not frame_preview.is_file():
                flags.append({'code': 'product_frame_preview_missing', 'product_id': pid})
            records.append(dict(product_base, record_id=_id('product', pid), entity_type='product',
                                name=product['product_name'], product_url=product['url'],
                                thumbnail_ref=str(frame_preview) if frame_preview and frame_preview.is_file() else page_proof.get('screenshot'),
                                product_type='prescription_frames', frame_style=None,
                                frame_style_status='undisclosed', scope='requested_list'))
            seen_products.add(pid)
        if variant not in seen_variants:
            records.append(dict(base, record_id=variant, entity_type='variant', variant_id=variant,
                                source_sku=None, color=None, color_status='url_color_parameter_only',
                                size=None, size_status='undisclosed', availability=None,
                                availability_status='not_checked', variant_coverage='one_url_color_only'))
            seen_variants.add(variant)
        common = dict(base, variant_id=variant, lens_config_id=lens_id)
        if lens_id not in seen_lenses:
            records.append(dict(common, record_id=lens_id, entity_type='lens_configuration',
                                vision_type='non_prescription', vision_type_status='verified_selected',
                                supporting_evidence_ids=[config_id] if config_id else [], original_labels=[list(x) for x in route],
                                selection_path=' → '.join(step.get('label','') for step in row.get('path', [])),
                                compatibility_status='verified_selected_path'))
            seen_lenses.add(lens_id)
        records.append(dict(common, record_id=_id('price', str(path),index), entity_type='price_observation',
                            currency=row['currency'], base_frame_price=str(frame), lens_surcharge=str(lens),
                            quoted_subtotal=str(total), complete_pair_price=None, price_basis=row.get('price_scope'),
                            eligibility=None, pair_basis=None, tax_included=None, shipping_included=None,
                            history_scope='single_observation_only'))
    result = normalize({'records': records, 'evidence': evidence, 'errors': errors,
                        'coverage': {'requested_scope': 'firmoo_secondary_choices',
                                     'observed_scope': source.get('selection_policy'),
                                     'success_count': len(evidence),
                                     'missing_count': None, 'completeness': 'partial'}})
    result['quality_flags'].extend(flags)
    return result

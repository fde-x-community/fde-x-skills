"""Import the monitor's verified cart observations without treating quotes as paid totals."""
import hashlib
from html import unescape
import json
import re
from datetime import datetime
from decimal import Decimal, InvalidOperation
from pathlib import Path

from .core import normalize


def _id(kind, *parts):
    body = json.dumps(parts, ensure_ascii=False, sort_keys=True)
    return kind + ':' + hashlib.sha256(body.encode('utf-8')).hexdigest()[:20]


def _amount(value):
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None


def _frame_style_from_page(page):
    if not page.is_file():
        return None
    markup = page.read_text(encoding='utf-8', errors='replace')
    match = re.search(
        r'<p[^>]*class="detail-label"[^>]*>\s*Frame Shape\s*</p>\s*'
        r'<p[^>]*class="detail-value"[^>]*>\s*([^<]+?)\s*</p>', markup, re.I)
    return unescape(match.group(1)).strip() if match else None


def _product_page_images(report_path, source, product_id):
    """Find identity screenshots beside a fresh run or in the archived monitor layout."""
    run_root = report_path.parent
    candidates = [run_root / 'scripts' / 'vooglam_products' / product_id,
                  run_root / 'vooglam_products' / product_id]
    if len(report_path.parents) > 4:
        assets = report_path.parents[4] / 'assets'
        if assets.is_dir():
            candidates.append(assets / 'm' / str(source.get('today', '')).replace('-', '') /
                              'vooglam_products' / product_id)
    return sorted(image for directory in candidates for image in directory.glob('identity_*/product.png'))


def import_monitor_report(path):
    path = Path(path).resolve()
    source = json.loads(path.read_text(encoding='utf-8'))
    if 'history' not in source or 'products' not in source:
        raise ValueError('expected monitor prices.json with products and history')
    run_id = _id('monitor-run', str(path), source.get('generated_at'))
    products = {str(p['product_id']): p for p in source['products']}
    records, evidence, flags, errors = [], [], [], []
    seen_products, seen_variants, seen_lenses = set(), set(), set()
    for index, row in enumerate(source['history']):
        source_id = str(row.get('product_id', ''))
        product = products.get(source_id)
        if not product:
            errors.append({'source': str(path), 'stage': 'normalize', 'code': 'unknown_product',
                           'message': source_id, 'retryable': False, 'evidence_ref': row.get('evidence')})
            continue
        when = row.get('observed_at')
        try:
            stamp = datetime.fromisoformat(when)
            if stamp.tzinfo is None:
                raise ValueError('timezone absent')
        except (TypeError, ValueError):
            flags.append({'code': 'invalid_observation_time', 'row': index})
            continue
        frame, lens, total = (_amount(row.get(k)) for k in ('frame_price', 'lens_price', 'total'))
        if None in (frame, lens, total) or frame + lens != total:
            flags.append({'code': 'price_arithmetic_mismatch', 'row': index})
            continue
        if row.get('currency') != 'USD' or row.get('sku') != product.get('sku'):
            flags.append({'code': 'market_or_variant_mismatch', 'row': index})
            continue
        pid = 'vooglam:' + source_id
        variant = _id('variant', pid, row['sku'])
        config = _id('lens', variant, row.get('lens_path'), row.get('technology'),
                     row.get('material'), row.get('cart_configuration'), row.get('scope'))
        ev_id = _id('ev', run_id, row.get('observation_id') or index)
        url = row.get('source_url') or product['url']
        ref = row.get('evidence')
        snapshot = path.parent / ref if ref else None
        evidence.append({'evidence_id': ev_id, 'source_url_or_ref': url,
                         'source_type': 'cart_screenshot', 'captured_at': when,
                         'data_date': stamp.date().isoformat(), 'scope': source.get('scope'),
                         'snapshot_ref': str(snapshot) if snapshot else None,
                         'snapshot_exists': bool(snapshot and snapshot.is_file()),
                         'access_status': 'public'})
        if not snapshot or not snapshot.is_file():
            flags.append({'code': 'evidence_file_missing', 'evidence_id': ev_id})
        base = dict(run_id=run_id, brand='Vooglam', market='US', currency='USD', source_kind='public_observation',
                    source_timezone=stamp.strftime('%z'), granularity='instant', schema_version='0.1-provisional',
                    parser_version='monitoring-prices-v1', status='ok', data_period_start=None,
                    data_period_end=None, missing_reason=None, raw_payload_ref=str(path),
                    product_id=pid, source_product_id=source_id, source_url_or_ref=url,
                    observed_at=when, evidence_id=ev_id)
        if pid not in seen_products:
            page_images = _product_page_images(path, source, source_id)
            if not page_images:
                flags.append({'code': 'product_screenshot_missing', 'product_id': pid})
            frame_style = _frame_style_from_page(page_images[-1].with_name('product.html')) if page_images else None
            records.append(dict(base, record_id=_id('product', pid), entity_type='product',
                                name=product['name'], product_url=product['url'],
                                thumbnail_ref=str(page_images[-1]) if page_images else None,
                                product_type='prescription_frames', frame_style=frame_style,
                                frame_style_status='observed' if frame_style else 'undisclosed', scope='requested_list'))
            seen_products.add(pid)
        if variant not in seen_variants:
            records.append(dict(base, record_id=variant, entity_type='variant', variant_id=variant,
                                source_sku=row['sku'], color=None, color_status='undisclosed',
                                size=None, size_status='undisclosed', availability=None,
                                availability_status='not_checked', variant_coverage='observed_default_only'))
            seen_variants.add(variant)
        common = dict(base, variant_id=variant, lens_config_id=config)
        if config not in seen_lenses:
            records.append(dict(common, record_id=config, entity_type='lens_configuration',
                                vision_type='single_vision', material=None if row.get('material') == '未经过材料页' else row.get('material'),
                                material_status='not_traversed' if row.get('material') == '未经过材料页' else 'observed',
                                original_labels={k: row.get(k) for k in ('lens_path','technology','material','cart_configuration')},
                                selection_path=row.get('lens_path'), compatibility_status='verified_selected_path'))
            seen_lenses.add(config)
        records.append(dict(common, record_id=_id('price', run_id, row.get('observation_id') or index),
                            entity_type='price_observation', currency='USD', base_frame_price=str(frame),
                            lens_surcharge=str(lens), quoted_subtotal=str(total), complete_pair_price=None,
                            price_basis=row.get('price_basis'), eligibility=None, pair_basis=None,
                            tax_included=None, shipping_included=None,
                            history_group_key=row.get('config_key'), history_scope='observed_quote_only',
                            original_observation_id=row.get('observation_id'),
                            original_revision=row.get('revision')))
    dataset = normalize({'records': records, 'evidence': evidence,
                         'coverage': {'requested_scope': 'monitor_configured_products',
                                      'observed_scope': source.get('scope'),
                                      'success_count': len([r for r in records if r['entity_type']=='price_observation']),
                                      'missing_count': None, 'completeness': 'partial',
                                      'history_dates': source.get('dates', {}),
                                      'source_report': str(path)}, 'errors': errors})
    dataset['quality_flags'].extend(flags)
    return dataset

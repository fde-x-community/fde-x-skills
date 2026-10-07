"""Append verified same-configuration daily observations to a monitor dataset."""
import hashlib
import json
import re
from decimal import Decimal, InvalidOperation
from pathlib import Path


def _signature(row):
    labels = row.get('original_labels') or row
    return (str(row.get('source_product_id') or row.get('product_id', '').removeprefix('vooglam:')),
            labels.get('lens_path'), labels.get('technology'), labels.get('material'),
            labels.get('cart_configuration'))


def _evidence_file(source_path, ref):
    parts = re.split(r'[\\/]+', str(ref))
    try:
        at = parts.index(source_path.parent.name)
    except ValueError:
        return None
    candidate = source_path.parent.joinpath(*parts[at + 1:])
    return candidate if candidate.is_file() else None


def append_incremental_observations(dataset, source_path):
    source_path = Path(source_path).resolve()
    source = json.loads(source_path.read_text(encoding='utf-8'))
    if not isinstance(source.get('observed_rows'), list):
        raise ValueError('expected incremental prices.json with observed_rows')
    lens_by_signature = {_signature(row): row for row in dataset['records']
                         if row.get('brand') == 'Vooglam' and row.get('entity_type') == 'lens_configuration'}
    price_by_lens = {}
    variant_sku = {row.get('variant_id'): row.get('source_sku') for row in dataset['records']
                   if row.get('entity_type') == 'variant' and row.get('brand') == 'Vooglam'}
    for row in dataset['records']:
        if row.get('entity_type') == 'price_observation' and row.get('brand') == 'Vooglam':
            key = row.get('lens_config_id')
            if key not in price_by_lens or row['observed_at'] > price_by_lens[key]['observed_at']:
                price_by_lens[key] = row
    added = 0
    for index, raw in enumerate(source['observed_rows']):
        lens = lens_by_signature.get(_signature(raw))
        baseline = price_by_lens.get(lens.get('lens_config_id')) if lens else None
        evidence_file = _evidence_file(source_path, raw.get('evidence'))
        try:
            frame, surcharge, subtotal = [Decimal(str(raw[k])) for k in ('frame_price', 'lens_price', 'total')]
            valid_amount = frame + surcharge == subtotal
        except (InvalidOperation, KeyError, TypeError):
            valid_amount = False
        if (not baseline or not evidence_file or not valid_amount or
                raw.get('sku') != variant_sku.get(baseline.get('variant_id')) or
                raw.get('currency') != baseline.get('currency')):
            dataset['quality_flags'].append({'code': 'incremental_row_not_imported', 'row': index,
                                             'reason': 'configuration_evidence_or_arithmetic_missing'})
            continue
        identity = hashlib.sha256((str(source_path) + '|' + str(index) + '|' + raw['observed_at']).encode()).hexdigest()[:20]
        evidence_id = 'ev:' + identity
        dataset['evidence'].append({'evidence_id': evidence_id, 'source_url_or_ref': raw['source_url'],
                                    'source_type': 'cart_screenshot', 'captured_at': raw['observed_at'],
                                    'data_date': raw['observed_at'][:10], 'scope': raw.get('scope'),
                                    'snapshot_ref': str(evidence_file), 'snapshot_exists': True,
                                    'access_status': 'public'})
        record = dict(baseline, record_id='price:' + identity, run_id='incremental-' + source_path.parent.name,
                      observed_at=raw['observed_at'], evidence_id=evidence_id,
                      source_url_or_ref=raw['source_url'], raw_payload_ref=str(source_path),
                      base_frame_price=raw['frame_price'], lens_surcharge=raw['lens_price'],
                      quoted_subtotal=raw['total'], price_basis=raw['price_basis'],
                      original_observation_id=None)
        dataset['records'].append(record)
        added += 1
    if source.get('failures'):
        dataset['quality_flags'].append({'code': 'incremental_collection_incomplete',
                                         'source': str(source_path), 'details': source['failures']})
    dataset['coverage']['incremental'] = {'source': str(source_path), 'verified_price_rows': added,
                                          'reported_rows': len(source['observed_rows']),
                                          'failures': source.get('failures', []), 'completeness': 'partial'}
    return added

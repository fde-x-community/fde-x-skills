"""Deterministic presentation data for observed no-prescription cart quotes."""
from collections import defaultdict
from datetime import date, timedelta
from decimal import Decimal


CATEGORIES = {'Standard Lenses': 'standard', 'Blue Light Blocking': 'blue_light',
              'Driving Lenses': 'driving'}


def build_product_cards(dataset, as_of=None):
    records = dataset.get('records', [])
    products = {r['product_id']: r for r in records if r.get('entity_type') == 'product'}
    lenses = {r['lens_config_id']: r for r in records if r.get('entity_type') == 'lens_configuration'}
    grouped = defaultdict(list)
    for r in records:
        if r.get('entity_type') != 'price_observation' or r.get('status') != 'ok' or r.get('quoted_subtotal') is None:
            continue
        if as_of and r.get('observed_at', '')[:10] > as_of:
            continue
        lens = lenses.get(r.get('lens_config_id'), {})
        labels = lens.get('original_labels') or {}
        if isinstance(labels, dict):
            category = CATEGORIES.get(labels.get('lens_path'))
            technology = labels.get('technology')
        else:
            category = None
            technology = None
        if not category and r.get('brand') == 'Firmoo':
            route = lens.get('selection_path', '')
            if route.startswith('Driving'):
                category = 'driving'
            elif route.startswith('Blue-light Blocking'):
                category = 'blue_light'
            elif route.startswith('Clear'):
                category = 'standard'
            elif route.startswith('Photochromic & Transitions'):
                category = 'photochromic'
            elif route.startswith('Tint & Polarized'):
                category = 'tint'
            elif route.startswith('Featured - LED Pro Lenses'):
                category = 'led'
        if category:
            grouped[(r['product_id'], category)].append((r, lens, technology))
    result = []
    for pid, product in products.items():
        featured = {}
        sparkline = []
        categories = ('standard', 'blue_light', 'driving', 'photochromic', 'tint', 'led') if product.get('brand') == 'Firmoo' else ('standard', 'blue_light', 'driving')
        for category in categories:
            candidates = grouped.get((pid, category), [])
            if not candidates:
                featured[category] = {'status': 'unavailable', 'reason': 'no_verified_configuration'}
                continue
            latest_day = max(item[0]['observed_at'][:10] for item in candidates)
            current = [item for item in candidates if item[0]['observed_at'][:10] == latest_day]
            # Prefer the plain Standard Lenses technology; otherwise show the actual selected path.
            current.sort(key=lambda item: (item[2] != 'Standard Lenses',
                                           Decimal(str(item[0]['quoted_subtotal'])), item[0]['observed_at']))
            row, lens, technology = current[0]
            previous_day = (date.fromisoformat(latest_day) - timedelta(days=1)).isoformat()
            prior = [item[0] for item in candidates if item[0]['observed_at'][:10] == previous_day
                     and item[0].get('lens_config_id') == row.get('lens_config_id')
                     and item[0].get('history_group_key') and item[0].get('history_group_key') == row.get('history_group_key')
                     and item[0].get('currency') == row.get('currency')
                     and item[0].get('price_basis') == row.get('price_basis')]
            change = {'status': 'unavailable', 'reason': 'no_previous_calendar_day_same_configuration'}
            if prior:
                baseline = max(prior, key=lambda r: r['observed_at'])
                old, new = Decimal(str(baseline['quoted_subtotal'])), Decimal(str(row['quoted_subtotal']))
                if old:
                    change = {'status': 'ok', 'value': str((new-old)/old*100), 'unit': 'percent',
                              'baseline_date': previous_day, 'baseline_evidence_id': baseline['evidence_id']}
                else:
                    change = {'status': 'unavailable', 'reason': 'zero_baseline'}
            featured[category] = {'status': 'ok', 'price': row['quoted_subtotal'], 'currency': row['currency'],
                                  'observed_at': row['observed_at'], 'evidence_id': row['evidence_id'],
                                  'lens_config_id': row['lens_config_id'], 'selection_path': lens.get('selection_path'),
                                  'technology': technology, 'change': change,
                                  'price_basis': row.get('price_basis')}
            if category == 'standard' and technology == 'Standard Lenses':
                by_day = {}
                for observed, _, tech in candidates:
                    if tech != 'Standard Lenses' or observed.get('lens_config_id') != row.get('lens_config_id'):
                        continue
                    day = observed['observed_at'][:10]
                    if day not in by_day or observed['observed_at'] > by_day[day]['observed_at']:
                        by_day[day] = observed
                sparkline = [{'date': day, 'price': observed['quoted_subtotal'],
                              'evidence_id': observed['evidence_id']}
                             for day, observed in sorted(by_day.items())]
        result.append({'product_id': pid, 'name': product.get('name'), 'brand': product.get('brand'),
                       'market': product.get('market'), 'product_url': product.get('product_url'),
                       'thumbnail_local': product.get('thumbnail_local'),
                       'featured': featured, 'standard_sparkline': sparkline})
    return result

"""Evidence-linked alert inputs. Thresholds are presentation settings, not facts."""
from collections import defaultdict
from datetime import date, timedelta

from .core import percent_change


OUT_OF_STOCK = {'out_of_stock', 'outofstock', 'sold_out', 'https://schema.org/OutOfStock'}


def build_alert_inputs(dataset):
    prices = defaultdict(lambda: defaultdict(list))
    stock = defaultdict(lambda: defaultdict(list))
    for row in dataset.get('records', []):
        observed = row.get('observed_at')
        if not observed or not row.get('evidence_id'):
            continue
        day = observed[:10]
        if row.get('entity_type') == 'price_observation' and row.get('status') == 'ok':
            key = (row.get('product_id'), row.get('variant_id'), row.get('lens_config_id'),
                   row.get('market'), row.get('currency'), row.get('source_kind'),
                   row.get('price_basis'), row.get('history_group_key'))
            if all(key) and row.get('quoted_subtotal') is not None:
                prices[key][day].append(row)
        if row.get('entity_type') == 'variant' and row.get('availability'):
            key = (row.get('product_id'), row.get('variant_id'), row.get('market'))
            if all(key):
                stock[key][day].append(row)
    changes = []
    for key, by_day in prices.items():
        days = sorted(by_day)
        for previous_day, current_day in zip(days, days[1:]):
            previous = max(by_day[previous_day], key=lambda r: r['observed_at'])
            current = max(by_day[current_day], key=lambda r: r['observed_at'])
            change = percent_change(current['quoted_subtotal'], previous['quoted_subtotal'])
            changes.append({'product_id': key[0], 'variant_id': key[1], 'lens_config_id': key[2],
                            'market': key[3], 'currency': key[4], 'source_kind': key[5],
                            'price_basis': key[6], 'baseline_at': previous['observed_at'],
                            'current_at': current['observed_at'],
                            'baseline': previous['quoted_subtotal'], 'current': current['quoted_subtotal'],
                            'baseline_record_id': previous['record_id'], 'current_record_id': current['record_id'],
                            'baseline_evidence_id': previous['evidence_id'],
                            'current_evidence_id': current['evidence_id'],
                            'change': change, 'scope': 'same_configuration_observed_quote'})
    stock_runs = []
    for key, by_day in stock.items():
        ordered = [(day, max(rows, key=lambda r: r['observed_at'])) for day, rows in sorted(by_day.items())]
        run = []
        for day, row in ordered:
            if row['availability'] not in OUT_OF_STOCK:
                if run:
                    stock_runs.append(_stock_run(key, run))
                    run = []
                continue
            if run and date.fromisoformat(day) != date.fromisoformat(run[-1][0]) + timedelta(days=1):
                stock_runs.append(_stock_run(key, run))
                run = []
            run.append((day, row))
        if run:
            stock_runs.append(_stock_run(key, run))
    return {'price_changes': changes, 'stockout_runs': stock_runs,
            'stock_observation_count': sum(len(days) for days in stock.values()),
            'defaults': {'price_change_percent': 10, 'stockout_consecutive_days': 3}}


def _stock_run(key, rows):
    return {'product_id': key[0], 'variant_id': key[1], 'market': key[2],
            'start': rows[0][0], 'end': rows[-1][0], 'days': len(rows),
            'record_ids': [row['record_id'] for _, row in rows],
            'evidence_ids': [row['evidence_id'] for _, row in rows]}

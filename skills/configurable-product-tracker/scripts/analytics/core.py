"""Conservative calculations: incompatible or missing inputs never become zero."""

from decimal import Decimal, InvalidOperation
from datetime import date, timedelta

PRICE_KEYS = ("product_id", "variant_id", "lens_config_id", "market", "currency",
              "eligibility", "pair_basis", "tax_included", "shipping_included")


def _decimal(value):
    if value is None or isinstance(value, bool):
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError):
        return None


def percent_change(current, baseline):
    new, old = _decimal(current), _decimal(baseline)
    if new is None or old is None:
        return {"status": "unavailable", "reason": "missing_or_invalid_value", "value": None}
    if old == 0:
        return {"status": "unavailable", "reason": "zero_baseline", "value": None}
    return {"status": "ok", "unit": "percent", "value": str((new - old) / old * 100)}


def compare_daily_periods(current, baseline):
    """Compare two complete, consecutive natural days with matching scope."""
    if not current.get('complete') or not baseline.get('complete'):
        return {'status': 'unavailable', 'reason': 'incomplete_day', 'value': None}
    try:
        current_day = date.fromisoformat(current['day'])
        baseline_day = date.fromisoformat(baseline['day'])
    except (KeyError, TypeError, ValueError):
        return {'status': 'unavailable', 'reason': 'invalid_period', 'value': None}
    if current_day - baseline_day != timedelta(days=1):
        return {'status': 'incomparable', 'reason': 'nonconsecutive_days', 'value': None}
    if current.get('scope') != baseline.get('scope'):
        return {'status': 'incomparable', 'reason': 'different_scope', 'value': None}
    return percent_change(current.get('value'), baseline.get('value'))


def compare_month_periods(current, baseline):
    """Compare complete months or equal elapsed days of consecutive months."""
    try:
        current_start = date.fromisoformat(current['start'])
        current_end = date.fromisoformat(current['end'])
        baseline_start = date.fromisoformat(baseline['start'])
        baseline_end = date.fromisoformat(baseline['end'])
    except (KeyError, TypeError, ValueError):
        return {'status': 'unavailable', 'reason': 'invalid_period', 'value': None}
    if any(day.day != 1 for day in (current_start, baseline_start)) or current_end < current_start or baseline_end < baseline_start:
        return {'status': 'unavailable', 'reason': 'invalid_period', 'value': None}
    month_after_baseline = date(baseline_start.year + (baseline_start.month == 12), baseline_start.month % 12 + 1, 1)
    if month_after_baseline != current_start or current.get('scope') != baseline.get('scope'):
        return {'status': 'incomparable', 'reason': 'different_scope_or_month', 'value': None}
    current_next = date(current_start.year + (current_start.month == 12), current_start.month % 12 + 1, 1)
    baseline_next = current_start
    if current_end >= current_next or baseline_end >= baseline_next:
        return {'status': 'unavailable', 'reason': 'invalid_period', 'value': None}
    current_days = (current_end - current_start).days + 1
    baseline_days = (baseline_end - baseline_start).days + 1
    current_complete = current_end == current_next - timedelta(days=1)
    baseline_complete = baseline_end == baseline_next - timedelta(days=1)
    if current_complete != baseline_complete or (not current_complete and current_days != baseline_days):
        return {'status': 'incomparable', 'reason': 'unequal_elapsed_days', 'value': None}
    change = percent_change(current.get('value'), baseline.get('value'))
    if change['status'] != 'ok':
        return change
    value = _decimal(current['value'])
    return {**change, 'label': '月环比' if current_complete else '月累计环比',
            'daily_average_current': str(value / current_days),
            'current_days': current_days, 'baseline_days': baseline_days}


def percentage_point_change(current_share, baseline_share):
    new, old = _decimal(current_share), _decimal(baseline_share)
    if new is None or old is None:
        return {"status": "unavailable", "reason": "missing_or_invalid_value", "value": None}
    return {"status": "ok", "unit": "percentage_points", "value": str(new - old)}


def compare_prices(current, baseline):
    if not baseline:
        return {"status": "unavailable", "reason": "no_comparable_history", "value": None}
    missing = [key for key in PRICE_KEYS if current.get(key) is None or baseline.get(key) is None]
    if missing:
        return {"status": "incomparable", "reason": "unconfirmed_configuration", "fields": missing, "value": None}
    different = [key for key in PRICE_KEYS if current[key] != baseline[key]]
    if different:
        return {"status": "incomparable", "reason": "different_scope", "fields": different, "value": None}
    if current.get("source_kind") != baseline.get("source_kind"):
        return {"status": "incomparable", "reason": "different_data_nature", "value": None}
    if current.get("status") != "ok" or baseline.get("status") != "ok":
        return {"status": "unavailable", "reason": "source_status", "value": None}
    result = percent_change(current.get("complete_pair_price"), baseline.get("complete_pair_price"))
    result["evidence_ids"] = [baseline.get("evidence_id"), current.get("evidence_id")]
    return result


def analyze(dataset, comparison_policy=None):
    records = dataset.get("records", [])
    products = {r.get("product_id") for r in records if r.get("entity_type") == "product" and r.get("status") == "ok"}
    variants = {r.get("variant_id") for r in records if r.get("entity_type") == "variant" and r.get("status") == "ok"}
    prices = [r for r in records if r.get("entity_type") == "price_observation" and r.get("status") == "ok"]
    values = [(_decimal(r.get("quoted_subtotal")), r) for r in prices]
    values = [(v, r) for v, r in values if v is not None]
    def count_metric(name, value, unit, rows):
        return {"metric": name, "value": value, "unit": unit, "scope": "observed_records",
                "evidence_ids": sorted({r["evidence_id"] for r in rows if r.get("evidence_id")}),
                "observed_at_latest": max((r["observed_at"] for r in rows if r.get("observed_at")), default=None),
                "source_kinds": sorted({r["source_kind"] for r in rows if r.get("source_kind")})}
    metrics = [
        count_metric("observed_product_count", len(products), "products",
                     [r for r in records if r.get("entity_type") == "product" and r.get("status") == "ok"]),
        count_metric("public_variant_count", len(variants), "variants",
                     [r for r in records if r.get("entity_type") == "variant" and r.get("status") == "ok"]),
        count_metric("observed_quoted_configuration_count", len(prices), "configurations", prices),
    ]
    if values:
        currencies = {r.get("currency") for _, r in values}
        if len(currencies) == 1:
            for name, (value, record) in (("observed_min_quoted_subtotal", min(values, key=lambda x: x[0])),
                                          ("observed_max_quoted_subtotal", max(values, key=lambda x: x[0]))):
                metrics.append({"metric": name, "value": str(value), "currency": record.get("currency"),
                                "scope": "observed_records", "price_basis": record.get("price_basis"),
                                "observed_at": record.get("observed_at"),
                                "source_kind": record.get("source_kind"), "evidence_ids": [record["evidence_id"]]})
    flags = list(dataset.get("quality_flags", []))
    if not prices:
        flags.append({"code": "no_observed_prices", "reason": "no_usable_price_records"})
    elif len({r.get("currency") for r in prices}) > 1:
        flags.append({"code": "mixed_currency_price_range"})
    if prices:
        quoted_days = {}
        for record in prices:
            key = record.get('history_group_key')
            if key and record.get('observed_at'):
                quoted_days.setdefault((record.get('product_id'), key, record.get('currency')),
                                       set()).add(record['observed_at'][:10])
        observed_series = sum(len(days) >= 2 for days in quoted_days.values())
        if observed_series:
            metrics.append({'metric': 'observed_quoted_history_series_count', 'value': observed_series,
                            'unit': 'configurations', 'scope': 'observed_quotes_only',
                            'limitation': 'tax_shipping_and_eligibility_unverified'})
        flags.append({"code": "no_comparable_history", "reason": "no_fully_qualified_price_comparison"
                      if observed_series else "first_observed_run"})
        if any(r.get("complete_pair_price") is None for r in prices):
            flags.append({"code": "total_price_unverified", "reason": "tax_shipping_or_pair_basis_unverified"})
    return {"metrics": metrics, "findings": [], "quality_flags": flags,
            "coverage": dataset.get("coverage", {}), "evidence": dataset.get("evidence", []),
            "errors": dataset.get("errors", [])}

from analytics.core import compare_daily_periods, compare_month_periods


def test_unfinished_day_is_not_compared():
    result = compare_daily_periods(
        {'day': '2026-09-28', 'complete': False, 'value': '120'},
        {'day': '2026-09-27', 'complete': True, 'value': '100'},
    )
    assert result == {'status': 'unavailable', 'reason': 'incomplete_day', 'value': None}


def test_equal_elapsed_monthly_totals_and_daily_average():
    result = compare_month_periods(
        {'start': '2026-09-01', 'end': '2026-09-10', 'value': '120'},
        {'start': '2026-08-01', 'end': '2026-08-10', 'value': '100'},
    )
    assert result['status'] == 'ok'
    assert result['label'] == '月累计环比'
    assert result['value'] == '20.0'
    assert result['daily_average_current'] == '12'


def test_month_comparison_rejects_different_elapsed_days():
    result = compare_month_periods(
        {'start': '2026-09-01', 'end': '2026-09-10', 'value': '120'},
        {'start': '2026-08-01', 'end': '2026-08-09', 'value': '100'},
    )
    assert result['reason'] == 'unequal_elapsed_days'

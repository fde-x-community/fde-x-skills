"""Offline, synthetic R14 acceptance cases; writes a reviewable JSON result file."""
import json
import tempfile
from pathlib import Path

from analytics.core import compare_daily_periods, compare_month_periods, compare_prices, percent_change, percentage_point_change
from storage import SnapshotStore


def price(**changes):
    row = dict(product_id="p", variant_id="v", lens_config_id="l", market="US",
               currency="USD", eligibility="public", pair_basis="pair",
               tax_included=False, shipping_included=False,
               source_kind="synthetic_fixture", status="ok",
               complete_pair_price="100", evidence_id="ev-old")
    row.update(changes)
    return row


def compact(result):
    return {key: result.get(key) for key in ("status", "reason", "unit", "value", "fields")
            if key in result}


def main():
    cases = []

    def add(name, category, inputs, expected, action, correction="无；通过后无需修正"):
        try:
            actual = action()
        except Exception as exc:
            actual = {"error": type(exc).__name__, "message": str(exc)}
        cases.append(dict(id=f"S5-{len(cases)+1:02d}", name=name, category=category,
                          input=inputs, expected=expected, actual=actual,
                          passed=actual == expected,
                          correction="无；通过后无需修正" if actual == expected else correction))

    def pct(name, current, baseline, expected):
        add(name, "环比/增长率", {"current": current, "baseline": baseline}, expected,
            lambda: compact(percent_change(current, baseline)))

    pct("正向增长", "120", "100", {"status": "ok", "unit": "percent", "value": "20.0"})
    pct("负向增长", "80", "100", {"status": "ok", "unit": "percent", "value": "-20.0"})
    add("未完结自然日不可做日环比", "日环比",
        {"baseline": {"day": "2026-09-27", "complete": True, "value": "100"},
         "current": {"day": "2026-09-28", "complete": False, "value": "120"}},
        {"status": "unavailable", "reason": "incomplete_day", "value": None},
        lambda: compact(compare_daily_periods(
            {"day": "2026-09-28", "complete": False, "value": "120"},
            {"day": "2026-09-27", "complete": True, "value": "100"})),
        "检查日比较入口的完整性校验。")
    pct("零基期", "5", "0", {"status": "unavailable", "reason": "zero_baseline", "value": None})
    pct("缺失本期", None, "100", {"status": "unavailable", "reason": "missing_or_invalid_value", "value": None})
    pct("无效基期", "100", "bad", {"status": "unavailable", "reason": "missing_or_invalid_value", "value": None})

    def cmp(name, changes, expected, correction="检查可比维度和状态；补齐规则后重跑"):
        current = price(complete_pair_price="125", evidence_id="ev-new", **changes)
        add(name, "同配置价格", {"baseline": price(), "current": current}, expected,
            lambda: compact(compare_prices(current, price())), correction)

    cmp("同配置上涨", {}, {"status": "ok", "unit": "percent", "value": "25.00"})
    cmp("跨市场", {"market": "UK"}, {"status": "incomparable", "reason": "different_scope", "fields": ["market"], "value": None})
    cmp("跨币种", {"currency": "GBP"}, {"status": "incomparable", "reason": "different_scope", "fields": ["currency"], "value": None})
    cmp("不同镜片配置", {"lens_config_id": "l2"}, {"status": "incomparable", "reason": "different_scope", "fields": ["lens_config_id"], "value": None})
    cmp("不同优惠资格", {"eligibility": "member"}, {"status": "incomparable", "reason": "different_scope", "fields": ["eligibility"], "value": None})
    cmp("税费口径不同", {"tax_included": True}, {"status": "incomparable", "reason": "different_scope", "fields": ["tax_included"], "value": None})
    cmp("不同数据性质", {"source_kind": "third_party_estimate"}, {"status": "incomparable", "reason": "different_data_nature", "value": None})
    cmp("本期来源不可得", {"status": "unavailable"}, {"status": "unavailable", "reason": "source_status", "value": None})
    add("无历史", "同配置价格", {"current": price(), "baseline": None},
        {"status": "unavailable", "reason": "no_comparable_history", "value": None},
        lambda: compact(compare_prices(price(), None)))
    add("缺少配置标识", "同配置价格", {"current": price(lens_config_id=None), "baseline": price()},
        {"status": "incomparable", "reason": "unconfirmed_configuration", "fields": ["lens_config_id"], "value": None},
        lambda: compact(compare_prices(price(lens_config_id=None), price())))
    add("渠道份额百分点", "渠道", {"current_share": "35", "baseline_share": "30"},
        {"status": "ok", "unit": "percentage_points", "value": "5"},
        lambda: compact(percentage_point_change("35", "30")))
    add("渠道份额缺失", "渠道", {"current_share": None, "baseline_share": "30"},
        {"status": "unavailable", "reason": "missing_or_invalid_value", "value": None},
        lambda: compact(percentage_point_change(None, "30")))

    with tempfile.TemporaryDirectory() as root:
        store = SnapshotStore(root)
        old = {"record_id": "historical-1", "observed_at": "2026-08-31T00:00:00Z",
               "source_kind": "synthetic_fixture", "product_id": "p", "value": "100"}
        first = store.append(old)
        second = store.append(dict(old, value="105"))
        actual = [{"revision": r["revision"], "value": r["value"]}
                  for r in store.query(kind="synthetic_fixture", product_id="p")]
        add("历史修订保留两版", "修订", {"first": first, "correction": second},
            [{"revision": 1, "value": "100"}, {"revision": 2, "value": "105"}], lambda: actual)

    add("未完结月份同日范围及日均", "月环比",
        {"baseline": {"start": "2026-08-01", "end": "2026-08-10", "value": "100"},
         "current": {"start": "2026-09-01", "end": "2026-09-10", "value": "120"}},
        {"status": "ok", "label": "月累计环比", "value": "20.0", "daily_average_current": "12"},
        lambda: {key: compare_month_periods(
            {"start": "2026-09-01", "end": "2026-09-10", "value": "120"},
            {"start": "2026-08-01", "end": "2026-08-10", "value": "100"})[key]
            for key in ("status", "label", "value", "daily_average_current")},
        "检查月期间比较入口与日均口径。")

    output = Path(__file__).with_name("20_cases_result.json")
    output.write_text(json.dumps({"data_nature": "synthetic_fixture", "case_count": len(cases),
                                  "passed": sum(c["passed"] for c in cases),
                                  "failed": sum(not c["passed"] for c in cases),
                                  "cases": cases}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(f"{len(cases)} cases: {sum(c['passed'] for c in cases)} passed, {sum(not c['passed'] for c in cases)} failed")
    print(output)


if __name__ == "__main__":
    main()

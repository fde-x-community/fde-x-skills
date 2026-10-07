"""Build a Session 3 dataset/analysis and Session 4 page from monitor history."""
import argparse
from datetime import datetime, timedelta, date
import json
from pathlib import Path

from analytics import analyze
from normalization.monitoring import import_monitor_report
from normalization.firmoo import import_firmoo_prices
from normalization.incremental import append_incremental_observations
from dashboard import render_dashboard


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path)
    parser.add_argument('output', type=Path)
    parser.add_argument('--firmoo', type=Path, help='Optional verified Firmoo US/UK secondary-choice export')
    parser.add_argument('--incremental', type=Path, help='Optional verified same-configuration daily observations')
    parser.add_argument('--external-bundle', type=Path, help='Optional external search attempt log')
    parser.add_argument('--mode', choices=('historical_replay', 'live_observation'), default='historical_replay')
    parser.add_argument('--period-start', help='Requested display range start (YYYY-MM-DD)')
    parser.add_argument('--period-end', help='Requested display range end (YYYY-MM-DD)')
    parser.add_argument('--show-live-current', action='store_true',
                        help='Include current run-day observations in the initial dashboard filter')
    parser.add_argument('--reused-monitor-cache', action='store_true',
                        help='Some quotes come from verified monitor observations collected earlier today')
    parser.add_argument('--fresh-collected', action='store_true',
                        help='The same report also includes newly collected cart quotes')
    args = parser.parse_args()
    if bool(args.period_start) != bool(args.period_end):
        parser.error('period-start and period-end must be supplied together')
    if args.period_start:
        try:
            start_day, end_day = datetime.fromisoformat(args.period_start).date(), datetime.fromisoformat(args.period_end).date()
        except ValueError:
            parser.error('period dates must use YYYY-MM-DD')
        if start_day > end_day:
            parser.error('period-start must not follow period-end')
    dataset = import_monitor_report(args.source)
    if args.firmoo:
        extra = import_firmoo_prices(args.firmoo)
        for key in ('records', 'evidence', 'errors', 'quality_flags'):
            dataset[key].extend(extra.get(key, []))
        dataset['coverage'] = {'sources': [dataset['coverage'], extra['coverage']],
                               'completeness': 'partial'}
    incremental_count = append_incremental_observations(dataset, args.incremental) if args.incremental else 0
    external = json.loads(args.external_bundle.read_text(encoding='utf-8')) if args.external_bundle else None
    if external:
        for record in external.get('records', []):
            if record.get('granularity') == 'month' and record.get('period_label') and not record.get('data_period_start'):
                try:
                    month = datetime.strptime(record['period_label'], '%B %Y').date()
                    following = date(month.year + (month.month == 12), month.month % 12 + 1, 1)
                    record['data_period_start'] = month.isoformat()
                    record['data_period_end'] = (following - timedelta(days=1)).isoformat()
                except ValueError:
                    pass
            dataset['records'].append(record)
        dataset['evidence'].extend(external.get('evidence', []))
        dataset['errors'].extend(external.get('errors', []))
    analysis = analyze(dataset)
    source = json.loads(args.source.read_text(encoding='utf-8'))
    today = datetime.now().astimezone().date()
    limitation = ('包含今日已核验的 ' + str(incremental_count) + ' 条购物车报价；今日采集未完成，部分商品配置缺失。税费、运费与优惠资格未验证，不是成交价。'
                  if args.incremental else
                  '复用今日定时监测的已核验购物车报价' + ('，并包含本次新增采集' if args.fresh_collected else '') + '；每条保留实际观测时间。税费、运费与优惠资格未验证，不是成交价。'
                  if args.reused_monitor_cache else
                  '本次实时购物车报价；每条仅代表实际观测时点。税费、运费与优惠资格未验证，缺少的来源和商品类型不补造。'
                  if args.mode == 'live_observation' else
                  '真实历史购物车报价；税费、运费与优惠资格未验证，不是成交价。缺少的来源和商品类型不补造。')
    manifest = {'run_id': 'monitoring-' + str(source.get('today', 'history')),
                'products': ['Vooglam ' + p['name'] for p in source['products']] +
                            (['Firmoo ' + p['name'] for p in dataset['records'] if p['entity_type']=='product' and p['brand']=='Firmoo'] if args.firmoo else []),
                'market': 'US/UK' if args.firmoo else 'US', 'currency': 'USD/GBP' if args.firmoo else 'USD', 'period_start': args.period_start or (today-timedelta(days=30)).isoformat(),
                'period_end': args.period_end or (today-timedelta(days=1)).isoformat(), 'generated_at': datetime.now().astimezone().isoformat(),
                'mode': 'mixed_observations' if args.incremental else args.mode, 'status': 'partial',
                'limitation': limitation}
    if args.show_live_current and args.mode == 'live_observation':
        manifest['display_period_end'] = today.isoformat()
    if external:
        products = {(r.get('brand', '').casefold(), r.get('name', '').casefold(), r.get('market')): r['product_id']
                    for r in dataset['records'] if r.get('entity_type') == 'product'}
        manifest['trend_attempts'] = [
            {'product_id': products.get((s.get('merchant', '').casefold(), s.get('product', '').casefold(),
                                         s.get('market', 'US'))),
             'brand': s.get('merchant'), 'product_name': s.get('product'), 'source': '网页搜索',
             'query': s.get('query'), 'checked_at': external.get('captured_at'),
             'status': s.get('status'), 'outcome': s.get('reason'), 'url': (s.get('urls') or [None])[0]}
            for s in external.get('search_signals', [])]
        manifest['trend_source_status'] = [s for s in external.get('sources', [])
                                           if s.get('source') == 'Google Trends']
    result = render_dashboard(dataset, analysis, manifest, args.output)
    print(json.dumps({**result, 'records': len(dataset['records']),
                      'history_prices': sum(r['entity_type']=='price_observation' for r in dataset['records']),
                      'evidence': len(dataset['evidence'])}, ensure_ascii=False))


if __name__ == '__main__':
    main()

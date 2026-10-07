"""Collect a confirmed brand/product list and build one offline dashboard.

Known official URLs are only discovery aids. Every live collector still checks
the actual product identity before accepting a cart observation.
"""
import argparse
from datetime import datetime, timedelta
from importlib.util import find_spec
import json
import os
from pathlib import Path
import re
import subprocess
import sys

from firmoo_lens_tree import validate_url
from .reach_backend import search
from .live import COLLECTORS
from .monitor_cache import find_reusable, write_reused_source


ROOT = Path(__file__).resolve().parents[1]
CATALOG = Path(__file__).with_name('known_products.json')


def read_products(path):
    raw = path.read_text(encoding='utf-8-sig')
    if path.suffix.lower() == '.json':
        data = json.loads(raw)
        items = data.get('products', []) if isinstance(data, dict) else data
    else:
        items = [line.strip() for line in raw.splitlines()
                 if line.strip() and not line.lstrip().startswith('#')]
    if not isinstance(items, list) or not items:
        raise ValueError('请提供非空的品牌－商品名列表')
    products = []
    for item in items:
        if isinstance(item, str):
            match = re.match(r'^\s*(Vooglam|Firmoo)\s*[-－—–:]\s*(.+?)\s*$', item, re.I)
            if not match:
                match = re.match(r'^\s*(Vooglam|Firmoo)\s+(.+?)\s*$', item, re.I)
            if not match:
                raise ValueError('名单每行使用“Vooglam - Okinawa”或“Firmoo - S939”')
            item = {'merchant': match.group(1), 'product': match.group(2)}
        if not isinstance(item, dict):
            raise ValueError('商品项必须是品牌－商品名或对象')
        brand = str(item.get('merchant') or item.get('brand') or '').strip().casefold()
        if brand not in ('vooglam', 'firmoo'):
            raise ValueError('当前实时采集仅支持 Vooglam 和 Firmoo')
        name = str(item.get('product') or item.get('name') or '').strip()
        if not name:
            raise ValueError('商品名不能为空')
        market = str(item.get('market') or 'US').upper()
        if market not in ('US', 'UK') or brand == 'vooglam' and market != 'US':
            raise ValueError('Vooglam 仅支持 US；Firmoo 支持 US 或 UK')
        products.append({'merchant': brand.title(), 'product': name,
                         'market': market, 'url': item.get('url')})
    return products


def resolve_products(products, catalog):
    resolved, questions = [], []
    for item in products:
        matches = [entry for entry in catalog
                   if entry['merchant'].casefold() == item['merchant'].casefold()
                   and entry['product'].casefold() == item['product'].casefold()
                   and entry['market'] == item['market']]
        url = item.get('url') or (matches[0]['url'] if len(matches) == 1 else None)
        if not url:
            questions.append({'input': item, 'reason': '未找到唯一的已核验官网链接；请核对官网商品名、型号、配色并提供 URL',
                              'candidates': [entry['url'] for entry in matches]})
            continue
        try:
            if item['merchant'] == 'Vooglam':
                if not re.fullmatch(r'https://www\.vooglam\.com/goods-detail/\d+/?', url):
                    raise ValueError('不是 Vooglam 官方商品链接')
            else:
                validate_url(url, item['market'].lower())
        except ValueError as exc:
            questions.append({'input': item, 'reason': str(exc), 'candidates': []})
            continue
        resolved.append({**item, 'url': url})
    return resolved, questions


def run_step(name, command, cwd, output, *, allow_partial=False, tolerate_failure=False):
    log = output / (name + '.log')
    environment = dict(os.environ, PYTHONIOENCODING='utf-8')
    with log.open('w', encoding='utf-8') as stream:
        result = subprocess.run(command, cwd=cwd, env=environment,
                                stdout=stream, stderr=subprocess.STDOUT)
    if result.returncode not in ((0, 2) if allow_partial else (0,)) and not tolerate_failure:
        raise RuntimeError(f'{name} 失败；详情见 {log}')
    return {'step': name, 'exit_code': result.returncode, 'log': str(log)}


def external_attempts(products, existing, target):
    bundle = json.loads(existing.read_text(encoding='utf-8')) if existing.is_file() else {
        'captured_at': datetime.now().astimezone().isoformat(), 'search_signals': [], 'sources': []}
    for item in products:
        query = f"{item['merchant']} {item['product']} eyeglasses reviews"
        try:
            response = search(query)
            urls = list(dict.fromkeys(re.findall(r'https?://[^\s<>\[\]"\)]+', response)))
            status, reason = 'leads_only', '取得网页搜索线索，尚未核验为独立商品需求趋势'
        except Exception as exc:
            urls, status, reason = [], 'unavailable', str(exc)
        bundle['search_signals'].append({'merchant': item['merchant'], 'product': item['product'],
                                          'market': item['market'],
                                          'query': query, 'status': status, 'reason': reason, 'urls': urls})
    if not any(s.get('source') == 'Google Trends' for s in bundle['sources']):
        bundle['sources'].append({'source': 'Google Trends', 'status': 'not_connected',
                                  'reason': '本次未取得同地区、同窗口的商品级搜索指数'})
    target.write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding='utf-8')
    return target


def preflight(products):
    """Fail clearly before starting a collection that cannot run here."""
    missing = []
    if find_spec('playwright') is None:
        missing.append('当前 Python 缺少 Playwright；在 scripts 目录运行 python -m pip install -r skill/requirements.txt，随后运行 python -m playwright install chromium')
    if any(p['merchant'] == 'Vooglam' for p in products):
        missing_files = [name for name in COLLECTORS if not (ROOT / name).is_file()]
        if missing_files:
            missing.append('安装包缺少 Vooglam 采集文件：' + ', '.join(missing_files) + '；请重新打包并安装完整 Skill')
    return missing


def result_status(verified, steps):
    if verified == 0:
        return 'failed'
    if any(step['exit_code'] != 0 for step in steps):
        return 'partial'
    return 'completed'


def main():
    parser = argparse.ArgumentParser(description='品牌－商品名列表 → 实时采集 → 一个离线看板')
    parser.add_argument('--input', type=Path, required=True, help='UTF-8 文本名单或 JSON；可附已核对的官网 URL')
    parser.add_argument('--output', type=Path, required=True, help='全新输出目录')
    parser.add_argument('--tier', choices=('classic', 'medium', 'full'), default='classic')
    parser.add_argument('--channel', choices=('chrome', 'msedge'), default='chrome')
    parser.add_argument('--headless', action='store_true')
    parser.add_argument('--dry-run', action='store_true', help='仅解析名单和链接，不联网采集')
    parser.add_argument('--force-refresh', action='store_true', help='忽略今日监测缓存，重新采集')
    parser.add_argument('--start', help='看板默认监测起日 YYYY-MM-DD')
    parser.add_argument('--end', help='看板默认监测止日 YYYY-MM-DD')
    args = parser.parse_args()
    request_file = json.loads(args.input.read_text(encoding='utf-8-sig')) if args.input.suffix.lower() == '.json' else {}
    supplied_period = request_file.get('monitoring_period') or request_file.get('period') if isinstance(request_file, dict) else None
    if bool(args.start) != bool(args.end):
        parser.error('--start and --end must be supplied together')
    if args.start:
        supplied_period = {'start': args.start, 'end': args.end}
    period_explicit = bool(supplied_period)
    if supplied_period:
        try:
            start_day = datetime.fromisoformat(supplied_period['start']).date()
            end_day = datetime.fromisoformat(supplied_period['end']).date()
        except (KeyError, TypeError, ValueError):
            parser.error('monitoring period must contain YYYY-MM-DD start and end')
        if start_day > end_day:
            parser.error('monitoring period start must not follow end')
    else:
        end_day = datetime.now().date() - timedelta(days=1)
        start_day = end_day - timedelta(days=29)
        supplied_period = {'start': start_day.isoformat(), 'end': end_day.isoformat()}
    catalog = json.loads(CATALOG.read_text(encoding='utf-8'))
    products, questions = resolve_products(read_products(args.input), catalog)
    output = args.output.resolve()
    if questions:
        if output.exists():
            parser.error('输出目录已存在；请选择新目录，避免覆盖旧证据')
        output.mkdir(parents=True)
        target = output / 'clarification.json'
        target.write_text(json.dumps({'status': 'needs_clarification', 'questions': questions},
                                     ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'status': 'needs_clarification', 'file': str(target)}, ensure_ascii=False))
        return 2
    today = datetime.now().astimezone().date().isoformat()
    reusable, cache_warnings = ({}, []) if args.force_refresh else find_reusable(
        products, args.tier, ROOT / 'monitoring', today)
    pending = [p for p in products if p['merchant'] != 'Vooglam' or p['url'].rstrip('/') not in reusable]
    reused_summary = [{'product': entry['product']['name'], 'url': url,
                       'today_configurations': len(entry['today_rows']),
                       'latest_observed_at': max(r['observed_at'] for r in entry['today_rows'])}
                      for url, entry in reusable.items()]
    if args.dry_run:
        print(json.dumps({'status': 'resolved', 'products': products, 'monitoring_period': supplied_period,
                          'period_user_specified': period_explicit,
                          'reused_today': reused_summary, 'needs_collection': pending,
                          'cache_warnings': cache_warnings,
                          'runtime_issues': preflight(pending) if pending else []}, ensure_ascii=False))
        return 0
    issues = preflight(pending) if pending else []
    if issues:
        print(json.dumps({'status': 'preflight_failed', 'issues': issues}, ensure_ascii=False))
        return 1
    if output.exists():
        parser.error('输出目录已存在；请选择新目录，避免覆盖旧证据')
    output.mkdir(parents=True)
    (output / 'resolved_request.json').write_text(json.dumps({'products': products, 'monitoring_period': supplied_period,
                                                              'period_user_specified': period_explicit}, ensure_ascii=False,
                                                            indent=2), encoding='utf-8')
    steps = []
    vooglam = [p for p in pending if p['merchant'] == 'Vooglam']
    firmoo = [p for p in products if p['merchant'] == 'Firmoo']
    try:
        if vooglam:
            request = output / 'vooglam_request.json'
            request.write_text(json.dumps({'products': vooglam, 'market': 'US', 'currency': 'USD', 'monitoring_period': supplied_period,
                                           'period_user_specified': period_explicit},
                                          ensure_ascii=False, indent=2), encoding='utf-8')
            command = [sys.executable, '-m', 'skill.live', '--input', str(request),
                       '--output', str(output / 'vooglam'), '--tier', args.tier,
                       '--channel', args.channel, '--external', 'online']
            steps.append(run_step('vooglam_live', command, ROOT, output, tolerate_failure=True))
        firmoo_root = output / 'firmoo'
        if firmoo:
            for index, item in enumerate(firmoo, 1):
                market = item['market'].lower()
                command = [sys.executable, str(ROOT / 'firmoo_lens_tree.py'),
                           '--market', market, f'--{market}-url', item['url'],
                           '--expected-model', item['product'], '--tier', args.tier,
                           '--channel', args.channel, '--output', str(firmoo_root)]
                if args.headless:
                    command.append('--headless')
                steps.append(run_step(f'firmoo_{index}', command, ROOT, output,
                                      allow_partial=True, tolerate_failure=True))
            steps.append(run_step('firmoo_export', [sys.executable, str(ROOT / 'firmoo_build_report.py'),
                                                    '--input', str(firmoo_root)], ROOT, output))
        source = output / 'vooglam' / 'prices.json'
        if reusable:
            reused_source = output / 'reused_vooglam_prices.json'
            reused_data = write_reused_source(reusable, reused_source, today)
            steps.append({'step': 'vooglam_monitor_cache', 'exit_code': 0,
                          'source': str(ROOT / 'monitoring' / 'history.sqlite3'),
                          'reused_today': reused_summary})
            if source.is_file():
                live_data = json.loads(source.read_text(encoding='utf-8'))
                live_data['products'].extend(reused_data['products'])
                live_data['history'].extend(reused_data['history'])
                live_data['observations'].extend(reused_data['observations'])
                source = output / 'combined_vooglam_prices.json'
                source.write_text(json.dumps(live_data, ensure_ascii=False, indent=2), encoding='utf-8')
            else:
                source = reused_source
        if not source.is_file():
            source = output / 'empty_vooglam_prices.json'
            source.write_text(json.dumps({'today': datetime.now().date().isoformat(),
                                          'generated_at': datetime.now().astimezone().isoformat(),
                                          'products': [], 'history': [], 'scope': 'requested_list'},
                                         ensure_ascii=False), encoding='utf-8')
        command = [sys.executable, '-m', 'analytics.run_monitoring', str(source),
                   str(output / 'dashboard'), '--mode', 'live_observation',
                   '--period-start', supplied_period['start'], '--period-end', supplied_period['end']]
        if not period_explicit:
            command.append('--show-live-current')
        if reusable:
            command.append('--reused-monitor-cache')
            if vooglam or firmoo:
                command.append('--fresh-collected')
        firmoo_file = firmoo_root / 'firmoo_prices.json'
        if firmoo_file.is_file():
            command.extend(('--firmoo', str(firmoo_file)))
        external = external_attempts(firmoo, output / 'vooglam' / 'external' / 'external_bundle.json',
                                     output / 'external_bundle.json')
        command.extend(('--external-bundle', str(external)))
        steps.append(run_step('combined_dashboard', command, ROOT, output))
        dataset = json.loads((output / 'dashboard' / 'normalized_dataset.json').read_text(encoding='utf-8'))
        verified = sum(r.get('entity_type') == 'price_observation' for r in dataset['records'])
        status = result_status(verified, steps)
        result = {'status': status, 'verified_prices': verified,
                  'dashboard': str(output / 'dashboard' / 'index.html'),
                  'steps': steps, 'products': products, 'reused_today': reused_summary,
                  'cache_warnings': cache_warnings}
        if verified == 0:
            result['reason'] = '未取得任何购物车核价；请检查各步日志并处理可恢复失败后重试'
    except Exception as exc:
        result = {'status': 'failed', 'reason': str(exc), 'steps': steps, 'products': products}
    (output / 'run_result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
    print(json.dumps(result, ensure_ascii=False))
    return 0 if result['status'] in ('completed', 'partial') else 1


if __name__ == '__main__':
    raise SystemExit(main())

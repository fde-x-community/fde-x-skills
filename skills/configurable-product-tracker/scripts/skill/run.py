import argparse
from datetime import date, datetime, timedelta, timezone
import json
from pathlib import Path
from dashboard import render_dashboard


def validate_input(raw, today=None):
    today = today or date.today()
    products = raw.get('products', [])
    if isinstance(products, str):
        products = [p.strip() for p in products.splitlines() if p.strip()]
    if not products or not all(isinstance(p, str) and p.strip() for p in products):
        raise ValueError('商品名称或名单必填，填写品牌与名称/型号')
    market = raw.get('market') or 'US'
    if market not in ('US', '美国'):
        raise ValueError('当前接入仅支持 US/USD；其它市场需相应站点与币种')
    window = raw.get('period')
    if not window or window in ('最近30天', 'last30days'):
        start, end = today - timedelta(days=30), today - timedelta(days=1)
    else:
        start, end = date.fromisoformat(window['start']), date.fromisoformat(window['end'])
        if start > end or end >= today:
            raise ValueError('日期需按先后排列，且截止于运行前一日或更早')
    return {'products': [p.strip() for p in products], 'market': 'US', 'currency': 'USD',
            'period_start': start.isoformat(), 'period_end': end.isoformat()}


def resolve_input(spec, dataset):
    catalog = [r for r in dataset['records'] if r.get('entity_type') == 'product'
               and r.get('market') == spec.get('market', 'US')]
    matches, questions = [], []
    for name in spec['products']:
        found = [r for r in catalog if name.casefold() in
                 {(str(r.get('brand', '')) + ' ' + str(r.get('name', ''))).casefold(),
                  (str(r.get('brand', '')) + ' ' + str(r.get('source_product_id', ''))).casefold()}]
        if len(found) != 1:
            questions.append({'input': name, 'reason': '未找到唯一商品身份，请确认官方商品及版本'})
        else:
            matches.append(found[0]['product_id'])
    return {'status': 'needs_clarification' if questions else 'ok', 'product_ids': matches,
            'questions': questions}


def main():
    p = argparse.ArgumentParser(description='将已有真实采集/回放结果组装为六页离线看板；本入口不重新采集')
    p.add_argument('--input', type=Path, required=True)
    p.add_argument('--dataset', type=Path, required=True)
    p.add_argument('--analysis', type=Path, required=True)
    p.add_argument('--output', type=Path, required=True)
    args = p.parse_args()
    spec = validate_input(json.loads(args.input.read_text(encoding='utf-8')))
    dataset = json.loads(args.dataset.read_text(encoding='utf-8'))
    resolution = resolve_input(spec, dataset)
    args.output.mkdir(parents=True, exist_ok=True)
    if resolution['status'] != 'ok':
        (args.output / 'clarification.json').write_text(json.dumps(resolution, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(resolution, ensure_ascii=False))
        return
    ids = set(resolution['product_ids'])
    dataset['records'] = [r for r in dataset['records'] if not r.get('product_id') or r['product_id'] in ids]
    analysis = json.loads(args.analysis.read_text(encoding='utf-8'))
    # Metrics are recomputed by Session 3 on this exact subset, never by the frontend.
    from analytics import analyze
    subset = analyze(dataset)
    subset['findings'] = [f for f in analysis.get('findings', []) if f.get('product_id') in ids]
    manifest = dict(spec, generated_at=datetime.now(timezone.utc).isoformat(),
                    mode='historical_replay', status='partial', interface_version='0.1-provisional',
                    limitation='离线组装已有资料，非本次线上采集；未接入的来源保留缺失。')
    print(json.dumps(render_dashboard(dataset, subset, manifest, args.output), ensure_ascii=False))


if __name__ == '__main__':
    main()

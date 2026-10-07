"""Read today's verified Vooglam monitor observations for list collection."""
from collections import Counter
from contextlib import closing
from datetime import datetime
from decimal import Decimal, InvalidOperation
import json
from pathlib import Path
import shutil
import sqlite3

from monitoring.history import config_key, SCENARIO


def _job_key(item):
    path = item['lens_type'] + (' → ' + item['child'] if item.get('child') else '')
    return path, item['technology'], item['material']


def _row_key(row):
    material = 'auto' if row.get('material') == '未经过材料页' else row.get('material')
    return row.get('lens_path'), row.get('technology'), material


def _valid_row(row, stored_key, product, jobs):
    try:
        if (str(row['product_id']) != str(product['product_id']) or
                row['sku'] != product['sku'] or row['currency'] != 'USD' or
                row.get('source_url', '').rstrip('/') != product['url'].rstrip('/') or
                _row_key(row) not in jobs or config_key(row, SCENARIO) != stored_key):
            return False
        if Decimal(str(row['frame_price'])) + Decimal(str(row['lens_price'])) != Decimal(str(row['total'])):
            return False
        if datetime.fromisoformat(row['observed_at']).tzinfo is None:
            return False
        return all(Path(row[field]).is_file() for field in ('evidence', 'evidence_text'))
    except (KeyError, TypeError, ValueError, InvalidOperation):
        return False


def find_reusable(products, tier, monitor_root, today):
    """Return fully covered products and their evidence-backed monitor history.

    Reuse is deliberately limited to the fixed classic/medium seed groups. A
    monitored set of jobs cannot prove that the site's full option tree is done.
    """
    if tier == 'full':
        return {}, []
    monitor_root = Path(monitor_root)
    config_path, database = monitor_root / 'config.json', monitor_root / 'history.sqlite3'
    if not config_path.is_file() or not database.is_file():
        return {}, []
    try:
        config = json.loads(config_path.read_text(encoding='utf-8'))
        seeds_name = 'vooglam_classic_seeds.json' if tier == 'classic' else 'vooglam_comparison_seeds.json'
        seeds = json.loads((monitor_root.parent / seeds_name).read_text(encoding='utf-8'))
        required = {seed['lens_type'] + (' → ' + seed['child'] if seed.get('child') else '') for seed in seeds}
        wanted = {p['url'].rstrip('/'): p for p in products if p['merchant'] == 'Vooglam'}
        monitored = {p['url'].rstrip('/'): p for p in config['products']
                     if p['url'].rstrip('/') in wanted and
                     p['name'].casefold() == wanted[p['url'].rstrip('/')]['product'].casefold() and
                     str(p['product_id']) == p['url'].rstrip('/').rsplit('/', 1)[-1]}
        if not monitored:
            return {}, []
        with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)) as db:
            saved = db.execute('SELECT observation_id,config_key,payload FROM prices ORDER BY observed_at').fetchall()
        reusable = {}
        for url, product in monitored.items():
            jobs = {_job_key(job) for job in product['jobs']}
            history = []
            current = {}
            for oid, key, payload in saved:
                row = json.loads(payload)
                if not _valid_row(row, key, product, jobs):
                    continue
                row.update(observation_id=oid, config_key=key)
                history.append(row)
                if datetime.fromisoformat(row['observed_at']).date().isoformat() == today:
                    job = _row_key(row)
                    if job not in current or row['observed_at'] > current[job]['observed_at']:
                        current[job] = row
            if required <= {job[0] for job in current}:
                reusable[url] = {'product': product, 'history': history,
                                 'today_rows': list(current.values())}
        return reusable, []
    except (OSError, ValueError, KeyError, sqlite3.Error) as exc:
        return {}, ['监测历史不可读取，改为实时采集：' + str(exc)]


def write_reused_source(reusable, output, today):
    """Write monitor rows in the same input shape as a fresh Vooglam run."""
    history = [row for entry in reusable.values() for row in entry['history']]
    for row in history:
        for field in ('evidence', 'evidence_text'):
            source = Path(row[field])
            target = output.parent / 'reused_evidence' / row['observation_id'] / (field + source.suffix)
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            row[field] = str(target.relative_to(output.parent))
    products = []
    for entry in reusable.values():
        item = entry['product']
        latest = max(entry['today_rows'], key=lambda row: row['observed_at'])
        products.append({'product_id': item['product_id'], 'name': item['name'],
                         'sku': item['sku'], 'url': item['url'],
                         'frame_price': latest['frame_price'],
                         'expected_configurations': len(item['jobs']),
                         'latest_configurations': len(entry['today_rows']),
                         'today_configurations': len(entry['today_rows'])})
    data = {'generated_at': datetime.now().astimezone().isoformat(), 'today': today,
            'scope': '已核验的 Vooglam 定时监测报价；沿用实际采集时间',
            'products': products, 'history': history,
            'observations': [r for entry in reusable.values() for r in entry['today_rows']],
            'dates': dict(Counter(r['observed_at'][:10] for r in history)),
            'history_count': len(history)}
    output.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    return data

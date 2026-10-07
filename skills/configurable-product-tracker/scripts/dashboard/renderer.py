"""Offline renderer for the existing provisional Session 3 envelopes."""
import json
from pathlib import Path
import shutil
from analytics.core import PRICE_KEYS
from analytics.product_cards import build_product_cards
from analytics.alerts import build_alert_inputs
from analytics.lens_fields import structure_lens_fields


def render_dashboard(dataset, analysis, run_manifest, output_dir):
    if not isinstance(dataset.get('records'), list):
        raise ValueError('NormalizedDataset.records must be a list')
    structure_lens_fields(dataset)
    output = Path(output_dir)
    output.mkdir(parents=True, exist_ok=True)
    # Keep a portable evidence copy where the source snapshot actually exists.
    for item in dataset.get('evidence', []):
        ref = item.get('snapshot_ref')
        if not ref or not item.get('snapshot_exists'):
            continue
        source = Path(ref)
        if not source.is_file():
            continue
        clean_id = ''.join(c for c in str(item.get('evidence_id', '')) if c.isalnum() or c in '-_')
        if not clean_id:
            continue
        relative = Path('evidence') / (clean_id + source.suffix.lower())
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.is_file() or destination.stat().st_size != source.stat().st_size:
            shutil.copy2(source, destination)
        item['snapshot_local'] = relative.as_posix()
    for item in dataset['records']:
        if item.get('entity_type') != 'product' or not item.get('thumbnail_ref'):
            continue
        source = Path(item['thumbnail_ref'])
        if not source.is_file():
            continue
        name = ''.join(c for c in item['product_id'] if c.isalnum() or c in '-_') + source.suffix.lower()
        relative = Path('media') / name
        destination = output / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        if not destination.is_file() or destination.stat().st_size != source.stat().st_size:
            shutil.copy2(source, destination)
        item['thumbnail_local'] = relative.as_posix()
    analysis['product_cards'] = build_product_cards(dataset)
    dates = sorted({r['observed_at'][:10] for r in dataset['records']
                    if r.get('entity_type') == 'price_observation' and r.get('observed_at')})
    analysis['product_cards_by_date'] = {day: build_product_cards(dataset, as_of=day) for day in dates}
    analysis['alert_inputs'] = build_alert_inputs(dataset)
    payload = {'dataset': dataset, 'analysis': analysis, 'manifest': run_manifest,
               'price_comparison_keys': list(PRICE_KEYS)}
    encoded = json.dumps(payload, ensure_ascii=False).replace('<', '\\u003c').replace('&', '\\u0026')
    assets = Path(__file__).resolve().parents[2] / 'assets' / 'dashboard'
    for name in ('tsparticles.engine.min.js', 'tsparticles.slim.bundle.min.js',
                 'particle_background.js', 'tsparticles-LICENSE.txt'):
        shutil.copy2(assets / name, output / name)
    template = (assets / 'template.html').read_text(encoding='utf-8')
    template = template.replace('__HISTORY_SCRIPT__', (assets / 'history.js').read_text(encoding='utf-8'))
    template = template.replace('__PRODUCT_CARD_SCRIPT__', (assets / 'product_cards.js').read_text(encoding='utf-8'))
    template = template.replace('__ALERT_SCRIPT__', (assets / 'alerts.js').read_text(encoding='utf-8'))
    target = output / 'index.html'
    target.write_text(template.replace('__PAYLOAD__', encoded), encoding='utf-8')
    for name, value in [('normalized_dataset', dataset), ('analysis_bundle', analysis),
                        ('run_manifest', run_manifest), ('sources', dataset.get('evidence', []))]:
        (output / (name + '.json')).write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding='utf-8')
    return {'html': str(target), 'output_dir': str(output)}

"""Check one Standard Lenses configuration per previously verified color URL."""
import argparse
from datetime import datetime
import importlib.util
import json
import os
from pathlib import Path
import sys
from urllib.parse import unquote


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--run-dir', required=True, type=Path)
    parser.add_argument('--channel', default=os.environ.get('VOOGLAM_BROWSER_CHANNEL', 'chrome'))
    args = parser.parse_args()
    root = args.run_dir.resolve()
    spec = importlib.util.spec_from_file_location('color_report', root / 'vooglam_five_product_report.py')
    report = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(report)
    sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'monitoring'))
    from monitor import command_run
    seed = root / 'standard_seeds.json'
    seed.write_text(json.dumps([{'lens_type': 'Standard Lenses', 'material': 'auto'}]), encoding='utf-8')
    urls = json.loads((root / 'variant_urls.json').read_text(encoding='utf-8'))
    rows, failures = [], []
    for url in urls:
        pid = url.rstrip('/').rsplit('/', 1)[-1]
        master_path = root / 'vooglam_products' / pid / 'vooglam_lens_tree_master.json'
        try:
            master = json.loads(master_path.read_text(encoding='utf-8'))
            identity = master['product_identity']
            if (identity.get('status') != 'observed' or identity.get('requested_url') != url
                    or identity.get('scope_status') != 'in_scope'
                    or identity.get('purchase_mode') != 'select_lenses'):
                raise ValueError('Product URL, identity or scope not verified')
            command_run([sys.executable, '-u', str(root / 'vooglam_incremental_batch.py'),
                         '--url', url, '--seed-file', str(seed), '--max-paths', '1',
                         '--no-expand', '--channel', args.channel], root,
                        root / (pid + '_standard.log'), 300, dict(os.environ))
            master = json.loads(master_path.read_text(encoding='utf-8'))
            observed = report.verified_rows(master, identity)
            detail = master.get('branches', {}).get('Single Vision', {}).get('details', {}).get('Standard Lenses', {})
            options = detail.get('technology_options', detail.get('lens_technology_options', []))
            first_technology = options[0]['name'] if options else None
            observed = [r for r in observed if r['lens_path'] == 'Standard Lenses'
                        and (first_technology is None or r['technology'] == first_technology)
                        and r['material'] in ('未经过材料页', 'Standard Material')]
            if len(observed) != 1:
                raise ValueError('Expected one verified Standard Lenses cart row')
            for row in observed:
                for field in ('evidence', 'evidence_text'):
                    if not row.get(field):
                        raise ValueError('Missing cart evidence')
                    row[field] = str(report.OUT / unquote(row[field]))
                    if not Path(row[field]).is_file():
                        raise ValueError('Cart evidence file not found')
                row['frame_color'] = identity.get('default_color') or identity.get('default_colorway')
            rows.extend(observed)
            print(pid, 'verified total', observed[0]['total'], flush=True)
        except Exception as exc:
            failures.append({'url': url, 'error': str(exc)})
            print(pid, 'FAILED', str(exc), flush=True)
        (root / 'color_standard_prices.json').write_text(json.dumps({
            'generated_at': datetime.now().astimezone().isoformat(),
            'scope': 'Other color URLs: Single Vision → Standard Lenses, first technology only',
            'observed_rows': rows, 'failures': failures}, ensure_ascii=False, indent=2), encoding='utf-8')
    return 1 if failures else 0


if __name__ == '__main__':
    sys.exit(main())

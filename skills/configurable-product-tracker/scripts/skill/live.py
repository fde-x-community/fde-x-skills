"""Collect confirmed Vooglam URLs with repository collectors and render the six-page dashboard."""
import argparse
from datetime import datetime
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import uuid

from .request_input import load_request, unresolved, verify_identities
from .verified_to_dashboard import convert
from .external import acquire

ROOT = Path(__file__).resolve().parents[1]
COLLECTORS = ('vooglam_lens_tree.py', 'vooglam_product_probe.py',
              'vooglam_incremental_batch.py', 'vooglam_five_product_run.py',
              'vooglam_five_product_report.py', 'vooglam_comparison_seeds.json',
              'vooglam_classic_seeds.json')
TIERS = {'classic': ('vooglam_classic_seeds.json', True, 3),
         'medium': ('vooglam_comparison_seeds.json', True, 9),
         'full': ('vooglam_comparison_seeds.json', False, 0)}


def run_step(name, command, cwd, environment, manifest, log_dir):
    log = log_dir / f'{name}.log'
    with log.open('w', encoding='utf-8') as stream:
        result = subprocess.run(command, cwd=cwd, env=environment,
                                stdout=stream, stderr=subprocess.STDOUT)
    manifest['steps'].append({'name': name, 'exit_code': result.returncode, 'log': str(log)})
    if result.returncode:
        raise RuntimeError(f'{name} failed; see {log}')


def main():
    parser = argparse.ArgumentParser(description='Fresh Vooglam cart collection to six-page dashboard')
    parser.add_argument('--input', type=Path, required=True, help='Agent-confirmed products and URLs')
    parser.add_argument('--output', type=Path, help='Fresh output directory; must not already exist')
    parser.add_argument('--tier', choices=tuple(TIERS), help='Chosen collection scope: classic, medium or full')
    parser.add_argument('--max-paths', type=int, help='Optional explicit cap; 0 traverses the selected scope')
    parser.add_argument('--channel', choices=('chromium', 'chrome', 'msedge'), default='chromium')
    parser.add_argument('--external', choices=('online', 'offline'), default='online')
    parser.add_argument('--external-input', type=Path)
    args = parser.parse_args()
    if args.tier is None and args.max_paths is None:
        parser.error('Choose --tier after confirming the collection scope with the user')
    if args.max_paths is not None and args.max_paths < 0:
        parser.error('--max-paths must be non-negative')
    seed_name, no_expand, tier_limit = TIERS.get(args.tier, ('vooglam_comparison_seeds.json', False, 0))
    max_paths = tier_limit if args.max_paths is None else args.max_paths
    request = load_request(args.input)
    if unresolved(request):
        parser.error('Resolve and verify every official product URL before live collection')
    output = (args.output or ROOT.parent / 'assets' / 'runs' / uuid.uuid4().hex[:8]).resolve()
    if output.exists():
        parser.error('Output directory already exists; choose a fresh directory')
    output.mkdir(parents=True)
    manifest = {'mode': 'live_observation', 'tier': args.tier or 'custom',
                'seed_file': seed_name, 'expand_observed_options': not no_expand,
                'max_paths_per_product': max_paths,
                'started_at': datetime.now().astimezone().isoformat(),
                'status': 'running', 'products': request['products'], 'steps': []}
    manifest_path = output / 'run_manifest.json'
    scripts = output / 'scripts'
    scripts.mkdir()
    try:
        for name in COLLECTORS:
            shutil.copy2(ROOT / name, scripts / name)
        (scripts / 'vooglam_five_urls.json').write_text(json.dumps(
            [p['url'] for p in request['products']], ensure_ascii=False), encoding='utf-8')
        environment = dict(os.environ, VOOGLAM_BROWSER_CHANNEL=args.channel,
                           PYTHONIOENCODING='utf-8')
        run_step('identity', [sys.executable, str(scripts / 'vooglam_product_probe.py'),
                              '--channel', args.channel], scripts, environment, manifest, output)
        manifest['identity_checks'] = verify_identities(request, scripts / 'vooglam_products')
        if any(item['status'] != 'verified' for item in manifest['identity_checks']):
            if any(item['status'] == 'unavailable' for item in manifest['identity_checks']):
                raise RuntimeError('Product identity unavailable; inspect identity.log and source errors before retrying')
            raise RuntimeError('Product identity mismatch; no cart collection started')
        collection_command = [sys.executable, str(scripts / 'vooglam_five_product_run.py'),
                              '--workers', '1', '--max-paths', str(max_paths),
                              '--seed-file', str(scripts / seed_name)]
        if no_expand:
            collection_command.append('--no-expand')
        run_step('collection', collection_command,
                 scripts, environment, manifest, output)
        run_step('verified_export', [sys.executable, str(ROOT / 'monitoring' / 'export_run.py'),
                                      '--run-dir', str(scripts)], scripts, environment, manifest, output)
        verified = scripts / 'vooglam_products' / 'verified_prices.json'
        converted = convert(verified, output / 'prices.json')
        external_bundle = None
        try:
            external = acquire(request, output, offline=args.external == 'offline',
                               imports=args.external_input)
            manifest['external_coverage'] = external.get('sources', [])
            manifest['external_bundle'] = str(output / 'external' / 'external_bundle.json')
            external_bundle = output / 'external' / 'external_bundle.json'
        except Exception as exc:
            manifest['external_coverage'] = {'status': 'unavailable', 'reason': str(exc)}
        dashboard_command = [sys.executable, '-m', 'analytics.run_monitoring',
                             str(output / 'prices.json'), str(output / 'dashboard'),
                             '--mode', 'live_observation', '--period-start', request['monitoring_period']['start'],
                             '--period-end', request['monitoring_period']['end']]
        if not request['period_user_specified']:
            dashboard_command.append('--show-live-current')
        if external_bundle:
            dashboard_command.extend(('--external-bundle', str(external_bundle)))
        run_step('six_page_dashboard', dashboard_command, ROOT, environment, manifest, output)
        manifest.update(status='completed' if converted['history'] else 'partial',
                        verified_observations=len(converted['history']),
                        dashboard=str(output / 'dashboard' / 'index.html'))
    except Exception as exc:
        manifest.update(status='failed', error=str(exc))
        raise
    finally:
        manifest['finished_at'] = datetime.now().astimezone().isoformat()
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps({'output': str(output), 'status': manifest['status'],
                          'dashboard': manifest.get('dashboard')}, ensure_ascii=False))


if __name__ == '__main__':
    main()

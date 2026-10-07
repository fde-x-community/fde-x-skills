"""Move verified Vooglam monitor history with evidence between installations."""
import argparse
from contextlib import closing
from datetime import datetime
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import zipfile

from history import archive, SCENARIO


ROOT = Path(__file__).resolve().parent
FORMAT = 'eyewear-monitor-history-v1'


def export_bundle(database, output, config=None):
    database, output = Path(database), Path(output)
    with closing(sqlite3.connect(database.resolve().as_uri() + '?mode=ro', uri=True)) as db:
        saved = db.execute('SELECT observation_id,observed_at,payload FROM prices ORDER BY observed_at').fetchall()
    if not saved:
        raise ValueError('历史库没有可导出的报价')
    output.parent.mkdir(parents=True, exist_ok=True)
    manifest = {'format': FORMAT, 'exported_at': datetime.now().astimezone().isoformat(),
                'observations': []}
    with zipfile.ZipFile(output, 'w', compression=zipfile.ZIP_DEFLATED) as bundle:
        for index, (oid, observed_at, payload) in enumerate(saved):
            row = json.loads(payload)
            if row.get('observed_at') != observed_at:
                raise ValueError('历史观测时间与原始记录不一致：' + oid)
            for field in ('evidence', 'evidence_text'):
                source = Path(row[field])
                if not source.is_file():
                    raise FileNotFoundError('历史证据不存在：' + str(source))
                member = f'evidence/{index}/{field}{source.suffix.lower()}'
                bundle.write(source, member)
                row[field] = member
            manifest['observations'].append(row)
        if config and Path(config).is_file():
            bundle.write(config, 'history_view_config.json')
        bundle.writestr('manifest.json', json.dumps(manifest, ensure_ascii=False, indent=2))
    return {'bundle': str(output), 'observations': len(saved),
            'includes_view_config': bool(config and Path(config).is_file())}


def import_bundle(bundle_path, database):
    bundle_path, database = Path(bundle_path), Path(database)
    digest = hashlib.sha256(bundle_path.read_bytes()).hexdigest()[:16]
    evidence_root = database.parent / 'imported_evidence' / digest
    with zipfile.ZipFile(bundle_path) as bundle:
        manifest = json.loads(bundle.read('manifest.json'))
        if manifest.get('format') != FORMAT or not isinstance(manifest.get('observations'), list):
            raise ValueError('不是支持的历史迁移包')
        rows = []
        for index, source_row in enumerate(manifest['observations']):
            row = dict(source_row)
            for field in ('evidence', 'evidence_text'):
                member = row.get(field, '')
                if not re.fullmatch(r'evidence/' + str(index) + r'/' + field + r'\.[A-Za-z0-9]{1,8}', member):
                    raise ValueError('历史证据路径不符合迁移包格式')
                target = evidence_root / str(index) / Path(member).name
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(bundle.read(member))
                row[field] = str(target.resolve())
            rows.append(row)
        before = 0
        if database.is_file():
            with closing(sqlite3.connect(database)) as db:
                before = db.execute('SELECT COUNT(*) FROM prices').fetchone()[0]
        archive(database, rows, SCENARIO, 'import_' + digest)
        with closing(sqlite3.connect(database)) as db:
            after = db.execute('SELECT COUNT(*) FROM prices').fetchone()[0]
        view_config = None
        if 'history_view_config.json' in bundle.namelist():
            view_config = database.parent / ('history_view_config_' + digest + '.json')
            view_config.write_bytes(bundle.read('history_view_config.json'))
    return {'database': str(database), 'imported': after - before,
            'duplicates': len(rows) - (after - before), 'evidence_dir': str(evidence_root),
            'history_view_config': str(view_config) if view_config else None,
            'monitoring_config_changed': False}


def main():
    parser = argparse.ArgumentParser(description='可迁移的已核验监测历史与证据')
    actions = parser.add_subparsers(dest='action', required=True)
    exporting = actions.add_parser('export')
    exporting.add_argument('--database', type=Path, default=ROOT / 'history.sqlite3')
    exporting.add_argument('--config', type=Path, default=ROOT / 'config.json')
    exporting.add_argument('--output', required=True, type=Path)
    importing = actions.add_parser('import')
    importing.add_argument('--input', required=True, type=Path)
    importing.add_argument('--database', type=Path, default=ROOT / 'history.sqlite3')
    args = parser.parse_args()
    result = (export_bundle(args.database, args.output, args.config) if args.action == 'export'
              else import_bundle(args.input, args.database))
    print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    main()

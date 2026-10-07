"""Adapt a verified single-run Vooglam export to the six-page dashboard input."""
import argparse
from collections import Counter
from datetime import datetime
import json
from pathlib import Path


def convert(source_path, output_path):
    source_path = Path(source_path).resolve()
    output_path = Path(output_path).resolve()
    source = json.loads(source_path.read_text(encoding='utf-8'))
    rows = source['observations']
    products = source['products']
    for row in rows:
        for field in ('evidence', 'evidence_text'):
            evidence = (source_path.parent / row[field]).resolve()
            if not evidence.is_file():
                raise ValueError(f'Missing verified {field}: {evidence}')
            row[field] = str(evidence.relative_to(output_path.parent)) if evidence.is_relative_to(output_path.parent) else str(evidence)
    dates = Counter(datetime.fromisoformat(row['observed_at']).date().isoformat() for row in rows)
    data = {'generated_at': datetime.now().astimezone().isoformat(),
            'today': datetime.now().astimezone().date().isoformat(),
            'scope': source['scope'], 'products': products, 'history': rows,
            'observations': rows, 'dates': dict(dates), 'history_count': len(rows)}
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding='utf-8')
    return data


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('source', type=Path, help='verified_prices.json from monitoring/export_run.py')
    parser.add_argument('output', type=Path, help='six-page dashboard input prices.json')
    args = parser.parse_args()
    result = convert(args.source, args.output)
    print(json.dumps({'products': len(result['products']), 'verified_observations': len(result['history']),
                      'output': str(args.output)}, ensure_ascii=False))


if __name__ == '__main__':
    main()

"""Search official URL candidates; an agent verifies identity before selecting."""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import re
from .reach_backend import search
from .request_input import load_request


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    request = load_request(args.input)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    for index, product in enumerate(request['products']):
        if product.get('url'):
            continue
        query = 'site:vooglam.com/goods-detail "' + product['product'] + '" eyeglasses'
        try:
            text = search(query)
            evidence = args.output.with_name(args.output.stem + '_search_' + str(index+1) + '.txt')
            evidence.write_text(text, encoding='utf-8')
            candidates = list(dict.fromkeys(re.findall(r'https://www\.vooglam\.com/goods-detail/\d+', text)))
            product['resolution'] = {'status': 'needs_verification' if len(candidates) == 1 else 'needs_clarification' if candidates else 'not_found',
                'query': query, 'candidates': candidates, 'snapshot': evidence.name,
                'searched_at': datetime.now(timezone.utc).isoformat(),
                'instruction': 'Read official pages; verify exact name, SKU, color and purchase mode. Set url only after unambiguous identity is established.'}
        except Exception as exc:
            product['resolution'] = {'status': 'unavailable', 'query': query, 'reason': str(exc)}
    args.output.write_text(json.dumps(request, ensure_ascii=False, indent=2), encoding='utf-8')
    print('Candidate request:', args.output)


if __name__ == '__main__':
    main()

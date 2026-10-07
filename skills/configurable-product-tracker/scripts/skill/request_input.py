"""Turn user product names into a validated, explicit collection scope."""
import json
from pathlib import Path
import re
from datetime import datetime, timedelta


def load_request(path=None, names=(), sample=False, root=None):
    if path:
        request = json.loads(Path(path).read_text(encoding='utf-8'))
    elif names:
        products = []
        for name in names:
            parts = name.strip().split(maxsplit=1)
            if len(parts) != 2:
                raise ValueError('Use merchant + product name, for example: Vooglam Spine')
            products.append({'merchant': parts[0], 'product': parts[1]})
        request = {'products': products}
    elif sample:
        request = json.loads((root / 'sample_request.json').read_text(encoding='utf-8'))
    else:
        raise ValueError('Provide --product "Vooglam Spine" or --input request.json; fixed five products require --sample-input')
    products = request.get('products')
    if not isinstance(products, list) or not products:
        raise ValueError('products must be a non-empty list')
    normalized = []
    for product in products:
        if isinstance(product, str):
            parts = product.strip().split(maxsplit=1)
            if len(parts) != 2:
                raise ValueError('Use merchant + product name, for example: Vooglam Spine')
            product = {'merchant': parts[0], 'product': parts[1]}
        if not isinstance(product, dict) or not all(isinstance(product.get(key), str) and product[key].strip() for key in ('merchant', 'product')):
            raise ValueError('Every product needs merchant and product')
        normalized.append(product)
        product['merchant'] = product['merchant'].strip()
        product['product'] = product['product'].strip()
        if product['merchant'].lower() != 'vooglam':
            raise ValueError('Unsupported merchant: ' + product['merchant'] + '; this demo currently supports Vooglam only')
        if product.get('url') and not re.fullmatch(r'https://www\.vooglam\.com/goods-detail/\d+/?', product['url']):
            raise ValueError('Expected official Vooglam goods-detail URL')
    products = request['products'] = normalized
    urls = [p['url'].rstrip('/') for p in products if p.get('url')]
    if len(urls) != len(set(urls)):
        raise ValueError('Duplicate product URLs; resolve ambiguous or repeated inputs first')
    if request.get('market', 'US') != 'US' or request.get('currency', 'USD') != 'USD':
        raise ValueError('This demo supports US/USD only; do not silently change the requested market')
    request.setdefault('market', 'US')
    request.setdefault('currency', 'USD')
    end = datetime.now().date() - timedelta(days=1)
    request.setdefault('period_user_specified', bool(request.get('monitoring_period') or request.get('period')))
    request.setdefault('monitoring_period', request.get('period') or
                       {'start': (end - timedelta(days=29)).isoformat(), 'end': end.isoformat()})
    period = request['monitoring_period']
    start_date = datetime.fromisoformat(period['start']).date()
    end_date = datetime.fromisoformat(period['end']).date()
    if start_date > end_date:
        raise ValueError('monitoring_period start must not follow end')
    return request


def unresolved(request):
    return [p for p in request['products'] if not p.get('url')]


def verify_identities(request, directory):
    results = []
    for product in request['products']:
        pid = product['url'].rstrip('/').rsplit('/', 1)[-1]
        path = directory / pid / 'vooglam_lens_tree_master.json'
        master = json.loads(path.read_text(encoding='utf-8'))
        identity = master.get('product_identity', {})
        expected = product['product'].strip().casefold()
        actual = (identity.get('name') or '').strip().casefold()
        matched = identity.get('status') == 'observed' and actual == expected
        if identity.get('status') == 'observed' and not matched:
            identity.update(status='name_mismatch', error='Requested product ' + product['product'] + '; official heading is ' + str(identity.get('name')))
            master['product_identity'] = identity
            path.write_text(json.dumps(master, ensure_ascii=False, indent=2), encoding='utf-8')
        elif matched and identity.get('purchase_mode') != 'select_lenses' and identity.get('product_type') != 'sunglasses':
            identity.update(scope_status='unsupported_purchase_mode', error='预配镜片或未识别购买流程暂不支持；不能将整镜标价当作镜框价')
            master['product_identity'] = identity
            path.write_text(json.dumps(master, ensure_ascii=False, indent=2), encoding='utf-8')
        results.append({'requested_product': product['product'], 'url': product['url'],
                        'official_name': identity.get('name'), 'status': 'verified' if matched else identity.get('status', 'unavailable'),
                        'reason': identity.get('error')})
    return results

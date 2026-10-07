"""Expose independently named lens fields without guessing absent selections."""
import re


_INDEX = re.compile(r'(?<!\d)(1\.(?:49|50|53|56|57|59|60|61|67|71|74|76))(?!\d)')


def _function_label(path):
    name = (path or '').lower()
    functions = []
    for token, label in (('photochromic', '变色'), ('blue light', '防蓝光'),
                         ('blue-light', '防蓝光'), ('polarized', '偏光'),
                         ('driving', '驾驶')):
        if token in name and label not in functions:
            functions.append(label)
    if functions:
        return '、'.join(functions)
    if name in ('standard lenses', 'clear') or name.startswith('clear '):
        return '普通透明'
    return path


def structure_lens_fields(dataset):
    for row in dataset.get('records', []):
        if row.get('entity_type') != 'lens_configuration':
            continue
        raw = row.get('original_labels') or {}
        labels = dict(raw) if isinstance(raw, (dict, list)) else {}
        path = labels.get('lens_path') or labels.get('type') or row.get('selection_path')
        row['lens_path'] = path
        row['technology'] = labels.get('technology')
        material = row.get('material') or labels.get('material')
        row['material'] = material if material and material != '未经过材料页' else None
        index_text = ' '.join(str(v) for v in (labels.get('index'), labels.get('cart_configuration'),
                                               row.get('selection_path')) if v)
        index = _INDEX.search(index_text)
        row['refractive_index'] = index.group(1) if index else None
        row['lens_function'] = _function_label(path)
        row['coating'] = row.get('coating') or labels.get('coating')
        row['lens_brand'] = row.get('lens_brand') or labels.get('brand')
        row['raw_configuration'] = labels.get('cart_configuration') or row.get('selection_path')

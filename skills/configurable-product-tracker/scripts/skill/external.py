"""Small, independent external-data chain; source failures are explicit."""
from datetime import datetime, timezone
from html import escape
import json
from pathlib import Path
import re
import shutil
import subprocess

from external_data.vooglam_channels import parse_public_overview
from .reach_backend import search

SIMILARWEB = 'https://www.similarweb.com/website/vooglam.com/'


def acquire(request, target, *, offline=False, imports=None):
    directory = target / 'external'
    directory.mkdir(exist_ok=True)
    now = datetime.now(timezone.utc).isoformat()
    bundle = {'captured_at': now, 'requested_period': request['monitoring_period'], 'records': [],
              'evidence': [], 'search_signals': [], 'sources': [], 'errors': []}
    snapshots = json.loads(Path(imports).read_text(encoding='utf-8')) if imports else {}
    for product in request['products']:
        query = product['merchant'] + ' ' + product['product'] + ' eyeglasses reviews'
        index = len(bundle['search_signals']) + 1
        status = 'not_attempted'
        reason = 'Offline replay; no new search performed'
        refs = []
        if not offline:
            try:
                text = search(query)
                filename = 'search_' + str(index) + '.txt'
                (directory / filename).write_text(text, encoding='utf-8')
                refs = list(dict.fromkeys(re.findall(r'https?://[^\s<>\[\]"\)]+', text)))
                status = 'leads_only'
                reason = '搜索线索，未核验讨论内容；不是趋势指数或销量'
                bundle['evidence'].append({'source_url_or_ref': 'exa search: ' + query, 'snapshot_ref': filename, 'captured_at': now, 'scope': 'product_search'})
            except Exception as exc:
                status, reason = 'unavailable', str(exc)
        bundle['search_signals'].append({'merchant': product['merchant'], 'product': product['product'],
                                        'query': query, 'status': status, 'reason': reason, 'urls': refs})
    status, reason = 'not_attempted', 'Offline replay; no new external data retrieved'
    try:
        content = None
        captured_at = now
        supplied = snapshots.get('similarweb')
        if supplied:
            if supplied.get('source_url') != SIMILARWEB or not supplied.get('captured_at'):
                raise ValueError('similarweb import requires exact source_url and explicit captured_at')
            source = (Path(imports).resolve().parent / supplied['file']).resolve()
            content = source.read_text(encoding='utf-8')
            captured_at = supplied['captured_at']
        elif not offline:
            curl = shutil.which('curl.exe') or shutil.which('curl')
            if not curl:
                raise RuntimeError('curl missing for agent-reach Jina Reader')
            result = subprocess.run([curl, '--fail', '--silent', '--show-error', '--location', '--max-time', '45',
                                     'https://r.jina.ai/' + SIMILARWEB], capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=55)
            if result.returncode:
                raise RuntimeError(result.stderr[:1000] or 'Jina Reader fetch failed')
            content = result.stdout
        if content:
            filename = 'similarweb.txt'
            (directory / filename).write_text(content, encoding='utf-8')
            batch = parse_public_overview(content, captured_at=captured_at)
            batch['evidence'][0]['snapshot_ref'] = filename
            # A page month and country are reported verbatim, not inferred from the requested window.
            bundle['records'] = batch['records']
            bundle['evidence'] += batch['evidence']
            bundle['errors'] += batch['errors']
            status = batch['coverage']['status']
            reason = '仅公开桌面端渠道份额/排名；国家未指定；来源月份独立于请求窗口。访问量未接入。' if batch['records'] else '未取得可解析的明确月份和渠道数据'
    except Exception as exc:
        status, reason = 'unavailable', str(exc)
        bundle['errors'].append({'source': 'similarweb', 'message': reason})
    bundle['sources'].append({'source': 'Similarweb public', 'url': SIMILARWEB, 'status': status, 'reason': reason,
                              'scope': 'vooglam.com website / desktop', 'market': 'not_specified'})
    for source, url, reason in (
        ('Semrush', 'https://www.semrush.com/website/vooglam.com/overview/', '尚未接入授权 API/CSV；本 Skill 未验证数值'),
        ('Google Trends', 'https://trends.google.com/trends/', '尚未接入同地区、同查询窗口的指数；网页搜索不能替代搜索指数'),
        ('Wayback Machine', 'https://web.archive.org/web/*/https://www.vooglam.com/', '尚未读取具体历史快照；不生成历史价格曲线'),
        ('First-party clicks', None, '没有授权埋点或导出；不生成自有点击数据')):
        bundle['sources'].append({'source': source, 'url': url, 'status': 'not_connected', 'reason': reason})
    bundle['coverage'] = {'status': 'partial' if bundle['records'] or any(signal['status'] == 'leads_only' for signal in bundle['search_signals']) else 'unavailable', 'metric_records': len(bundle['records']),
                          'search_leads': sum(signal['status'] == 'leads_only' for signal in bundle['search_signals'])}
    (directory / 'external_bundle.json').write_text(json.dumps(bundle, ensure_ascii=False, indent=2), encoding='utf-8')
    return bundle


def render(bundle):
    e = lambda value: escape(str(value if value is not None else '暂无数据'))
    labels = {'traffic_share':'估算渠道份额', 'channel_rank':'渠道排名', 'percent':'%', 'rank':'名次',
              'desktop':'桌面端', 'not_specified':'未指定', 'partial':'部分取得', 'unavailable':'暂无数据',
              'not_connected':'待接入', 'not_attempted':'本轮未查询', 'leads_only':'已取得搜索线索'}
    display = lambda value: e(labels.get(value, value))
    rows = ''.join('<tr>' + ''.join('<td>' + display(record.get(key)) + '</td>' for key in
                   ('source_channel', 'metric_type', 'value', 'unit', 'period_label', 'device', 'market')) + '</tr>'
                   for record in bundle['records'])
    metrics = ('<div class="tablewrap"><table><thead><tr><th>渠道</th><th>指标</th><th>值</th><th>单位</th><th>来源月份</th><th>设备</th><th>国家</th></tr></thead><tbody>' + rows + '</tbody></table></div>') if rows else '<p class="meta">渠道指标：暂无数据。</p>'
    sources = ''.join('<p class="meta"><strong>' + e(source['source']) + '</strong> · ' + display(source['status']) + '：' + e(source['reason']) +
                      (' <a href="' + e(source['url']) + '">来源入口</a>' if source.get('url') else '') + '</p>' for source in bundle['sources'])
    signals = ''.join('<p class="meta"><strong>' + e(signal['merchant'] + ' ' + signal['product']) + '</strong> · ' + display(signal['status']) + '：' + e(signal['reason']) +
                      '<br>' + ' · '.join('<a href="' + e(url) + '">搜索线索 ' + str(index+1) + '</a>' for index, url in enumerate(signal['urls'][:5])) + '</p>' for signal in bundle['search_signals'])
    evidence = ''.join('<p class="meta"><a href="../../external/' + e(record['snapshot_ref']) + '">原始外部证据</a> · ' + e(record['captured_at']) + '</p>' for record in bundle['evidence'])
    return '<section><h2>访问与渠道 · Session 02</h2><p class="meta">第三方估算；范围为 Vooglam 全站，不分摊到产品。访问量：暂无数据。请求监测窗口：' + e(bundle['requested_period']['start']) + ' 至 ' + e(bundle['requested_period']['end']) + '；实时价格为当前点位观测，不代表该窗口历史。</p>' + metrics + sources + '</section><section><h2>商品外部搜索线索</h2><p class="meta">以下为 agent-reach / Exa 搜索结果入口；线索不等于已验证趋势、流量或销量。</p>' + signals + evidence + '<p><a href="../../external/external_bundle.json">下载外部结果 JSON</a></p></section>'

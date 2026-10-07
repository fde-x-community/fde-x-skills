"""Build an offline, evidence-linked five-product price report from script output."""
from datetime import datetime
from decimal import Decimal
from html import escape
import json
from pathlib import Path
from urllib.parse import quote

ROOT = Path(__file__).resolve().parent
OUT = ROOT / "vooglam_products"
IDS = ("9999", "9990", "10002", "10003", "10262")


def relative_evidence(path):
    if not path:
        return None
    candidate = Path(path)
    if not candidate.is_file():
        return None
    try:
        return quote(candidate.resolve().relative_to(OUT.resolve()).as_posix(), safe="/")
    except ValueError:
        return None


def verified_rows(master, identity):
    rows = []
    for lens_type, detail in master.get("branches", {}).get("Single Vision", {}).get("details", {}).items():
        nodes = [(lens_type, detail)] + [(lens_type + " → " + child, node)
                                       for child, node in detail.get("children", {}).items()]
        for label, node in nodes:
            for obs in node.get("technology_observations", []):
                for record in list(obs.get("material_variants", {}).values()) or [obs]:
                    if not (record.get("success") and record.get("cart_price_status") == "ok"
                            and record.get("reached_stage") == "Cart"):
                        continue
                    frame = Decimal(str(record["frame_price"]))
                    lens = Decimal(str(record["lens_price"]))
                    total = Decimal(str(record["item_total_before_coupon"]))
                    if frame + lens != total:
                        raise ValueError("Cart price mismatch for " + identity["product_id"])
                    material = record.get("selected_material") or {}
                    if material and Decimal(str(obs["price"])) + Decimal(str(material["additional_price"])) != lens:
                        raise ValueError("Material price mismatch for " + identity["product_id"])
                    cart_name = record.get("cart_product_name", "")
                    if identity.get("name") and cart_name and identity["name"].lower() not in cart_name.lower():
                        raise ValueError("Wrong product in cart for " + identity["product_id"])
                    rows.append({"product_id": identity["product_id"], "product": identity.get("name"),
                        "sku": identity.get("product_code"), "source_url": identity["requested_url"],
                        "scope": "单光配镜", "lens_path": label, "technology": record.get("technology"),
                        "material": material.get("name", "未经过材料页"),
                        "material_surcharge": material.get("additional_price"),
                        "cart_configuration": record.get("lens_configuration_label"),
                        "frame_price": str(frame), "lens_price": str(lens), "total": str(total),
                        "currency": "USD", "observed_at": record.get("observed_at"),
                        "price_basis": "优惠前单件商品小计，不含未验证税费与运费",
                        "evidence": relative_evidence(record.get("evidence", {}).get("screenshot")),
                        "evidence_text": relative_evidence(record.get("evidence", {}).get("text"))})
    return rows


def collect():
    products, rows, excluded_products = [], [], []
    for pid in IDS:
        path = OUT / pid / "vooglam_lens_tree_master.json"
        master = json.loads(path.read_text(encoding="utf-8"))
        identity = master["product_identity"]
        offer = identity.get("product_page_price", {})
        if identity.get("status") != "observed" or not offer.get("matches_visible_headline"):
            raise ValueError("Product identity or displayed price unverified: " + pid)
        if identity.get("scope_status") != "in_scope":
            excluded_products.append({"product_id": pid, "name": identity.get("name"),
                                      "url": identity["requested_url"],
                                      "product_type": identity.get("product_type"),
                                      "scope_status": identity.get("scope_status"),
                                      "reason": "当前采集器不支持太阳镜" if identity.get("product_type") == "sunglasses"
                                                else "商品类型未确认，需人工核对",
                                      "evidence": relative_evidence(identity["evidence"]["screenshot"])})
            continue
        product = {"product_id": pid, "name": identity.get("name"), "sku": identity.get("product_code"),
                   "url": identity["requested_url"], "purchase_mode": identity.get("purchase_mode"),
                   "color": identity.get("default_color") or identity.get("default_colorway"),
                   "page_price": offer["amount"], "page_price_scope": offer["scope"],
                   "strikethrough_price": offer.get("strikethrough_amount"),
                   "availability": offer.get("availability"),
                   "observed_at": identity["observed_at"],
                   "page_evidence": relative_evidence(identity["evidence"]["screenshot"]),
                   "master": str(path)}
        product_rows = verified_rows(master, identity)
        product["verified_configurations"] = len(product_rows)
        if product["purchase_mode"] == "select_lenses":
            seeds = json.loads((ROOT / "vooglam_comparison_seeds.json").read_text(encoding="utf-8"))
            seed_labels = [s["lens_type"] + (" → " + s["child"] if s.get("child") else "") for s in seeds]
            priced_labels = {row["lens_path"] for row in product_rows}
            product["unpriced_seed_paths"] = [label for label in seed_labels if label not in priced_labels]
            manifests = sorted((OUT / pid / "vooglam_lens_tree").glob("batch_*/batch_manifest.json"))
            if manifests:
                batch = json.loads(manifests[-1].read_text(encoding="utf-8"))
                processed = [item["job"] for item in batch.get("attempted", [])] + batch.get("skipped_complete", [])
                seeded = all(any(all(job.get(key) == value for key, value in seed.items())
                                 for job in processed) for seed in seeds)
                product["collection"] = {"attempted": len(batch.get("attempted", [])),
                                         "pending": len(batch.get("pending", [])),
                                         "seed_queue_exhausted": not batch.get("pending") and seeded,
                                         "errors": [item["job"] for item in batch.get("attempted", [])
                                                    if item.get("error")]}
        rows.extend(product_rows)
        products.append(product)
    return {"generated_at": datetime.now().astimezone().isoformat(),
            "scope": "五个指定URL中仅纳入普通配镜商品；默认颜色、Single Vision、双眼SPH/CYL 0.00、PD 66.00；太阳镜暂不支持",
            "products": products, "excluded_products": excluded_products, "observations": rows}


def render(data):
    quote_html = lambda value: escape(str(value if value is not None else "—"))
    cards = []
    for p in data["products"]:
        base = "镜框标价"
        note = (f"{p['verified_configurations']} 条配镜价已到购物车；"
                f"{p.get('collection', {}).get('pending', 0)} 个待处理任务")
        strike = f"<span class='strike'>原标价 ${quote_html(p['strikethrough_price'])}</span>" if p.get("strikethrough_price") else ""
        evidence = f"<a href='{p['page_evidence']}'>商品页证据</a>" if p.get("page_evidence") else "证据不可用"
        cards.append(f"<article><div class='eyebrow'>{p['product_id']} · {quote_html(p['sku'])}</div>"
                     f"<h2>{quote_html(p['name'])}</h2><p class='color'>{quote_html(p['color'])}</p>"
                     f"<div class='price'>${quote_html(p['page_price'])}</div><div class='label'>{base}</div>"
                     f"{strike}<p class='note'>{quote_html(note)}</p>"
                     f"<div class='links'><a href='{quote_html(p['url'])}'>商品链接</a> · {evidence}</div></article>")
    rows_html = []
    for row in data["observations"]:
        evidence = f"<a href='{row['evidence']}'>截图</a>" if row.get("evidence") else "—"
        total = quote_html(row["total"])
        search = quote_html(" ".join(str(row.get(k) or "") for k in
                  ("product", "lens_path", "technology", "material", "cart_configuration"))).lower()
        rows_html.append(f"<tr data-product='{row['product_id']}' data-search='{search}'><td>"
            f"<strong>{quote_html(row['product'])}</strong><small>{row['product_id']}</small></td>"
            f"<td>{quote_html(row['scope'])}</td><td>{quote_html(row['lens_path'])}</td>"
            f"<td>{quote_html(row['technology'])}</td><td>{quote_html(row['material'])}</td>"
            f"<td class='number'>{'$'+quote_html(row['frame_price']) if row['frame_price'] else '—'}</td>"
            f"<td class='number'>{'$'+quote_html(row['lens_price']) if row['lens_price'] else '—'}</td>"
            f"<td class='number total'>${total}</td><td>{evidence}</td></tr>")
    prod_options = "".join(f"<option value='{p['product_id']}'>{p['product_id']} · {quote_html(p['name'])}</option>"
                           for p in data["products"])
    gaps = "".join(f"<p class='meta'><strong>{quote_html(p['product_id'])} {quote_html(p['name'])}：</strong>"
                   + ("；".join(quote_html(label) for label in p.get("unpriced_seed_paths", []))
                      if p.get("unpriced_seed_paths") else "指定的九条种子镜片路径均有购物车价")
                   + "</p>" for p in data["products"] if p["purchase_mode"] == "select_lenses")
    excluded = "".join(f"<p class='meta'><strong>{quote_html(p['product_id'])} {quote_html(p['name'])}：</strong>"
                       f"{quote_html(p['reason'])}。<a href='{quote_html(p['evidence'])}'>商品页证据</a></p>"
                       for p in data["excluded_products"])
    return f"""<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vooglam 配镜商品价格报表</title><style>
:root{{font-family:Inter,'Segoe UI',Arial,sans-serif;color:#192336;background:#f5f7fa}}*{{box-sizing:border-box}}body{{margin:0}}
header{{background:#17243d;color:white;padding:32px max(28px,calc((100vw - 1280px)/2))}}header h1{{font-size:29px;margin:0 0 10px}}header p{{margin:0;color:#cbd7e8;line-height:1.6}}
main{{max-width:1280px;margin:auto;padding:28px}}.cards{{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:14px}}
article{{background:white;border:1px solid #e3e8f0;border-radius:14px;padding:20px;box-shadow:0 4px 18px #16223a0a}}
.eyebrow{{color:#6b7e97;font-size:12px;font-weight:700;letter-spacing:.04em}}h2{{font-size:19px;margin:11px 0 4px}}
.color{{color:#697992;font-size:13px;margin:0 0 18px}}.price{{font-size:29px;font-weight:800;color:#d9531e}}.label,.note{{color:#65748b;font-size:13px}}
.strike{{display:block;font-size:12px;color:#98a3b3;text-decoration:line-through;margin-top:5px}}.note{{min-height:20px}}
a{{color:#1969b9}}.links{{font-size:12px;margin-top:20px}}section{{margin-top:28px;background:white;border:1px solid #e3e8f0;border-radius:14px;padding:22px}}
section h2{{margin:0 0 12px}}.meta{{line-height:1.7;color:#61718a;font-size:14px}}.controls{{display:flex;gap:10px;flex-wrap:wrap;margin:16px 0}}
select,input{{font:inherit;padding:10px 12px;border:1px solid #cbd4e2;border-radius:8px;background:white}}input{{min-width:260px;flex:1}}
.tablewrap{{overflow:auto}}table{{width:100%;border-collapse:collapse;font-size:13px;min-width:1060px}}th,td{{text-align:left;padding:11px 10px;border-bottom:1px solid #e8edf4;vertical-align:top}}th{{background:#f4f7fb;color:#53657f;white-space:nowrap}}
td small{{display:block;color:#8290a4}}td.number{{white-space:nowrap}}td.total{{font-weight:800;color:#17243d}}tr:hover{{background:#f9fbff}}
footer{{max-width:1280px;margin:8px auto 30px;padding:0 28px;color:#6d7b91;font-size:12px}}
</style></head><body><header><h1>Vooglam 配镜商品价格报表</h1><p>{quote_html(data['scope'])}<br>采集时间：{quote_html(data['generated_at'])} · USD · 商品页与购物车原始证据可点击查看</p></header>
<main><div class="cards">{''.join(cards)}</div><section><h2>已核对的配置价格</h2><p class="meta">配镜价为镜框＋镜片（含实际所选材料）的优惠前单件小计。税费、优惠资格和最终运费未验证。</p>
<div class="controls"><select id="product"><option value="">全部商品</option>{prod_options}</select><input id="search"
placeholder="搜索镜片、技术、材料或颜色" aria-label="搜索配置"><span id="count" class="meta"></span></div>
<div class="tablewrap"><table><thead><tr><th>商品</th><th>类别</th><th>镜片路径</th><th>技术</th><th>材料</th><th>镜框</th><th>镜片</th><th>商品总价</th><th>证据</th></tr></thead>
<tbody>{''.join(rows_html)}</tbody></table></div></section><section><h2>排除的商品</h2><p class="meta">太阳镜不在当前配镜采集能力内，不计入商品数、价格区间或配置明细。</p>{excluded}</section><section><h2>没有购物车价的指定路径</h2><p class="meta">这些分支在对应商品上未提供选项或本轮未得到可核对总价，不表示价格为零。</p>{gaps}</section><section><h2>采集边界</h2><p class="meta">仅限提供的五个 URL 中三款普通配镜商品及默认配色。单光价格使用相同测试处方；页面技术报价不等于购物车验证。Color Tint、Non-Prescription、其他度数/颜色未覆盖。价格可能因促销、地区或时间变化；需要比较历史时应重新采集相同配置。</p>
<p class="meta"><a href="five_product_prices.json">下载完整数据 JSON</a></p></section></main>
<footer>来源：Vooglam 公开商品页及浏览器配镜流程。每条配置记录保留原始路径、观察时间、价格组成和截图。</footer>
<script>const p=document.getElementById('product'),q=document.getElementById('search'),n=document.getElementById('count'),rows=[...document.querySelectorAll('tbody tr')];function update(){{let c=0;for(const row of rows){{const show=(!p.value||row.dataset.product===p.value)&&row.dataset.search.includes(q.value.trim().toLowerCase());row.hidden=!show;if(show)c++}}n.textContent=`显示 ${{c}} / ${{rows.length}} 条`}}p.addEventListener('change',update);q.addEventListener('input',update);update();</script></body></html>"""


def main():
    OUT.mkdir(exist_ok=True)
    data = collect()
    (OUT / "five_product_prices.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    (OUT / "five_product_report.html").write_text(render(data), encoding="utf-8")
    print("Products:", len(data["products"]), "verified configurations:", len(data["observations"]))


if __name__ == "__main__":
    main()

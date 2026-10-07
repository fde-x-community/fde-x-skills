"""Build a portable, evidence-linked demonstration report from real monitor history."""
import argparse
from collections import Counter
from contextlib import closing
from datetime import datetime
from decimal import Decimal
from html import escape
import json
from pathlib import Path
import shutil
import sqlite3
from urllib.parse import quote
import zipfile

ROOT = Path(__file__).resolve().parent


def build(config_path, database, output):
    config = json.loads(config_path.read_text(encoding="utf-8"))
    output.mkdir(parents=True, exist_ok=True)
    with closing(sqlite3.connect(database.resolve().as_uri() + "?mode=ro", uri=True)) as db:
        observations = db.execute("SELECT observation_id,config_key,observed_at,payload FROM prices ORDER BY observed_at").fetchall()
    ids = {p["product_id"] for p in config["products"]}
    history, latest, by_key = [], {}, {}
    for oid, key, at, payload in observations:
        row = json.loads(payload)
        if row["product_id"] not in ids:
            continue
        row.update(observation_id=oid, config_key=key)
        for field in ("evidence", "evidence_text"):
            source = Path(row[field]) if row.get(field) else None
            if source and source.is_file():
                relative = Path("evidence") / oid / ("cart" + source.suffix)
                destination = output / relative
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)
                row[field] = quote(relative.as_posix(), safe="/")
            else:
                row[field] = None
        previous = next((r for r in reversed(by_key.get(key, [])) if r["observed_at"][:10] < at[:10]), None)
        row["previous_day_observation"] = ({"observed_at": previous["observed_at"], "total": previous["total"],
            "difference": str(Decimal(row["total"]) - Decimal(previous["total"])),
            "evidence": previous["evidence"]} if previous else None)
        history.append(row)
        by_key.setdefault(key, []).append(row)
        latest[key] = row
    today = datetime.now().astimezone().date().isoformat()
    current = sorted(latest.values(), key=lambda r: (r["product_id"], r["lens_path"], r["technology"], r["material"]))
    day_counts = Counter(r["observed_at"][:10] for r in history)
    products = []
    for p in config["products"]:
        rows = [r for r in current if r["product_id"] == p["product_id"]]
        products.append({**{k: p[k] for k in ("product_id", "name", "sku", "url")},
            "bestseller_source": p.get("bestseller_source"),
            "expected_configurations": len(p["jobs"]), "latest_configurations": len(rows),
            "today_configurations": sum(r["observed_at"][:10] == today for r in rows),
            "frame_price": max(rows, key=lambda r: r["observed_at"])["frame_price"] if rows else None})
    data = {"generated_at": datetime.now().astimezone().isoformat(), "today": today,
        "scope": "Vooglam 普通眼镜；默认已核验颜色；Single Vision SPH/CYL 0.00、PD 66；优惠前购物车单件小计；不含未验证税费与运费",
        "products": products, "dates": dict(sorted(day_counts.items())), "observations": current,
        "history": history, "history_count": len(history)}
    (output / "prices.json").write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    e = lambda value: escape(str(value if value is not None else "—"))
    cards = "".join(f'<article><h2>{e(p["name"])}</h2><p>{e(p["product_id"])} · {e(p["sku"])}</p>'
        f'<strong>镜框 ${e(p["frame_price"])}</strong><p>今日购物车核价 {p["today_configurations"]}/{p["expected_configurations"]} 条</p>'
        f'<a href="{e(p["url"])}">官方商品页</a>' +
        (f' · <a href="{e(p["bestseller_source"])}">官网畅销集合</a>' if p.get("bestseller_source") else '') +
        '</article>' for p in products)
    lines = []
    for row in current:
        prior = row["previous_day_observation"]
        change = "$" + prior["difference"] if prior else "无跨日基期"
        freshness = "今日" if row["observed_at"][:10] == today else "历史，尚未刷新"
        evidence = f'<a href="{row["evidence"]}">截图</a>' if row["evidence"] else "证据文件缺失"
        lines.append('<tr>' + ''.join(f'<td>{e(v)}</td>' for v in (row["product"], row["lens_path"],
            row["technology"], row["material"],
            "$" + format(Decimal(str(row["material_surcharge"])), ".2f") if row.get("material_surcharge") is not None else "未经过材料页",
            "$"+row["frame_price"], "$"+row["lens_price"],
            "$"+row["total"], change, row["observed_at"], freshness)) + f'<td>{evidence}</td></tr>')
    date_text = "；".join(f"{d}：{n} 条真实观测" for d, n in sorted(day_counts.items()))
    page = '''<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Vooglam 最新价格与历史比价</title><style>body{font:15px system-ui;background:#f5f6fa;color:#182335;margin:30px}h1{font-size:27px}.cards{display:flex;flex-wrap:wrap;gap:14px}article{background:white;padding:18px;border-radius:12px;min-width:200px;flex:1}article p{color:#536176}strong{font-size:21px}a{color:#205ab4}table{border-collapse:collapse;background:white;width:100%;font-size:13px}th,td{padding:10px;text-align:left;border-bottom:1px solid #e0e5ee;white-space:nowrap}th{background:#e9eef8;position:sticky;top:0}.table{overflow:auto;max-height:65vh}input{padding:11px;width:min(450px,90%);margin:18px 0}</style>
<h1>Vooglam 最新价格与历史比价</h1>'''
    page += f'<p>{e(data["scope"])}</p><p>生成时间 {e(data["generated_at"])} · {e(date_text)}</p>'
    page += '<p>仅真实观测；未刷新组合保留原日期。涨跌对比使用同配置的上一观测日；新商品没有历史时不补造趋势。</p>'
    page += (f'<section class="cards">{cards}</section><input id="filter"'
             ' placeholder="筛选商品、镜片、材料或日期"><a href="prices.json">下载价格与完整历史 JSON</a>')
    page += '<div class="table"><table><thead><tr>' + ''.join('<th>'+x+'</th>' for x in
        ('商品','镜片路径','技术','材料','材料加价','镜框','镜片含材料','总价','跨日变化','实际观测时间','时效','证据')) + '</tr></thead><tbody>'
    page += ''.join(lines) + '</tbody></table></div><script>document.getElementById("filter").oninput=e=>{const q=e.target.value.toLowerCase();document.querySelectorAll("tbody tr").forEach(r=>r.hidden=!r.textContent.toLowerCase().includes(q))}</script></html>'
    (output / "index.html").write_text(page, encoding="utf-8")
    archive = output.with_suffix(".zip")
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for path in output.rglob("*"):
            if path.is_file():
                z.write(path, path.relative_to(output).as_posix())
    print(json.dumps({"report": str(output / "index.html"), "archive": str(archive),
        "history_count": len(history), "dates": data["dates"], "products": products}, ensure_ascii=False))
    return data


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", type=Path, default=ROOT / "config.json")
    parser.add_argument("--database", type=Path, default=ROOT / "history.sqlite3")
    parser.add_argument("--output", type=Path, default=ROOT / "reports" / datetime.now().strftime("%Y%m%d"))
    args = parser.parse_args()
    build(args.config, args.database, args.output)

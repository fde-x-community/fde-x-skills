const alertData=A.alert_inputs||{price_changes:[],stockout_runs:[],stock_observation_count:0,defaults:{price_change_percent:10,stockout_consecutive_days:3}};
const alertStorageKey='eyewear-alert-rules:'+String(M.run_id||JSON.stringify(M.products||[]));
let savedRules=null;
try{savedRules=JSON.parse(localStorage.getItem(alertStorageKey)||'null')}catch{}
$('alert-price-threshold').value=Number(savedRules?.price_change_percent)>0?savedRules.price_change_percent:alertData.defaults.price_change_percent;
$('alert-stock-days').value=Number.isInteger(Number(savedRules?.stockout_consecutive_days))&&Number(savedRules.stockout_consecutive_days)>0?savedRules.stockout_consecutive_days:alertData.defaults.stockout_consecutive_days;
function alertSettings(){return {price_change_percent:Number($('alert-price-threshold').value),stockout_consecutive_days:Number($('alert-stock-days').value)}}
function validAlertSettings(s){return Number.isFinite(s.price_change_percent)&&s.price_change_percent>=0.1&&s.price_change_percent<=1000&&Number.isInteger(s.stockout_consecutive_days)&&s.stockout_consecutive_days>=1&&s.stockout_consecutive_days<=365}
function visibleRecordIds(){return new Set(filtered.map(r=>r.record_id))}
function comparableQuoteChanges(){const visible=visibleRecordIds();return (alertData.price_changes||[]).filter(c=>visible.has(c.current_record_id)&&visible.has(c.baseline_record_id)&&c.change?.status==='ok')}
function renderOverviewPrices(){
 const groups=new Map();
 for(const r of filtered){
  if(r.entity_type!=='price_observation'||r.status!=='ok'||r.quoted_subtotal===null||r.quoted_subtotal===undefined||r.quoted_subtotal===''||!r.currency||!r.observed_at)continue;
  const value=Number(r.quoted_subtotal);if(!Number.isFinite(value))continue;
  const key=JSON.stringify([r.brand,r.market,r.currency,r.price_basis,r.observed_at.slice(0,10)]);
  if(!groups.has(key))groups.set(key,{brand:r.brand,market:r.market,currency:r.currency,basis:r.price_basis,date:r.observed_at.slice(0,10),values:[],evidence_ids:[]});
  groups.get(key).values.push(value);groups.get(key).evidence_ids.push(r.evidence_id);
 }
 const rows=[...groups.values()].sort((a,b)=>a.date.localeCompare(b.date)||a.brand.localeCompare(b.brand)||a.market.localeCompare(b.market));
 const changes=comparableQuoteChanges(),up=changes.filter(c=>Number(c.change.value)>0).length,down=changes.filter(c=>Number(c.change.value)<0).length,flat=changes.length-up-down;
 $('overview-prices').innerHTML=rows.length?`<p><strong>同配置跨观测日：</strong>${changes.length} 组可核对报价，其中上涨 ${up}、下降 ${down}、持平 ${flat}。这是两次已观测报价的比较，缺测日不视为前一日；税运费/优惠资格未验证，不代表成交价变化。</p><div class="table"><table><thead><tr><th>品牌</th><th>市场 / 币种</th><th>观测日</th><th>已查到最低</th><th>已查到最高</th><th>报价记录</th><th>报价口径</th></tr></thead><tbody>${rows.map(g=>`<tr><td>${esc(g.brand)}</td><td>${esc(g.market)} / ${esc(g.currency)}</td><td>${esc(g.date)}</td><td>${esc(Math.min(...g.values).toFixed(2))}</td><td>${esc(Math.max(...g.values).toFixed(2))}</td><td>${g.values.length}</td><td>${esc(g.basis||'未说明')}</td></tr>`).join('')}</tbody></table></div>`:'<p>暂无数据：当前筛选没有可核验的配置报价。</p>';
}
function renderAlertResults(){
 const settings=alertSettings();
 if(!validAlertSettings(settings)){$('alert-results').innerHTML='<p class="notice">请输入 0.1%–1000% 的价格阈值，以及 1–365 的整数天数。</p>';return}
 const matches=comparableQuoteChanges().filter(c=>Math.abs(Number(c.change.value))>=settings.price_change_percent);
 const visible=visibleRecordIds();
 const stock=(alertData.stockout_runs||[]).filter(s=>s.days>=settings.stockout_consecutive_days&&s.record_ids.every(id=>visible.has(id)));
 const priceHtml=matches.length?matches.map(c=>`<div class="alert-row"><strong>报价波动 ${Number(c.change.value)>0?'↑':'↓'} ${Math.abs(Number(c.change.value)).toFixed(1)}%</strong> · ${esc(products.get(c.product_id)?.name||c.product_id)} · ${esc(c.market)} / ${esc(c.currency)}<br>${esc(c.baseline_at.slice(0,10))} ${esc(c.baseline)} → ${esc(c.current_at.slice(0,10))} ${esc(c.current)} · 同一配置的优惠前报价<br><button data-evidence="${esc(c.baseline_evidence_id)}">前次证据</button> <button data-evidence="${esc(c.current_evidence_id)}">本次证据</button><p class="muted">可能原因：原因不明。下一步：核对原站同配置、促销和费用条件。</p></div>`).join(''):'<p>当前筛选和阈值下，没有达到价格波动条件的已核验报价。</p>';
 const stockHtml=!alertData.stock_observation_count?'<p>连续缺货：暂无法判断；当前数据包没有逐日库存观测，不把未观测日算作缺货。</p>':stock.length?stock.map(s=>`<div class="alert-row"><strong>连续缺货 ${s.days} 天</strong> · ${esc(products.get(s.product_id)?.name||s.product_id)} · ${esc(s.start)} 至 ${esc(s.end)}<br>${s.evidence_ids.map(id=>`<button data-evidence="${esc(id)}">来源 ${esc(id)}</button>`).join(' ')}<p class="muted">下一步：重新核对该变体官网库存与地区条件。</p></div>`).join(''):'<p>当前筛选和阈值下，没有连续缺货记录；仅按有证据的连续自然日判断。</p>';
 $('alert-results').innerHTML=`<h3>价格波动 · ${matches.length} 条</h3>${priceHtml}<h3>连续缺货 · ${stock.length} 条</h3>${stockHtml}`;
}
for(const id of ['alert-price-threshold','alert-stock-days'])$(id).addEventListener('input',()=>{$('alert-rule-status').textContent='规则尚未保存';renderAlertResults()});
$('alert-save').onclick=()=>{const settings=alertSettings();if(!validAlertSettings(settings)){$('alert-rule-status').textContent='阈值无效，请检查输入。';return}try{localStorage.setItem(alertStorageKey,JSON.stringify(settings));$('alert-rule-status').textContent='规则已保存到当前浏览器，刷新后仍可使用。'}catch{$('alert-rule-status').textContent='浏览器保存失败；当前页面仍按所填阈值显示。'}renderAlertResults()};

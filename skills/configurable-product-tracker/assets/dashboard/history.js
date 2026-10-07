// Presentation of observed points only. Comparison dimensions come from Session 3.
const historyKeys=B.price_comparison_keys||[];
let historyGroups=[];
const historyLenses=new Map(records.filter(r=>r.entity_type==='lens_configuration').map(r=>[r.lens_config_id,r]));
const historyVariants=new Map(records.filter(r=>r.entity_type==='variant').map(r=>[r.variant_id,r]));
function historyLabel(group){
 const row=group.sample,lens=historyLenses.get(row.lens_config_id),variant=historyVariants.get(row.variant_id);
 const route=lens?.selection_path||lens?.raw_configuration||lens?.original_labels?.lens_path||'镜片配置未说明';
 const details=[lens?.refractive_index?lens.refractive_index+' 折射率':null,lens?.material,variant?.source_sku?'SKU '+variant.source_sku:null].filter(Boolean);
 return [products.get(row.product_id)?.name||'当前商品',route,...details,row.market+' / '+row.currency].join(' · ');
}
function historyNumber(r,key){const value=r[key];return value===null||value===undefined||value===''||typeof value==='boolean'?null:Number.isFinite(Number(value))?Number(value):null}
function renderHistory(){
 const metric=$('history-metric').value,previous=$('history-series').value,groups=new Map();let excluded=0;
 const keys=[...historyKeys,'source_kind','source_timezone','granularity',...(metric==='quoted_subtotal'?['price_basis']:[])];
 for(const r of filtered){
  if(r.entity_type!=='price_observation')continue;
  const observedQuote=metric==='quoted_subtotal'&&r.history_scope==='observed_quote_only'&&r.history_group_key;
  const required=observedQuote?['product_id','variant_id','lens_config_id','market','currency','source_kind','source_timezone','granularity','price_basis','history_group_key']:keys;
  if(r.status!=='ok'||historyNumber(r,metric)===null||!r.evidence_id||!Number.isFinite(Date.parse(r.observed_at))||!required.length||required.some(k=>r[k]===null||r[k]===undefined||r[k]===''||['undisclosed','not_specified','unknown'].includes(r[k]))){excluded++;continue}
  const signature=JSON.stringify([observedQuote?'observed_quote_only':'comparable',...required.map(k=>r[k])]);
  if(!groups.has(signature))groups.set(signature,{id:signature,rows:[],sample:r});groups.get(signature).rows.push(r);
 }
 historyGroups=[...groups.values()];
 $('history-series').innerHTML=historyGroups.length?historyGroups.map(g=>`<option value="${esc(g.id)}">${esc(historyLabel(g))}</option>`).join(''):'<option value="">暂无可比配置</option>';
 if(historyGroups.some(g=>g.id===previous))$('history-series').value=previous;
 drawHistory(excluded);
}
function drawHistory(excluded=0){
 const group=historyGroups.find(g=>g.id===$('history-series').value),metric=$('history-metric').value;
 if(!group){$('history-chart').innerHTML='<div class="history-empty"><strong>暂无可比历史</strong><p>后续接入多日记录后，在这里查看价格曲线。</p><small>当前记录缺少完整可比配置、费用条件或时间口径，暂不连成历史曲线。</small></div>';$('history-detail').innerHTML='';return}
 const rows=[...group.rows].sort((a,b)=>Date.parse(a.observed_at)-Date.parse(b.observed_at));
 const days=new Set(rows.map(r=>r.observed_at.slice(0,10)));
 $('history-detail').innerHTML=table('历史观测明细（保留原始日期与修订）',rows,[['观测日期','observed_at'],['金额',metric],['币种','currency'],['修订','revision'],['报价口径','price_basis']]);
 if(days.size<2){$('history-chart').innerHTML='<div class="history-empty"><strong>暂无可比历史</strong><p>当前配置仅有一天记录；至少两个日期的同口径观测后展示曲线。</p></div>';return}
 const times=rows.map(r=>Date.parse(r.observed_at)),values=rows.map(r=>historyNumber(r,metric));
 const t0=Math.min(...times),t1=Math.max(...times),lo=Math.min(...values),hi=Math.max(...values),padding=Math.max((hi-lo)*.15,1);
 const bottom=lo-padding,top=hi+padding,x=t=>65+(t-t0)/(t1-t0)*820,y=v=>230-(v-bottom)/(top-bottom)*190;
	 const latestByDay=new Map();rows.forEach(r=>latestByDay.set(r.observed_at.slice(0,10),r));
	 const daily=[...latestByDay.values()];
	 let paths='';for(let i=1;i<daily.length;i++){
	  const prev=daily[i-1],next=daily[i],gap=(Date.parse(next.observed_at.slice(0,10))-Date.parse(prev.observed_at.slice(0,10)))/86400000;
	  paths+=`<line x1="${x(Date.parse(prev.observed_at))}" y1="${y(historyNumber(prev,metric))}" x2="${x(Date.parse(next.observed_at))}" y2="${y(historyNumber(next,metric))}" stroke="#1969b9" stroke-width="2" ${gap>1?'stroke-dasharray="5 5"':''}/>`;
	 }
 const grid=[0,.5,1].map(f=>{const v=bottom+(top-bottom)*f;return `<line x1="65" x2="885" y1="${y(v)}" y2="${y(v)}" stroke="#e3e8f0"/><text x="55" y="${y(v)+4}" text-anchor="end" fill="#65748b" font-size="12">${esc(v.toFixed(2))}</text>`}).join('');
	 const points=rows.map((r,i)=>`<circle ${r.source_kind==='synthetic_fixture'?'':`data-evidence="${esc(r.evidence_id)}" tabindex="0" role="button"`} aria-label="${esc(r.observed_at+' '+values[i]+' '+r.currency)}" cx="${x(times[i])}" cy="${y(values[i])}" r="5" fill="#d9531e" stroke="white" stroke-width="2"><title>${esc(r.observed_at+' · '+values[i]+' '+r.currency+(r.source_kind==='synthetic_fixture'?' · 演示数据':' · 点击查看来源'))}</title></circle>`).join('');
		 $('history-chart').innerHTML=`<p class="muted">${esc(group.sample.currency)} · ${esc(labels[group.sample.source_kind])} · ${rows.length} 次观测 / ${days.size} 个日期。${group.sample.source_kind==='synthetic_fixture'?'虚构的三日报价，仅用于演示波动与连线。':group.sample.history_scope==='observed_quote_only'?'同一已核验购物车路径的报价观测；税、运费与优惠资格未验证，不计算价格变化率。':''}连线使用每个观测日的最新记录；跨缺测日用虚线，同日其他记录和修订仍保留为点。${group.sample.source_kind==='synthetic_fixture'?'':'点击数据点查看来源。'}</p><svg viewBox="0 0 940 280" role="img" aria-label="商品历史价格观测曲线">${grid}${paths}${points}<text x="65" y="260" fill="#65748b" font-size="12">${esc(rows[0].observed_at.slice(0,10))}</text><text x="885" y="260" text-anchor="end" fill="#65748b" font-size="12">${esc(rows.at(-1).observed_at.slice(0,10))}</text></svg>`;
}
$('history-metric').onchange=renderHistory;
$('history-series').onchange=()=>drawHistory();
document.addEventListener('keydown',e=>{if(e.target.matches('circle[data-evidence]')&&['Enter',' '].includes(e.key)){e.preventDefault();e.target.dispatchEvent(new MouseEvent('click',{bubbles:true}))}});

const cardLabels={standard:'Standard Lenses',blue_light:'Blue Light Blocking',driving:'Driving Lenses',photochromic:'Photochromic & Transitions',tint:'Tint & Polarized',led:'Featured - LED Pro Lenses'};
let activeConfigProduct=null;
function littleTrend(points){
 const byDay=new Map([...points].filter(p=>(!$('start').value||p.date>=$('start').value)&&(!$('end').value||p.date<=$('end').value)).sort((a,b)=>a.date.localeCompare(b.date)).map(p=>[p.date,p]));
 const ordered=[...byDay.values()];
 const end=ordered.at(-1)?.date||$('end').value||M.period_end;
 if(!end)return '<div class="sparkline muted">暂无观测</div>';
 const start=new Date(end+'T12:00:00');start.setDate(start.getDate()-29);
 const minDay=start.toISOString().slice(0,10);
 const visible=ordered.filter(p=>p.date>=minDay&&p.date<=end);
 if(!visible.length)return '<div class="sparkline muted">近30天暂无观测</div>';
 const values=visible.map(p=>Number(p.price)),lo=Math.min(...values),hi=Math.max(...values),span=Math.max(hi-lo,1);
 const firstDay=visible[0].date;
 const daySpan=Math.max((Date.parse(visible.at(-1).date)-Date.parse(firstDay))/86400000,1);
 const x=p=>visible.length===1?73:8+(Date.parse(p.date)-Date.parse(firstDay))/86400000*(130/daySpan),y=p=>46-(Number(p.price)-lo)/span*34;
 let lines='';for(let i=1;i<visible.length;i++){const gap=(Date.parse(visible[i].date)-Date.parse(visible[i-1].date))/86400000;lines+=`<line x1="${x(visible[i-1])}" y1="${y(visible[i-1])}" x2="${x(visible[i])}" y2="${y(visible[i])}" stroke="#1969b9" stroke-width="2" ${gap>1?'stroke-dasharray="3 3"':''}/>`}
 return `<div class="trend-compact"><svg class="sparkline" viewBox="0 0 146 58" role="img" aria-label="实际报价近30天趋势，${visible.length} 个观测"><line x1="8" y1="49" x2="138" y2="49" stroke="#e3e8f0"/>${lines}${visible.map(p=>`<circle cx="${x(p)}" cy="${y(p)}" r="2.4" fill="#d9531e"><title>${esc(p.date+' · '+Number(p.price).toFixed(2))}</title></circle>`).join('')}</svg><small>近30天 · ${visible.length}天观测</small></div>`;
}
function formatChange(item){
 const change=item?.change;
 if(!item||item.status!=='ok')return '<span class="muted">暂无报价</span>';
 if(!change||change.status!=='ok')return '<span class="muted" title="缺少同配置前一自然日记录">—</span>';
 const value=Number(change.value),cls=value>0?'price-up':value<0?'price-down':'price-flat';
 return `<span class="${cls}">${value>0?'+':value<0?'−':''}${Math.abs(value).toFixed(1)}%</span> <a href="#page2" data-history-config="${esc(item.lens_config_id||'')}">查看历史</a>`;
}
function priceDirection(item){const change=item?.change;if(!change||change.status!=='ok')return '<span class="muted" title="缺少同配置前一自然日记录">·</span>';const value=Number(change.value);return `<span class="${value>0?'price-up':value<0?'price-down':'price-flat'}">${value>0?'↑':value<0?'↓':'—'}</span>`}
function cardFor(product){
 const safeImage=product.thumbnail_local&&/^media\/[a-zA-Z0-9_-]+\.(png|jpg|jpeg|webp)$/i.test(product.thumbnail_local)
  ?product.brand==='Vooglam'
   ?`<a class="product-image-link" href="${esc(product.thumbnail_local)}" target="_blank" rel="noopener" aria-label="查看 ${esc(product.name)} 原始截图"><span class="vooglam-crop"><img src="${esc(product.thumbnail_local)}" alt="${esc(product.name)} 眼镜" loading="lazy"></span></a>`
   :`<a class="product-image-link" href="${esc(product.thumbnail_local)}" target="_blank" rel="noopener" aria-label="查看 ${esc(product.name)} 商品页截图"><img class="product-image" src="${esc(product.thumbnail_local)}" alt="${esc(product.name)} 商品页截图" loading="lazy"></a>`:'<span>暂无商品图</span>';
 const shown=Object.entries(cardLabels).filter(([key])=>key in product.featured).map(([key,title])=>{
  const item=product.featured[key];
	  return `<div class="product-quote"><div><strong>${esc(title)}</strong>${item?.selection_path?`<div class="product-card-meta">${esc(item.selection_path)}${item.technology?' / '+esc(item.technology):''}</div>`:''}</div><div><strong>${item?.status==='ok'?`${esc(item.currency==='USD'?'$':item.currency==='GBP'?'£':item.currency+' ')}${esc(item.price)} ${priceDirection(item)}`:'—'}</strong></div><div>${formatChange(item)}${item?.observed_at?`<div class="product-card-meta">观测 ${esc(item.observed_at.slice(0,10))}${product.product_id===DEMO_ID?' · 虚构演示':` · <button data-evidence="${esc(item.evidence_id)}">来源</button>`}</div>`:''}</div></div>`;
 }).join('');
	 return `<article class="card product-card"><div class="product-thumb">${safeImage}</div><div class="product-card-main"><div class="product-card-head"><div><h3>${esc(product.name)}</h3><div class="product-card-meta">${esc(product.brand)} · ${esc(product.market)} · 零度场景报价</div></div><div>${littleTrend(product.standard_sparkline||[])}</div></div>${shown}<p><button data-all-config="${esc(product.product_id)}">更多配置 →</button> ${product.product_id===DEMO_ID?'虚构演示，无官网来源':link(product.product_url)}</p><p class="muted">小图：Standard Lenses 同配置报价；· 表示前一自然日缺少可比记录。优惠、税费与运费未验证。</p></div></article>`;
}
function renderProductCards(){
 const days=Object.keys(A.product_cards_by_date||{}).filter(day=>!$('end').value||day<=$('end').value).sort();
 const cards=days.length?A.product_cards_by_date[days.at(-1)]:Object.keys(A.product_cards_by_date||{}).length?[]:(A.product_cards||[]);
 const visibleIds=new Set(filtered.filter(r=>r.product_id).map(r=>r.product_id));
	 const shown=$('product-focus').value===DEMO_ID&&visibleIds.has(DEMO_ID)?[demoCard()]:cards.filter(c=>visibleIds.has(c.product_id));
 $('product-cards').innerHTML=shown.length?shown.map(cardFor).join(''):'<div class="card">当前筛选下暂无商品及报价记录。</div>';
 $('product-cards').querySelectorAll('.vooglam-crop img').forEach(img=>{
  const position=()=>{
   const crop=img.naturalWidth===2023&&img.naturalHeight===1355
    ?{x:72,y:168,width:1173,height:715}
    :img.naturalWidth===1440&&img.naturalHeight===1000
     ?{x:48,y:160,width:846,height:508}:null;
   if(!crop)return;
   const frame=img.parentElement;
   frame.style.aspectRatio=`${crop.width}/${crop.height}`;
   img.style.width=`${img.naturalWidth/crop.width*100}%`;
   img.style.left=`${-crop.x/crop.width*100}%`;
   img.style.top=`${-crop.y/crop.height*100}%`;
  };
  if(img.complete)position();else img.addEventListener('load',position,{once:true});
 });
 if(activeConfigProduct){if(visibleIds.has(activeConfigProduct))renderAllConfigs();else{activeConfigProduct=null;$('all-config-view').hidden=true;$('product-cards').hidden=false}}
}
function demoCard(){
 const current=demoPrices.at(-1),comparison=demoChanges.at(-1);
 return {...products.get(DEMO_ID),featured:{standard:{status:'ok',price:current.quoted_subtotal,currency:'USD',observed_at:current.observed_at,lens_config_id:DEMO_LENS,selection_path:'Standard Lenses / 演示配置',technology:'单光镜片',change:comparison.change}},standard_sparkline:demoPrices.map(row=>({date:row.observed_at.slice(0,10),price:row.quoted_subtotal}))};
}
function configCategory(row,lens){
 const path=lens?.original_labels?.lens_path||lens?.selection_path||'';
 if(path==='Standard Lenses'||path.startsWith('Clear'))return 'standard';
 if(path==='Blue Light Blocking'||path.startsWith('Blue-light Blocking'))return 'blue_light';
 if(path==='Driving Lenses'||path.startsWith('Driving'))return 'driving';
 if(path.startsWith('Photochromic & Transitions'))return 'photochromic';
 if(path.startsWith('Tint & Polarized'))return 'tint';
 if(path.startsWith('Featured - LED Pro Lenses'))return 'led';
 return 'other';
}
function renderAllConfigs(){
 const product=products.get(activeConfigProduct);
 $('all-config-title').textContent=(product?.name||activeConfigProduct)+' · 所有已核验配置';
 const lensMap=new Map(records.filter(r=>r.entity_type==='lens_configuration').map(r=>[r.lens_config_id,r]));
 const latest=new Map();
 for(const row of filtered.filter(r=>r.entity_type==='price_observation'&&r.product_id===activeConfigProduct)){
  const key=row.variant_id+'|'+row.lens_config_id+'|'+row.currency;
  if(!latest.has(key)||row.observed_at>latest.get(key).observed_at)latest.set(key,row);
 }
 const allLatest=[...latest.values()];
 for(const [id,key] of [['config-technology','technology'],['config-material','material']]){
  const control=$(id),previous=control.value;
  const values=[...new Set(allLatest.map(row=>lensMap.get(row.lens_config_id)?.[key]||'__missing__'))].sort((a,b)=>a.localeCompare(b));
  control.innerHTML='<option value="">全部</option>'+values.map(value=>`<option value="${esc(value)}">${esc(value==='__missing__'?'未核验':value)}</option>`).join('');
  if(values.includes(previous))control.value=previous;
 }
 const category=$('config-category').value,technology=$('config-technology').value,material=$('config-material').value;
 const selected=allLatest.filter(row=>{
  const lens=lensMap.get(row.lens_config_id),kind=configCategory(row,lens);
  return (!category||category===kind)&&(!technology||technology===(lens?.technology||'__missing__'))&&(!material||material===(lens?.material||'__missing__'));
 }).sort((a,b)=>{
  const la=lensMap.get(a.lens_config_id),lb=lensMap.get(b.lens_config_id);
  return (la?.selection_path||'').localeCompare(lb?.selection_path||'');
 });
 const changesByRecord=new Map(allPriceChanges().filter(c=>c.change?.status==='ok').map(c=>[c.current_record_id,c]));
 $('config-count').textContent=`显示 ${selected.length} / ${latest.size} 种已观测配置；同一配置取筛选期间的最新报价，不将不同市场、币种或变体合并。`;
 $('config-table').innerHTML=selected.length?`<div class="card table"><table><thead><tr><th>配置类别</th><th>用途 / 功能</th><th>镜片技术</th><th>材料</th><th>折射率</th><th>镀膜</th><th>镜片品牌</th><th>镜框</th><th>镜片</th><th>报价小计 / 变化</th><th>观测日期</th><th>来源</th></tr></thead><tbody>${selected.map(row=>{
  const lens=lensMap.get(row.lens_config_id),kind=configCategory(row,lens),comparison=changesByRecord.get(row.record_id),value=Number(comparison?.change?.value),cls=value>0?'price-up':value<0?'price-down':'price-flat';
  const change=comparison?`<span class="${cls}">${value>0?'+':value<0?'−':''}${Math.abs(value).toFixed(1)}%</span>`:'<span class="muted">暂无可比变化</span>';
  return `<tr><td>${esc(cardLabels[kind]||'其他')}</td><td>${esc(lens?.lens_function||'未核验')}</td><td>${esc(lens?.technology||'未核验')}</td><td>${esc(lens?.material||'未核验')}</td><td>${esc(lens?.refractive_index||'未核验')}</td><td>${esc(lens?.coating||'-')}</td><td>${esc(lens?.lens_brand||'-')}</td><td>${esc(row.base_frame_price)} ${esc(row.currency)}</td><td>${esc(row.lens_surcharge)} ${esc(row.currency)}</td><td><strong>${esc(row.quoted_subtotal)} ${esc(row.currency)} ${priceDirection({change:comparison?.change})}</strong><div>${change} · <a href="#page2" data-history-config="${esc(row.lens_config_id)}">查看历史</a></div></td><td>${esc(row.observed_at.slice(0,10))}</td><td>${row.source_kind==='synthetic_fixture'?'<span class="muted">演示无来源</span>':`<button data-evidence="${esc(row.evidence_id)}">查看截图</button>`}</td></tr>`}).join('')}</tbody></table></div>`:'<div class="card">当前筛选下没有对应配置。</div>';
}
document.addEventListener('click',event=>{const pid=event.target.dataset.allConfig;if(!pid)return;activeConfigProduct=pid;$('product-cards').hidden=true;$('all-config-view').hidden=false;renderAllConfigs();$('page1').scrollIntoView({behavior:'smooth'})});
$('back-to-products').onclick=()=>{activeConfigProduct=null;$('all-config-view').hidden=true;$('product-cards').hidden=false};
document.addEventListener('click',event=>{const link=event.target.closest('a[data-history-config]');if(!link)return;$('history-metric').value='quoted_subtotal';renderHistory();const group=historyGroups.find(g=>g.sample.product_id===$('product-focus').value&&g.sample.lens_config_id===link.dataset.historyConfig);if(group){$('history-series').value=group.id;drawHistory()} });
$('config-category').onchange=renderAllConfigs;
$('config-technology').onchange=renderAllConfigs;
$('config-material').onchange=renderAllConfigs;

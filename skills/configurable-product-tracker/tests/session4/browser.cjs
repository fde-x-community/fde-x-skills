// Run with the bundled Node runtime and NODE_PATH pointing at its packages.
const {chromium}=require('playwright');
const {spawnSync}=require('child_process');
const fs=require('fs'),path=require('path'),assert=require('assert');
const out=path.resolve('dashboard/test-report');
const base={brand:'Alpha',market:'US',product_id:'a',source_kind:'public_observation',observed_at:'2026-09-25',status:'ok',evidence_id:'ev-a',source_url_or_ref:'https://example.invalid/a'};
const records=[{...base,entity_type:'product',record_id:'p-a',name:'One',product_type:'prescription_frames',frame_style:'round'},
 {...base,entity_type:'price_observation',record_id:'price-a',currency:'USD',quoted_subtotal:'35'},
 {...base,entity_type:'price_observation',record_id:'price-null',currency:'USD',quoted_subtotal:null},
 {...base,entity_type:'product',record_id:'p-b',product_id:'b',brand:'Beta',market:'CA',name:'Two',product_type:'sunglasses',frame_style:'square',source_kind:'synthetic_fixture',observed_at:'2026-09-24',evidence_id:'ev-b'},
 {...base,entity_type:'traffic_observation',record_id:'traffic',product_id:null,source_kind:'third_party_estimate',value:'100',scope:'website',granularity:'month',data_period_start:'2026-08-01',data_period_end:'2026-08-31'}];
const dataset={records,evidence:[{evidence_id:'ev-a',source_url_or_ref:base.source_url_or_ref},{evidence_id:'ev-b'}],errors:[],coverage:{requested_scope:'synthetic browser test'}};
const manifest={run_id:'browser-test',products:['Alpha One','Beta Two'],market:'US',period_start:'2026-08-01',period_end:'2026-09-26',mode:'synthetic_fixture'};
const result=spawnSync(process.env.SESSION4_PYTHON || 'python',['-c','import json,sys;from dashboard import render_dashboard;b=json.load(sys.stdin);render_dashboard(b["dataset"],{},b["manifest"],b["output"])'],{input:JSON.stringify({dataset,manifest,output:out}),encoding:'utf8',env:{...process.env,PYTHONUTF8:'1'}});
assert.equal(result.status,0,result.stderr);
(async()=>{
 const browser=await chromium.launch({channel:'chrome',headless:true});
 const page=await browser.newPage({viewport:{width:1440,height:1000},acceptDownloads:true});const errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.goto('file:///'+out.replace(/\\/g,'/')+'/index.html');
 const count=()=>page.evaluate(()=>filtered.length);
 assert.equal(await count(),5);assert.equal(await page.locator('#synthetic').isVisible(),true);
 for(const [id,value,expected] of [['brand','Beta',1],['market','CA',1],['type','sunglasses',1],['style','square',1],['nature','third_party_estimate',1]]){
  await page.selectOption('#'+id,value);assert.equal(await count(),expected,id);assert.equal(await page.locator('.bar-row').count(),1);await page.click('#reset');
 }
 await page.fill('#start','2026-09-25');assert.equal(await count(),3);await page.click('#reset');
 assert.equal(await page.locator('#min,#max').count(),0);await page.click('.export-menu summary');assert.equal(await page.locator('#json').isVisible(),true);
 for(let i=0;i<6;i++){await page.click(`[data-page="${i}"]`);assert.equal(await page.locator(`#page${i}`).isVisible(),true)}
 await page.click('[data-page="1"]');await page.click('#page1 details summary');await page.click('#page1 [data-evidence="ev-a"]');assert.equal(await page.locator('#source-dialog').isVisible(),true);assert((await page.locator('#source-detail').innerText()).includes('ev-a'));await page.click('#close-dialog');
 await page.selectOption('#brand','Alpha');
 for(const [id,suffix] of [['json','details.json'],['csv','details.csv'],['sources','sources.json'],['summary','summary.json']]){
  const wait=page.waitForEvent('download');await page.click('#'+id);const dl=await wait;const target=path.join(out,suffix);await dl.saveAs(target);const data=fs.readFileSync(target,'utf8');assert(data.includes('Alpha')||id==='sources'||id==='summary');
  if(id==='json'){const parsed=JSON.parse(data);assert.equal(parsed.metadata.record_count,4);assert.equal(parsed.records.length,4)}
 }
 await page.click('[data-page="5"]');await page.fill('[name=item]','核验优惠');await page.fill('[name=owner]','运营');await page.fill('[name=method]','核对原始购物车');await page.fill('[name=due_or_action_date]','2026-09-28');await page.click('#action-form button:not([type])');
 assert((await page.locator('#action-status').innerText()).includes('已保存'));await page.reload();await page.click('[data-page="5"]');assert((await page.locator('#actions').innerText()).includes('核验优惠'));
 await page.selectOption('#brand','Beta');await page.click('.export-menu summary');const wait=page.waitForEvent('download');await page.click('#html');const dl=await wait;const html=path.join(out,'exported.html');await dl.saveAs(html);
 await page.goto('file:///'+html.replace(/\\/g,'/'));assert.equal(await count(),1);await page.click('[data-page="5"]');assert((await page.locator('#actions').innerText()).includes('核验优惠'));
 await page.emulateMedia({media:'print'});for(let i=0;i<6;i++)assert.equal(await page.locator('#page'+i).isVisible(),true);
 await page.emulateMedia({media:'screen'});await page.click('[data-page="0"]');await page.screenshot({path:path.join(out,'preview.png'),fullPage:true});
 await page.click('#reset');await page.click('[data-page="2"]');assert((await page.locator('#history-chart').innerText()).includes('暂无可比历史'));
 await page.evaluate(()=>{for(const [day,price] of [['23','0'],['24','35'],['26','40'],['25',null]])records.push({entity_type:'price_observation',record_id:'history-'+day,product_id:'a',variant_id:'v-a',lens_config_id:'l-a',market:'US',brand:'Alpha',currency:'USD',eligibility:'everyone',pair_basis:'pair',tax_included:false,shipping_included:false,source_kind:'synthetic_fixture',source_timezone:'Asia/Shanghai',granularity:'instant',status:'ok',observed_at:'2026-09-'+day+'T12:00:00+08:00',quoted_subtotal:price,price_basis:'before_coupon_subtotal',evidence_id:'ev-a'});render()});
 assert.equal(await page.locator('#history-chart circle').count(),3);assert.equal(await page.locator('#history-chart line[stroke="#1969b9"]').count(),1,'unobserved day gap not connected');assert((await page.locator('#history-chart').innerText()).includes('3 次观测'));
 await page.locator('#history-chart circle').first().click();assert.equal(await page.locator('#source-dialog').isVisible(),true);await page.click('#close-dialog');
 await page.fill('#start','2026-09-26');assert.equal(await page.locator('#history-chart circle').count(),0);assert((await page.locator('#history-chart').innerText()).includes('仅有一天'));
 await page.click('#reset');await page.selectOption('#history-metric','complete_pair_price');assert((await page.locator('#history-chart').innerText()).includes('暂无可比历史'));
 await page.goto('file:///'+path.resolve('dashboard/sample-report/index.html').replace(/\\/g,'/'));assert((await page.locator('#mode').innerText()).includes('历史真实资料回放'));assert((await count())>0);await page.click('[data-page="2"]');assert((await page.locator('#history-chart').innerText()).includes('暂无可比历史'));await page.screenshot({path:path.resolve('dashboard/sample-report/history-preview.png')});
 await page.goto('file:///'+path.resolve('dashboard/monitor-report/index.html').replace(/\\/g,'/'));assert.equal(await count(),418);await page.click('[data-page="2"]');assert((await page.locator('#history-chart').innerText()).includes('报价观测'));assert((await page.locator('#history-chart').innerText()).includes('2 个日期'));assert((await page.locator('#history-chart circle').count())>=2);
 await page.goto('file:///'+path.resolve('dashboard/combined-report/index.html').replace(/\\/g,'/'));assert.equal(await count(),438);await page.selectOption('#brand','Firmoo');assert.equal(await count(),20);await page.selectOption('#market','UK');assert.equal(await count(),6);await page.selectOption('#currency','GBP');assert.equal(await count(),6);await page.click('[data-page="2"]');assert((await page.locator('#history-chart').innerText()).includes('暂无可比历史'));await page.click('#reset');await page.click('[data-page="5"]');await page.locator('#evidence [data-evidence]').first().click();assert.equal(await page.getByText('打开本地原始快照').count(),1);assert((await page.locator('#source-detail').innerText()).includes('snapshot_local'));await page.click('#close-dialog');
 await page.click('[data-page="1"]');assert.equal(await page.locator('.product-card').count(),8);assert.equal(await page.locator('.product-card img').count(),5);assert((await page.locator('.product-card').first().innerText()).includes('较前一日：暂无可比记录'));await page.locator('.product-card [data-all-config]').first().click();assert.equal(await page.locator('#all-config-view').isVisible(),true);assert((await page.locator('#config-count').innerText()).includes('种已观测配置'));await page.selectOption('#config-category','standard');assert((await page.locator('#config-table').innerText()).includes('Standard Lenses'));await page.click('#back-to-products');assert.equal(await page.locator('.product-card').first().isVisible(),true);await page.screenshot({path:path.resolve('dashboard/combined-report/product-cards-preview.png'),fullPage:true});
 assert.deepEqual(errors,[]);await browser.close();
 console.log(JSON.stringify({status:'passed',checks:['six_pages','filters','export_dropdown','chart_sync','source_dialog','four_exports','action_reload','portable_html','print_six_pages','history_points','history_gap','history_zero_and_missing','history_filter','history_evidence','real_monitor_import','firmoo_market_currency','local_snapshot','product_cards','featured_quotes','all_config_drilldown','no_js_errors']}));
})().catch(e=>{console.error(e);process.exit(1)});

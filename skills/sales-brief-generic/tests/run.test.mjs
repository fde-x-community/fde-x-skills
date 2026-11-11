// 机械层回归：索引 → 校验 → 渲染，外加两个 script 阶段与 CLI 入口。
// 语义结论由 agent 节点负责，这里只钉死确定性规则；每个用例都用合成数据。
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  SEGMENT_TURNS,
  evaluateExpr,
  indexTranscript,
  parseChineseNumber,
  planIndexes,
  renderHtml,
  runFinalize,
  runIndex,
  runRender,
  validateAnalysis,
  validateAnalysisDetailed,
  writeInputAudit,
  writeSegments,
} from '../scripts/run.mjs'

const TESTS_DIR = dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = dirname(TESTS_DIR)
const FIXTURES = join(SKILL_DIR, 'examples', 'fixtures')
const TRANSCRIPT = join(FIXTURES, 'synthetic.txt')
const ANALYSIS = join(FIXTURES, 'analysis.json')
const CLI = join(SKILL_DIR, 'scripts', 'run.mjs')

function loadAnalysis() {
  return JSON.parse(readFileSync(ANALYSIS, 'utf8'))
}

function loadIndex() {
  return indexTranscript({ transcriptPath: TRANSCRIPT, sessionId: 'S1' })
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), 'brief-fusion-'))
}

function runInputFor(outDir) {
  return { transcripts: [{ session_id: 'S1', path: TRANSCRIPT, sequence: 1, session_date: '2026-01-01' }], out_dir: outDir }
}

function contains(errors, fragment) {
  return errors.some((error) => error.includes(fragment))
}

// ── 索引 ────────────────────────────────────────────────────────────────────

test('索引保留原始行号、时间戳与输入 SHA-256', () => {
  const index = loadIndex()
  assert.equal(index.session_id, 'S1')
  assert.equal(index.source_name, 'synthetic.txt')
  assert.match(index.sha256, /^[a-f0-9]{64}$/)
  assert.equal(index.turns.length, 6)
  assert.equal(index.turns[0].turn_id, 'L2@00:00:01')
  assert.equal(index.turns[0].line, 2)
  assert.equal(index.turns[0].speaker, '发言人1')
  assert.equal(index.turns[1].text, '我想先了解眼部，效果自然一点。')
  assert.equal(index.unparsed_lines.length, 1)
  assert.equal(index.unparsed_lines[0].line, 1)
  assert.equal(index.unparsed_lines[0].possible_title, true)
})

test('没有可解析话轮时干净失败', () => {
  const outDir = tempDir()
  const emptyPath = join(outDir, 'no-turns.txt')
  writeFileSync(emptyPath, '这是一段没有任何时间戳的正文\n第二行\n', 'utf8')
  assert.throws(() => indexTranscript({ transcriptPath: emptyPath, sessionId: 'S1' }), /没有可解析的话轮/)
})

test('index 阶段写盘并产出 index_only 契约文档', () => {
  const outDir = tempDir()
  const output = runIndex(runInputFor(outDir), SKILL_DIR)
  assert.equal(output.status, 'index_only')
  assert.equal(output.h5, '')
  assert.deepEqual(output.validation, { checked: false, ok: false, errors: [] })
  assert.equal(output.execution_status, 'no_action_executed')
  assert.deepEqual(Object.keys(output).sort(), ['execution_status', 'h5', 'input_binding', 'kb', 'kb_source', 'kb_status', 'kb_tried', 'sessions', 'status', 'validation'])
  assert.equal(output.sessions.length, 1)
  assert.equal(output.sessions[0].turns, 6)
  assert.equal(output.sessions[0].unparsed_lines, 1)
  assert.ok(existsSync(output.sessions[0].index_path))
  const index = JSON.parse(readFileSync(output.sessions[0].index_path, 'utf8'))
  assert.equal(index.turns[1].turn_id, 'L3@00:00:05')
})

test('缺少 out_dir 时报三段式错误', () => {
  assert.throws(
    () => planIndexes({ transcripts: [{ session_id: 'S1', path: TRANSCRIPT }] }, SKILL_DIR),
    (error) => error.name === 'SkillError' && error.what.includes('out_dir') && typeof error.fix === 'string',
  )
})

test('重复 session_id 直接拒绝', () => {
  assert.throws(
    () => planIndexes({
      transcripts: [{ session_id: 'S1', path: TRANSCRIPT }, { session_id: 'S1', path: TRANSCRIPT }],
      out_dir: tempDir(),
    }, SKILL_DIR),
    /重复/,
  )
})

test('session_id 只能是安全文件名', () => {
  assert.throws(
    () => planIndexes({ transcripts: [{ session_id: 'S 1', path: TRANSCRIPT }], out_dir: tempDir() }, SKILL_DIR),
    /非法字符/,
  )
})

// ── 校验 ────────────────────────────────────────────────────────────────────

test('黄金样例通过机械校验并渲染出可读 H5', () => {
  const analysis = loadAnalysis()
  const index = loadIndex()
  assert.deepEqual(validateAnalysis(analysis, [index]), [])
  const page = renderHtml(analysis, [index])
  // v0.5.7：页面改为「速览 + 折叠分区」，折叠元素带 class（sect / ev），不再是裸 <details>
  assert.ok(page.includes('<details class="sect"'), '应有折叠分区')
  assert.ok(page.includes('<details class="ev"'), '应有折叠证据')
  assert.ok(page.includes('一页速览'), '应有速览区')
  assert.ok(page.includes('执行条件'))
  assert.ok(page.includes('先不交钱'))
  assert.ok(page.includes('客户画像与项目意向'))
  assert.ok(!page.includes('[object Object]'))
})

test('编造原话被拦下', () => {
  const analysis = loadAnalysis()
  analysis.evidence[0].quote = '我已经付款'
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '连续子串'))
})

test('跨会话引用被拦下', () => {
  const analysis = loadAnalysis()
  analysis.evidence[0].session_id = 'S2'
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '不存在'))
})

test('混杂角色不能写成客户表达', () => {
  const analysis = loadAnalysis()
  analysis.evidence[0].role_status = 'mixed'
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '混杂/未知'))
})

test('停止联系时不能有对客任务', () => {
  const analysis = loadAnalysis()
  analysis.contact_policy = 'stop_all'
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '禁止联系'))
})

test('verified 缺凭证被拦下', () => {
  const analysis = loadAnalysis()
  analysis.transaction.payment = 'verified'
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '缺少凭证'))
})

test('未解析正文阻断校验', () => {
  const index = loadIndex()
  index.unparsed_lines.push({ line: 8, text: '未解析正文', possible_title: false })
  assert.ok(contains(validateAnalysis(loadAnalysis(), [index]), '未解析正文'))
})

test('联系许可未明时对客任务必须写明许可条件', () => {
  const analysis = loadAnalysis()
  analysis.actions[1].condition = '可以随时联系。'
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '必须要求许可'))
})

test('内部任务不能带对客话术', () => {
  const analysis = loadAnalysis()
  analysis.actions[0].script = '建议您尽快付款。'
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '内部任务不能有对客话术'))
})

test('渲染转义 HTML', () => {
  const analysis = loadAnalysis()
  const index = loadIndex()
  analysis.summary = '<script>alert(1)</script>'
  const page = renderHtml(analysis, [index])
  assert.ok(!page.includes('<script>alert(1)</script>'))
  assert.ok(page.includes('&lt;script&gt;'))
})

test('重复索引被拦下', () => {
  const index = loadIndex()
  assert.ok(contains(validateAnalysis(loadAnalysis(), [index, loadIndex()]), '重复'))
})

// ── render 阶段 ─────────────────────────────────────────────────────────────

test('render 阶段渲染 H5 并守住输出契约', () => {
  const outDir = tempDir()
  const output = runRender({ runInput: runInputFor(outDir), submission: { analysis: loadAnalysis() }, base: SKILL_DIR })
  assert.equal(output.status, 'rendered')
  assert.equal(output.validation.ok, true)
  assert.equal(output.execution_status, 'no_action_executed')
  assert.deepEqual(Object.keys(output).sort(), ['execution_status', 'h5', 'industry_basis', 'kb_report', 'kb_source', 'kb_status', 'kb_tried', 'sessions', 'status', 'validation'])
  assert.ok(output.h5.endsWith('销售简报.html'))
  assert.ok(existsSync(output.h5))
  assert.ok(existsSync(join(outDir, 'S1.index.json')))
  assert.ok(existsSync(join(outDir, 'analysis.json')))
  assert.ok(existsSync(join(outDir, '校验结果.json')))
  const page = readFileSync(output.h5, 'utf8')
  assert.ok(page.includes('查看依据'))
  // 没写 industry-mode.json（例如 preflight 未挂载）：横幅必须明说「基准未标注」，不能假装是行业配置
  assert.equal(output.industry_basis.source, 'unknown')
  assert.ok(page.includes('配置基准未标注'))
})

// 配置基准（industry-mode.json）：决定「行业词校验开不开」与「H5 页首横幅写什么」。
// 不能只测「generic 时没报错」——必须同时证明同一份稿子在非通用模式下真的会被拒收。
function writeIndustryMode(outDir, mode) {
  writeFileSync(join(outDir, 'industry-mode.json'), JSON.stringify(mode), 'utf8')
}

test('通用词表模式：行业词校验关闭，H5 与 run 输出都标明「不是行业特异」', () => {
  const analysisWithTerm = () => {
    const analysis = loadAnalysis()
    // 「体检」在合成转录里从未出现，且不在任何证据原话里：非通用模式下必然被拒收
    analysis.barriers[0].text = '顾问交代了体检与麻醉的安排。'
    return analysis
  }

  // 对照组：没有 industry-mode.json、但工作目录给了行业配置 → 行业词断言被拦
  // （技能包自带的模板 industry_terms 为空，所以这里显式给一份词表，才谈得上「非通用模式下会被拦」）
  const plainDir = tempDir()
  writeFileSync(join(plainDir, 'industry-config.json'), JSON.stringify({ industry_terms: ['体检', '麻醉'] }), 'utf8')
  const plain = runRender({ runInput: runInputFor(plainDir), submission: { analysis: analysisWithTerm() }, base: SKILL_DIR })
  assert.ok(contains(plain.validation.errors, '行业词'), `对照组应被行业词校验拦下：${plain.validation.errors.join(' | ')}`)
  assert.equal(plain.industry_basis.source, 'unknown')

  // 实验组：preflight 写了 generic=true → 同一条正文不再报行业词
  const genericDir = tempDir()
  writeIndustryMode(genericDir, { source: 'generic', generic: true, industry_terms_count: 0, industry_label: '示例行业' })
  const generic = runRender({ runInput: runInputFor(genericDir), submission: { analysis: analysisWithTerm() }, base: SKILL_DIR })
  assert.deepEqual(generic.validation.errors.filter((error) => error.includes('行业词')), [])
  assert.equal(generic.industry_basis.generic, true)
  assert.equal(generic.industry_basis.industry_terms, 0)
  const page = readFileSync(generic.h5, 'utf8')
  assert.ok(page.includes('本次基于通用词表'))
  assert.ok(page.includes('行业流程词校验已关闭'))
})

test('行业配置模式：H5 横幅写明生效词数与来源', () => {
  const outDir = tempDir()
  writeIndustryMode(outDir, { source: 'bootstrapped', generic: false, industry_terms_count: 27, industry_label: '示例行业' })
  const output = runRender({ runInput: runInputFor(outDir), submission: { analysis: loadAnalysis() }, base: SKILL_DIR })
  assert.equal(output.industry_basis.generic, false)
  assert.equal(output.industry_basis.industry_terms, 27)
  const page = readFileSync(output.h5, 'utf8')
  assert.ok(page.includes('已按行业配置出稿'))
  assert.ok(page.includes('27 个词'))
})

test('工作目录里的行业配置优先于技能包自带配置', () => {
  // 设计约定：行业配置落在工作目录（<out_dir>/industry-config.json），技能包保持通用。
  const outDir = tempDir()
  writeFileSync(join(outDir, 'industry-config.json'), JSON.stringify({ industry_terms: ['镇痛泵'] }), 'utf8')
  const analysis = loadAnalysis()
  analysis.actions[0].content = '已和客户确认镇痛泵下周二。'
  const output = runRender({ runInput: runInputFor(outDir), submission: { analysis }, base: SKILL_DIR })
  assert.ok(contains(output.validation.errors, '行业词「镇痛泵」'), output.validation.errors.join(' | '))
  // 对照组：只按技能包配置校验时没有这个词表，这条错误不会出现——证明工作目录配置被采用
  assert.ok(!contains(validateAnalysisDetailed(analysis, [loadIndex()]).errors, '镇痛泵'))
  const result = JSON.parse(readFileSync(join(outDir, '校验结果.json'), 'utf8'))
  assert.ok(result.industry_basis.config_path.endsWith('industry-config.json'))
  assert.equal(result.industry_basis.config_source, 'dir')
})

test('generic 模式下工作目录里的行业配置被忽略', () => {
  const outDir = tempDir()
  writeFileSync(join(outDir, 'industry-config.json'), JSON.stringify({ industry_terms: ['镇痛泵'] }), 'utf8')
  writeIndustryMode(outDir, { source: 'generic', generic: true, industry_terms_count: 0, industry_label: '示例行业' })
  const analysis = loadAnalysis()
  analysis.actions[0].content = '已和客户确认镇痛泵下周二。'
  const output = runRender({ runInput: runInputFor(outDir), submission: { analysis }, base: SKILL_DIR })
  assert.ok(!contains(output.validation.errors, '行业词'))
  assert.equal(output.industry_basis.generic, true)
  assert.ok(readFileSync(output.h5, 'utf8').includes('本次基于通用词表'))
})

test('render 阶段校验不通过也渲染 H5：核对清单默认折叠、放在页底', () => {
  const outDir = tempDir()
  const analysis = loadAnalysis()
  analysis.evidence[0].quote = '我已经付款'
  const output = runRender({ runInput: runInputFor(outDir), submission: { analysis }, base: SKILL_DIR })
  assert.equal(output.status, 'needs_revision')
  assert.equal(output.validation.ok, false)
  assert.ok(contains(output.validation.errors, '连续子串'))
  // 「没通过核对」不等于「没有页面」：H5 必须照常生成，且正文先于核对清单。
  const h5Path = join(outDir, '销售简报.html')
  assert.equal(output.h5, h5Path)
  assert.ok(existsSync(h5Path))
  const page = readFileSync(h5Path, 'utf8')
  assert.ok(page.includes('机械核对未通过'))
  assert.ok(page.includes('连续子串'))
  assert.ok(page.includes('决策阻碍与待核问题'), '校验不通过时正文分区仍应渲染')
  // 折叠面板：必须出现在页脚之后（页面最底部），且默认不展开（不带 open 属性）。
  const panelIndex = page.indexOf('details class="vpanel"')
  assert.ok(panelIndex > page.indexOf('</footer>'), '核对清单应放在页脚之后')
  assert.ok(!/<details class="vpanel"[^>]*\sopen/.test(page), '核对清单默认收起')
  assert.ok(existsSync(join(outDir, '校验结果.json')))
})

test('render 阶段缺少 analysis 时降级为占位页，不中断 run', () => {
  const outDir = tempDir()
  const output = runRender({ runInput: runInputFor(outDir), submission: { notes: '只有备注' }, base: SKILL_DIR })
  assert.equal(output.status, 'needs_revision')
  assert.equal(output.validation.ok, false)
  assert.ok(contains(output.validation.errors, 'analysis 对象'))
  const h5Path = join(outDir, '销售简报.html')
  assert.equal(output.h5, h5Path)
  assert.ok(existsSync(h5Path))
  const page = readFileSync(h5Path, 'utf8')
  assert.ok(page.includes('本页只承载校验错误清单'))
  assert.ok(page.includes('机械核对未通过'))
  assert.ok(existsSync(join(outDir, '校验结果.json')))
})

test('render 阶段收到非对象提交时同样正常终止', () => {
  const outDir = tempDir()
  const output = runRender({ runInput: runInputFor(outDir), submission: '这不是对象', base: SKILL_DIR })
  assert.equal(output.status, 'needs_revision')
  assert.equal(output.execution_status, 'no_action_executed')
  assert.ok(contains(output.validation.errors, 'analysis 对象'))
})

test('run 指定的 case_id 未被遵守时判 needs_revision', () => {
  const outDir = tempDir()
  const runInput = { ...runInputFor(outDir), case_id: 'SYN-99' }
  const output = runRender({ runInput, submission: { analysis: loadAnalysis() }, base: SKILL_DIR })
  assert.equal(output.status, 'needs_revision')
  assert.ok(contains(output.validation.errors, 'case_id 必须与本次 run 指定的代号一致'))
  // 代号不符也只是 needs_revision：页面照常生成，页底折叠面板点明未通过。
  assert.ok(existsSync(output.h5))
  assert.ok(readFileSync(output.h5, 'utf8').includes('机械核对未通过'))
})

// ── finalize（修复后复渲染）────────────────────────────────────────────────

test('finalize 只把 polish 明确修不掉的条目留在页底折叠面板里', () => {
  const outDir = tempDir()
  const runInput = runInputFor(outDir)
  // 先跑 render 落一份 analysis.json 到 outDir。
  runRender({ runInput, submission: { analysis: loadAnalysis() }, base: SKILL_DIR })
  // polish 声称修掉全部问题、只留一条 residual（缺医生书面确认）。
  const polish = { status: 'partially_fixed', fixed: ['把算式结论写进正文'], residual: ['除皱针刺入层次需医生书面确认'] }
  const output = runFinalize({ runInput, polish, base: SKILL_DIR })
  assert.equal(output.status, 'needs_revision')
  assert.equal(output.validation.ok, false)
  assert.ok(output.validation.warnings.some((item) => item.includes('待人工确认')), 'residual 应以提醒形式回到 run 输出')
  const page = readFileSync(output.h5, 'utf8')
  assert.ok(page.includes('仍需人工确认'))
  assert.ok(page.includes('除皱针刺入层次需医生书面确认'))
  // 页面干净：修掉的定义性条目（这里没有校验错误）不应出现在面板里。
  assert.ok(!page.includes('机械核对未通过'), '没有剩余校验错误时不该渲染错误清单')
  const panelIndex = page.indexOf('details class="vpanel"')
  assert.ok(panelIndex > page.indexOf('</footer>'))
  assert.ok(!/<details class="vpanel"[^>]*\sopen/.test(page), '面板默认收起')
})

test('finalize 在 polish 修干净之后给出 rendered 且页面无技术尾巴', () => {
  const outDir = tempDir()
  const runInput = runInputFor(outDir)
  runRender({ runInput, submission: { analysis: loadAnalysis() }, base: SKILL_DIR })
  const output = runFinalize({ runInput, polish: { status: 'nothing_to_fix', fixed: [], residual: [] }, base: SKILL_DIR })
  assert.equal(output.status, 'rendered')
  assert.equal(output.validation.ok, true)
  const page = readFileSync(output.h5, 'utf8')
  assert.ok(!page.includes('details class="vpanel"'), '修干净时页面上不应出现折叠面板')
})

test('finalize 读到不合法 analysis 时仍出页面并列出错误，不中断 run', () => {
  const outDir = tempDir()
  const runInput = runInputFor(outDir)
  runRender({ runInput, submission: { analysis: loadAnalysis() }, base: SKILL_DIR })
  // polish 改坏了文档：写一份缺字段的 JSON。
  writeFileSync(join(outDir, 'analysis.json'), JSON.stringify({ schema_version: '2.0' }), 'utf8')
  const output = runFinalize({ runInput, polish: { status: 'fixed', fixed: [], residual: [] }, base: SKILL_DIR })
  assert.equal(output.status, 'needs_revision')
  assert.equal(output.validation.ok, false)
  assert.ok(output.validation.errors.length > 0)
  assert.ok(existsSync(output.h5))
})

// ── CLI（entrypoint 契约）──────────────────────────────────────────────────

test('CLI index 阶段按 argv 约定执行', () => {
  const outDir = tempDir()
  const inputPath = join(outDir, 'input.json')
  const outputPath = join(outDir, 'output.json')
  writeFileSync(inputPath, JSON.stringify(runInputFor(outDir)), 'utf8')
  const result = spawnSync(process.execPath, [CLI, inputPath, outputPath, '--stage', 'index'], { encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(readFileSync(outputPath, 'utf8'))
  assert.equal(output.status, 'index_only')
  assert.ok(existsSync(join(outDir, 'S1.index.json')))
})

test('CLI render 阶段用 fromNode 提交物 + run 输入执行', () => {
  const outDir = tempDir()
  const runInputPath = join(outDir, 'input.json')
  const submissionPath = join(outDir, 'node-extract.json')
  const outputPath = join(outDir, 'output.json')
  writeFileSync(runInputPath, JSON.stringify(runInputFor(outDir)), 'utf8')
  writeFileSync(submissionPath, JSON.stringify({ analysis: loadAnalysis() }), 'utf8')
  const result = spawnSync(
    process.execPath,
    [CLI, submissionPath, outputPath, '--stage', 'render', '--run-input', runInputPath],
    { encoding: 'utf8' },
  )
  assert.equal(result.status, 0, result.stderr)
  const output = JSON.parse(readFileSync(outputPath, 'utf8'))
  assert.equal(output.status, 'rendered')
  assert.ok(existsSync(output.h5))
})

test('CLI 违约输入以退出码 2 给三段式原因', () => {
  const outDir = tempDir()
  const inputPath = join(outDir, 'input.json')
  const outputPath = join(outDir, 'output.json')
  writeFileSync(inputPath, JSON.stringify({ transcripts: [{ session_id: 'S1', path: TRANSCRIPT }] }), 'utf8')
  const result = spawnSync(process.execPath, [CLI, inputPath, outputPath, '--stage', 'index'], { encoding: 'utf8' })
  assert.equal(result.status, 2)
  assert.ok(result.stderr.includes('问题：'))
  assert.ok(result.stderr.includes('修复：'))
})

// ── v2 契约新增的三条硬检查（都对应真实审计发现的错误类型）──────────────

test('孤儿证据被拒收（收了不用会掩盖关键事实）', () => {
  const analysis = loadAnalysis()
  analysis.oral_quotes = []
  analysis.summary = analysis.summary.replace('顾问口头估计两万左右、说明以正式报价为准，', '')
  const errors = validateAnalysis(analysis, [loadIndex()])
  assert.ok(contains(errors, '没有被任何条目引用'), errors.join(' | '))
})

test('引号里的片段不是原话时被拒收', () => {
  const analysis = loadAnalysis()
  analysis.profiles[0].text = '客户说「我要做自然款」，身份待确认。'
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '不是任何证据的原话子串'))
})

test('完成态措辞与 transaction 矛盾时被拒收', () => {
  const analysis = loadAnalysis()
  analysis.barriers[0].text = '客户已经成交，只是没交钱。'
  const errors = validateAnalysis(analysis, [loadIndex()])
  assert.ok(contains(errors, '完成态措辞'), errors.join(' | '))
})

test('完成态措辞与 transaction.verified 一致时放行', () => {
  const analysis = loadAnalysis()
  analysis.transaction.payment = 'verified'
  analysis.transaction_evidence = { payment: '收费单号 C-001（示例）' }
  analysis.barriers[0].text = '客户已经付款，收款已核对。'
  assert.deepEqual(validateAnalysis(analysis, [loadIndex()]), [])
})

test('有口头报价但 summary 未点明「口头」时被拒收', () => {
  const analysis = loadAnalysis()
  analysis.summary = analysis.summary.replace('口头', '')
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '必须点明「口头」'))
})

test('conflicts 少于两个版本时被拒收（不许把冲突抹平）', () => {
  const analysis = loadAnalysis()
  analysis.conflicts = [{ item: '活动瓶数', versions: ['2999 四瓶'], evidence_ids: ['E4'] }]
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '至少要有两个版本'))
})

test('decision_stage 无效时被拒收', () => {
  const analysis = loadAnalysis()
  analysis.decision_stage = 'thinking'
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), 'decision_stage 无效'))
})

test('analysis_meta.turns_read 与索引话轮数不一致时被拒收', () => {
  const analysis = loadAnalysis()
  analysis.analysis_meta.turns_read = 5
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '不一致'))
})

test('coverage=partial 但没有 limitations 时被拒收', () => {
  const analysis = loadAnalysis()
  analysis.analysis_meta.coverage = 'partial'
  analysis.analysis_meta.limitations = []
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), 'limitations 不能为空'))
})

test('页面显示意向阶段与证据行号（turn_id）', () => {
  const outDir = tempDir()
  const output = runRender({ runInput: runInputFor(outDir), submission: { analysis: loadAnalysis() }, base: SKILL_DIR })
  assert.equal(output.status, 'rendered')
  const page = readFileSync(output.h5, 'utf8')
  assert.ok(page.includes('意向阶段'))
  assert.ok(page.includes('方案讨论'))
  assert.ok(page.includes('L3@00:00:05'))
  assert.ok(page.includes('口头报价'))
  assert.ok(page.includes('未知待问'))
  assert.ok(page.includes('项目状态一览'))
  assert.ok(page.includes('须由医务人员书面回答'))
})

test('projects 为空时被拒收（多项目客户不能只写主诉）', () => {
  const analysis = loadAnalysis()
  analysis.projects = []
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '至少要有一项'))
})

test('项目标了状态却没给证据时被拒收', () => {
  const analysis = loadAnalysis()
  analysis.projects[0].evidence_ids = []
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '必须给 evidence_ids'))
})

test('客户事实标为客户本人确认却没证据时被拒收', () => {
  const analysis = loadAnalysis()
  analysis.client_facts[0] = { item: '付款安排', value: '先不交钱', state: 'confirmed_by_client' }
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '标为客户本人确认时必须给 evidence_ids'))
})

// ── v0.4 新增：堵住审计指出的五个绕过口子 ──────────────────────────────────

test('客户本人确认但证据角色只是候选时被拒收', () => {
  const analysis = loadAnalysis()
  analysis.client_facts[0].state = 'confirmed_by_client'
  const errors = validateAnalysis(analysis, [loadIndex()])
  assert.ok(contains(errors, '请改用 likely_client'), errors.join(' | '))
})

test('中文双引号里的推断词同样要被拦下（换引号绕不过）', () => {
  const analysis = loadAnalysis()
  analysis.profiles[0].text = '客户说“我要自然款”，身份待确认。'
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '不是任何证据的原话子串'))
})

test('口头报价里夹带括注解释时被拒收', () => {
  const analysis = loadAnalysis()
  analysis.oral_quotes[0].amount = '两万左右（含麻醉）'
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '不能夹带括注解释'))
})

test('口头报价里的数字在原话里找不到时被拒收', () => {
  const analysis = loadAnalysis()
  analysis.oral_quotes[0].amount = '39999'
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '在所引原话里找不到'))
})

test('行业词在转录里说过、只是这条没引到：降为提醒，不拒收', () => {
  const analysis = loadAnalysis()
  analysis.actions[0].content = '已约定上门时间与定金安排，并提醒带上合同。'
  const base = loadIndex()
  const index = {
    ...base,
    turns: [
      ...base.turns,
      {
        turn_id: 'L999@09:00:00',
        line: 999,
        timestamp: '09:00:00',
        speaker: '发言人2',
        text: '合同要今天签吗？签之前我想再看一遍条款。',
      },
    ],
  }
  analysis.analysis_meta.turns_read = index.turns.length
  // 词表显式给：技能包自带模板是空词表（通用），用例不该依赖自带示例值
  const detailed = validateAnalysisDetailed(analysis, [index], { industry_config: { industry_terms: ['合同', '定金'] } })
  assert.ok(
    detailed.warnings.some((w) => w.includes('行业词「合同」') && w.includes('引文未落地')),
    detailed.warnings.join(' | '),
  )
  assert.ok(
    !detailed.errors.some((e) => e.includes('行业词「合同」')),
    detailed.errors.join(' | '),
  )
})

test('行业词在转录里根本没有：仍然拒收', () => {
  // 词表显式给（技能包自带模板是空词表），挑一个「已配置、但这份转录里没有」的词。
  const configured = ['体检', '麻醉', '合同', '定金']
  const index = loadIndex()
  const term = configured.find((candidate) => !index.turns.some((turn) => String(turn.text).includes(candidate)))
  if (term === undefined) return // 当前词表里每个词都在这份合成转录里出现过，本例无从构造
  const analysis = loadAnalysis()
  analysis.actions[0].content = `已和客户确认${term}在下周二。`
  const detailed = validateAnalysisDetailed(analysis, [index], { industry_config: { industry_terms: configured } })
  assert.ok(
    detailed.errors.some((e) => e.includes(`行业词「${term}」`)),
    detailed.errors.join(' | '),
  )
  assert.ok(
    !detailed.warnings.some((w) => w.includes(`行业词「${term}」`)),
    detailed.warnings.join(' | '),
  )
})

test('对客话术预设后续步骤但尚未发生时被拒收', () => {
  // 用例跟着配置走：从 assets/industry-config.json 的 post_action_words 里取一个词来构造。
  const config = JSON.parse(readFileSync(join(SKILL_DIR, 'assets', 'industry-config.json'), 'utf8'))
  const postWords = Array.isArray(config.post_action_words) && config.post_action_words.length > 0 ? config.post_action_words : ['后续安排']
  const analysis = loadAnalysis()
  analysis.actions[1].script = `后续一个月记得回来${postWords[0]}。`
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), '不能对客户讲后续安排'))
})

test('专业复核问题缺 why 时被拒收', () => {
  const analysis = loadAnalysis()
  analysis.medical_review_questions = [{ question: '月经期能否注射？', why: '' }]
  assert.ok(contains(validateAnalysis(analysis, [loadIndex()]), 'why 必须为非空文本'))
})

// ── 0.5.0：长录音分段通读 ──────────────────────────────────────────────────

test('index 阶段额外写出可分段通读的分段稿', () => {
  const outDir = tempDir()
  runIndex(runInputFor(outDir), SKILL_DIR)
  const segmentsPath = join(outDir, 'S1.segments.md')
  assert.ok(existsSync(segmentsPath), '应写出 S1.segments.md 供 agent 分段读')
  const body = readFileSync(segmentsPath, 'utf8')
  assert.ok(body.includes('分段稿'), '分段稿应有标题')
  assert.ok(body.includes('L3@00:00:05'), '分段稿必须保留与索引一致的 turn_id')
  assert.ok(body.includes('发言人'), '分段稿应保留发言人标签')
})

test('分段稿按每段 SEGMENT_TURNS 话轮切分', () => {
  const outDir = tempDir()
  const turns = Array.from({ length: 250 }, (_, i) => ({
    turn_id: `L${i + 1}@00:00:01`,
    line: i + 1,
    timestamp: '00:00:01',
    speaker: '发言人1',
    text: `第${i + 1}句`,
  }))
  const result = writeSegments(outDir, { session_id: 'S1', turns })
  assert.equal(result.segments, 3, '250 话轮应按 '+SEGMENT_TURNS+' 一段切成 3 段')
  const body = readFileSync(result.segments_path, 'utf8')
  assert.ok(body.includes('第 1/3 段'), '应有第 1 段标题')
  assert.ok(body.includes('第 3/3 段'), '应有第 3 段标题')
  assert.ok(body.includes('第250句'), '最后一句不能被截断')
})

test('负例样本以事故记录形式留存（purpose / root_cause / prohibited_recurrence 齐备）', () => {
  for (const name of ['cross-case-contamination.json', 'inferred-date-as-fact.json']) {
    const doc = JSON.parse(readFileSync(join(SKILL_DIR, 'examples', 'failed', name), 'utf8'))
    assert.equal(doc.synthetic, true, `${name} 必须标 synthetic`)
    for (const key of ['purpose', 'root_cause', 'required_response', 'prohibited_recurrence', 'scope_limit']) {
      assert.ok(doc[key], `${name} 缺 ${key}`)
    }
    assert.ok(Array.isArray(doc.prohibited_recurrence) && doc.prohibited_recurrence.length >= 2, `${name} 的禁止复发项至少要两条`)
  }
})

// ── 0.5.0：输入审计与变异样本（借鉴某个提交包的 self_check 思路：构造坏输出、断言被拒）──

test('index 阶段写出输入审计（含说话人标签分布与归属骨架）', () => {
  const outDir = tempDir()
  runIndex(runInputFor(outDir), SKILL_DIR)
  const auditPath = join(outDir, 'S1.input-audit.json')
  assert.ok(existsSync(auditPath), '应写出 S1.input-audit.json')
  const audit = JSON.parse(readFileSync(auditPath, 'utf8'))
  assert.equal(audit.turns, loadIndex().turns.length)
  assert.ok(audit.sha256 && audit.sha256.length === 64, '审计里应带输入 SHA-256')
  assert.ok(Object.keys(audit.speaker_tags).length >= 1, '应统计说话人编号分布')
  assert.equal(
    Object.values(audit.speaker_map_skeleton).every((role) => role === 'unknown'),
    true,
    '归属骨架默认全部 unknown：编号不是身份',
  )
})

test('中文数字解析覆盖口语省略与「零」的区分', () => {
  // 口语省掉末位单位：八百八 = 880、三千五 = 3500
  assert.equal(parseChineseNumber('八百八'), 880)
  assert.equal(parseChineseNumber('三千五'), 3500)
  assert.equal(parseChineseNumber('四万九千八'), 49800)
  assert.equal(parseChineseNumber('两万三'), 23000)
  // 完整写法不受影响
  assert.equal(parseChineseNumber('八百八十'), 880)
  assert.equal(parseChineseNumber('一百二十'), 120)
  assert.equal(parseChineseNumber('一万一千'), 11000)
  // 中间有「零」时末位是各位，不能当省略：八百零八 = 808，不是 880
  assert.equal(parseChineseNumber('八百零八'), 808)
  assert.equal(parseChineseNumber('一千零五十'), 1050)
  // 太短或不是数字的串一律返回 null——「万一」「一个」不能被当成钱
  assert.equal(parseChineseNumber('十二'), null)
  assert.equal(parseChineseNumber('万一'), null)
  assert.equal(parseChineseNumber('一个'), null)
  assert.equal(parseChineseNumber('三百'), null, '两个字不够判，避免误伤「三百块」以外的词')
  // 阿拉伯与中文混写（录音里常见）：4万9千八 = 49800、1万2 = 12000
  assert.equal(parseChineseNumber('4万9千八'), 49800)
  assert.equal(parseChineseNumber('1万2'), 12000)
  assert.equal(parseChineseNumber('2千3'), 2300)
  // 纯阿拉伯数字没有单位，不能被当成金额串解析
  assert.equal(parseChineseNumber('39320'), null)
  assert.equal(parseChineseNumber('58008'), null)
  assert.equal(parseChineseNumber(''), null)
})

test('算式求值器只认数字与四则运算', () => {
  assert.equal(evaluateExpr('50008+8000'), 58008)
  assert.equal(evaluateExpr('2999/3'), 2999 / 3)
  assert.equal(evaluateExpr('(44600+4550)*0.8'), 39320)
  assert.equal(evaluateExpr('15800-10800'), 5000)
  assert.equal(evaluateExpr('五万加八千'), null, '中文数字不是可验算算式')
  assert.equal(evaluateExpr('50008 + require("fs")'), null, '不能执行任何代码')
})

test('变异样本必须被拒收（构造坏输出，断言校验器真拦得住）', () => {
  const cases = [
    ['编造原话', (a) => { a.evidence[0].quote = 'This sentence never appeared.' }, '连续子串'],
    ['跨会话引用', (a) => { a.evidence[0].session_id = 'S9' }, '会话'],
    ['伪造的声学核验标记', (a) => { a.evidence[0].role_status = 'audio_verified' }, 'role_status 无效'],
    ['未校准的成交概率', (a) => { a.conversion_probability = 0.9 }, '契约外的顶层字段'],
    ['未校准的意向评分', (a) => { a.intent_score = 86 }, '契约外的顶层字段'],
    ['完成态措辞越级', (a) => { a.summary = '双方已成交并完成支付。' }, '完成态措辞'],
    ['孤儿证据', (a) => { a.evidence.push({ id: 'E99', session_id: 'S1', turn_id: 'L3@00:00:05', quote: '我想先了解眼部，效果自然一点。', role: '客户候选', role_status: 'candidate' }) }, '没有被任何条目引用'],
    ['归属倒置：stated 引用顾问证据', (a) => {
      a.evidence[3].role = '咨询顾问候选'
      a.profiles.push({ title: '客户预算充裕', text: '客户预算充裕，可接受更高价位。', status: 'stated', evidence_ids: ['E4'] })
    }, '引用了非客户证据'],
    ['漏写 money_math', (a) => { delete a.money_math }, 'money_math 必须为数组'],
    ['money_math 算错', (a) => { a.money_math = [{ expr: '50008+8000', result: 50000, note: '故意算错' }] }, '算错'],
    ['money_math 非算式', (a) => { a.money_math = [{ expr: '五万加八千', result: 58000, note: '非法算式' }] }, '不是可验算的算式'],
    ['漏写 not_found_claims', (a) => { delete a.not_found_claims }, 'not_found_claims 必须为数组'],
    ['写「未提及」却不登记检索', (a) => { a.barriers[0].text = '顾问未说明效果差异。'; a.not_found_claims = [] }, 'not_found_claims 为空'],
    ['「未提及」与转录冲突', (a) => {
      a.barriers[0].text = '顾问未提及眼部项目。'
      a.not_found_claims = [{ claim: '顾问未提及眼部项目', keywords: ['眼部'] }]
    }, '与转录冲突'],
    // v0.5.5：审计实证的三类语义越界，改成机械可判的形态
    ['一边断言「客户说」一边写「待复听」', (a) => {
      a.profiles[0].text = '客户说自己以前在铜雀台、当代都打过针，角色按待复听处理。'
    }, '断言归属'],
    // v0.5.5-fix：档位已声明归属未定时，正文仍断言归属（初版规则漏掉的形态，C3 实证 4 条）
    ['归属待复听档位却在正文断言「客户自述」', (a) => {
      a.profiles[0] = {
        title: '意向项目',
        text: '客户自述「我想先了解眼部，效果自然一点」。',
        status: 'pending_confirmation',
        evidence_ids: ['E1'],
      }
    }, '已声明归属未定'],
    ['具体量（10 毫升）没有原话支撑', (a) => {
      a.medical_review_questions[0].why = '术区出血量不超过10毫升，因此可以当天离院。'
    }, '没有任何 evidence.quote 包含它'],
    ['断言单据已在手上却没有原话', (a) => {
      a.summary = '00:16 单据已在顾问手上，等待补拍留存。'
    }, '断言单据'],
    // v0.5.8：正文数字必须有出处（C2 实测在 conflicts 里写了转录零命中的「658」）
    ['正文出现转录里没有的金额', (a) => {
      a.barriers[0].text = '两档总价相差 47123 元，需核实。'
    }, '找不到出处的数字'],
    // v0.5.10：stated 条目的引号只能放本条证据的原话（C1 实证 9 处引了顾问原话却带「客户表达」标签）
    ['stated 条目引号引了非本条证据', (a) => {
      a.profiles.push({
        title: '术式选择',
        text: `顾问的建议是「${String(a.evidence[1].quote)}」，客户据此选择。`,
        status: 'stated',
        evidence_ids: [a.evidence[0].id],
      })
    }, '不在本条目的证据里'],
  ]
  for (const [label, mutate, expected] of cases) {
    const analysis = loadAnalysis()
    mutate(analysis)
    const errors = validateAnalysis(analysis, [loadIndex()])
    assert.ok(contains(errors, expected), `${label} 应被拒收，实际：${errors.join(' | ') || '（未报错）'}`)
  }
})

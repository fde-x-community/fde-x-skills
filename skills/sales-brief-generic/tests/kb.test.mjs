// 知识库接入（v0.8.0-kb）的机械层回归。
// 每个用例都用临时目录里的迷你知识库 + 合成转录，不依赖真实客户资料。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  gapLooksStale,
  kbConfig,
  kbReport,
  loadKb,
  normText,
  termHits,
  validateKbAnalysis,
} from '../scripts/kb.mjs'
import { planIndexes, renderHtml, runIndex, runRender, validateAnalysisDetailed } from '../scripts/run.mjs'

const TESTS_DIR = dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = dirname(TESTS_DIR)
const TRANSCRIPT = join(SKILL_DIR, 'examples', 'fixtures', 'synthetic.txt')
const ANALYSIS = JSON.parse(readFileSync(join(SKILL_DIR, 'examples', 'fixtures', 'analysis.json'), 'utf8'))

/** 迷你知识库：一张行业卡 + 一张机构事实卡 + 一张同主题相邻卡（用于「缺口禁用卡」）。 */
function makeKb({ contentK1 = '示例项目的原理说明：先评估，再确定方案。恢复期有个体差异。', draft = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'kb-'))
  mkdirSync(join(dir, '02_结构化数据'), { recursive: true })
  const rows = [
    {
      id: 'K1',
      title: '示例项目卡',
      content: contentK1,
      keywords: ['示例项目', '恢复期'],
      review_status: draft ? 'draft_needs_review' : 'approved',
      institution_fact: false,
    },
    { id: 'K2', title: '相邻项目卡', content: '相邻项目的原理说明。', keywords: ['相邻项目'], review_status: 'draft_needs_review', institution_fact: false },
    { id: 'F1', title: '价目表条目', content: '示例项目 9999 元。', keywords: ['价目'], review_status: 'approved', institution_fact: true },
  ]
  writeFileSync(join(dir, '02_结构化数据', '知识条目.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8')
  writeFileSync(
    join(dir, '02_结构化数据', '术语与转录纠错词典.json'),
    JSON.stringify([
      { term: '示例项目', related_card_id: 'K1', resolution_status: 'confirmed' },
      { term: '相邻项目', related_card_id: 'K2', resolution_status: 'confirmed' },
    ], null, 2),
    'utf8',
  )
  return dir
}

function indexFor(kbDir, extra = {}) {
  const outDir = mkdtempSync(join(tmpdir(), 'run-'))
  return planIndexes({ transcripts: [{ session_id: 'S1', path: TRANSCRIPT }], out_dir: outDir, ...(kbDir === undefined ? {} : { knowledge_base_dir: kbDir }), ...extra }, SKILL_DIR)
}

function withKbFields(kbDir) {
  const plan = indexFor(kbDir)
  const data = JSON.parse(JSON.stringify(ANALYSIS))
  data.kb_gaps = []
  data.input_binding = {
    kb_fingerprint: plan.kb.fingerprint.slice(0, 16),
    transcripts: Object.fromEntries(plan.indexes.map((index) => [index.session_id, index.sha256])),
  }
  data.barriers[0].kb_refs = ['K1']
  data.barriers[0].kb_excerpts = [{ id: 'K1', quote: '示例项目的原理说明：先评估，再确定方案。', used_for: data.barriers[0].title }]
  return { data, plan }
}

function validate(data, plan) {
  return validateAnalysisDetailed(data, plan.indexes, { kb: plan.kb, kb_cfg: plan.cfg ?? kbConfig() })
}

test('知识库读取：条目、术语、指纹稳定；同 ID 不同正文记为冲突', () => {
  const dir = makeKb()
  const kb = loadKb(dir, kbConfig())
  assert.equal(kb.entries.size, 3)
  assert.equal(kb.terms.length, 2)
  assert.equal(kb.fingerprint.length, 64)
  assert.deepEqual(loadKb(dir, kbConfig()).fingerprint, kb.fingerprint)
  // 同一个 id 出现两次且正文不同 → 冲突，且不静默取最后一条
  writeFileSync(
    join(dir, '02_结构化数据', '知识条目.jsonl'),
    [
      JSON.stringify({ id: 'K1', title: '示例项目卡', content: '示例项目的原理说明：先评估，再确定方案。恢复期有个体差异。', keywords: ['示例项目'] }),
      JSON.stringify({ id: 'K1', title: '示例项目卡', content: '完全不同的正文。' }),
      JSON.stringify({ id: 'K2', title: '相邻项目卡', content: '相邻项目的原理说明。' }),
    ].join('\n') + '\n',
    'utf8',
  )
  const conflicted = loadKb(dir, kbConfig())
  assert.deepEqual(conflicted.conflicts, ['K1'])
  assert.equal(conflicted.entries.get('K1').content, '示例项目的原理说明：先评估，再确定方案。恢复期有个体差异。')
})

test('知识库读不出来：默认 error 直接失败，degrade 才降级', () => {
  const missing = join(tmpdir(), 'kb-does-not-exist')
  assert.throws(() => indexFor(missing), /读不出知识库/)
  const plan = indexFor(missing, { kb_missing_policy: 'degrade' })
  assert.equal(plan.kb, null)
  assert.equal(plan.kb_degraded, true)
})

test('索引逐话轮记术语命中；未接入时不产出 kb 段', () => {
  const plan = indexFor(makeKb())
  assert.ok(plan.indexes[0].kb && plan.indexes[0].kb.connected)
  assert.ok(plan.indexes[0].kb.card_hashes.K1)
  assert.equal(plan.indexes[0].turns.some((turn) => Array.isArray(turn.term_hits) && turn.term_hits.length > 0), false)
  const plain = indexFor(undefined)
  assert.equal(plain.kb, null)
  assert.equal(plain.indexes[0].kb, undefined)
  // 术语命中只认正确写法
  const kb = loadKb(makeKb(), kbConfig())
  assert.equal(termHits('今天聊示例项目', kb)[0].card, 'K1')
  assert.deepEqual(termHits('今天聊示例项木', kb), [])
  assert.equal(normText('（示例） “项目”'), '(示例)"项目"')
})

test('未接入知识库时出现 kb_refs / kb_basis.connected 一律判失败', () => {
  const plan = indexFor(undefined)
  const data = JSON.parse(JSON.stringify(ANALYSIS))
  data.barriers[0].kb_refs = ['K1']
  const result = validate(data, plan)
  assert.ok(result.errors.some((error) => error.includes('未接入知识库却填写了 kb_refs')))
  const data2 = JSON.parse(JSON.stringify(ANALYSIS))
  data2.kb_basis = { connected: true }
  assert.ok(validate(data2, plan).errors.some((error) => error.includes('kb_basis.connected=true')))
  // 未接入时给空 kb_gaps 之类无 kb 字段的分析仍应通过（向后兼容）
  const clean = validate(JSON.parse(JSON.stringify(ANALYSIS)), plan)
  assert.equal(clean.errors.length, 0)
})

test('接入知识库：成对引用 + input_binding 齐全才通过', () => {
  const kbDir = makeKb()
  const { data, plan } = withKbFields(kbDir)
  const result = validate(data, plan)
  assert.deepEqual(result.errors, [])
  assert.ok(result.warnings.some((warning) => warning.includes('未签审'))) // draft 引用提示

  const missingBinding = JSON.parse(JSON.stringify(data))
  delete missingBinding.input_binding
  assert.ok(validate(missingBinding, plan).errors.some((error) => error.includes('缺少 input_binding')))

  const wrongBinding = JSON.parse(JSON.stringify(data))
  wrongBinding.input_binding.transcripts.S1 = 'deadbeef'
  assert.ok(validate(wrongBinding, plan).errors.some((error) => error.includes('不是对着这份转录写的')))
})

test('片段必须真在卡片正文里；used_for 必须落在本条正文上', () => {
  const kbDir = makeKb()
  const { data, plan } = withKbFields(kbDir)

  const outside = JSON.parse(JSON.stringify(data))
  outside.barriers[0].kb_excerpts[0].quote = '这句在卡片里不存在'
  assert.ok(validate(outside, plan).errors.some((error) => error.includes('在该卡片正文里找不到')))

  const deco = JSON.parse(JSON.stringify(data))
  deco.barriers[0].kb_excerpts[0].used_for = '完全无关的一句'
  assert.ok(validate(deco, plan).errors.some((error) => error.includes('不是本条正文的子串')))

  const noPairs = JSON.parse(JSON.stringify(data))
  delete noPairs.barriers[0].kb_excerpts
  assert.ok(validate(noPairs, plan).errors.some((error) => error.includes('没有 kb_excerpts')))
})

test('引用不存在 / 机构事实层 / 缺口点名禁用的卡都被拦', () => {
  const kbDir = makeKb()
  const { data, plan } = withKbFields(kbDir)

  const ghost = JSON.parse(JSON.stringify(data))
  ghost.barriers[0].kb_refs = ['K9']
  ghost.barriers[0].kb_excerpts = [{ id: 'K9', quote: 'x', used_for: ghost.barriers[0].title }]
  assert.ok(validate(ghost, plan).errors.some((error) => error.includes('不存在的条目 K9')))

  const fact = JSON.parse(JSON.stringify(data))
  fact.barriers[0].kb_refs = ['F1']
  fact.barriers[0].kb_excerpts = [{ id: 'F1', quote: '示例项目 9999 元。', used_for: fact.barriers[0].title }]
  assert.ok(validate(fact, plan).errors.some((error) => error.includes('机构事实层条目 F1')))

  const forbidden = JSON.parse(JSON.stringify(data))
  forbidden.kb_gaps = [{ topic: '相邻项目能不能同台', why_missing: '库里没有', fallback: '交医生', must_not_use_cards: ['K2'], evidence_turns: [data.evidence[0].turn_id] }]
  forbidden.barriers[0].kb_refs = ['K1', 'K2']
  forbidden.barriers[0].kb_excerpts.push({ id: 'K2', quote: '相邻项目的原理说明。', used_for: forbidden.barriers[0].title })
  assert.ok(validate(forbidden, plan).errors.some((error) => error.includes('明确禁止替代的卡片 K2')))
})

test('缺口必须可追；主题与已有卡片撞车判「可能已过期」', () => {
  const kbDir = makeKb()
  const { data, plan } = withKbFields(kbDir)

  const noTurns = JSON.parse(JSON.stringify(data))
  noTurns.kb_gaps = [{ topic: '品牌型号对照', why_missing: '库里没有' }]
  assert.ok(validate(noTurns, plan).errors.some((error) => error.includes('缺少 evidence_turns')))

  const badTurn = JSON.parse(JSON.stringify(data))
  badTurn.kb_gaps = [{ topic: '品牌型号对照', why_missing: '库里没有', evidence_turns: ['L999@00:00:01'] }]
  assert.ok(validate(badTurn, plan).errors.some((error) => error.includes('不在本条分析的证据里')))

  // 缺口主题正好就是库里那张卡的标题 → 过期
  const staleTopic = '示例项目卡'
  const stale = JSON.parse(JSON.stringify(data))
  stale.kb_gaps = [{ topic: staleTopic, why_missing: '库里没有', evidence_turns: [data.evidence[0].turn_id] }]
  assert.ok(validate(stale, plan).errors.some((error) => error.includes('可能已过期')))
  assert.notEqual(gapLooksStale(staleTopic, { title: '示例项目卡', keywords: [] }), '')
})

test('术语三态：candidate 必须写「疑似」，confirmed 必须给正确写法', () => {
  const kbDir = makeKb()
  const { data, plan } = withKbFields(kbDir)

  const confirmed = JSON.parse(JSON.stringify(data))
  confirmed.barriers[0].term_status = 'confirmed'
  assert.ok(validate(confirmed, plan).errors.some((error) => error.includes('必须给出 kb_term')))
  confirmed.barriers[0].kb_term = '示例项目'
  assert.equal(validate(confirmed, plan).errors.length, 0)

  const candidate = JSON.parse(JSON.stringify(data))
  candidate.barriers[0].term_status = 'candidate'
  candidate.barriers[0].term_note = '是另一个词'
  assert.ok(validate(candidate, plan).errors.some((error) => error.includes('「疑似/待核」字样')))
  candidate.barriers[0].term_note = '疑似「示例项目」，待核'
  assert.equal(validate(candidate, plan).errors.length, 0)

  const unknown = JSON.parse(JSON.stringify(data))
  unknown.barriers[0].term_status = 'unknown'
  assert.ok(validate(unknown, plan).errors.some((error) => error.includes('必须写 term_note')))
})

test('kb_unused_notes 的键必须是真实卡片；命中未引用会提醒', () => {
  const kbDir = makeKb()
  const { data, plan } = withKbFields(kbDir)

  const bogus = JSON.parse(JSON.stringify(data))
  bogus.kb_unused_notes = { K9: '没用到' }
  assert.ok(validate(bogus, plan).errors.some((error) => error.includes('不是知识库条目')))

  // 话轮里真出现了「相邻项目」（术语/关键词命中），但正文没引用 K2 → 只提醒、不阻断
  const kb = loadKb(kbDir, kbConfig())
  const turns = [
    { turn_id: 'L1@00:00:01', line: 1, timestamp: '00:00:01', speaker: '发言人1', text: '今天先聊相邻项目。', term_hits: termHits('今天先聊相邻项目。', kb) },
  ]
  const indexes = [{ session_id: 'S1', sha256: plan.indexes[0].sha256, turns, kb: plan.indexes[0].kb }]
  const unused = JSON.parse(JSON.stringify(data))
  unused.summary = `${unused.summary}（相邻项目也提过）`
  unused.evidence = unused.evidence.map((item) => item)
  const result = validateKbAnalysis(unused, { kb, indexes, cfg: kbConfig() })
  assert.deepEqual(result.errors, [])
  assert.ok(result.warnings.some((warning) => warning.includes('没有任何条目引用 K2')))
  unused.kb_unused_notes = { K2: '客户只是带过一句，不构成依据' }
  assert.equal(validateKbAnalysis(unused, { kb, indexes, cfg: kbConfig() }).warnings.some((warning) => warning.includes('没有任何条目引用 K2')), false)
})

test('索引指纹与当前知识库不一致：被引卡片正文变了才报错，没变降级为提醒', () => {
  const kbDir = makeKb()
  const { data, plan } = withKbFields(kbDir)
  // 库变了：K3 是新增卡（不影响被引的 K1）
  const addRow = JSON.stringify({ id: 'K3', title: '新增卡', content: '新增内容。', keywords: ['新增'], review_status: 'approved' })
  writeFileSync(
    join(kbDir, '02_结构化数据', '知识条目.jsonl'),
    readFileSync(join(kbDir, '02_结构化数据', '知识条目.jsonl'), 'utf8') + addRow + '\n',
    'utf8',
  )
  const kbAfterAdd = loadKb(kbDir, kbConfig())
  const unrelated = validateAnalysisDetailed(data, plan.indexes, { kb: kbAfterAdd })
  assert.deepEqual(unrelated.errors, [])
  assert.ok(unrelated.warnings.some((warning) => warning.includes('被引用卡片正文未变')))

  // 被引卡片正文变了 → 必须重新索引
  const changedDir = makeKb({ contentK1: '示例项目的原理说明：先评估，再确定方案。恢复期因人而异（改过）。' })
  const kbChanged = loadKb(changedDir, kbConfig())
  const changed = validateAnalysisDetailed(data, plan.indexes, { kb: kbChanged })
  assert.ok(changed.errors.some((error) => error.includes('请重新索引后再校验')))
})

test('render 阶段：接入知识库时页面有知识依据与缺口分区，kb_report 落盘', () => {
  const kbDir = makeKb()
  const { data, plan } = withKbFields(kbDir)
  data.kb_gaps = [{ topic: '品牌型号对照', why_missing: '库里没有', fallback: '交医生', evidence_turns: [data.evidence[0].turn_id] }]
  const page = renderHtml(data, plan.indexes, { kb: plan.kb, kb_report: kbReport(data, plan.indexes, plan.kb) })
  assert.ok(page.includes('行业知识依据'))
  assert.ok(page.includes('知识覆盖缺口'))
  assert.ok(page.includes('知识库体检'))
  assert.ok(page.includes('示例项目的原理说明'))
  assert.ok(/行业知识库：已接入 3 条记录/.test(page))
  // 未接入时不出现知识分区
  const plain = renderHtml(JSON.parse(JSON.stringify(ANALYSIS)), planIndexes({ transcripts: [{ session_id: 'S1', path: TRANSCRIPT }], out_dir: mkdtempSync(join(tmpdir(), 'run-')) }, SKILL_DIR).indexes, {})
  assert.equal(plain.includes('知识覆盖缺口'), false)
  assert.ok(plain.includes('未接入'))
})

test('runRender 全链路：接入知识库的 analysis 通过并产出 kb_report', () => {
  const kbDir = makeKb()
  const outDir = mkdtempSync(join(tmpdir(), 'run-'))
  const runInput = { transcripts: [{ session_id: 'S1', path: TRANSCRIPT }], out_dir: outDir, case_id: 'SYN-01', knowledge_base_dir: kbDir }
  const plan = planIndexes(runInput, SKILL_DIR)
  const data = JSON.parse(JSON.stringify(ANALYSIS))
  data.kb_gaps = []
  data.input_binding = {
    kb_fingerprint: plan.kb.fingerprint.slice(0, 16),
    transcripts: Object.fromEntries(plan.indexes.map((index) => [index.session_id, index.sha256])),
  }
  data.barriers[0].kb_refs = ['K1']
  data.barriers[0].kb_excerpts = [{ id: 'K1', quote: '示例项目的原理说明：先评估，再确定方案。', used_for: data.barriers[0].title }]
  const output = runRender({ runInput, submission: { analysis: data }, base: SKILL_DIR })
  assert.equal(output.status, 'rendered')
  assert.equal(output.validation.ok, true)
  assert.equal(output.kb_report.connected, true)
  assert.equal(output.kb_report.cards_cited, 1)
  assert.equal(output.kb_report.excerpts, 1)
  const saved = JSON.parse(readFileSync(join(outDir, '校验结果.json'), 'utf8'))
  assert.equal(saved.kb_report.connected, true)
  assert.ok(readFileSync(join(outDir, '销售简报.html'), 'utf8').includes('行业知识依据'))
})

test('index 阶段在接入知识库时给出可直接抄的 input_binding', () => {
  const kbDir = makeKb()
  const outDir = mkdtempSync(join(tmpdir(), 'run-'))
  const output = runIndex({ transcripts: [{ session_id: 'S1', path: TRANSCRIPT }], out_dir: outDir, knowledge_base_dir: kbDir }, SKILL_DIR)
  assert.equal(output.kb.connected, true)
  assert.equal(output.input_binding.transcripts.S1.length, 64)
  assert.equal(output.input_binding.kb_fingerprint.length, 16)
  const index = JSON.parse(readFileSync(join(outDir, 'S1.index.json'), 'utf8'))
  assert.equal(index.kb.fingerprint.slice(0, 16), output.input_binding.kb_fingerprint)
})

test('黄金样例（examples/fixtures/analysis-kb.json + mini-kb）通过校验并可渲染', () => {
  const miniKb = join(SKILL_DIR, 'examples', 'fixtures', 'mini-kb')
  const golden = JSON.parse(readFileSync(join(SKILL_DIR, 'examples', 'fixtures', 'analysis-kb.json'), 'utf8'))
  const plan = planIndexes(
    { transcripts: [{ session_id: 'S1', path: TRANSCRIPT }], out_dir: mkdtempSync(join(tmpdir(), 'run-')), knowledge_base_dir: miniKb },
    SKILL_DIR,
  )
  const result = validateAnalysisDetailed(golden, plan.indexes, { kb: plan.kb })
  assert.deepEqual(result.errors, [])
  assert.ok(result.warnings.every((warning) => warning.includes('未签审')))
  const page = renderHtml(golden, plan.indexes, { kb: plan.kb })
  assert.ok(page.includes('示例项目的原理说明'))
  assert.ok(page.includes('不得拿这些卡顶替：K3'))
  assert.equal(/\{\{[A-Z_]+\}\}/.test(page), false)
})


// ── 知识库目录的「工作目录优先」发现（与词表配置同一套设计，v0.8.1-kb） ──────────

function kbDirIn(parent, name = 'knowledge-base') {
  const dir = join(parent, name)
  mkdirSync(join(dir, '02_结构化数据'), { recursive: true })
  writeFileSync(
    join(dir, '02_结构化数据', '知识条目.jsonl'),
    [
      JSON.stringify({ id: 'K1', title: '示例项目卡', content: '示例项目的原理说明：先评估适用性，再确定方案。', keywords: ['示例项目'], review_status: 'draft_needs_review', institution_fact: false }),
      JSON.stringify({ id: 'K3', title: '相邻项目卡', content: '相邻项目不能互相替代。', keywords: ['相邻项目'], review_status: 'draft_needs_review', institution_fact: false }),
    ].join('\n') + '\n',
    'utf8',
  )
  writeFileSync(
    join(dir, '02_结构化数据', '术语与转录纠错词典.json'),
    JSON.stringify([{ term: '示例项目', related_card_id: 'K1', resolution_status: 'confirmed' }], null, 2),
    'utf8',
  )
  return dir
}

test('发现顺序①：不给参数时自动发现 <out_dir>/knowledge-base（冷启动的落点）', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'run-'))
  const dir = kbDirIn(outDir)
  const plan = planIndexes({ transcripts: [{ session_id: 'S1', path: TRANSCRIPT }], out_dir: outDir }, SKILL_DIR)
  assert.equal(plan.kb_source, 'out_dir')
  assert.equal(plan.kb_dir, dir)
  assert.equal(plan.kb.entries.size, 2)
})

test('发现顺序②：冷启动落在 <out_dir>/industry-config/knowledge-base 也能发现', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'run-'))
  const dir = kbDirIn(join(outDir, 'industry-config'))
  const plan = planIndexes({ transcripts: [{ session_id: 'S1', path: TRANSCRIPT }], out_dir: outDir }, SKILL_DIR)
  assert.equal(plan.kb_source, 'out_dir')
  assert.equal(plan.kb_dir, dir)
})

test('发现顺序③：<out_dir> 下名字像知识库的目录也能发现（容忍命名差异）', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'run-'))
  const dir = kbDirIn(outDir, 'KB-示例-v2')
  const plan = planIndexes({ transcripts: [{ session_id: 'S1', path: TRANSCRIPT }], out_dir: outDir }, SKILL_DIR)
  assert.equal(plan.kb_dir, dir)
})

test('发现顺序④：显式 knowledge_base_dir 优先；给了却读不出默认失败、degrade 才降级', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'run-'))
  kbDirIn(outDir)
  const explicit = kbDirIn(mkdtempSync(join(tmpdir(), 'kb-')), 'kb')
  const plan = planIndexes({ transcripts: [{ session_id: 'S1', path: TRANSCRIPT }], out_dir: outDir, knowledge_base_dir: explicit }, SKILL_DIR)
  assert.equal(plan.kb_source, 'param')
  assert.equal(plan.kb_dir, explicit)
  assert.throws(
    () => planIndexes({ transcripts: [{ session_id: 'S1', path: TRANSCRIPT }], out_dir: outDir, knowledge_base_dir: join(tmpdir(), 'nope-kb') }, SKILL_DIR),
    /读不出知识库/,
  )
  const degraded = planIndexes({ transcripts: [{ session_id: 'S1', path: TRANSCRIPT }], out_dir: outDir, knowledge_base_dir: join(tmpdir(), 'nope-kb'), kb_missing_policy: 'degrade' }, SKILL_DIR)
  assert.equal(degraded.kb, null)
  assert.equal(degraded.kb_degraded, true)
})

test('发现顺序⑤：工作目录没有知识库时如实「未接入」，并写出 kb-mode.json 基准', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'run-'))
  const output = runIndex({ transcripts: [{ session_id: 'S1', path: TRANSCRIPT }], out_dir: outDir }, SKILL_DIR)
  assert.equal(output.kb_source, 'none')
  assert.equal(output.kb.connected, false)
  const mode = JSON.parse(readFileSync(join(outDir, 'kb-mode.json'), 'utf8'))
  assert.equal(mode.written_by, 'index')
  assert.equal(mode.connected, false)
  assert.equal(mode.source, 'none')
  assert.ok(String(mode.note).includes('没有可用知识库'))
})

test('接入知识库时索引逐话轮记术语命中；kb-mode.json 记下来源与指纹', () => {
  const outDir = mkdtempSync(join(tmpdir(), 'run-'))
  const dir = kbDirIn(outDir)
  const output = runIndex({ transcripts: [{ session_id: 'S1', path: TRANSCRIPT }], out_dir: outDir }, SKILL_DIR)
  assert.equal(output.kb.connected, true)
  assert.equal(output.kb_source, 'out_dir')
  const mode = JSON.parse(readFileSync(join(outDir, 'kb-mode.json'), 'utf8'))
  assert.equal(mode.connected, true)
  assert.equal(mode.source, 'out_dir')
  assert.equal(mode.dir, dir)
  assert.equal(mode.records, 2)
  assert.equal(mode.fingerprint.length, 16)
})

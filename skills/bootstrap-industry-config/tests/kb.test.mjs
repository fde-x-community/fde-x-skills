// 知识库对齐（v0.3.0-kb）的机械层回归：scan → apply，多格式、空库、冲突、CLI。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { applyKbPlan, parseSource, scanKbSources, suggestPlan, writeEmptyKb } from '../scripts/kb.mjs'
import { parseArgv, runKbApply, runKbScan } from '../scripts/run.mjs'

const TESTS_DIR = dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = dirname(TESTS_DIR)
const CLI = join(SKILL_DIR, 'scripts', 'run.mjs')

function tmp(prefix = 'kb-') {
  return mkdtempSync(join(tmpdir(), prefix))
}

function writeFile(path, body) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, body, 'utf8')
  return path
}

/** 一套多格式材料：jsonl（含坏行）、md（标题分段）、csv、txt（空行分段）、json（数组），外加一个 docx。 */
function makeMaterials() {
  const root = tmp('kb-src-')
  writeFile(
    join(root, 'cards.jsonl'),
    [
      JSON.stringify({ id: 'A1', title: '项目甲', content: '项目甲的原理与边界。', keywords: ['甲', '原理'] }),
      '这一行不是 JSON',
      JSON.stringify({ id: 'A2', title: '项目乙', content: '项目乙的恢复期存在个体差异。', keywords: ['乙'] }),
    ].join('\n') + '\n',
  )
  writeFile(join(root, 'guide.md'), ['# 行业指南', '', '## 咨询流程', '先确认需求，再解释方案。', '', '## 费用口径', '口头报价不是正式价格。', ''].join('\n'))
  writeFile(join(root, 'table.csv'), 'title,content,keywords\n项目丙,"项目丙的适用边界","丙;边界"\n')
  writeFile(join(root, 'notes.txt'), ['第一条 说明', '这是第一条的正文。', '', '第二条 说明', '这是第二条的正文。', ''].join('\n'))
  writeFile(join(root, 'array.json'), JSON.stringify([{ 标题: '项目丁', 正文: '项目丁的说明。'.split('').join(''), tags: ['丁'] }], null, 2))
  writeFileSync(join(root, 'word.docx'), 'PK\u0003\u0004binary', 'binary')
  return root
}

test('扫描：识别多种格式、统计字段频次，二进制与不存在路径单独归类', () => {
  const root = makeMaterials()
  const scan = scanKbSources([root, join(root, 'nope.txt')])
  assert.ok(scan.files >= 5)
  assert.ok(scan.formats.jsonl >= 1)
  assert.ok(scan.formats.markdown >= 1)
  assert.ok(scan.formats.csv >= 1)
  assert.equal(scan.unsupported.length, 1)
  assert.equal(scan.unsupported[0].ext, '.docx')
  assert.equal(scan.missing.length, 1)
  const jsonl = scan.sources.find((item) => item.path.endsWith('cards.jsonl'))
  assert.equal(jsonl.hints.jsonl_lines, 3)
  assert.equal(jsonl.hints.parsed_rows, 2)
  assert.ok(jsonl.hints.keys.some((item) => item.key === 'title'))
  const md = scan.sources.find((item) => item.path.endsWith('guide.md'))
  assert.equal(md.hints.headings, 3)
})

test('解析：md 按标题切、csv 按列、txt 按空行、单块 txt 报「未对齐」', () => {
  const root = makeMaterials()
  const scan = scanKbSources(root)
  const fieldMap = { id: ['id'], title: ['title', '标题'], content: ['content', '正文'], keywords: ['keywords', 'tags'], institution_fact: [], review_status: [] }
  const md = scan.sources.find((item) => item.path.endsWith('guide.md'))
  const mdParsed = parseSource(md, fieldMap)
  assert.ok(mdParsed.records.some((record) => record.title === '咨询流程'))
  const csv = scan.sources.find((item) => item.path.endsWith('table.csv'))
  const csvParsed = parseSource(csv, fieldMap)
  assert.equal(csvParsed.records.length, 1)
  assert.equal(csvParsed.records[0].title, '项目丙')
  assert.deepEqual(csvParsed.records[0].keywords.sort(), ['丙', '边界'].sort())
  const txt = scan.sources.find((item) => item.path.endsWith('notes.txt'))
  assert.equal(parseSource(txt, fieldMap).records.length, 2)
  // 整份只有一个文字块 → 未对齐，不硬切
  const single = writeFile(join(tmp('kb-one-'), 'one.txt'), '只有一段没有任何结构的正文。\n')
  const parsedSingle = parseSource({ path: single, ext: '.txt', format: 'plain-text' }, fieldMap)
  assert.equal(parsedSingle.records.length, 0)
  assert.ok(parsedSingle.issues.some((issue) => issue.reason.includes('未对齐')))
})

test('apply：统一格式落盘（id/retrieval_text/源映射/术语/报告/问题），坏行与二进制进未对齐清单', () => {
  const root = makeMaterials()
  const outDir = tmp()
  const scan = scanKbSources(root)
  const result = applyKbPlan({ plan: suggestPlan(scan), scan, outDir, industryName: '示例行业' })
  assert.equal(result.empty, false)
  assert.ok(result.entries >= 5)
  const entriesPath = join(outDir, 'knowledge-base', '02_结构化数据', '知识条目.jsonl')
  assert.ok(existsSync(entriesPath))
  const rows = readFileSync(entriesPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  const first = rows[0]
  for (const key of ['id', 'title', 'content', 'review_status', 'institution_fact', 'retrieval_text', 'citation_label', 'source_ref']) {
    assert.ok(key in first, `条目缺少字段 ${key}`)
  }
  assert.equal(first.institution_fact, false)
  assert.ok(first.citation_label.startsWith(`${first.id}@`))
  assert.ok(rows.every((row) => JSON.parse(JSON.stringify(row.source_ref)).file.length > 0))
  const terms = JSON.parse(readFileSync(join(outDir, 'knowledge-base', '02_结构化数据', '术语与转录纠错词典.json'), 'utf8'))
  assert.ok(terms.length > 0)
  assert.ok(terms.every((term) => term.term.length >= 2 && term.related_card_id))
  const sourceMap = JSON.parse(readFileSync(join(outDir, 'knowledge-base', 'kb-source-map.json'), 'utf8'))
  assert.equal(sourceMap.entries.length, rows.length)
  const report = readFileSync(join(outDir, 'knowledge-base', 'kb-report.md'), 'utf8')
  assert.ok(report.includes('知识库对齐报告'))
  assert.ok(report.includes('未对齐'))
  assert.ok(report.includes('docx'))
  const questions = readFileSync(join(outDir, 'knowledge-base', 'kb-open-questions.md'), 'utf8')
  assert.ok(questions.includes('不是可解析的文本格式'))
  assert.ok(result.issues >= 2) // 一条坏 jsonl 行 + 一个 docx
})

test('apply：同 ID 不同正文保留首条并记冲突；没有任何可解析材料时产出显式空库', () => {
  const root = tmp('kb-dup-')
  writeFile(
    join(root, 'dup.jsonl'),
    [
      JSON.stringify({ id: 'X1', title: '同号甲', content: '第一份正文。' }),
      JSON.stringify({ id: 'X1', title: '同号乙', content: '第二份正文（不同）。' }),
    ].join('\n') + '\n',
  )
  const scan = scanKbSources(root)
  const plan = { ...suggestPlan(scan), id_strategy: 'from_field', id_prefix: 'X' }
  const outDir = tmp()
  const result = applyKbPlan({ plan, scan, outDir })
  assert.equal(result.entries, 1)
  assert.equal(result.conflicts, 1)
  assert.ok(readFileSync(join(outDir, 'knowledge-base', 'kb-report.md'), 'utf8').includes('保留首条'))

  const emptyDir = tmp()
  const empty = writeEmptyKb({ outDir: emptyDir, reason: '用户未提供知识库材料' })
  assert.equal(empty.empty, true)
  assert.equal(readFileSync(join(emptyDir, 'knowledge-base', '02_结构化数据', '知识条目.jsonl'), 'utf8'), '')
  assert.ok(readFileSync(join(emptyDir, 'knowledge-base', 'kb-report.md'), 'utf8').includes('没有可用知识库'))
})

test('机构事实：价目/资质不进行业条目，拆到机构事实层并留空待补字段', () => {
  const root = tmp('kb-if-')
  writeFile(
    join(root, 'mixed.jsonl'),
    [
      JSON.stringify({ id: 'P1', title: '行业卡', content: '行业知识正文。' }),
      JSON.stringify({ id: 'F1', title: '价目表', content: '某项目 9999 元。', institution_fact: true }),
    ].join('\n') + '\n',
  )
  const scan = scanKbSources(root)
  const outDir = tmp()
  const result = applyKbPlan({ plan: { ...suggestPlan(scan), field_map: { ...suggestPlan(scan).field_map, institution_fact: ['institution_fact'] } }, scan, outDir })
  assert.equal(result.entries, 1)
  assert.equal(result.institution_facts, 1)
  const facts = JSON.parse(readFileSync(join(outDir, 'knowledge-base', '06_机构资料接入', '机构事实录入模板.json'), 'utf8'))
  assert.equal(facts.items.length, 1)
  const item = facts.items[0]
  assert.equal(item.amount, null)
  assert.equal(item.valid_until, '')
  assert.ok(Array.isArray(item.includes))
})

test('运行阶段：kb-scan 只盘点不产条目；kb-apply 产出 kb_dir / 报告 / kb-mode.json', () => {
  const root = makeMaterials()
  const outDir = tmp('kb-run-')
  const runInput = { transcripts: [{ session_id: 'S1', path: writeFile(join(tmp('kb-t-'), 'S1.txt'), '[00:00:01] 发言人1：你好\n') }], out_dir: outDir, knowledge_base: root, industry_name: '示例行业' }
  const scanOut = runKbScan(runInput, SKILL_DIR)
  assert.equal(scanOut.status, 'kb_scanned')
  assert.ok(existsSync(scanOut.kb_scan_path))
  assert.equal(existsSync(join(outDir, 'knowledge-base', '02_结构化数据', '知识条目.jsonl')), false, 'scan 阶段不应产出条目')
  const applyOut = runKbApply({ runInput, plan: scanOut.suggested_plan, questions: ['测试问题'], base: SKILL_DIR })
  assert.equal(applyOut.status, 'kb_applied')
  assert.ok(existsSync(join(applyOut.kb_dir, '02_结构化数据', '知识条目.jsonl')))
  assert.ok(applyOut.entries > 0)
  const mode = JSON.parse(readFileSync(join(outDir, 'kb-mode.json'), 'utf8'))
  assert.equal(mode.written_by, 'kb-apply')
  assert.equal(mode.empty, false)
  assert.ok(mode.entries > 0)
})

test('没有提供知识库：kb-scan 报 0，kb-apply 产出显式空库并说明原因', () => {
  const outDir = tmp('kb-none-')
  const runInput = { transcripts: [{ session_id: 'S1', path: writeFile(join(tmp('kb-t2-'), 'S1.txt'), '[00:00:01] 发言人1：你好\n') }], out_dir: outDir }
  const scanOut = runKbScan(runInput, SKILL_DIR)
  assert.equal(scanOut.provided, 0)
  assert.equal(scanOut.files, 0)
  const applyOut = runKbApply({ runInput, base: SKILL_DIR })
  assert.equal(applyOut.empty, true)
  assert.equal(applyOut.entries, 0)
  const report = readFileSync(join(applyOut.kb_dir, 'kb-report.md'), 'utf8')
  assert.ok(report.includes('没有可用知识库'))
  const mode = JSON.parse(readFileSync(join(outDir, 'kb-mode.json'), 'utf8'))
  assert.equal(mode.empty, true)
})

test('CLI 契约：--stage kb-scan / kb-apply 可离线跑，错误以退出码 2 + 三段式返回', () => {
  const root = makeMaterials()
  const outDir = tmp('kb-cli-')
  const transcriptPath = writeFile(join(tmp('kb-t3-'), 'S1.txt'), '[00:00:01] 发言人1：你好\n')
  const inputPath = join(outDir, 'input.json')
  writeFileSync(inputPath, JSON.stringify({ transcripts: [{ session_id: 'S1', path: transcriptPath }], out_dir: outDir, knowledge_base: [root] }, null, 2), 'utf8')
  const scanOutPath = join(outDir, 'out-scan.json')
  execFileSync(process.execPath, [CLI, inputPath, scanOutPath, '--stage', 'kb-scan'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const scanOut = JSON.parse(readFileSync(scanOutPath, 'utf8'))
  assert.equal(scanOut.status, 'kb_scanned')

  const submissionPath = join(outDir, 'submission.json')
  writeFileSync(submissionPath, JSON.stringify({ plan: scanOut.suggested_plan, questions: ['CLI 测试问题'] }, null, 2), 'utf8')
  const applyOutPath = join(outDir, 'out-apply.json')
  execFileSync(process.execPath, [CLI, submissionPath, applyOutPath, '--stage', 'kb-apply', '--run-input', inputPath], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  const applyOut = JSON.parse(readFileSync(applyOutPath, 'utf8'))
  assert.equal(applyOut.status, 'kb_applied')
  assert.ok(applyOut.entries > 0)
  assert.ok(parseArgv(['a', 'b', '--stage', 'kb-apply']).stage === 'kb-apply')
})

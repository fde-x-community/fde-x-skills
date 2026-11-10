// 行业配置冷启动 —— 基线测试
// 导入时运行时以 `node --test tests/run.test.mjs` 作为基线；它同时是"这个 skill 真能跑"的证明。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  SEGMENT_TURNS,
  SkillError,
  buildReport,
  countTerms,
  findOverlaps,
  indexTranscript,
  parseArgv,
  resolveDraft,
  resolveRunInputPath,
  runCheck,
  runIndex,
  submissionDraft,
  submissionQuestions,
  validateDraft,
} from '../scripts/run.mjs'

const contains = (haystack, needle) => haystack.some((item) => String(item).includes(needle))

function makeTranscript(lines) {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-test-'))
  const path = join(dir, 'S1.txt')
  writeFileSync(path, lines.join('\n'), 'utf8')
  return path
}

function makeTurns(n) {
  const out = []
  for (let i = 0; i < n; i += 1) {
    const mm = String(Math.floor(i / 60)).padStart(2, '0')
    const ss = String(i % 60).padStart(2, '0')
    out.push(`[00:${mm}:${ss}] 发言人1：第 ${i + 1} 句话，提到合同与定金。`)
  }
  return out
}

// ── 索引 ────────────────────────────────────────────────────────────────────

test('索引保留原始行号、时间戳与说话人', () => {
  const path = makeTranscript([
    '标题行不该被当作话轮',
    '[00:01:02] 发言人1：你好，我想了解一下。',
    '[00:01:09] 发言人2：好的，这边帮您安排。',
  ])
  const index = indexTranscript({ transcriptPath: path, transcriptKey: 'S1' })
  assert.equal(index.turns.length, 2)
  assert.equal(index.turns[0].line, 2)
  assert.equal(index.turns[0].timestamp, '00:01:02')
  assert.equal(index.turns[0].speaker, '发言人1')
  assert.equal(index.turns[0].turn_id, 'L2@00:01:02')
  assert.equal(index.unparsed_lines.length, 1)
  assert.equal(index.unparsed_lines[0].line, 1)
  assert.match(index.sha256, /^[0-9a-f]{64}$/)
})

test('session_id 不合法时直接拒绝', () => {
  const path = makeTranscript(['[00:00:01] 发言人1：你好。'])
  assert.throws(
    () => indexTranscript({ transcriptPath: path, transcriptKey: 'a/b' }),
    (error) => error instanceof SkillError && error.what.includes('不合法'),
  )
})

test('没有可解析话轮时干净失败', () => {
  const path = makeTranscript(['这一行不是话轮', '这一行也不是'])
  assert.throws(
    () => indexTranscript({ transcriptPath: path, transcriptKey: 'S1' }),
    (error) => error instanceof SkillError && error.what.includes('没有可解析的话轮'),
  )
})

// ── 分段稿 ──────────────────────────────────────────────────────────────────

test('分段稿按 SEGMENT_TURNS 切分并写盘', () => {
  const path = makeTranscript(makeTurns(SEGMENT_TURNS + 25))
  const outDir = mkdtempSync(join(tmpdir(), 'bootstrap-out-'))
  const output = runIndex(
    { transcripts: [{ session_id: 'S1', path }], out_dir: outDir },
    process.cwd(),
  )
  assert.equal(output.status, 'index_only')
  assert.equal(output.sessions[0].turns, SEGMENT_TURNS + 25)
  assert.equal(output.sessions[0].segments, 2)
  const segments = readFileSync(output.sessions[0].segments_path, 'utf8')
  assert.ok(segments.includes(`每段 ${SEGMENT_TURNS} 话轮`))
  assert.ok(segments.includes('第 1/2 段'))
  assert.ok(segments.includes('第 2/2 段'))
  const index = JSON.parse(readFileSync(output.sessions[0].index_path, 'utf8'))
  assert.equal(index.turns.length, SEGMENT_TURNS + 25)
})

test('重复 session_id 被拒绝（索引会互相覆盖）', () => {
  const path = makeTranscript(makeTurns(3))
  const outDir = mkdtempSync(join(tmpdir(), 'bootstrap-out-'))
  assert.throws(
    () => runIndex({ transcripts: [{ session_id: 'S1', path }, { session_id: 'S1', path }], out_dir: outDir }, process.cwd()),
    (error) => error instanceof SkillError && error.what.includes('重复'),
  )
})

// ── 干跑统计 ────────────────────────────────────────────────────────────────

test('干跑统计按话轮计命中次数，不按字符计', () => {
  const path = makeTranscript([
    '[00:00:01] 发言人1：合同在这里，合同你看一下。',
    '[00:00:02] 发言人2：好的。',
    '[00:00:03] 发言人1：定金先交一下。',
  ])
  const index = indexTranscript({ transcriptPath: path, transcriptKey: 'S1' })
  const counts = countTerms([index], ['合同', '定金', '从未出现的词'])
  const byWord = Object.fromEntries(counts.map((c) => [c.word, c.hits]))
  // 同一话轮里出现两次也只算 1 次：统计口径是"多少条话轮提到过它"
  assert.equal(byWord['合同'], 1)
  assert.equal(byWord['定金'], 1)
  assert.equal(byWord['从未出现的词'], 0)
})

// ── 草案校验 ────────────────────────────────────────────────────────────────

test('缺少必填键时报错', () => {
  const errors = validateDraft({ industry_terms: ['合同'] })
  assert.ok(contains(errors, '缺少必填键 completion_words'), errors.join(' | '))
  assert.ok(contains(errors, '缺少必填键 required_question_topics'), errors.join(' | '))
})

test('关键词少于两个字时报错（单字会大量误命中）', () => {
  const errors = validateDraft({
    industry_terms: ['合同', '价'],
    completion_words: [],
    required_question_topics: [],
  })
  assert.ok(contains(errors, '太短'), errors.join(' | '))
})

test('completion_words 不是 [词, 字段] 二元组时报错', () => {
  const errors = validateDraft({
    industry_terms: ['合同'],
    completion_words: [['已付款'], '已预约'],
    required_question_topics: [],
  })
  assert.ok(contains(errors, '格式错误'), errors.join(' | '))
})

test('completion_words 的字段名拼错时被拒收（否则该检查静默失效）', () => {
  const errors = validateDraft({
    industry_terms: ['合同'],
    completion_words: [['已付款', 'paymnet']],
    required_question_topics: [],
  })
  assert.ok(contains(errors, '字段名只能取'), errors.join(' | '))
  assert.ok(contains(errors, 'paymnet'), errors.join(' | '))
})

test('required_question_topics 里有空项时被拒收', () => {
  const errors = validateDraft({
    industry_terms: ['合同'],
    completion_words: [],
    required_question_topics: ['预算', '   '],
  })
  assert.ok(contains(errors, '空的项'), errors.join(' | '))
})

test('契约外的未知键被拒收（防止配置悄悄失效）', () => {
  const errors = validateDraft({
    industry_terms: ['合同'],
    completion_words: [],
    required_question_topics: [],
    process_terms: ['空腹'],
  })
  assert.ok(contains(errors, '未知键 process_terms'), errors.join(' | '))
})

test('合法草案零错误', () => {
  const errors = validateDraft({
    industry_terms: ['合同', '定金'],
    completion_words: [['已付款', 'payment']],
    required_question_topics: ['预算与支付能力'],
    post_action_words: ['后续'],
    page: { notice: '内部分析草稿' },
    _note: '下划线开头的键是注释，允许存在',
  })
  assert.deepEqual(errors, [])
})

// ── 子串重叠 ────────────────────────────────────────────────────────────────

test('词互为子串时给出提示', () => {
  const overlaps = findOverlaps(['合同', '购房合同', '定金'])
  assert.ok(overlaps.some(([a, b]) => a === '合同' && b === '购房合同'))
  assert.equal(overlaps.filter(([a, b]) => a === '定金').length, 0)
})

// ── check 阶段 ──────────────────────────────────────────────────────────────

test('check 阶段写出草案与报告，并把「从未出现」标为需人工判断', () => {
  const path = makeTranscript([
    '[00:00:01] 发言人1：合同在这里。',
    '[00:00:02] 发言人2：好的。',
  ])
  const outDir = mkdtempSync(join(tmpdir(), 'bootstrap-check-'))
  const draft = {
    industry_terms: ['合同', '住院'],
    completion_words: [['已付款', 'payment']],
    required_question_topics: ['预算'],
    page: { notice: '内部分析草稿' },
  }
  const output = runCheck({
    runInput: { transcripts: [{ session_id: 'S1', path }], out_dir: outDir, industry_name: '测试行业' },
    draft,
    base: process.cwd(),
  })
  assert.equal(output.status, 'drafted')
  const report = readFileSync(output.report_path, 'utf8')
  assert.ok(report.includes('测试行业'))
  assert.ok(report.includes('需人工判断'))
  // 关键：不能把「从未出现」写成「建议删除」——实测里恰恰是未出现的词在防编造
  assert.ok(report.includes('两种完全相反的解读'))
  const written = JSON.parse(readFileSync(output.config_path, 'utf8'))
  assert.deepEqual(written.industry_terms, ['合同', '住院'])
})

test('check 阶段草案格式错误时以 needs_revision 结束并仍出报告', () => {
  const path = makeTranscript(['[00:00:01] 发言人1：合同在这里。'])
  const outDir = mkdtempSync(join(tmpdir(), 'bootstrap-check-'))
  const output = runCheck({
    runInput: { transcripts: [{ session_id: 'S1', path }], out_dir: outDir },
    draft: { industry_terms: ['价'], completion_words: [], required_question_topics: [] },
    base: process.cwd(),
  })
  assert.equal(output.status, 'needs_revision')
  const report = readFileSync(output.report_path, 'utf8')
  assert.ok(report.includes('格式问题'))
})

// ── 报告内容 ────────────────────────────────────────────────────────────────

test('报告把「出现过于频繁」单列，提示要从硬词表收窄', () => {
  const report = buildReport({
    draft: {},
    counts: [
      { word: '价格', hits: 80 },
      { word: '合同', hits: 3 },
    ],
    overlaps: [],
    industryName: '测试',
    sessions: [{ session_id: 'S1', turns: 100 }],
    validationErrors: [],
  })
  assert.ok(report.includes('过于常见'))
  assert.ok(report.includes('价格'))
})

// ── CLI 契约（check 节点拿到的是节点提交物，运行输入要另读） ────────────────

test('check 阶段的输入是节点提交物，运行输入用 --run-input 另给', () => {
  const parsed = parseArgv(['in.json', 'out.json', '--stage', 'check', '--run-input', 'run-input.json'])
  assert.equal(parsed.stage, 'check')
  assert.equal(parsed.inputPath, 'in.json')
  assert.equal(parsed.outputPath, 'out.json')
  assert.ok(String(resolveRunInputPath(parsed.runInputPath)).endsWith('run-input.json'))
})

test('没有 --run-input 时回落到运行时注入的 FDEX_RUN_DIR', () => {
  const previous = process.env.FDEX_RUN_DIR
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-run-'))
  process.env.FDEX_RUN_DIR = dir
  try {
    assert.equal(resolveRunInputPath(undefined), join(dir, 'input.json'))
  } finally {
    if (previous === undefined) delete process.env.FDEX_RUN_DIR
    else process.env.FDEX_RUN_DIR = previous
  }
})

test('节点提交物只取 draft 字段，别的形状一律不认', () => {
  assert.deepEqual(submissionDraft({ draft: { industry_terms: [] } }), { industry_terms: [] })
  assert.equal(submissionDraft({ analysis: {} }), undefined)
  assert.equal(submissionDraft(null), undefined)
  assert.equal(submissionDraft({ draft: 'not-an-object' }), 'not-an-object')
})

test('草案优先取节点提交物，没有才回落到 run 输入里的 draft', () => {
  const fromSubmission = { industry_terms: ['定金'] }
  const fromRunInput = { industry_terms: ['分期'] }
  assert.deepEqual(resolveDraft({ draft: fromSubmission }, { draft: fromRunInput }), fromSubmission)
  assert.deepEqual(resolveDraft({}, { draft: fromRunInput }), fromRunInput)
  assert.deepEqual(resolveDraft(null, { draft: fromRunInput }), fromRunInput)
  assert.equal(resolveDraft({}, { transcripts: [] }), undefined)
  assert.equal(resolveDraft({ draft: 'not-an-object' }, {}), undefined)
})

test('节点提交物里的 questions 被取出，空项与非法形状丢弃', () => {
  assert.deepEqual(submissionQuestions({ draft: {}, questions: ['a', '', '   '] }), ['a'])
  assert.deepEqual(submissionQuestions({ draft: {} }), [])
  assert.deepEqual(submissionQuestions({ questions: 'not-an-array' }), [])
  assert.deepEqual(submissionQuestions(null), [])
})

// ── 多轮迭代：文件数不随轮数增长 ────────────────────────────────────────────

const threeTopics = ['预算与支付方式', '决策人与陪同人', '时间安排']

test('转录没变时复用已有索引与分段稿，不重写（避免每轮重写几百 KB）', () => {
  const path = makeTranscript(makeTurns(3))
  const outDir = mkdtempSync(join(tmpdir(), 'bootstrap-idem-'))
  const input = { transcripts: [{ session_id: 'S1', path }], out_dir: outDir }
  const first = runIndex(input, process.cwd())
  const indexPath = first.sessions[0].index_path
  const segmentsPath = first.sessions[0].segments_path
  const indexMtime = statSync(indexPath).mtimeMs
  const segmentsMtime = statSync(segmentsPath).mtimeMs

  const second = runIndex(input, process.cwd())

  assert.equal(second.sessions[0].turns, 3)
  assert.equal(second.sessions[0].segments, 1)
  assert.equal(statSync(indexPath).mtimeMs, indexMtime, '索引被重写了')
  assert.equal(statSync(segmentsPath).mtimeMs, segmentsMtime, '分段稿被重写了')
})

test('转录内容变了就重写索引（复用不能变成漏更新）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bootstrap-reindex-'))
  const path = join(dir, 'S1.txt')
  const outDir = mkdtempSync(join(tmpdir(), 'bootstrap-reindex-out-'))
  const input = { transcripts: [{ session_id: 'S1', path }], out_dir: outDir }

  writeFileSync(path, '[00:00:01] 发言人1：合同。', 'utf8')
  const first = runIndex(input, process.cwd())
  assert.equal(first.sessions[0].turns, 1)

  writeFileSync(path, '[00:00:01] 发言人1：合同。\n[00:00:09] 发言人2：定金。', 'utf8')
  const second = runIndex(input, process.cwd())
  assert.equal(second.sessions[0].turns, 2)

  const index = JSON.parse(readFileSync(second.sessions[0].index_path, 'utf8'))
  assert.equal(index.turns.length, 2)
})

test('每轮向 dialog.jsonl 追加一行，自动递增轮次并保留上一轮草案', () => {
  const path = makeTranscript(['[00:00:01] 发言人1：合同在这里。'])
  const outDir = mkdtempSync(join(tmpdir(), 'bootstrap-dialog-'))
  const runInput = { transcripts: [{ session_id: 'S1', path }], out_dir: outDir }
  const draft1 = { industry_terms: ['合同'], completion_words: [], required_question_topics: threeTopics }
  const draft2 = { industry_terms: ['合同', '定金'], completion_words: [], required_question_topics: threeTopics }

  runCheck({ runInput, draft: draft1, base: process.cwd() })
  runCheck({ runInput, draft: draft2, base: process.cwd() })

  const lines = readFileSync(join(outDir, 'dialog.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
  assert.equal(lines.length, 2)
  const first = JSON.parse(lines[0])
  const second = JSON.parse(lines[1])
  assert.equal(first.round, 1)
  assert.equal(second.round, 2)
  assert.deepEqual(first.previous_draft, null)
  assert.deepEqual(second.previous_draft.industry_terms, ['合同'])
  assert.deepEqual(second.draft.industry_terms, ['合同', '定金'])
})

test('0 命中的词与过少的必问项会变成待确认问题，判 needs_more_rounds', () => {
  const path = makeTranscript(['[00:00:01] 发言人1：合同在这里。'])
  const outDir = mkdtempSync(join(tmpdir(), 'bootstrap-q-'))
  const runInput = { transcripts: [{ session_id: 'S1', path }], out_dir: outDir }
  const draft = { industry_terms: ['合同', '住院'], completion_words: [], required_question_topics: ['预算'] }

  runCheck({ runInput, draft, base: process.cwd() })

  const questions = readFileSync(join(outDir, 'open-questions.md'), 'utf8')
  assert.ok(questions.includes('zero:住院'), questions)
  assert.ok(questions.includes('topics:too_few'), questions)
  assert.ok(questions.includes('还需要下一轮'), questions)
  const entry = JSON.parse(readFileSync(join(outDir, 'dialog.jsonl'), 'utf8').trim())
  assert.equal(entry.verdict, 'needs_more_rounds')
  assert.deepEqual(entry.zero_hit, ['住院'])
})

test('业务方回答后收敛为 ready_for_review，且不再重复问同一个词', () => {
  const path = makeTranscript(['[00:00:01] 发言人1：合同在这里。'])
  const outDir = mkdtempSync(join(tmpdir(), 'bootstrap-ready-'))
  const runInput = {
    transcripts: [{ session_id: 'S1', path }],
    out_dir: outDir,
    answers: { zero_hit: { 住院: 'keep' } },
  }
  const draft = { industry_terms: ['合同', '住院'], completion_words: [], required_question_topics: threeTopics }

  runCheck({ runInput, draft, base: process.cwd() })

  const questions = readFileSync(join(outDir, 'open-questions.md'), 'utf8')
  assert.ok(questions.includes('可以交业务方复核'), questions)
  assert.ok(!questions.includes('zero:住院'), '已处置的词不该再问')
  const entry = JSON.parse(readFileSync(join(outDir, 'dialog.jsonl'), 'utf8').trim())
  assert.equal(entry.verdict, 'ready_for_review')
})

test('agent 提出的问题进 open-questions 但不阻塞收敛判定', () => {
  const path = makeTranscript(['[00:00:01] 发言人1：合同在这里。'])
  const outDir = mkdtempSync(join(tmpdir(), 'bootstrap-advisory-'))
  const runInput = { transcripts: [{ session_id: 'S1', path }], out_dir: outDir }
  const draft = { industry_terms: ['合同'], completion_words: [], required_question_topics: threeTopics }

  runCheck({
    runInput,
    draft,
    base: process.cwd(),
    agentQuestions: ['这个行业还有哪些没说过但一旦写了就是编造的词？'],
  })

  const questions = readFileSync(join(outDir, 'open-questions.md'), 'utf8')
  assert.ok(questions.includes('agent 提出的问题'), questions)
  assert.ok(questions.includes('没说过但一旦写了就是编造的词'), questions)
  assert.ok(questions.includes('可以交业务方复核'), '建议确认项不应把收敛判定卡住')
  const entry = JSON.parse(readFileSync(join(outDir, 'dialog.jsonl'), 'utf8').trim())
  assert.equal(entry.agent_questions.length, 1)
  assert.equal(entry.verdict, 'ready_for_review')
})

test('keep_snapshot 默认关闭，打开时才多写一份快照', () => {
  const path = makeTranscript(['[00:00:01] 发言人1：合同在这里。'])
  const outDir = mkdtempSync(join(tmpdir(), 'bootstrap-snap-'))
  const base = { transcripts: [{ session_id: 'S1', path }], out_dir: outDir }
  const draft = { industry_terms: ['合同'], completion_words: [], required_question_topics: threeTopics }

  runCheck({ runInput: base, draft, base: process.cwd() })
  assert.equal(existsSync(join(outDir, 'snapshot-round-1')), false, '默认不该写快照')

  runCheck({ runInput: { ...base, keep_snapshot: true }, draft, base: process.cwd() })
  assert.equal(existsSync(join(outDir, 'snapshot-round-2', 'industry-config.draft.json')), true)
})

test('多轮之后目录里仍是固定几个文件，历史只长在 dialog.jsonl 里', () => {
  const path = makeTranscript(makeTurns(3))
  const outDir = mkdtempSync(join(tmpdir(), 'bootstrap-files-'))
  const runInput = { transcripts: [{ session_id: 'S1', path }], out_dir: outDir }
  const draft = { industry_terms: ['合同'], completion_words: [], required_question_topics: threeTopics }

  runIndex(runInput, process.cwd())
  for (let round = 0; round < 4; round += 1) {
    runCheck({ runInput, draft: { ...draft, industry_terms: round === 0 ? ['合同'] : ['合同', '定金'] }, base: process.cwd() })
  }

  const entries = readdirSync(outDir)
  assert.deepEqual(
    entries.sort(),
    ['S1.index.json', 'S1.segments.md', 'bootstrap-report.md', 'dialog.jsonl', 'industry-config.draft.json', 'open-questions.md'].sort(),
  )
  const lines = readFileSync(join(outDir, 'dialog.jsonl'), 'utf8').split('\n').filter((line) => line.trim() !== '')
  assert.equal(lines.length, 4, '四轮应该有四行历史')
})

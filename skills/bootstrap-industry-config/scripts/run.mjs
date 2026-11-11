#!/usr/bin/env node
// 行业配置冷启动 —— 机械层
// index 阶段：切话轮、写索引与分段稿
// bootstrap 阶段（agent）：从转录抽候选词，产出配置草案
// check 阶段：读 agent 产出的配置草案，校验格式、统计每个词在转录中的真实出现次数、生成报告
// kb-scan / kb-apply 阶段（v0.3.0-kb）：把用户提供的知识库材料（格式任意）对齐成统一格式，
//   落在工作目录 <out_dir>/knowledge-base/，供通用版 sales-brief-generic 自动发现。
// 本脚本不做任何语义判断：它只回答「这个配置格式对不对」「这个词在这份转录里出现过几次」
// 以及「知识库材料能机械对齐成什么」。字段映射这类语义判断由 kb-align（agent）给出。
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { applyKbPlan, describeScan, scanKbSources, suggestPlan, writeEmptyKb } from './kb.mjs'

export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const TURN_PATTERN = /^\[(\d{1,2}:\d{2}:\d{2})\]\s*([^：:]+)[：:]\s*(.*)$/
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/
export const SEGMENT_TURNS = 100

export class SkillError extends Error {
  constructor(what, why, fix) {
    super(what)
    this.name = 'SkillError'
    this.what = what
    this.why = why
    this.fix = fix
  }
}

const isObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmptyText = (v) => typeof v === 'string' && v.trim().length > 0
const hasOwn = (obj, key) => Object.prototype.hasOwnProperty.call(obj, key)

function resolveUserPath(p, base) {
  if (typeof p !== 'string' || p.trim() === '') throw new SkillError('路径为空', '没有路径就没有输入', '传一个文件路径')
  const abs = isAbsolute(p) ? p : resolve(base, p)
  return abs
}

function writeJson(path, data) {
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

function readJsonIfExists(path) {
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

/**
 * 内容没变就不写：多轮迭代时「当前状态」文件被打上新的修改时间但没有实质变化，
 * 会让人误以为这一轮改了什么。
 */
export function writeIfChanged(path, body) {
  if (existsSync(path) && readFileSync(path, 'utf8') === body) return false
  writeFileSync(path, body, 'utf8')
  return true
}

/** 历史只追加不覆盖：每轮一行 JSON，文件数不随轮数增长。 */
export function appendDialog(dialogPath, record) {
  appendFileSync(dialogPath, `${JSON.stringify(record)}\n`, 'utf8')
}

/** 下一个轮次号 = dialog.jsonl 已有的非空行数 + 1（不需要额外状态文件）。 */
export function nextRoundNumber(outDir) {
  const dialogPath = join(outDir, 'dialog.jsonl')
  if (!existsSync(dialogPath)) return 1
  const lines = readFileSync(dialogPath, 'utf8').split('\n').filter((line) => line.trim() !== '')
  return lines.length + 1
}

/** 现有索引是否可复用：同一会话、同一份转录内容、话轮数一致。 */
export function indexMatchesExisting(indexPath, index) {
  const existing = readJsonIfExists(indexPath)
  if (!isObject(existing)) return false
  return (
    existing.session_id === index.session_id &&
    existing.sha256 === index.sha256 &&
    Array.isArray(existing.turns) &&
    existing.turns.length === index.turns.length
  )
}

export function segmentCount(turns) {
  return Math.max(1, Math.ceil(turns / SEGMENT_TURNS))
}

/** 解析转录为话轮。保留原始行号，引用仍以索引为准。 */
export function indexTranscript({ transcriptPath, transcriptKey }) {
  if (!SESSION_ID_PATTERN.test(String(transcriptKey ?? ''))) {
    throw new SkillError(`session_id 不合法：${String(transcriptKey)}`, '它同时是索引文件名的一部分', '只用字母数字下划线连字符')
  }
  const text = readFileSync(transcriptPath, 'utf8')
  const sha256 = createHash('sha256').update(text).digest('hex')
  const lines = text.split(/\r?\n/)
  const turns = []
  const unparsed = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    const m = line.match(TURN_PATTERN)
    if (m === null) {
      unparsed.push({ line: i + 1, text: line, possible_title: i < 3 })
      continue
    }
    turns.push({
      turn_id: `L${i + 1}@${m[1]}`,
      line: i + 1,
      timestamp: m[1],
      speaker: m[2].trim(),
      text: m[3].trim(),
    })
  }
  if (turns.length === 0) {
    throw new SkillError('转录里没有可解析的话轮', '每行格式必须为 [hh:mm:ss] 发言人N：文本', '先修正转录格式再运行')
  }
  return {
    schema_version: '1.0',
    session_id: transcriptKey,
    source_name: basename(transcriptPath),
    sha256,
    turns,
    unparsed_lines: unparsed,
  }
}

export function planIndexes(runInput, base) {
  const outDir = resolveUserPath(runInput.out_dir, base)
  const transcripts = Array.isArray(runInput.transcripts) ? runInput.transcripts : []
  if (transcripts.length === 0) {
    throw new SkillError('transcripts 不能为空', '至少需要一份转录', '给出一份转录的路径')
  }
  const seen = new Set()
  const indexes = []
  for (const [position, item] of transcripts.entries()) {
    if (!isObject(item)) throw new SkillError(`transcripts[${position}] 必须为对象`, '格式不对', '按契约给 session_id 与 path')
    const transcriptId = String(item.session_id ?? '')
    if (seen.has(transcriptId)) {
      throw new SkillError(`session_id 重复：${transcriptId}`, '索引会互相覆盖', '改用不同的 session_id')
    }
    seen.add(transcriptId)
    if (!nonEmptyText(item.path)) throw new SkillError(`transcripts[${position}].path 为空`, '没有转录就没有索引', '给路径')
    indexes.push(indexTranscript({ transcriptPath: resolveUserPath(item.path, base), transcriptKey: transcriptId }))
  }
  return { outDir, indexes }
}

export function writeSegments(outDir, index) {
  const turns = index.turns
  const total = Math.max(1, Math.ceil(turns.length / SEGMENT_TURNS))
  const parts = []
  for (let i = 0; i < total; i += 1) {
    const slice = turns.slice(i * SEGMENT_TURNS, (i + 1) * SEGMENT_TURNS)
    if (slice.length === 0) continue
    parts.push(`## 第 ${i + 1}/${total} 段 · ${slice[0].turn_id} ~ ${slice[slice.length - 1].turn_id}（${slice.length} 话轮）`, '')
    for (const turn of slice) parts.push(`- ${turn.turn_id}　${turn.speaker}：${turn.text}`)
    parts.push('')
  }
  const body = [
    `# 会话 ${index.session_id} 分段稿（每段 ${SEGMENT_TURNS} 话轮，共 ${turns.length} 话轮）`,
    '',
    '> 供分段通读用：原话一字未改。抽词时**逐段读**，不要一次泛读。',
    '',
    ...parts,
  ].join('\n')
  const p = join(outDir, `${index.session_id}.segments.md`)
  writeFileSync(p, body, 'utf8')
  return { segments_path: p, segments: total }
}

export function runIndex(runInput, base) {
  const { outDir, indexes } = planIndexes(runInput, base)
  mkdirSync(outDir, { recursive: true })
  const sessions = []
  for (const index of indexes) {
    const indexPath = join(outDir, `${index.session_id}.index.json`)
    const segmentsPath = join(outDir, `${index.session_id}.segments.md`)
    // 多轮迭代时索引内容不变：复用已有产物，避免每轮重写 700 KB 索引与分段稿
    const reusable = indexMatchesExisting(indexPath, index) && existsSync(segmentsPath)
    if (!reusable) {
      writeJson(indexPath, index)
      writeSegments(outDir, index)
    }
    sessions.push({
      session_id: index.session_id,
      turns: index.turns.length,
      unparsed_lines: index.unparsed_lines.length,
      index_path: indexPath,
      segments_path: segmentsPath,
      segments: segmentCount(index.turns.length),
    })
  }
  return {
    status: 'index_only',
    sessions,
    config_path: '',
    report_path: '',
    execution_status: 'no_action_executed',
  }
}

// ── check 阶段：校验配置草案 + 干跑统计 ──────────────────────────────────────

const REQUIRED_KEYS = ['industry_terms', 'completion_words', 'required_question_topics']
export const COMPLETION_FIELDS = ['payment', 'appointment', 'treatment']
const OPTIONAL_KEYS = [
  'post_action_words', 'transaction_keys', 'decision_stages', 'project_statuses',
  'client_fact_states', 'labels', 'page', 'medical_review_topic',
]

/**
 * 统计一批词在转录里的出现次数。
 * 这是"干跑"的核心：一个词如果在这份转录里一次都没出现，它大概率不该进词表。
 */
export function countTerms(indexes, words) {
  const turns = indexes.flatMap((index) => index.turns.map((t) => `${t.speaker}：${t.text}`))
  const all = turns.join('\n')
  return words.map((word) => {
    let hits = 0
    for (const turn of turns) if (turn.includes(word)) hits += 1
    return { word, hits, total_chars: all.length }
  })
}

export function validateDraft(draft) {
  const errors = []
  if (!isObject(draft)) return ['配置草案必须是一个 JSON 对象']
  for (const key of REQUIRED_KEYS) {
    if (!hasOwn(draft, key)) errors.push(`缺少必填键 ${key}`)
  }
  if (hasOwn(draft, 'industry_terms')) {
    if (!Array.isArray(draft.industry_terms)) errors.push('industry_terms 必须是字符串数组')
    else {
      const bad = draft.industry_terms.filter((w) => !nonEmptyText(w) || String(w).length < 2)
      if (bad.length > 0) errors.push(`industry_terms 里有太短或空的词：${JSON.stringify(bad)}（关键词至少 2 个字）`)
    }
  }
  if (hasOwn(draft, 'completion_words')) {
    if (!Array.isArray(draft.completion_words)) errors.push('completion_words 必须是 [词, 字段名] 的数组')
    else {
      const bad = draft.completion_words.filter((pair) => !Array.isArray(pair) || pair.length !== 2)
      if (bad.length > 0) {
        errors.push(`completion_words 里有格式错误的项：${JSON.stringify(bad)}（应为 [词, payment|appointment|treatment]）`)
      } else {
        // 字段名拼错会让这条完成态检查静默失效：配置看着生效、实际永远匹配不上
        const badField = draft.completion_words.filter((pair) => !COMPLETION_FIELDS.includes(pair[1]))
        if (badField.length > 0) {
          errors.push(
            `completion_words 的字段名只能取 ${COMPLETION_FIELDS.join(' / ')}，收到 ${JSON.stringify(badField)}（拼错的字段名会让这条检查静默失效）`,
          )
        }
        const badWord = draft.completion_words.filter((pair) => !nonEmptyText(pair[0]))
        if (badWord.length > 0) errors.push(`completion_words 里有空的词：${JSON.stringify(badWord)}`)
      }
    }
  }
  if (hasOwn(draft, 'required_question_topics')) {
    if (!Array.isArray(draft.required_question_topics)) {
      errors.push('required_question_topics 必须是字符串数组')
    } else {
      const bad = draft.required_question_topics.filter((topic) => !nonEmptyText(topic))
      if (bad.length > 0) errors.push(`required_question_topics 里有空的项：${JSON.stringify(bad)}`)
    }
  }
  for (const key of Object.keys(draft)) {
    if (!REQUIRED_KEYS.includes(key) && !OPTIONAL_KEYS.includes(key) && !key.startsWith('_')) {
      errors.push(`未知键 ${key}：不在契约内（允许 ${REQUIRED_KEYS.concat(OPTIONAL_KEYS).join(' / ')}）`)
    }
  }
  return errors
}

/** 找一个词是否被另一个词包含（互为子串会导致重复命中，值得提示）。 */
export function findOverlaps(words) {
  const out = []
  for (let i = 0; i < words.length; i += 1) {
    for (let j = 0; j < words.length; j += 1) {
      if (i === j) continue
      if (String(words[j]).includes(String(words[i])) && String(words[i]) !== String(words[j])) {
        out.push([words[i], words[j]])
      }
    }
  }
  return out
}

export function buildReport({ draft, counts, overlaps, industryName, sessions, validationErrors }) {
  const lines = []
  lines.push(`# 行业配置冷启动报告${industryName ? `：${industryName}` : ''}`)
  lines.push('')
  lines.push(`- 转录：${sessions.map((s) => `${s.session_id}（${s.turns} 话轮）`).join('、')}`)
  lines.push(`- 草案词量：industry_terms ${counts.length} 个`)
  lines.push(`- 格式校验：${validationErrors.length === 0 ? '通过' : `${validationErrors.length} 处问题`}`)
  lines.push('')
  if (validationErrors.length > 0) {
    lines.push('## 一、格式问题（必须修）')
    for (const e of validationErrors) lines.push(`- ${e}`)
    lines.push('')
  }
  lines.push('## 二、逐词出现次数（干跑结果）')
  lines.push('')
  lines.push('> **「0 次」有两种完全相反的解读，必须人来判断**：')
  lines.push('>')
  lines.push('> - **可能是「该删」**：这个词在你的行业里不常用，进表只会造成误伤。')
  lines.push('> - **可能正是「要防的」**：这个词是行业常识、模型会主动写、但录音里从未出现过——它进表恰恰是对的，因为它拦的就是「凭空补出这个流程/承诺」。')
  lines.push('>')
  lines.push('> 实测参考：人工整理的行业词表放进真实长对话里，命中率常常不到一半；而没命中的那些恰恰是模型最容易凭空写出的流程词与资质词——所以「零命中」不等于「该删」。')
  lines.push('>')
  lines.push('> **判据：你是否希望模型永远别提这个词、除非原话里真的出现？** 是，就留；不是，就删。')
  lines.push('> **次数很高（如 >50）的词要谨慎**：太常见的词加进硬词表会造成大量误报。')
  lines.push('')
  lines.push('| 词 | 出现话轮数 | 判定 |')
  lines.push('| --- | ---: | --- |')
  const zero = []
  const heavy = []
  for (const c of counts.sort((a, b) => b.hits - a.hits)) {
    let verdict = '有效（行业真实用词）'
    if (c.hits === 0) {
      verdict = '**从未出现 → 见下节，需人工判断**'
      zero.push(c.word)
    } else if (c.hits > 50) {
      verdict = '**过于常见 → 建议删或收窄**'
      heavy.push(c.word)
    }
    lines.push(`| ${c.word} | ${c.hits} | ${verdict} |`)
  }
  lines.push('')
  if (zero.length > 0) {
    lines.push(`## 三、从未出现的词（需人工判断，不是自动该删）`)
    lines.push('')
    lines.push(zero.map((w) => `- ${w}`).join('\n'))
    lines.push('')
    lines.push('**逐个问一句：这个词是「行业常识、模型会主动写」吗？**')
    lines.push('')
    lines.push('- 是 → **留下**。它进表就是为了拦「模型凭空补出这个流程/承诺」。')
    lines.push('- 否 → **删掉**。它是行业里不常用的词，留着只会误伤。')
    lines.push('')
    lines.push('另一个要考虑的：**这份转录是不是太短、恰好没覆盖到？** 如果是，先别删，再用一份更长的录音验证。')
    lines.push('')
  }
  if (heavy.length > 0) {
    lines.push(`## 四、建议收窄（出现过于频繁）`)
    lines.push('')
    lines.push(heavy.map((w) => `- ${w}`).join('\n'))
    lines.push('')
    lines.push('这类词通常是"行业常用词"而非"承诺词"。它们不该进硬词表——写「谈过价格」不构成承诺，写「免息」才构成。')
    lines.push('')
  }
  if (overlaps.length > 0) {
    lines.push('## 五、词之间互为子串（会重复命中）')
    lines.push('')
    lines.push(overlaps.slice(0, 20).map(([a, b]) => `- 「${a}」是「${b}」的子串`).join('\n'))
    lines.push('')
    lines.push('保留更长的那个即可；或者两个都留（会重复报错但不漏）。')
    lines.push('')
  }
  lines.push('## 六、下一步')
  lines.push('')
  lines.push('1. 按上面三/四/五节调整 `industry-config.draft.json` 的 `industry_terms`')
  lines.push('2. 配置**留在当前运行目录**（通用版 run 会自动发现并采用 <out_dir>/industry-config.json 或 <out_dir>/industry-config/industry-config.draft.json）；**不要复制进通用版 skill 的 `assets/industry-config.json`**——技能包里的那份必须保持通用，行业配置只落在工作目录')
  lines.push('3. 如需把行业能力固化成一个独立 skill（如「sales-brief-<industry>」），询问业务方后走 skill-creator 从这份词表注册新 skill（通用版保持行业无关）')
  lines.push('4. **先以「只警告不拒收」跑 3–5 个真实案子**，确认没有大量误伤后再切强制模式')
  lines.push('')
  lines.push('> 这份报告只回答"格式对不对"和"词在转录里出现过几次"。**一个词该不该拦，最终要由业务负责人判断**——脚本不知道你的行业里哪些承诺是危险的。')
  return lines.join('\n')
}

/** 本轮结束后需要人回答的问题：只问阻塞收敛的少数几个，不把整份配置丢回去让人重填。 */
export function planOpenQuestions({ draft, counts, overlaps, answers }) {
  const questions = []
  const dispositions = isObject(answers) && isObject(answers.zero_hit) ? answers.zero_hit : {}
  for (const item of counts) {
    if (item.hits !== 0) continue
    if (nonEmptyText(dispositions[item.word])) continue
    questions.push({
      id: `zero:${item.word}`,
      question: `「${item.word}」在这份转录里 0 次。删掉（行业里不常用），还是保留（行业常识、模型容易凭空写，进表正是为了拦它）？`,
      options: ['drop', 'keep'],
    })
  }
  const resolved =
    isObject(answers) && Array.isArray(answers.overlaps_resolved) ? answers.overlaps_resolved.map(String) : []
  const seenPairs = new Set()
  for (const [shortWord, longWord] of overlaps) {
    const key = `${shortWord}|${longWord}`
    if (seenPairs.has(key) || resolved.includes(key)) continue
    seenPairs.add(key)
    questions.push({
      id: `overlap:${key}`,
      question: `「${shortWord}」是「${longWord}」的子串，会重复命中。只留长的那个，还是两个都留？`,
      options: ['keep_long', 'keep_both'],
    })
  }
  const topics = isObject(draft) && Array.isArray(draft.required_question_topics) ? draft.required_question_topics : []
  if (topics.length < 3) {
    questions.push({
      id: 'topics:too_few',
      question: `必问项目前只有 ${topics.length} 项。成交前还必须问清哪些事？（判据：这一项没问清就成交，会出什么麻烦）`,
      options: [],
    })
  }
  return questions
}

/** 收敛判据：没有待确认问题就交业务方复核，否则还要一轮。 */
export function convergenceVerdict(pendingQuestions) {
  return pendingQuestions.length === 0 ? 'ready_for_review' : 'needs_more_rounds'
}

export function buildOpenQuestions({ questions, round, industryName, verdict, agentQuestions }) {
  const lines = []
  lines.push(`# 第 ${round} 轮待确认问题${industryName ? `（${industryName}）` : ''}`)
  lines.push('')
  lines.push(
    `- 判定：${verdict === 'ready_for_review' ? '**可以交业务方复核**（本轮没有阻塞性问题）' : '**还需要下一轮**'}`,
  )
  lines.push(`- 问题数：${questions.length}`)
  lines.push('')
  if (questions.length === 0) {
    lines.push('本轮没有阻塞性问题：0 命中的词都已处置、没有未解的子串重叠、必问项不少于 3 项。')
    lines.push('')
    lines.push('> 「没有阻塞性问题」不等于「这份配置已适配这个行业」。词表的最终取舍仍要业务负责人过一遍。')
  } else {
    for (const question of questions) {
      lines.push(`- [ ] \`${question.id}\`　${question.question}`)
      if (question.options.length > 0) lines.push(`  - 可选回答：${question.options.join(' / ')}`)
    }
    lines.push('')
    lines.push('## 怎么回答')
    lines.push('')
    lines.push('把回答放进下一次 run 的 `answers` 字段，带着上一轮的 `draft` 再跑一轮：')
    lines.push('')
    lines.push('```json')
    lines.push('{')
    lines.push('  "transcripts": [ ... ],')
    lines.push('  "out_dir": "同一个目录",')
    lines.push('  "draft": { ... 上一轮的 industry-config.draft.json ... },')
    lines.push('  "answers": {')
    lines.push('    "zero_hit": { "空腹": "keep", "体检": "drop" },')
    lines.push('    "overlaps_resolved": ["合同|购房合同"]')
    lines.push('  }')
    lines.push('}')
    lines.push('```')
    lines.push('')
    lines.push('每轮的回答与草案都会追加进 `dialog.jsonl`，目录里不会多出快照文件。')
  }
  if (Array.isArray(agentQuestions) && agentQuestions.length > 0) {
    lines.push('')
    lines.push('## agent 提出的问题（建议确认，不阻塞收敛判定）')
    lines.push('')
    for (const question of agentQuestions) lines.push(`- ${question}`)
    lines.push('')
    lines.push('> 这些是读转录看不出来的事，只能由业务方回答。它们不计入机械收敛判定，但直接决定这份配置能不能定稿。')
  }
  return `${lines.join('\n')}\n`
}

export function runCheck({ runInput, draft, base, agentQuestions }) {
  const { outDir, indexes } = planIndexes(runInput, base)
  mkdirSync(outDir, { recursive: true })
  const validationErrors = validateDraft(draft)
  const words = isObject(draft) && Array.isArray(draft.industry_terms) ? draft.industry_terms.map(String) : []
  const counts = countTerms(indexes, words)
  const overlaps = findOverlaps(words)
  const sessions = indexes.map((index) => ({ session_id: index.session_id, turns: index.turns.length }))
  const industryName = nonEmptyText(runInput.industry_name) ? String(runInput.industry_name) : ''
  const answers = isObject(runInput.answers) ? runInput.answers : {}
  const round = Number.isInteger(runInput.round) && runInput.round > 0 ? runInput.round : nextRoundNumber(outDir)
  const questions = planOpenQuestions({ draft, counts, overlaps, answers })
  const verdict = convergenceVerdict(questions)
  const advisory = Array.isArray(agentQuestions) ? agentQuestions.filter((item) => nonEmptyText(item)).map(String) : []

  const configPath = join(outDir, 'industry-config.draft.json')
  const reportPath = join(outDir, 'bootstrap-report.md')
  const questionsPath = join(outDir, 'open-questions.md')
  const dialogPath = join(outDir, 'dialog.jsonl')
  const previousDraft = readJsonIfExists(configPath)

  writeIfChanged(configPath, `${JSON.stringify(draft, null, 2)}\n`)
  const reportBody = [
    buildReport({ draft, counts, overlaps, industryName, sessions, validationErrors }),
    '',
    '## 七、收敛状态',
    '',
    `- 轮次：第 ${round} 轮`,
    `- 判定：${verdict === 'ready_for_review' ? '**可以交业务方复核**' : '**还需要下一轮**'}`,
    `- 待确认问题：${questions.length} 个（见 \`open-questions.md\`）`,
    `- 历史记录：\`dialog.jsonl\` 第 ${round} 行`,
    '',
  ].join('\n')
  writeIfChanged(reportPath, reportBody)
  writeIfChanged(questionsPath, buildOpenQuestions({ questions, round, industryName, verdict, agentQuestions: advisory }))

  // 历史只追加：上一轮草案随本轮记录一起留给未来查，不额外占文件
  appendDialog(dialogPath, {
    round,
    ts: new Date().toISOString(),
    industry_name: industryName,
    verdict,
    validation_errors: validationErrors,
    zero_hit: counts.filter((item) => item.hits === 0).map((item) => item.word),
    hits: Object.fromEntries(counts.map((item) => [item.word, item.hits])),
    open_questions: questions.map((question) => question.id),
    agent_questions: advisory,
    answers,
    previous_draft: previousDraft ?? null,
    draft,
  })

  if (runInput.keep_snapshot === true) {
    const snapshotDir = join(outDir, `snapshot-round-${round}`)
    mkdirSync(snapshotDir, { recursive: true })
    writeJson(join(snapshotDir, 'industry-config.draft.json'), draft)
  }

  return {
    status: validationErrors.length === 0 ? 'drafted' : 'needs_revision',
    sessions,
    config_path: configPath,
    report_path: reportPath,
    execution_status: 'no_action_executed',
  }
}

// ── CLI ─────────────────────────────────────────────────────────────────────
function loadJson(p) {
  // 剥 BOM：Windows PowerShell 5.1 的 Set-Content -Encoding UTF8 会带 BOM，
  // 一份写对了内容的 input.json 不该被当成非法 JSON 拒掉。
  return JSON.parse(readFileSync(p, 'utf8').replace(/^\uFEFF/, ''))
}

/** 节点提交物里的草案：agent 节点提交 { draft: {...} }。 */
export function submissionDraft(submission) {
  return isObject(submission) ? submission.draft : undefined
}

/** 节点提交物里的建议确认问题（可选，advisory：不阻塞收敛判定）。 */
export function submissionQuestions(submission) {
  if (!isObject(submission) || !Array.isArray(submission.questions)) return []
  return submission.questions.filter((item) => nonEmptyText(item)).map(String)
}

/**
 * 这次的草案从哪来：优先节点提交物，其次 run 输入里的 draft。
 * 后者用于多轮迭代：把上一轮（或人工改过）的草案直接塞回输入复跑校验，不必重走 agent。
 */
export function resolveDraft(submission, runInput) {
  const fromSubmission = submissionDraft(submission)
  if (isObject(fromSubmission)) return fromSubmission
  if (isObject(runInput) && isObject(runInput.draft)) return runInput.draft
  return undefined
}

/**
 * 本次 run 的输入文档路径（check 阶段需要它拿 transcripts / out_dir）。
 * 与主 skill 的约定一致：--run-input 优先，其次运行时注入的 FDEX_RUN_DIR。
 */
export function resolveRunInputPath(cliPath) {
  if (nonEmptyText(cliPath)) return resolveUserPath(cliPath, process.cwd())
  const runDir = process.env.FDEX_RUN_DIR
  if (nonEmptyText(runDir)) return join(runDir, 'input.json')
  return undefined
}

// ── 知识库对齐（v0.3.0-kb）：kb-scan（脚本）→ kb-align（agent）→ kb-apply（脚本） ──
// 与词表同构：技能包只带「统一格式的约定」，真实知识库由用户材料抽出来、对齐成统一格式、
// 落在工作目录（<out_dir>/knowledge-base/），供通用版 sales-brief-generic 自动发现。

/** kb-scan：只统计与取样，不产出条目。写 <out_dir>/kb-scan.json，并把摘要交回 agent。 */
export function runKbScan(runInput, base) {
  if (!isObject(runInput)) {
    throw new SkillError('输入文档必须为 JSON 对象', `收到 ${typeof runInput}`, '按 manifest.inputs 传入 { transcripts, out_dir, knowledge_base }')
  }
  if (!nonEmptyText(runInput.out_dir)) {
    throw new SkillError('缺少 out_dir', '知识库扫描结果要落盘到本次运行目录', '给一个技能包之外的私有目录路径')
  }
  const outDir = resolveUserPath(runInput.out_dir, base)
  mkdirSync(outDir, { recursive: true })
  const kbInput = runInput.knowledge_base
  const scan = scanKbSources(kbInput)
  const scanPath = join(outDir, 'kb-scan.json')
  writeIfChanged(scanPath, `${JSON.stringify(scan, null, 2)}\n`)
  const suggestion = suggestPlan(scan)
  return {
    status: 'kb_scanned',
    kb_scan_path: scanPath,
    provided: scan.provided,
    files: scan.files,
    total_bytes: scan.total_bytes,
    formats: scan.formats,
    unsupported: scan.unsupported.length,
    missing: scan.missing.length,
    summary: describeScan(scan),
    suggested_plan: suggestion,
    execution_status: 'no_action_executed',
  }
}

/**
 * kb-apply：按 agent 给的 plan 把候选记录落成统一格式。
 * plan 缺失时用扫描阶段的建议计划（宁少勿多：只做机械映射，不猜结构）。
 * 用户没提供知识库时产出**显式空库**，让下游「未接入」可审计。
 */
export function runKbApply({ runInput, plan, questions, base }) {
  if (!isObject(runInput)) {
    throw new SkillError('输入文档必须为 JSON 对象', `收到 ${typeof runInput}`, '按 manifest.inputs 传入 { transcripts, out_dir, knowledge_base }')
  }
  if (!nonEmptyText(runInput.out_dir)) {
    throw new SkillError('缺少 out_dir', '知识库产物要落盘到本次运行目录', '给一个技能包之外的私有目录路径')
  }
  const outDir = resolveUserPath(runInput.out_dir, base)
  mkdirSync(outDir, { recursive: true })
  const industryName = nonEmptyText(runInput.industry_name) ? String(runInput.industry_name) : ''
  const round = Number.isInteger(runInput.round) && runInput.round > 0 ? runInput.round : nextRoundNumber(outDir)

  // 扫描结果优先复用本轮的 kb-scan.json；没有就现场扫一遍（幂等）
  let scan
  const scanPath = join(outDir, 'kb-scan.json')
  try {
    scan = JSON.parse(readFileSync(scanPath, 'utf8').replace(/^\uFEFF/, ''))
  } catch {
    scan = scanKbSources(runInput.knowledge_base)
  }

  const noKb = (scan.files ?? 0) === 0
  const effectivePlan = isObject(plan)
    ? plan
    : (isObject(runInput.kb_draft) ? runInput.kb_draft : suggestPlan(scan))
  const mergedQuestions = Array.isArray(questions) ? questions.filter((item) => nonEmptyText(item)).map(String) : []
  const planWithQuestions = { ...effectivePlan, questions: [...(Array.isArray(effectivePlan.questions) ? effectivePlan.questions : []), ...mergedQuestions], round }

  const result = noKb
    ? writeEmptyKb({ outDir, industryName, reason: `用户未提供可解析的知识库材料（输入 ${scan.provided ?? 0} 个）` })
    : applyKbPlan({ plan: planWithQuestions, scan, outDir, industryName })

  // 知识库基准也落盘（与 industry-mode.json 同一套思路：脚本只知道「有什么」，读者要知道「按哪套基准」）
  writeJson(join(outDir, 'kb-mode.json'), {
    written_by: 'kb-apply',
    round,
    industry_name: industryName,
    kb_dir: result.kb_dir,
    entries: result.entries,
    terms: result.terms,
    institution_facts: result.institution_facts,
    empty: result.empty === true,
    plan_strategy: isObject(planWithQuestions) ? {
      id_strategy: planWithQuestions.id_strategy ?? 'seq',
      id_prefix: planWithQuestions.id_prefix ?? 'K',
      review_status_default: planWithQuestions.review_status_default ?? 'draft_needs_professional_review',
      institution_fact_handling: planWithQuestions.institution_fact_handling ?? 'separate_file',
    } : {},
    note: result.empty === true
      ? '本次没有可用知识库：通用版 run 会把本次 run 判定为「未接入」，页面不含任何知识依据。'
      : '知识库已落在工作目录；通用版 sales-brief-generic 会从工作目录自动发现（候选含 <out_dir>/knowledge-base 与 <out_dir>/industry-config/knowledge-base）。',
  })

  return {
    status: 'kb_applied',
    kb_dir: result.kb_dir,
    kb_report_path: result.report_path,
    kb_questions_path: result.questions_path,
    kb_source_map_path: result.source_map_path,
    entries: result.entries,
    terms: result.terms,
    institution_facts: result.institution_facts,
    issues: result.issues,
    conflicts: result.conflicts,
    empty: result.empty === true,
    questions: result.questions,
    execution_status: 'no_action_executed',
  }
}

/** 节点提交物里的 kb 计划：agent 节点提交 { plan: {...}, questions?: [...] }。 */
export function submissionPlan(submission) {
  return isObject(submission) ? (isObject(submission.plan) ? submission.plan : undefined) : undefined
}

export function submissionPlanQuestions(submission) {
  if (!isObject(submission) || !Array.isArray(submission.questions)) return []
  return submission.questions.filter((item) => nonEmptyText(item)).map(String)
}

export function parseArgv(argv) {
  const positional = []
  let stage = 'index'
  let runInputPath
  let index = 0
  while (index < argv.length) {
    const token = argv[index]
    if (token === '--stage') {
      stage = argv[index + 1] ?? ''
      index += 2
      continue
    }
    if (token === '--run-input') {
      runInputPath = argv[index + 1]
      index += 2
      continue
    }
    positional.push(token)
    index += 1
  }
  return { stage, runInputPath, inputPath: positional[0], outputPath: positional[1] }
}

export function main(argv) {
  const parsed = parseArgv(argv)
  const base = process.cwd()
  try {
    if (!nonEmptyText(parsed.inputPath) || !nonEmptyText(parsed.outputPath)) {
      throw new SkillError(
        '缺少参数',
        'node 入口需要 <input.json> <output.json>',
        '按 workflow 节点的 entrypoint 传 inputPath 与 outputPath',
      )
    }
    let output
    if (parsed.stage === 'index') {
      output = runIndex(loadJson(resolveUserPath(parsed.inputPath, base)), base)
    } else if (parsed.stage === 'check') {
      // 节点提交物（inputPath）只有 { draft }；transcripts/out_dir 要另读本次 run 的输入文档
      const runInputPath = resolveRunInputPath(parsed.runInputPath)
      if (runInputPath === undefined) {
        throw new SkillError(
          'check 阶段找不到本次 run 的输入文档',
          '该阶段需要 run 的 transcripts 与 out_dir；运行时通过 FDEX_RUN_DIR 提供',
          '用 --run-input 显式给出本次 run 的 input.json 路径',
        )
      }
      const runInput = loadJson(runInputPath)
      const submission = loadJson(resolveUserPath(parsed.inputPath, base))
      const draft = resolveDraft(submission, runInput)
      if (!isObject(draft)) {
        throw new SkillError(
          'check 阶段没有可校验的草案',
          '节点提交物与 run 输入里都没有 draft 对象',
          '按节点的 outputSchema 提交 { draft: {...} }，或在 run 输入里给 draft',
        )
      }
      output = runCheck({ runInput, draft, base, agentQuestions: submissionQuestions(submission) })
    } else if (parsed.stage === 'kb-scan') {
      const runInputPath = resolveRunInputPath(parsed.runInputPath)
      const runInput = runInputPath !== undefined ? loadJson(runInputPath) : loadJson(resolveUserPath(parsed.inputPath, base))
      output = runKbScan(runInput, base)
    } else if (parsed.stage === 'kb-apply') {
      const runInputPath = resolveRunInputPath(parsed.runInputPath)
      if (runInputPath === undefined) {
        throw new SkillError(
          'kb-apply 阶段找不到本次 run 的输入文档',
          '该阶段需要 run 的 knowledge_base 与 out_dir；运行时通过 FDEX_RUN_DIR 提供',
          '用 --run-input 显式给出本次 run 的 input.json 路径',
        )
      }
      const runInput = loadJson(runInputPath)
      const submission = loadJson(resolveUserPath(parsed.inputPath, base))
      const plan = submissionPlan(submission) ?? (isObject(runInput.kb_draft) ? runInput.kb_draft : undefined)
      output = runKbApply({ runInput, plan, questions: submissionPlanQuestions(submission), base })
    } else {
      throw new SkillError(`未知 stage：${parsed.stage}`, '只支持 index / check / kb-scan / kb-apply', '用 --stage index、--stage check、--stage kb-scan 或 --stage kb-apply')
    }
    writeJson(resolveUserPath(parsed.outputPath, base), output)
    return 0
  } catch (error) {
    if (error instanceof SkillError) {
      if (nonEmptyText(parsed.outputPath)) {
        writeJson(resolveUserPath(parsed.outputPath, base), {
          status: 'needs_revision',
          sessions: [],
          config_path: '',
          report_path: '',
          execution_status: 'no_action_executed',
          error: { what: error.what, why: error.why, fix: error.fix },
        })
      }
      process.stderr.write(`${error.what}\n为什么：${error.why}\n怎么改：${error.fix}\n`)
      return 2
    }
    throw error
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  process.exitCode = main(process.argv.slice(2))
}

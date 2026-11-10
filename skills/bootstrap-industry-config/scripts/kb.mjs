// 知识库对齐（bootstrap-industry-config v0.3.0-kb）
//
// 与「词表」同构的设计：技能包只带**统一格式的约定**，真实知识库由冷启动从用户材料里
// 抽出来、对齐成统一格式、落在工作目录，供通用版 sales-brief-generic 自动发现。
//
// 统一格式（与 sales-brief-generic 的既定约定一致）：
//   knowledge-base/
//     02_结构化数据/知识条目.jsonl        # 每行一条，至少 id/title/content
//     02_结构化数据/术语与转录纠错词典.json  # [{term, related_card_id, resolution_status}]
//     06_机构资料接入/机构事实录入模板.json  # 机构价目/资质/排期（不得混进行业条目）
//     kb-source-map.json                  # 每条条目 ← 哪个源文件的哪一处（可追溯）
//     kb-report.md                        # 计数、字段完整率、冲突、未解析、缺口
//     kb-open-questions.md                # 只能由业务方确认的问题
//
// 三条原则：
//   1. 不猜。解析不出结构就留原文、报「未对齐」，不编字段。
//   2. 宁少勿多。宁可少抽一条，也不把噪声抬成知识（沿用「误写不入库」的结论）。
//   3. 不给知识库也是合法输入：此时产出一份**显式的空库 + 缺口声明**，让下游「未接入」是可审计的，而不是看起来像接了。

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, relative } from 'node:path'

export const KB_DIR_NAME = 'knowledge-base'
export const KB_FILES = {
  entries: '02_结构化数据/知识条目.jsonl',
  terms: '02_结构化数据/术语与转录纠错词典.json',
  institutionFacts: '06_机构资料接入/机构事实录入模板.json',
  sourceMap: 'kb-source-map.json',
  report: 'kb-report.md',
  questions: 'kb-open-questions.md',
  readme: '00_使用说明.md',
}

/** 可作为知识条目正文的扩展名（都是纯文本；二进制格式必须先导出为文本，不假装能读 docx/pdf）。 */
export const TEXT_EXTENSIONS = ['.jsonl', '.json', '.md', '.markdown', '.txt', '.csv', '.tsv', '.html', '.htm']
/** 明确不支持、需要在 questions 里要求业务方导出文本的扩展名。 */
export const BINARY_EXTENSIONS = ['.doc', '.docx', '.pdf', '.xls', '.xlsx', '.ppt', '.pptx', '.zip', '.7z', '.rar', '.png', '.jpg', '.jpeg', '.mp3', '.mp4']

const isObject = (value) => typeof value === 'object' && value !== null && !Array.isArray(value)
const nonEmptyText = (value) => typeof value === 'string' && value.trim().length > 0

function readTextSafe(path) {
  try {
    return readFileSync(path, 'utf8').replace(/^\uFEFF/, '')
  } catch {
    return undefined
  }
}

function walk(root) {
  const files = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    let names = []
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      if (name === '__MACOSX') continue
      const full = join(dir, name)
      let info
      try {
        info = statSync(full)
      } catch {
        continue
      }
      if (info.isDirectory()) stack.push(full)
      else if (info.isFile()) files.push({ path: full, bytes: info.size })
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path))
}

/**
 * 把用户给的知识库输入（字符串或数组，文件或目录）展开成文件清单。
 * 目录递归；跳过 .DS_Store 这类系统文件；二进制格式单独归类（不解析、要问）。
 */
export function listKbSources(kbInput) {
  const raw = Array.isArray(kbInput) ? kbInput : (nonEmptyText(kbInput) ? [kbInput] : [])
  const files = []
  const unsupported = []
  const missing = []
  const seen = new Set()
  for (const item of raw) {
    const path = String(item ?? '').trim()
    if (path === '') continue
    let info
    try {
      info = statSync(path)
    } catch {
      missing.push(path)
      continue
    }
    const candidates = info.isDirectory() ? walk(path) : [{ path, bytes: info.size }]
    for (const file of candidates) {
      const name = basename(file.path)
      if (name === '.DS_Store' || name === 'Thumbs.db' || name.startsWith('~$')) continue
      if (seen.has(file.path)) continue
      seen.add(file.path)
      const ext = extname(file.path).toLowerCase()
      if (BINARY_EXTENSIONS.includes(ext)) unsupported.push({ path: file.path, ext, bytes: file.bytes })
      else if (!TEXT_EXTENSIONS.includes(ext)) unsupported.push({ path: file.path, ext: ext === '' ? '(无扩展名)' : ext, bytes: file.bytes })
      else files.push({ path: file.path, ext, bytes: file.bytes })
    }
  }
  return { files, unsupported, missing }
}

function guessFormat(text, ext) {
  if (ext === '.jsonl') return 'jsonl'
  if (ext === '.json') return 'json'
  if (ext === '.csv' || ext === '.tsv') return 'csv'
  if (ext === '.html' || ext === '.htm') return 'html'
  if (ext === '.md' || ext === '.markdown') return 'markdown'
  if (ext === '.txt') return /^\s*#+\s/m.test(text) ? 'markdown-ish' : 'plain-text'
  return 'unknown'
}

function sampleOf(text, limit = 1200) {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit)}…` : trimmed
}

/**
 * 扫描阶段（script，机械）：只读、只统计、只给建议，不产出任何知识条目。
 * 输出的是「材料长什么样」——格式、字段出现频次、标题层级、表格列、样例片段，
 * 供 agent 节点决定字段映射；映射错了比抽少了危险得多，所以这一步必须显式。
 */
export function scanKbSources(kbInput) {
  const { files, unsupported, missing } = listKbSources(kbInput)
  const sources = []
  const formats = {}
  for (const file of files) {
    const text = readTextSafe(file.path)
    if (text === undefined) {
      sources.push({ path: file.path, ext: file.ext, bytes: file.bytes, readable: false, format: 'unreadable', notes: ['读取失败（编码或权限）'] })
      continue
    }
    const format = guessFormat(text, file.ext)
    formats[format] = (formats[format] ?? 0) + 1
    const hints = {}
    const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
    if (format === 'jsonl') {
      hints.jsonl_lines = lines.length
      let parsed = 0
      const keyCount = {}
      for (const line of lines.slice(0, 200)) {
        try {
          const row = JSON.parse(line)
          if (isObject(row)) {
            parsed += 1
            for (const key of Object.keys(row)) keyCount[key] = (keyCount[key] ?? 0) + 1
          }
        } catch {
          // 坏行不影响扫描结论，计数会体现
        }
      }
      hints.parsed_rows = parsed
      hints.keys = Object.entries(keyCount).sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }))
    } else if (format === 'json') {
      try {
        const data = JSON.parse(text)
        hints.json_root = Array.isArray(data) ? 'array' : (isObject(data) ? 'object' : typeof data)
        if (Array.isArray(data)) {
          hints.items = data.length
          hints.item_keys = [...new Set(data.slice(0, 100).flatMap((row) => (isObject(row) ? Object.keys(row) : [])))]
        } else if (isObject(data)) {
          hints.top_keys = Object.keys(data)
          for (const [key, value] of Object.entries(data)) {
            if (Array.isArray(value) && value.length > 0 && isObject(value[0])) {
              hints.items_path = key
              hints.items = value.length
              hints.item_keys = [...new Set(value.slice(0, 100).flatMap((row) => Object.keys(row)))]
              break
            }
          }
        }
      } catch {
        hints.json_parse_error = true
      }
    } else if (format === 'csv') {
      const delimiter = file.ext === '.tsv' ? '\t' : ','
      hints.columns = (lines[0] ?? '').split(delimiter).map((cell) => cell.trim()).filter((cell) => cell !== '')
      hints.data_rows = Math.max(0, lines.length - 1)
    } else if (format === 'markdown' || format === 'markdown-ish') {
      const headings = lines.filter((line) => /^\s*#{1,6}\s+/.test(line))
      hints.headings = headings.length
      hints.heading_samples = headings.slice(0, 12).map((line) => line.trim())
    } else if (format === 'html') {
      hints.html_tags = [...text.matchAll(/<([a-zA-Z][a-zA-Z0-9]*)/g)].slice(0, 40).map((match) => match[1].toLowerCase())
      hints.html_headings = (text.match(/<h[1-4][\s>]/gi) ?? []).length
    } else {
      hints.lines = lines.length
      hints.blank_line_blocks = text.split(/\r?\n\s*\r?\n/).filter((block) => block.trim() !== '').length
    }
    sources.push({
      path: file.path,
      ext: file.ext,
      bytes: file.bytes,
      readable: true,
      format,
      role: format === 'json' && looksLikeTermDictionary(text) ? 'term_dictionary' : 'cards',
      hints,
      sample: sampleOf(text),
    })
  }
  const totalBytes = sources.reduce((sum, item) => sum + (item.bytes ?? 0), 0)
  return {
    scanned_at: new Date().toISOString(),
    provided: Array.isArray(kbInput) ? kbInput.length : (nonEmptyText(kbInput) ? 1 : 0),
    files: sources.length,
    total_bytes: totalBytes,
    formats,
    sources,
    unsupported,
    missing,
    notes: [
      '格式多样是常态：jsonl / json 数组 / md 标题分段 / txt 空行分段 / csv 表格 / html 都能对齐；docx、pdf、xlsx 必须先导出为文本（不假装能读二进制）。',
      '扫描阶段只统计与取样，不产出条目；字段映射由 agent 节点决定，再交给 apply 阶段机械落盘。',
      '没有提供知识库也是合法输入：此时 apply 阶段产出一份显式的空库 + 缺口声明，让下游「未接入」可审计。',
    ],
  }
}

// ── 解析（机械）：把单个文件解析成「候选记录」 ────────────────────────────────

function stripHtml(text) {
  return text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr|section|article)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function pickField(row, names) {
  for (const name of names) {
    const value = row[name]
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** 材料里「术语词典」这类文件的识别：数组元素普遍带 term 键，且没有正文/标题。 */
function looksLikeTermDictionary(text) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return false
  }
  const rows = Array.isArray(data) ? data : (isObject(data) ? Object.values(data).find((value) => Array.isArray(value)) : undefined)
  if (!Array.isArray(rows) || rows.length === 0) return false
  const objects = rows.filter((row) => isObject(row))
  if (objects.length === 0) return false
  const withTerm = objects.filter((row) => nonEmptyText(row.term)).length
  const withBody = objects.filter((row) => nonEmptyText(row.content) || nonEmptyText(row.title) || nonEmptyText(row.正文) || nonEmptyText(row.标题)).length
  return withTerm / objects.length >= 0.8 && withBody / objects.length < 0.2
}

/** 可移植的来源路径：优先相对当前目录，其次文件名（绝对路径不进知识库产物）。 */
function portablePath(path) {
  const rel = relTo(process.cwd(), path)
  return rel.startsWith('..') ? basename(path) : rel.replace(/\\/g, '/')
}

function recordFromRow(row, source, fieldMap, line) {
  const title = pickField(row, fieldMap.title)
  const content = pickField(row, fieldMap.content)
  if (title === '' && content === '') return undefined
  const keywordsRaw = fieldMap.keywords.map((key) => row[key]).find((value) => Array.isArray(value) || typeof value === 'string')
  const keywords = Array.isArray(keywordsRaw)
    ? keywordsRaw.map(String).filter((word) => word.trim() !== '')
    : (typeof keywordsRaw === 'string' ? keywordsRaw.split(/[,，、;；\s]+/).filter((word) => word.trim() !== '') : [])
  return {
    title: title !== '' ? title : content.slice(0, 24),
    content: content !== '' ? content : title,
    sections: isObject(row.sections) ? row.sections : undefined,
    keywords,
    raw_id: pickField(row, fieldMap.id),
    raw_institution: fieldMap.institution_fact.map((key) => row[key]).find((value) => value === true || value === 'true' || value === '是'),
    raw_review_status: pickField(row, fieldMap.review_status),
    source: { file: source.path, line: line ?? null, format: source.format },
  }
}

function parseJsonl(text, source, fieldMap) {
  const records = []
  const issues = []
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return
    let row
    try {
      row = JSON.parse(line)
    } catch {
      issues.push({ file: source.path, line: index + 1, reason: '不是合法 JSON，整行跳过（原文保留在源文件里，未进库）' })
      return
    }
    if (!isObject(row)) {
      issues.push({ file: source.path, line: index + 1, reason: '该行不是对象，跳过' })
      return
    }
    const record = recordFromRow(row, source, fieldMap, index + 1)
    if (record === undefined) issues.push({ file: source.path, line: index + 1, reason: '既没有标题也没有正文，跳过' })
    else records.push(record)
  })
  return { records, issues }
}

function parseJson(text, source, fieldMap) {
  let data
  try {
    data = JSON.parse(text)
  } catch {
    return { records: [], issues: [{ file: source.path, reason: 'JSON 解析失败，跳过（不做「尽力猜」）' }] }
  }
  let rows = []
  if (Array.isArray(data)) rows = data
  else if (isObject(data)) {
    const candidate = Object.values(data).find((value) => Array.isArray(value) && value.length > 0 && isObject(value[0]))
    if (Array.isArray(candidate)) rows = candidate
    else rows = [data]
  }
  const records = []
  const issues = []
  for (const [index, row] of rows.entries()) {
    if (!isObject(row)) {
      issues.push({ file: source.path, anchor: `#${index}`, reason: '数组元素不是对象，跳过' })
      continue
    }
    const record = recordFromRow(row, source, fieldMap, null)
    if (record === undefined) issues.push({ file: source.path, anchor: `#${index}`, reason: '既没有标题也没有正文，跳过' })
    else records.push(record)
  }
  return { records, issues }
}

function parseCsv(text, source, fieldMap) {
  const delimiter = source.ext === '.tsv' ? '\t' : ','
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  if (lines.length === 0) return { records: [], issues: [] }
  const header = lines[0].split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, ''))
  const records = []
  const issues = []
  for (let index = 1; index < lines.length; index += 1) {
    const cells = lines[index].split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, ''))
    if (cells.every((cell) => cell === '')) continue
    const row = Object.fromEntries(header.map((key, position) => [key, cells[position] ?? '']))
    const record = recordFromRow(row, source, fieldMap, index + 1)
    if (record === undefined) issues.push({ file: source.path, line: index + 1, reason: '整行都是空值，跳过' })
    else records.push(record)
  }
  return { records, issues }
}

function parseMarkdown(text, source, fieldMap) {
  const lines = text.split(/\r?\n/)
  const records = []
  const issues = []
  const headingPattern = /^(#{1,6})\s+(.+?)\s*$/
  const chunks = []
  let current = null
  for (const line of lines) {
    const match = line.match(headingPattern)
    if (match !== null) {
      if (current !== null) chunks.push(current)
      current = { level: match[1].length, title: match[2].trim(), body: [] }
      continue
    }
    if (current === null) current = { level: 0, title: '', body: [] }
    current.body.push(line)
  }
  if (current !== null) chunks.push(current)
  // 只有一级标题且正文很长时，把二级标题当作条目边界（多文档合并的 md 常见）
  const levels = chunks.filter((chunk) => chunk.title !== '').map((chunk) => chunk.level)
  const splitLevel = levels.length > 0 ? Math.min(...levels) + (levels.filter((level) => level === Math.min(...levels)).length === 1 ? 1 : 0) : 0
  for (const chunk of chunks) {
    const bodyText = chunk.body.join('\n').trim()
    if (chunk.title === '' && bodyText === '') continue
    if (chunk.level > 0 && splitLevel > 0 && chunk.level > splitLevel) {
      // 更深层级并入上一条的正文
      const last = records[records.length - 1]
      if (last !== undefined) {
        last.content += `\n\n${chunk.title}\n${bodyText}`.trim()
        continue
      }
    }
    if (chunk.title === '') {
      issues.push({ file: source.path, reason: '无标题的正文块（可能是文档前言），未成条目', preview: bodyText.slice(0, 80) })
      continue
    }
    if (bodyText === '') {
      // 只有标题没有正文（常见于「一级标题 + 二级小节」的文档）：不产空条目，记为未对齐
      issues.push({ file: source.path, anchor: `#${chunk.title}`, reason: '只有标题没有正文，未成条目（其子小节已单独成条）' })
      continue
    }
    records.push({
      title: chunk.title,
      content: bodyText,
      sections: undefined,
      keywords: [],
      raw_id: '',
      raw_institution: undefined,
      raw_review_status: '',
      source: { file: source.path, anchor: `#${chunk.title}`, format: source.format },
    })
  }
  return { records, issues }
}

function parsePlainText(text, source) {
  const blocks = text.split(/\r?\n\s*\r?\n/).filter((block) => block.trim() !== '')
  const records = []
  const issues = []
  if (blocks.length === 1) {
    issues.push({ file: source.path, reason: '整份文件只有一个文字块，无法切成条目；已标为「未对齐」，请在 kb_plan 里指定切分规则或人工分段' })
    return { records, issues }
  }
  for (const [index, block] of blocks.entries()) {
    const firstLine = block.split(/\r?\n/)[0].trim()
    const rest = block.split(/\r?\n/).slice(1).join('\n').trim()
    records.push({
      title: rest === '' ? `第 ${index + 1} 段` : firstLine.slice(0, 40),
      content: rest === '' ? block.trim() : rest,
      sections: undefined,
      keywords: [],
      raw_id: '',
      raw_institution: undefined,
      raw_review_status: '',
      source: { file: source.path, anchor: `段 ${index + 1}`, format: source.format },
    })
  }
  return { records, issues }
}

/** 解析一个源文件成候选记录（纯机械；字段映射由 plan 决定）。 */
export function parseSource(source, fieldMap, cache = new Map()) {
  let text = cache.get(source.path)
  if (text === undefined) {
    text = readTextSafe(source.path)
    cache.set(source.path, text)
  }
  if (text === undefined) return { records: [], issues: [{ file: source.path, reason: '读取失败' }] }
  const format = source.format ?? guessFormat(text, source.ext)
  if (format === 'jsonl') return parseJsonl(text, { ...source, format }, fieldMap)
  if (format === 'json') return parseJson(text, { ...source, format }, fieldMap)
  if (format === 'csv') return parseCsv(text, { ...source, format }, fieldMap)
  if (format === 'html') return parseMarkdown(stripHtml(text), { ...source, format }, fieldMap)
  if (format === 'markdown' || format === 'markdown-ish') return parseMarkdown(text, { ...source, format }, fieldMap)
  return parsePlainText(text, { ...source, format })
}

// ── 计划（agent 给）与落盘（script 做） ─────────────────────────────────────

export const DEFAULT_FIELD_MAP = {
  id: ['id', 'ID', '编号', '条目ID', 'card_id'],
  title: ['title', '标题', '名称', 'name', '主题', '项目名'],
  content: ['content', 'retrieval_text', '正文', '内容', 'description', 'answer', '说明', 'text'],
  keywords: ['keywords', '关键词', 'tags', '标签'],
  institution_fact: ['institution_fact', 'is_institution_fact', '机构事实'],
  review_status: ['review_status', '审核状态', 'status'],
}

/** 给 agent 的建议计划（骨架）：字段猜测 + 默认策略，agent 可以改。 */
export function suggestPlan(scan) {
  const fieldMap = { ...DEFAULT_FIELD_MAP }
  const seenKeys = new Set()
  for (const source of scan.sources ?? []) {
    for (const key of source.hints?.item_keys ?? []) seenKeys.add(key)
    for (const item of source.hints?.keys ?? []) seenKeys.add(item.key)
  }
  const pick = (candidates) => candidates.filter((key) => seenKeys.has(key))
  const idCandidates = pick(fieldMap.id)
  return {
    // 材料自带编号时**保留原 id**（from_field）：这样既有的术语词典/引用不会因为对齐而悬空；
    // 没有编号的材料（md/txt 标题）才用 seq。
    id_strategy: idCandidates.length > 0 ? 'from_field' : 'seq',
    id_prefix: 'K',
    field_map: {
      id: pick(fieldMap.id),
      title: pick(fieldMap.title),
      content: pick(fieldMap.content),
      keywords: pick(fieldMap.keywords),
      institution_fact: pick(fieldMap.institution_fact),
      review_status: pick(fieldMap.review_status),
    },
    section_split: 'auto',
    review_status_default: 'draft_needs_professional_review',
    institution_fact_handling: 'separate_file',
    institution_facts: [],
    term_rules: { from_titles: true, from_keywords: true, extra: [] },
    gaps: [],
    questions: [],
    notes: [],
    observed_keys: [...seenKeys].sort(),
  }
}

function slugify(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
}

function composeRetrievalText(entry) {
  const parts = [entry.title]
  if (entry.content && entry.content !== entry.title) parts.push(`知识内容：${entry.content}`)
  if (isObject(entry.sections)) for (const [key, value] of Object.entries(entry.sections)) parts.push(`${key}：${value}`)
  if (entry.keywords.length > 0) parts.push(`关键词：${entry.keywords.join('、')}`)
  return parts.filter((part) => nonEmptyText(part)).join('\n')
}

/**
 * apply 阶段：按 plan 把候选记录落成统一格式的知识库。
 * 全程机械：id 策略、字段映射、机构事实拆分、术语词典、源映射、报告、问题清单。
 */
export function applyKbPlan({ plan, scan, outDir, industryName = '', version = '1.0' }) {
  const kbDir = join(outDir, KB_DIR_NAME)
  mkdirSync(join(kbDir, '02_结构化数据'), { recursive: true })
  mkdirSync(join(kbDir, '06_机构资料接入'), { recursive: true })

  const safePlan = isObject(plan) ? plan : {}
  const fieldMap = isObject(safePlan.field_map) ? safePlan.field_map : DEFAULT_FIELD_MAP
  const normalizedMap = {
    id: Array.isArray(fieldMap.id) && fieldMap.id.length > 0 ? fieldMap.id.map(String) : DEFAULT_FIELD_MAP.id,
    title: Array.isArray(fieldMap.title) && fieldMap.title.length > 0 ? fieldMap.title.map(String) : DEFAULT_FIELD_MAP.title,
    content: Array.isArray(fieldMap.content) && fieldMap.content.length > 0 ? fieldMap.content.map(String) : DEFAULT_FIELD_MAP.content,
    keywords: Array.isArray(fieldMap.keywords) && fieldMap.keywords.length > 0 ? fieldMap.keywords.map(String) : DEFAULT_FIELD_MAP.keywords,
    institution_fact: Array.isArray(fieldMap.institution_fact) && fieldMap.institution_fact.length > 0 ? fieldMap.institution_fact.map(String) : DEFAULT_FIELD_MAP.institution_fact,
    review_status: Array.isArray(fieldMap.review_status) && fieldMap.review_status.length > 0 ? fieldMap.review_status.map(String) : DEFAULT_FIELD_MAP.review_status,
  }
  const reviewStatusDefault = nonEmptyText(safePlan.review_status_default) ? String(safePlan.review_status_default) : 'draft_needs_professional_review'
  const idStrategy = nonEmptyText(safePlan.id_strategy) ? String(safePlan.id_strategy) : 'seq'
  const idPrefix = nonEmptyText(safePlan.id_prefix) ? String(safePlan.id_prefix) : 'K'
  const institutionHandling = nonEmptyText(safePlan.institution_fact_handling) ? String(safePlan.institution_fact_handling) : 'separate_file'

  const parsedRecords = []
  const issues = []
  const cache = new Map()
  // 二进制/不支持的格式不解析，但必须进「未对齐」清单——否则报告会看起来像「全都对上了」。
  for (const item of scan.unsupported ?? []) {
    issues.push({ file: item.path, reason: `不支持的材料格式（${item.ext}）：需先导出为 txt / md / json / jsonl 后再对齐` })
  }
  for (const path of scan.missing ?? []) {
    issues.push({ file: path, reason: '路径不存在，未参与对齐' })
  }
  // 术语词典单独处理：它是「正确写法」的权威来源，不该被当成知识条目解析，
  // 否则会产出一堆「既没有标题也没有正文」的噪声（真实材料里就是这么一份 85 条的词典）。
  const materialTerms = []
  for (const source of scan.sources ?? []) {
    if (source.role !== 'term_dictionary') continue
    let data
    try {
      data = JSON.parse(readFileSync(source.path, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      issues.push({ file: source.path, reason: '术语词典解析失败，未纳入' })
      continue
    }
    const rows = Array.isArray(data) ? data : Object.values(data).find((value) => Array.isArray(value))
    if (!Array.isArray(rows)) continue
    let taken = 0
    for (const row of rows) {
      if (!isObject(row) || !nonEmptyText(row.term)) continue
      const related = row.related_card_id ?? row.card ?? row.card_id ?? ''
      materialTerms.push({
        term: String(row.term).trim(),
        related_card_id: nonEmptyText(related) ? String(related).trim() : '',
        resolution_status: nonEmptyText(row.resolution_status) ? String(row.resolution_status).trim() : 'candidate_term',
        normalized_candidate: nonEmptyText(row.normalized_candidate) ? String(row.normalized_candidate).trim() : '',
      })
      taken += 1
    }
    if (taken === 0) issues.push({ file: source.path, reason: '术语词典里没有可用 term 字段，未纳入' })
  }
  for (const source of scan.sources ?? []) {
    if (source.role === 'term_dictionary') continue
    if (source.readable === false) {
      issues.push({ file: source.path, reason: '源文件不可读，未参与对齐' })
      continue
    }
    const parsed = parseSource(source, normalizedMap, cache)
    for (const issue of parsed.issues) issues.push(issue)
    for (const record of parsed.records) parsedRecords.push(record)
  }

  const entries = []
  const institutionFacts = []
  const conflicts = []
  const seenIds = new Map()
  const rawIdToId = new Map()
  let sequence = 0
  for (const record of parsedRecords) {
    sequence += 1
    let id = ''
    if (idStrategy === 'seq') id = `${idPrefix}${String(sequence).padStart(3, '0')}`
    else if (idStrategy === 'slug') id = slugify(record.raw_id !== '' ? record.raw_id : record.title) || `${idPrefix}${String(sequence).padStart(3, '0')}`
    else if (idStrategy === 'from_field' && nonEmptyText(record.raw_id)) id = String(record.raw_id).trim()
    else if (idStrategy === 'title_hash') id = `${idPrefix}${slugify(record.title).slice(0, 16) || String(sequence).padStart(3, '0')}`
    else id = `${idPrefix}${String(sequence).padStart(3, '0')}`
    const isInstitution = institutionHandling === 'separate_file'
      && (record.raw_institution === true || (institutionHandling === 'separate_file' && safePlan.institution_facts?.includes?.(id)))
    const reviewStatus = nonEmptyText(record.raw_review_status) ? String(record.raw_review_status).trim() : reviewStatusDefault
    const entry = {
      id,
      title: record.title,
      content: record.content,
      sections: record.sections,
      keywords: record.keywords,
      category: nonEmptyText(safePlan.category) ? String(safePlan.category) : (nonEmptyText(industryName) ? industryName : ''),
      version,
      review_status: reviewStatus,
      institution_fact: isInstitution,
      source_ref: { file: portablePath(record.source.file), anchor: record.source.anchor ?? (record.source.line === null ? '' : `行 ${record.source.line}`) },
      origin: 'bootstrap-industry-config',
    }
    entry.retrieval_text = composeRetrievalText(entry)
    entry.citation_label = `${id}@${version}`

    if (isInstitution) {
      institutionFacts.push(entry)
      continue
    }
    const previous = seenIds.get(id)
    if (previous !== undefined) {
      if (previous.content === entry.content && previous.title === entry.title) {
        issues.push({ file: entry.source_ref.file, reason: `与已有条目 ${id} 完全相同，已合并（重复材料）` })
      } else {
        conflicts.push({ id, kept_title: previous.title, kept_source: previous.source_ref, dropped_title: entry.title, dropped_source: entry.source_ref })
        issues.push({ file: entry.source_ref.file, reason: `与已有条目 ${id} 正文不同，保留首条、冲突已记录（不静默取最后一条）` })
      }
      continue
    }
    seenIds.set(id, entry)
    if (nonEmptyText(record.raw_id)) rawIdToId.set(String(record.raw_id).trim(), id)
    entries.push(entry)
  }

  // 术语词典：材料自带的词典优先（它才是「正确写法」的权威来源），再补标题/关键词派生，
  // 最后并入 plan.term_rules.extra（agent 的显式补充）。
  const termRules = isObject(safePlan.term_rules) ? safePlan.term_rules : {}
  const terms = []
  const termSeen = new Set()
  const addTerm = (term, cardId, status = 'candidate_term') => {
    const text = String(term ?? '').trim()
    if (text.length < 2) return
    const card = nonEmptyText(cardId) ? String(cardId).trim() : null
    const key = `${text}→${card ?? ''}`
    if (termSeen.has(key)) return
    termSeen.add(key)
    terms.push({ term: text, related_card_id: card, resolution_status: status })
  }
  for (const item of materialTerms) {
    // 材料词典里的 related_card_id 往往指向**源知识库**的 id；对齐后 id 可能变了（seq 策略），
    // 这里按「源 id → 对齐后 id」重映射，避免术语悬空到不存在的卡片上。
    let card = item.related_card_id
    if (nonEmptyText(card)) {
      const mapped = rawIdToId.get(String(card).trim())
      if (mapped !== undefined) card = mapped
      else if (!seenIds.has(String(card).trim())) {
        issues.push({ file: '术语词典', reason: `术语「${item.term}」指向的卡片 ${card} 在本次对齐结果里不存在：已保留术语但清空卡片指向，需人工核对` })
        card = ''
      }
    }
    addTerm(item.term, card, item.resolution_status)
  }
  /** 标题派生的术语去掉章节编号前缀（「Q37　客户要求…」→「客户要求…」），标题本身不改。 */
  const stripNumberPrefix = (text) => String(text ?? '').replace(/^[A-Za-z]{0,3}\d{1,4}[.、　 ]+/, '').trim()
  if (termRules.from_titles !== false) for (const entry of entries) addTerm(stripNumberPrefix(entry.title), entry.id, 'confirmed')
  if (termRules.from_keywords !== false) for (const entry of entries) for (const word of entry.keywords) addTerm(word, entry.id, 'candidate_term')
  for (const extra of Array.isArray(termRules.extra) ? termRules.extra : []) {
    if (isObject(extra)) addTerm(extra.term, extra.related_card_id, extra.resolution_status ?? 'candidate_term')
  }
  terms.sort((a, b) => b.term.length - a.term.length)

  const fieldsComplete = entries.filter((entry) => nonEmptyText(entry.title) && nonEmptyText(entry.content)).length
  const draftCount = entries.filter((entry) => String(entry.review_status).startsWith('draft')).length

  // 同标题不同 id：常见于「同一份问答既有 jsonl 又有 md 版本」。不自动合并（宁少勿多），
  // 但必须在报告与问题清单里点名——否则下游会把两份当两张不同的卡引用。
  const titleKey = (text) => String(text ?? '').replace(/^[A-Za-z]{0,3}\d{1,4}[.、　 ]+/, '').replace(/[\s　]/g, '').toLowerCase()
  const byTitle = new Map()
  for (const entry of entries) {
    const key = titleKey(entry.title)
    if (key === '') continue
    byTitle.set(key, [...(byTitle.get(key) ?? []), entry.id])
  }
  const duplicateTitles = [...byTitle.entries()].filter(([, ids]) => ids.length > 1).map(([key, ids]) => ({ key, ids }))

  const writeJson = (rel, data) => writeFileSync(join(kbDir, rel), `${JSON.stringify(data, null, 2)}\n`, 'utf8')
  writeFileSync(join(kbDir, KB_FILES.entries), entries.map((entry) => JSON.stringify(entry)).join('\n') + (entries.length > 0 ? '\n' : ''), 'utf8')
  writeJson(KB_FILES.terms, terms)
  writeJson(KB_FILES.institutionFacts, {
    version,
    valid_until: '',
    source_doc: institutionFacts.length > 0 ? 'bootstrap-industry-config 抽取（待业务方补有效期与出处）' : '',
    _note: '机构价目/资质/排期只登记在这里，不得写进行业知识条目；金额必须带币种/单位/包含项/出处，且必须有 valid_until。',
    items: institutionFacts.map((entry) => ({
      item_id: entry.id,
      title: entry.title,
      content: entry.content,
      amount: null,
      currency: '',
      unit: '',
      includes: [],
      source_doc: entry.source_ref.file,
      valid_until: '',
    })),
  })
  writeJson(KB_FILES.sourceMap, {
    generated_at: new Date().toISOString(),
    plan: {
      id_strategy: idStrategy,
      id_prefix: idPrefix,
      review_status_default: reviewStatusDefault,
      institution_fact_handling: institutionHandling,
    },
    entries: [...entries, ...institutionFacts].map((entry) => ({ id: entry.id, ...entry.source_ref })),
    terms: terms.map((term) => ({ term: term.term, related_card_id: term.related_card_id })),
  })

  const report = [
    `# 知识库对齐报告${nonEmptyText(industryName) ? `（${industryName}）` : ''}`,
    '',
    '> 本报告由「行业配置冷启动」的 kb-scan → kb-align → kb-apply 三段产出。它是**草稿态**：条目多为待签审的行业整理，引用不等于专业审核通过。',
    '',
    '## 一、材料',
    '',
    `- 用户提供：${scan.provided ?? 0} 个输入（文件或目录），可解析文件 ${scan.files ?? 0} 个、合计 ${scan.total_bytes ?? 0} 字节`,
    `- 格式分布：${Object.entries(scan.formats ?? {}).map(([key, count]) => `${key}×${count}`).join('、') || '无'}`,
    `- 不支持/未解析：${(scan.unsupported ?? []).length} 个（${(scan.unsupported ?? []).map((item) => `${basename(item.path)}（${item.ext}）`).join('、') || '无'}）`,
    `- 路径不存在：${(scan.missing ?? []).length} 个${(scan.missing ?? []).length > 0 ? `（${scan.missing.join('、')}）` : ''}`,
    '',
    '## 二、产出',
    '',
    `| 项 | 数 |`,
    `| --- | --- |`,
    `| 行业知识条目 | ${entries.length} |`,
    `| 其中字段齐全（标题+正文） | ${fieldsComplete} / ${entries.length} |`,
    `| 待签审条目（review_status=draft_*） | ${draftCount} / ${entries.length} |`,
    `| 机构事实（已拆出，不进行业层） | ${institutionFacts.length} |`,
    `| 术语词典条目 | ${terms.length}（其中来自材料自带词典 ${materialTerms.length}） |`,
    `| 未对齐材料/坏行 | ${issues.length} |`,
    `| 同 ID 正文冲突 | ${conflicts.length} |`,
    `| 同标题不同 id（疑似重复收录） | ${duplicateTitles.length} |`,
    '',
    '## 三、未对齐与冲突（需人看一眼）',
    '',
    issues.length === 0
      ? '- 无'
      : [...issues.reduce((map, item) => {
          // 同一文件同一原因聚合成一条，避免一份 85 条的材料刷满整个章节
          const name = basename(String(item.file ?? ''))
          const key = `${name}|${item.reason}`
          const bucket = map.get(key) ?? { name, reason: item.reason, count: 0, lines: [] }
          bucket.count += 1
          if (item.line !== undefined && bucket.lines.length < 5) bucket.lines.push(item.line)
          map.set(key, bucket)
          return map
        }, new Map()).values()].map((bucket) => `- ${bucket.name}${bucket.count > 1 ? `（${bucket.count} 处）` : ''}${bucket.lines.length > 0 ? `，例：第 ${bucket.lines.join('、')} 行` : ''}：${bucket.reason}`).join('\n'),
    conflicts.length === 0 ? '' : ['', '### 同 ID 冲突（保留首条）', '', ...conflicts.map((item) => `- ${item.id}：保留「${item.kept_title}」（${basename(String(item.kept_source.file))}），丢弃「${item.dropped_title}」（${basename(String(item.dropped_source.file))}）`)].join('\n'),
    '',
    '## 四、缺口（下游必须显式声明，不得拿相邻条目顶替）',
    '',
    (Array.isArray(safePlan.gaps) && safePlan.gaps.length > 0 ? safePlan.gaps.map((gap) => `- ${typeof gap === 'string' ? gap : gap.topic ?? '未命名缺口'}${isObject(gap) && nonEmptyText(gap.why_missing) ? `：${gap.why_missing}` : ''}`).join('\n') : '- 无（若材料本身就不覆盖某些主题，请在这里补上，而不是让下游去猜）'),
    '',
    '## 五、下一步',
    '',
    '1. 业务方核对 `kb-open-questions.md` 里的问题（字段映射、机构事实、是否补材料）。',
    '2. 需要更准的条目切分时：带 `kb_draft`（本轮的 plan）+ 新的 `knowledge_base` 再跑一轮，只改 plan，不重抽转录。',
    '3. 这份知识库留在工作目录，通用版 `sales-brief-generic` 会**自动发现**它（候选路径见其 references/overview.md），不需要拷进技能包。',
    '',
  ].filter((line) => line !== undefined).join('\n')
  writeFileSync(join(kbDir, KB_FILES.report), report, 'utf8')

  const planQuestions = Array.isArray(safePlan.questions) ? safePlan.questions.filter((item) => nonEmptyText(item)).map(String) : []
  const issueQuestions = []
  for (const item of scan.unsupported ?? []) {
    issueQuestions.push(`材料 \`${basename(item.path)}\`（${item.ext}）不是可解析的文本格式：请导出为 txt / md / json / jsonl 后重跑，或人工确认是否需要纳入知识库。`)
  }
  for (const item of scan.missing ?? []) {
    issueQuestions.push(`路径 \`${item}\` 不存在：请确认是路径写错，还是这份材料暂时不提供。`)
  }
  if ((scan.files ?? 0) === 0 && (scan.provided ?? 0) === 0) {
    issueQuestions.push('本次**没有提供任何知识库材料**：是「暂时没有知识库」还是「漏传了」？没有知识库时，销售简报里的行业解释只能来自转录原话与工作流。')
  }
  if (institutionFacts.length > 0) {
    issueQuestions.push(`检测到 ${institutionFacts.length} 条疑似机构事实（价目/资质/排期）已拆到 \`06_机构资料接入/机构事实录入模板.json\`：请补金额的币种 / 单位 / 包含项 / 出处与 \`valid_until\`，否则它们不能当报价用。`)
  }
  if (entries.length > 0 && terms.length === 0) {
    issueQuestions.push('没有从标题/关键词派生出资质术语：如果行业里有固定的项目名/品牌名写法，请提供一份正确写法清单（它才是唯一权威，误写不该入库）。')
  }
  for (const conflict of conflicts) {
    issueQuestions.push(`同 ID 冲突 \`${conflict.id}\` 保留了「${conflict.kept_title}」：请确认是否要改成两份不同 id，或直接删掉过时的那份。`)
  }
  for (const dup of duplicateTitles.slice(0, 5)) {
    issueQuestions.push(`同标题不同 id：\`${dup.ids.join('、')}\` 标题相同（疑似同一张卡被收录了两次，例如 jsonl 与 md 各有一份）：保留哪一份、另一份是否删除？`)
  }
  const questions = [...new Set([...planQuestions, ...issueQuestions])].slice(0, 12)
  const questionsBody = [
    `# 知识库对齐 · 待确认问题（第 ${safePlan.round ?? 1} 轮）`,
    '',
    questions.length === 0 ? '- 本轮没有必须由业务方回答的问题。' : questions.map((question, index) => `${index + 1}. ${question}`).join('\n'),
    '',
    '> 这些问题的共同点：**只读材料看不出来，但不回答就定不了稿**。回答后请带 `kb_answers`（或直接在下一轮的 `kb_draft` 里改 plan）重跑一轮。',
    '',
  ].join('\n')
  writeFileSync(join(kbDir, KB_FILES.questions), questionsBody, 'utf8')

  writeFileSync(
    join(kbDir, KB_FILES.readme),
    [
      '# 行业知识库（由「行业配置冷启动」对齐产出）',
      '',
      '统一格式（与通用版 sales-brief-generic 的约定一致）：',
      '',
      '```',
      '02_结构化数据/知识条目.jsonl                 # 每行一条：id/title/content/keywords/review_status/institution_fact/retrieval_text',
      '02_结构化数据/术语与转录纠错词典.json         # [{term, related_card_id, resolution_status}]，只登记正确写法',
      '06_机构资料接入/机构事实录入模板.json         # 机构价目/资质/排期（不得混进行业条目）',
      'kb-source-map.json                         # 每条条目来自哪个源文件的哪一处',
      'kb-report.md                               # 计数/未对齐/冲突/缺口',
      'kb-open-questions.md                       # 只能由业务方确认的问题',
      '```',
      '',
      '注意：本目录是**草稿态**知识库，条目多为待签审的行业整理；引用它不等于专业审核通过。',
      '下一步：核对 kb-open-questions.md → 需要更准的切分就带 `kb_draft` 再跑一轮 → 通用版 run 会自动发现本目录。',
      '',
    ].join('\n'),
    'utf8',
  )

  return {
    kb_dir: kbDir,
    entries: entries.length,
    institution_facts: institutionFacts.length,
    terms: terms.length,
    issues: issues.length,
    conflicts: conflicts.length,
    fields_complete: fieldsComplete,
    draft_entries: draftCount,
    report_path: join(kbDir, KB_FILES.report),
    questions_path: join(kbDir, KB_FILES.questions),
    source_map_path: join(kbDir, KB_FILES.sourceMap),
    questions,
    empty: entries.length === 0,
  }
}

/**
 * 没有提供知识库时的显式空库：让下游的「未接入」可审计，而不是看起来像接了。
 */
export function writeEmptyKb({ outDir, industryName = '', reason = '用户未提供知识库材料' }) {
  const kbDir = join(outDir, KB_DIR_NAME)
  mkdirSync(join(kbDir, '02_结构化数据'), { recursive: true })
  writeFileSync(join(kbDir, KB_FILES.entries), '', 'utf8')
  writeFileSync(join(kbDir, KB_FILES.terms), '[]\n', 'utf8')
  writeFileSync(
    join(kbDir, KB_FILES.report),
    [
      `# 知识库对齐报告${nonEmptyText(industryName) ? `（${industryName}）` : ''}`,
      '',
      `- 结论：**本次没有可用知识库**（${reason}）。`,
      '- 已产出显式空库目录：下游 run 会判定为「未接入」，页面不含任何知识依据——这不是失败，是如实。',
      '- 判据是「能读出 ≥1 条 id 合法条目」：这个空目录不会被下游当成「已接入」，它只是把「没有」落成可审计的产物。',
      '- 行业解释此时只能来自：转录原话 + 工作流；需要知识依据时请提供材料后重跑一轮冷启动。',
      '',
    ].join('\n'),
    'utf8',
  )
  writeFileSync(join(kbDir, KB_FILES.questions), `# 知识库对齐 · 待确认问题\n\n1. 本次没有提供知识库材料：是「暂时没有」还是「漏传了」？\n2. 若行业里有固定的项目名/品牌名正确写法清单，建议提供（误写不该进知识库）。\n`, 'utf8')
  writeFileSync(join(kbDir, KB_FILES.readme), `# 行业知识库（空）\n\n${reason}。占位目录，供下游显式判定「未接入」。\n`, 'utf8')
  writeFileSync(join(kbDir, KB_FILES.sourceMap), `${JSON.stringify({ entries: [], note: reason }, null, 2)}\n`, 'utf8')
  const questions = [
    '本次没有提供知识库材料：是「暂时没有知识库」还是「漏传了」？没有知识库时，销售简报里的行业解释只能来自转录原话与工作流。',
    '若行业里有固定的项目名/品牌名正确写法清单，建议提供一份（误写不该进知识库；正确写法才是唯一权威）。',
  ]
  return { kb_dir: kbDir, entries: 0, terms: 0, institution_facts: 0, issues: 0, conflicts: 0, report_path: join(kbDir, KB_FILES.report), questions_path: join(kbDir, KB_FILES.questions), source_map_path: join(kbDir, KB_FILES.sourceMap), questions, empty: true }
}

/** 供 agent 节点读的扫描摘要（人/agent 都看得懂的一段文字）。 */
export function describeScan(scan) {
  const lines = []
  lines.push(`材料 ${scan.provided ?? 0} 个输入 / 可解析 ${scan.files ?? 0} 个文件 / 合计 ${scan.total_bytes ?? 0} 字节`)
  lines.push(`格式分布：${Object.entries(scan.formats ?? {}).map(([key, count]) => `${key}×${count}`).join('、') || '无'}`)
  for (const source of (scan.sources ?? []).slice(0, 20)) {
    const hintParts = []
    const hints = source.hints ?? {}
    if (hints.jsonl_lines !== undefined) hintParts.push(`${hints.jsonl_lines} 行 / 解析成功 ${hints.parsed_rows ?? 0}`)
    if (hints.json_root !== undefined) hintParts.push(`JSON 根=${hints.json_root}${hints.items !== undefined ? ` / 条目 ${hints.items}` : ''}`)
    if (hints.columns !== undefined) hintParts.push(`列=${hints.columns.join('|')}`)
    if (hints.headings !== undefined) hintParts.push(`标题 ${hints.headings} 个`)
    if (hints.blank_line_blocks !== undefined) hintParts.push(`${hints.blank_line_blocks} 个空行分段`)
    if (hints.keys !== undefined) hintParts.push(`字段=${hints.keys.slice(0, 10).map((item) => item.key).join(',')}`)
    if (hints.item_keys !== undefined) hintParts.push(`条目字段=${hints.item_keys.slice(0, 12).join(',')}`)
    lines.push(`- ${basename(source.path)}（${source.format}，${source.bytes} 字节）${hintParts.length > 0 ? ' · ' + hintParts.join(' · ') : ''}`)
  }
  if ((scan.unsupported ?? []).length > 0) lines.push(`不支持/未解析：${(scan.unsupported ?? []).map((item) => `${basename(item.path)}（${item.ext}）`).join('、')}`)
  if ((scan.missing ?? []).length > 0) lines.push(`路径不存在：${(scan.missing ?? []).join('、')}`)
  return lines.join('\n')
}

/** 相对路径（只用于报告里显示，避免把绝对路径写进产物）。 */
export function relTo(base, path) {
  try {
    return relative(base, path) || basename(path)
  } catch {
    return basename(path)
  }
}

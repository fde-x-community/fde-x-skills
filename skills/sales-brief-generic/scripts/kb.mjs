// 知识库接入（v0.8.0-kb 新增，行业无关骨架）
//
// 设计原则（沿用医美专用实现在这一层的结论，但把领域词换成行业配置）：
//   1. 知识库只登记正确写法与卡片边界；「转录说了什么」由 agent 判，脚本只做机械核对。
//   2. 引用必须双可回查：引了哪张卡（kb_refs）+ 那张卡到底说了什么（kb_excerpts.quote）。
//   3. 缺口必须显式、可追、且不得拿相邻卡顶替（kb_gaps.evidence_turns / must_not_use_cards）。
//   4. 不接知识库时禁止出现任何 kb_* 依据（防止把模型常识伪装成企业知识）。
//   5. 索引那一刻的知识库指纹要与分析声明一致（input_binding），但「库变了」本身不是错误——
//      被引卡片正文没变就降级为警告（否则降级通道会被指纹比对彻底遮蔽）。
//
// 所有路径/字段名都从行业配置的 knowledge_base 段读取，换行业不用改本文件。

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const KB_DEFAULTS = {
  label: '行业知识库',
  // 企业知识库的既定目录约定：02_结构化数据/知识条目.jsonl（每行一条，至少要有 id）
  entry_files: ['02_结构化数据/知识条目.jsonl'],
  // 找不到上面的文件时，递归找匹配这个正则的文件名
  entry_fallback: '知识条目.*\\.jsonl$',
  terms_file: '02_结构化数据/术语与转录纠错词典.json',
  // 卡片正文由哪些字段拼成（按顺序取第一个非空的，再并入 sections 的每一条）
  text_fields: ['retrieval_text', 'content'],
  sections_field: 'sections',
  title_field: 'title',
  keywords_field: 'keywords',
  institution_fact_field: 'institution_fact',
  review_status_field: 'review_status',
  // 同音/误写提示：行业无关骨架不自带词表，由行业配置补 [{wrong, right, severity, basis}]
  confusables: [],
  // 引用片段「几乎无共同实词」的判据：汉字交集 ≤ 该值 → 警告（疑似装饰性引用）
  decorative_shared_chars: 1,
  // 知识库目录：与「词表配置」同构——行业配置可以声明库在哪（一个或多个，相对路径以运行目录为基准），
  // 这样换行业/换库不用改输入参数；显式 knowledge_base_dir 仍然优先。
  dirs: [],
}

/** 合并行业配置里的 knowledge_base 段与默认值。 */
export function kbConfig(industryConfig) {
  const raw = industryConfig && typeof industryConfig === 'object' && industryConfig.knowledge_base
  const cfg = raw && typeof raw === 'object' ? raw : {}
  const pick = (key, fallback, valid) => (valid(cfg[key]) ? cfg[key] : fallback)
  const dirsRaw = Array.isArray(cfg.dirs) ? cfg.dirs : (typeof cfg.dir === 'string' && cfg.dir.trim() !== '' ? [cfg.dir] : [])
  return {
    label: pick('label', KB_DEFAULTS.label, (v) => typeof v === 'string' && v.trim() !== ''),
    entry_files: pick('entry_files', KB_DEFAULTS.entry_files, (v) => Array.isArray(v) && v.length > 0),
    entry_fallback: pick('entry_fallback', KB_DEFAULTS.entry_fallback, (v) => typeof v === 'string' && v.trim() !== ''),
    terms_file: pick('terms_file', KB_DEFAULTS.terms_file, (v) => typeof v === 'string' && v.trim() !== ''),
    text_fields: pick('text_fields', KB_DEFAULTS.text_fields, (v) => Array.isArray(v) && v.length > 0),
    sections_field: pick('sections_field', KB_DEFAULTS.sections_field, (v) => typeof v === 'string'),
    title_field: pick('title_field', KB_DEFAULTS.title_field, (v) => typeof v === 'string' && v.trim() !== ''),
    keywords_field: pick('keywords_field', KB_DEFAULTS.keywords_field, (v) => typeof v === 'string' && v.trim() !== ''),
    institution_fact_field: pick('institution_fact_field', KB_DEFAULTS.institution_fact_field, (v) => typeof v === 'string' && v.trim() !== ''),
    review_status_field: pick('review_status_field', KB_DEFAULTS.review_status_field, (v) => typeof v === 'string' && v.trim() !== ''),
    confusables: pick('confusables', KB_DEFAULTS.confusables, (v) => Array.isArray(v)),
    decorative_shared_chars: pick('decorative_shared_chars', KB_DEFAULTS.decorative_shared_chars, (v) => Number.isInteger(v) && v >= 0),
    dirs: dirsRaw.filter((item) => typeof item === 'string' && item.trim() !== '').map((item) => item.trim()),
  }
}

/** 归一化：去空白 + 全角标点转半角。片段比对一律走这一层，容忍标点差异、不容忍改写。 */
export function normText(text) {
  if (typeof text !== 'string') return ''
  const table = {
    '“': '"', '”': '"', '‘': "'", '’': "'", '「': '"', '」': '"', '『': '"', '』': '"',
    '（': '(', '）': ')', '，': ',', '；': ';', '：': ':', '？': '?', '！': '!', '、': ',', '　': '',
  }
  let out = ''
  for (const ch of text) {
    const mapped = table[ch]
    if (mapped !== undefined) out += mapped
    else if (/\s/.test(ch)) continue
    else out += ch
  }
  return out
}

/** 一条知识记录的「可核对正文」：text_fields 里第一个非空的，再并入 sections 的每一条。 */
export function entryText(rec, cfg = kbConfig()) {
  if (!rec || typeof rec !== 'object') return ''
  const parts = []
  for (const field of cfg.text_fields) {
    const value = rec[field]
    if (typeof value === 'string' && value.trim() !== '') {
      parts.push(value)
      break
    }
  }
  const sections = rec[cfg.sections_field]
  if (sections && typeof sections === 'object' && !Array.isArray(sections)) {
    for (const [key, value] of Object.entries(sections)) {
      if (typeof value === 'string' && value.trim() !== '') parts.push(`${key}：${value}`)
    }
  }
  return parts.join('\n')
}

function walkJsonl(root) {
  const found = []
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
      const full = join(dir, name)
      let stat
      try {
        stat = statSync(full)
      } catch {
        continue
      }
      if (stat.isDirectory()) stack.push(full)
      else if (stat.isFile()) found.push(full)
    }
  }
  return found.sort()
}

/**
 * 读取企业知识库（只读）。目录不存在、或读不出任何条目与术语时返回 null，
 * 由调用方按「未接入 / 显式降级」处理。
 *
 * 指纹 = 对「id:归一化正文的 sha256」按 id 排序后再哈希，用来绑定
 * 「这份分析是照着哪一版知识库写的」。同 id 不同正文 → 记为冲突，不静默取最后一条。
 */
export function loadKb(kbDir, cfg = kbConfig()) {
  if (typeof kbDir !== 'string' || kbDir.trim() === '') return null
  if (!existsSync(kbDir) || !statSync(kbDir).isDirectory()) return null

  const entries = new Map()
  const conflicts = []
  const files = []
  for (const rel of cfg.entry_files) {
    const full = join(kbDir, rel)
    if (existsSync(full) && statSync(full).isFile()) files.push(full)
  }
  if (files.length === 0) {
    const pattern = new RegExp(cfg.entry_fallback)
    for (const full of walkJsonl(kbDir)) if (pattern.test(full)) files.push(full)
  }
  for (const file of files) {
    let raw = ''
    try {
      raw = readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    } catch {
      continue
    }
    for (const line of raw.split(/\r\n|\r|\n/)) {
      if (line.trim() === '') continue
      let row
      try {
        row = JSON.parse(line)
      } catch {
        continue
      }
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue
      const id = row.id
      if (id === undefined || id === null || String(id).trim() === '') continue
      const kid = String(id)
      if (entries.has(kid) && normText(entryText(entries.get(kid), cfg)) !== normText(entryText(row, cfg))) {
        conflicts.push(kid)
        continue
      }
      entries.set(kid, row)
    }
  }

  let terms = []
  const termsPath = join(kbDir, cfg.terms_file)
  if (existsSync(termsPath) && statSync(termsPath).isFile()) {
    try {
      const data = JSON.parse(readFileSync(termsPath, 'utf8').replace(/^\uFEFF/, ''))
      const list = Array.isArray(data) ? data : (Array.isArray(data?.terms) ? data.terms : [])
      terms = list.filter((item) => item && typeof item === 'object' && typeof item.term === 'string' && item.term.trim() !== '')
    } catch {
      terms = []
    }
  }
  if (entries.size === 0 && terms.length === 0) return null

  // 长词优先：命中最长写法时不再重复报短写法，避免「押金」吃掉「住院押金」。
  terms = [...terms].sort((a, b) => b.term.length - a.term.length)
  const texts = new Map()
  for (const [kid, rec] of entries) texts.set(kid, normText(entryText(rec, cfg)))
  const fingerprint = createHash('sha256')
    .update([...texts.keys()].sort().map((kid) => `${kid}:${createHash('sha256').update(texts.get(kid)).digest('hex')}`).join('\n'))
    .digest('hex')
  const cardHashes = Object.fromEntries(
    [...texts.keys()].sort().map((kid) => [kid, createHash('sha256').update(texts.get(kid)).digest('hex').slice(0, 16)]),
  )
  return { dir: kbDir, cfg, entries, terms, texts, fingerprint, cardHashes, conflicts: [...new Set(conflicts)].sort() }
}

/** 可写进索引与输出的知识库摘要。 */
export function kbSummary(kb) {
  if (kb === null || kb === undefined) return { connected: false }
  return {
    connected: true,
    path: kb.dir,
    label: kb.cfg.label,
    records: kb.entries.size,
    terms: kb.terms.length,
    fingerprint: kb.fingerprint.slice(0, 16),
    conflicts: kb.conflicts,
  }
}

/** 卡片正文（归一化后），供引用片段核对。 */
export function entryTextOf(kb, id) {
  return kb !== null && kb !== undefined && kb.texts.has(String(id)) ? kb.texts.get(String(id)) : ''
}

function cardOf(kb, name) {
  if (kb === null || kb === undefined) return null
  if (kb.entries.has(name)) return name
  for (const term of kb.terms) if (term.term === name) return term.related_card_id ?? null
  return null
}

/** 知识库术语的精确命中：只认正确写法，不做任何改写。 */
export function termHits(text, kb) {
  if (kb === null || kb === undefined || typeof text !== 'string' || text === '') return []
  const hits = []
  for (const term of kb.terms) {
    let offset = 0
    for (;;) {
      const found = text.indexOf(term.term, offset)
      if (found < 0) break
      hits.push({
        term: term.term,
        offset: found,
        card: term.related_card_id ?? null,
        normalized_candidate: term.normalized_candidate ?? null,
        status: term.resolution_status ?? null,
      })
      offset = found + term.term.length
    }
  }
  hits.sort((a, b) => a.offset - b.offset || b.term.length - a.term.length)
  return hits
}

/** 行业配置里声明的已知误写提示（只提示，不改写原文）。 */
export function termSuspects(text, kb, cfg = kbConfig()) {
  if (kb === null || kb === undefined || typeof text !== 'string' || text === '') return []
  const out = []
  for (const rule of cfg.confusables) {
    if (!rule || typeof rule.wrong !== 'string' || typeof rule.right !== 'string') continue
    if (rule.wrong === '' || !text.includes(rule.wrong)) continue
    out.push({
      kind: 'confusable',
      text: rule.wrong,
      candidate: rule.right,
      card: cardOf(kb, rule.right),
      severity: typeof rule.severity === 'string' ? rule.severity : 'medium',
      basis: typeof rule.basis === 'string' ? rule.basis : '',
      note: `「${rule.wrong}」疑为「${rule.right}」的转录误写；原话保留，不自动改写（术语三态：判 candidate）`,
    })
  }
  return out
}

/** 最长公共连续子串长度（只用于「缺口是否已过期」的粗判，不做语义判断）。 */
export function lcsLen(a, b) {
  const left = String(a ?? '')
  const right = String(b ?? '')
  if (left === '' || right === '') return 0
  let best = 0
  let prev = new Array(right.length + 1).fill(0)
  for (const ch of left) {
    const cur = new Array(right.length + 1).fill(0)
    for (let j = 1; j <= right.length; j += 1) {
      if (ch === right[j - 1]) {
        cur[j] = prev[j - 1] + 1
        if (cur[j] > best) best = cur[j]
      }
    }
    prev = cur
  }
  return best
}

/**
 * 缺口主题是不是与库里已有卡片撞车（撞车 → 缺口可能已过期）。
 * 三条字面信号，从强到弱：整张标题出现在主题里 / 标题与主题 LCS ≥3 / 某个 ≥2 字关键词占主题一半以上。
 */
export function gapLooksStale(topic, rec, cfg = kbConfig()) {
  const text = typeof topic === 'string' ? topic.trim() : ''
  if (text === '' || !rec || typeof rec !== 'object') return ''
  const title = typeof rec[cfg.title_field] === 'string' ? rec[cfg.title_field].trim() : ''
  if (title.length >= 2 && text.includes(title)) return '主题里出现了整张卡片的标题'
  if (title !== '' && lcsLen(text, title) >= 3) return '标题与主题的最长公共片段 ≥3 字'
  const keywords = Array.isArray(rec[cfg.keywords_field]) ? rec[cfg.keywords_field] : []
  for (const keyword of keywords) {
    const word = String(keyword ?? '').trim()
    if (word.length < 2 || !text.includes(word)) continue
    if (word.length * 2 >= text.length) return `关键词「${word}」覆盖了主题的一半以上`
  }
  return ''
}

const FACT_GROUPS_FOR_KB = ['profiles', 'timeline', 'barriers']

function kbItems(data) {
  const items = []
  for (const group of FACT_GROUPS_FOR_KB) {
    const list = Array.isArray(data?.[group]) ? data[group] : []
    list.forEach((item, position) => {
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        items.push({ label: `${group}[${position}]`, group, item, bodyKeys: ['title', 'text', 'note'] })
      }
    })
  }
  const actions = Array.isArray(data?.actions) ? data.actions : []
  actions.forEach((item, position) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      items.push({ label: `actions[${position}]`, group: 'actions', item, bodyKeys: ['title', 'content', 'purpose', 'condition'] })
    }
  })
  return items
}

function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key)
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function fingerprintMatches(declared, known) {
  const want = String(declared ?? '').slice(0, 16)
  const have = String(known ?? '').slice(0, 16)
  return want !== '' && have !== '' && (want === have || have.startsWith(want) || want.startsWith(have))
}

/**
 * 知识库相关的全部机械校验。返回 { errors, warnings }：
 *  - errors 进 needs_revision 清单（会渲染在页底折叠面板）；
 *  - warnings 不阻断，但必须让人看见（检索到了却没用、引用未签审、库变但被引卡未变等）。
 *
 * 未接知识库时不是「什么都不查」：只要出现 kb_refs / kb_excerpts / kb_basis.connected=true
 * 就报错——把模型常识写成企业知识，比缺一条依据更危险。
 */
export function validateKbAnalysis(data, { kb = null, indexes = [], cfg = kbConfig(), degraded = false } = {}) {
  const errors = []
  const warnings = []
  const fail = (message) => errors.push(message)
  const warn = (message) => warnings.push(message)
  if (!data || typeof data !== 'object') return { errors, warnings }

  const items = kbItems(data)

  if (kb === null || kb === undefined) {
    for (const { label, item } of items) {
      if (Array.isArray(item.kb_refs) && item.kb_refs.length > 0) {
        fail(`${label} 未接入知识库却填写了 kb_refs：不得伪造行业依据`)
      }
      if (Array.isArray(item.kb_excerpts) && item.kb_excerpts.length > 0) {
        fail(`${label} 未接入知识库却填写了 kb_excerpts：不得伪造卡片原文`)
      }
      if (hasOwn(item, 'kb_term') || hasOwn(item, 'term_status')) {
        fail(`${label} 未接入知识库却填写了 term_status/kb_term：术语三态只在接入后才有意义`)
      }
    }
    if (data.kb_basis && typeof data.kb_basis === 'object' && data.kb_basis.connected === true) {
      fail('kb_basis.connected=true 但本次未提供知识库目录')
    }
    if (!degraded) return { errors, warnings }
    warn('本次知识库不可用，已按 kb_missing_policy=degrade 显式降级为「未接入」：页面不允许出现任何知识依据')
    return { errors, warnings }
  }

  const ids = new Set(kb.entries.keys())
  if (kb.conflicts.length > 0) {
    fail(`知识库存在同 ID 但正文不同的条目 ${kb.conflicts.join('、')}：先修知识库再出稿`)
  }

  // 插入 kb_basis / kb_gaps 的形态检查
  if (data.kb_basis !== undefined) {
    if (data.kb_basis === null || typeof data.kb_basis !== 'object' || Array.isArray(data.kb_basis)) {
      fail('kb_basis 必须为对象（声明本次依据的知识库）')
    } else if (data.kb_basis.connected === true && nonEmptyText(data.kb_basis.path) === false) {
      // path 不强求，但 connected=true 与本次接入必须一致；不一致在下面指纹处一并判
    }
  }
  if (!Array.isArray(data.kb_gaps)) {
    fail('接入知识库时 kb_gaps 必须为数组（没有缺口就写空数组 []）')
  }

  // 「刻意不引用」的说明：键必须是真实存在的卡片，值必须写理由
  const unusedNotes = data.kb_unused_notes === undefined ? undefined : data.kb_unused_notes
  if (unusedNotes !== undefined) {
    if (unusedNotes === null || typeof unusedNotes !== 'object' || Array.isArray(unusedNotes)) {
      fail('kb_unused_notes 必须是 {卡片id: 不用它的理由} 对象')
    } else {
      for (const [card, why] of Object.entries(unusedNotes)) {
        if (!ids.has(card)) fail(`kb_unused_notes 中的 ${card} 不是知识库条目`)
        if (!nonEmptyText(why)) fail(`kb_unused_notes[${card}] 必须写明为什么不用它`)
      }
    }
  }

  // 缺口：显式、可追（evidence_turns 必须落在本条分析的证据里）、不得与已有卡片撞车
  const evidenceTurnIds = new Set(
    (Array.isArray(data.evidence) ? data.evidence : [])
      .filter((item) => item && typeof item === 'object' && nonEmptyText(item.turn_id))
      .map((item) => String(item.turn_id)),
  )
  const forbidden = new Map()
  const gaps = Array.isArray(data.kb_gaps) ? data.kb_gaps : []
  gaps.forEach((gap, position) => {
    const label = `kb_gaps[${position}]`
    if (typeof gap === 'string') {
      // 允许纯字符串缺口（最简形态），但这种缺口没有 evidence_turns / must_not_use_cards，
      // 属于「说了一声缺什么」——不报错，但会在体检报告里体现为不可追的缺口。
      if (gap.trim() === '') fail(`${label} 不能是空字符串：缺口要写清缺什么、降到谁那里`)
      return
    }
    if (gap === null || typeof gap !== 'object' || Array.isArray(gap)) {
      fail(`${label} 必须是字符串或对象 {topic, why_missing, fallback, must_not_use_cards}`)
      return
    }
    for (const card of Array.isArray(gap.must_not_use_cards) ? gap.must_not_use_cards : []) {
      if (!forbidden.has(String(card))) forbidden.set(String(card), nonEmptyText(gap.topic) ? String(gap.topic) : '未命名缺口')
    }
    const topic = nonEmptyText(gap.topic) ? String(gap.topic) : ''
    const turns = Array.isArray(gap.evidence_turns) ? gap.evidence_turns : []
    if (turns.length === 0) {
      fail(`${label} 缺少 evidence_turns：缺口必须能指回具体话轮，不能凭空声明`)
    } else {
      for (const turnId of turns) {
        if (!evidenceTurnIds.has(String(turnId))) fail(`${label}.evidence_turns 指向的 ${turnId} 不在本条分析的证据里`)
      }
    }
    if (topic !== '') {
      const forbid = new Set((Array.isArray(gap.must_not_use_cards) ? gap.must_not_use_cards : []).map(String))
      const overlap = []
      for (const [id, rec] of kb.entries) {
        if (forbid.has(id)) continue
        const why = gapLooksStale(topic, rec, cfg)
        if (why !== '') overlap.push(`${id}（${typeof rec[cfg.title_field] === 'string' ? rec[cfg.title_field] : ''}）：${why}`)
      }
      if (overlap.length > 0) {
        fail(
          `${label} 声明的缺口「${topic}」可能已过期：知识库里 ${overlap.slice(0, 3).join('；')} 的标题与它高度重合；` +
            '若确实不适用，请把该卡列进 must_not_use_cards 并写明理由',
        )
      }
    }
  })

  // 引用与片段：成对、真实存在、属于行业层、不在缺口禁用的名单里
  const cited = new Set()
  for (const { label, item } of items) {
    const refsRaw = item.kb_refs
    let refs = []
    if (refsRaw !== undefined) {
      if (!Array.isArray(refsRaw)) {
        fail(`${label}.kb_refs 必须为数组`)
      } else {
        refs = refsRaw
        for (const ref of refs) {
          if (typeof ref !== 'string' || !ids.has(ref)) {
            fail(`${label}.kb_refs 引用了知识库中不存在的条目 ${String(ref)}`)
            continue
          }
          cited.add(ref)
          const rec = kb.entries.get(ref)
          if (rec && rec[cfg.institution_fact_field] === true) {
            fail(`${label}.kb_refs 引用了机构事实层条目 ${ref}：行业知识库不得承载机构价目/资质/排期`)
          }
          if (forbidden.has(ref)) {
            fail(`${label}.kb_refs 引用了缺口「${forbidden.get(ref)}」明确禁止替代的卡片 ${ref}`)
          }
        }
        if (refs.length > 0 && !Array.isArray(item.kb_excerpts)) {
          fail(`${label} 有 kb_refs 但没有 kb_excerpts：引用了哪张卡就必须给出该卡片里的原文片段，供回查`)
        }
      }
    }
    const excerpts = item.kb_excerpts
    const body = normText(['title', 'text', 'note', 'content', 'purpose', 'condition'].map((key) => String(item[key] ?? '')).join('。'))
    if (excerpts !== undefined) {
      if (!Array.isArray(excerpts)) {
        fail(`${label}.kb_excerpts 必须为数组`)
      } else {
        for (const excerpt of excerpts) {
          if (!excerpt || typeof excerpt !== 'object' || Array.isArray(excerpt)) {
            fail(`${label}.kb_excerpts 每项必须是 {id, quote, used_for}`)
            continue
          }
          const id = excerpt.id
          if (typeof id !== 'string' || !ids.has(id)) {
            fail(`${label}.kb_excerpts 指向不存在的知识条目 ${String(id)}`)
            continue
          }
          if (refsRaw !== undefined && Array.isArray(refsRaw) && !refsRaw.map(String).includes(id)) {
            fail(`${label}.kb_excerpts 的 ${id} 不在该条目的 kb_refs 里`)
          }
          const quote = excerpt.quote
          if (!nonEmptyText(quote)) {
            fail(`${label}.kb_excerpts[${id}] 缺少 quote`)
          } else if (!entryTextOf(kb, id).includes(normText(quote))) {
            fail(`${label}.kb_excerpts[${id}] 的片段在该卡片正文里找不到：不得引用卡片外的内容冒充依据`)
          }
          const usedFor = excerpt.used_for
          if (!nonEmptyText(usedFor)) {
            fail(`${label}.kb_excerpts[${id}] 缺少 used_for：要写明这段卡片原文支撑本条哪一句`)
          } else if (body !== '' && !body.includes(normText(usedFor))) {
            fail(`${label}.kb_excerpts[${id}].used_for 不是本条正文的子串：引用必须落在结论上，不能当装饰`)
          } else if (nonEmptyText(quote) && body !== '') {
            const han = (text) => new Set([...String(text)].filter((ch) => ch >= '\u4e00' && ch <= '\u9fa5'))
            const shared = [...han(normText(quote))].filter((ch) => han(body).has(ch))
            if (shared.length <= cfg.decorative_shared_chars) {
              warn(`${label}.kb_excerpts[${id}] 与正文几乎没有共同实词：疑似装饰性引用，请人工确认它真的支撑该结论`)
            }
          }
        }
      }
    }

    // 术语三态：confirmed 要正确写法；candidate/unknown 要写 term_note，且候选不得写成定论
    const status = item.term_status
    if (status !== undefined) {
      if (!['confirmed', 'candidate', 'unknown'].includes(status)) {
        fail(`${label}.term_status 无效（只能 confirmed / candidate / unknown）`)
      }
      const note = item.term_note
      if ((status === 'candidate' || status === 'unknown') && !nonEmptyText(note)) {
        fail(`${label}.term_status=${status} 时必须写 term_note（说明疑似什么／为何未知）`)
      }
      if (status === 'candidate' && nonEmptyText(note) && !/(疑似|待核|待确认|核对)/.test(note)) {
        fail(`${label}.term_note 为候选术语时必须写明「疑似/待核」字样，不能写成确定结论`)
      }
      if (status === 'confirmed' && !nonEmptyText(item.kb_term)) {
        fail(`${label}.term_status=confirmed 时必须给出 kb_term（知识库中的正确写法）`)
      }
    }
  }

  // input_binding：分析必须声明它是照着哪一份转录与哪一版知识库写的
  const bind = data.input_binding
  if (bind === undefined || bind === null || typeof bind !== 'object' || Array.isArray(bind)) {
    fail('缺少 input_binding：必须声明本次分析依据的转录 sha256 与知识库指纹（index 阶段的输出里已给出可直接填的值）')
  } else {
    const want = bind.kb_fingerprint
    if (!nonEmptyText(want)) {
      fail('input_binding.kb_fingerprint 缺失：接入知识库时必须写明指纹')
    } else {
      const marks = (Array.isArray(indexes) ? indexes : [])
        .map((index) => String((index && index.kb && index.kb.fingerprint) || ''))
        .filter((mark) => mark !== '')
      const targets = marks.length > 0 ? marks : [kb.fingerprint]
      if (!targets.some((mark) => fingerprintMatches(want, mark))) {
        fail(
          `input_binding.kb_fingerprint=${String(want)} 与索引记录的知识库指纹 ${targets.map((m) => m.slice(0, 16)).join('/')} 不一致：分析是基于另一版知识库写的`,
        )
      }
    }
    const turnsMap = bind.transcripts
    if (turnsMap === null || typeof turnsMap !== 'object' || Array.isArray(turnsMap) || Object.keys(turnsMap).length === 0) {
      fail('input_binding.transcripts 必须是 {session_id: sha256} 映射')
    } else {
      for (const index of Array.isArray(indexes) ? indexes : []) {
        const sid = index && index.session_id
        const value = turnsMap[sid]
        if (!nonEmptyText(value)) fail(`input_binding.transcripts 缺少会话 ${String(sid)} 的 sha256`)
        else if (String(value) !== String(index.sha256)) {
          fail(`input_binding.transcripts[${sid}]=${String(value)} 与索引记录的转录 sha256 ${String(index.sha256)} 不一致：分析不是对着这份转录写的`)
        }
      }
    }
  }

  // 索引指纹 vs 当前知识库：被引卡片正文未变 → 降级为警告，变了/被删 → 报错
  const staleSessions = []
  for (const index of Array.isArray(indexes) ? indexes : []) {
    const mark = index && index.kb ? index.kb : {}
    const markFingerprint = String(mark.fingerprint ?? '')
    if (markFingerprint === '' || fingerprintMatches(markFingerprint, kb.fingerprint)) continue
    staleSessions.push(index)
  }
  if (staleSessions.length > 0) {
    const unchanged = [...cited].every((card) => {
      return staleSessions.every((index) => {
        const hashes = (index.kb && index.kb.card_hashes) || {}
        const old = hashes[card]
        return old !== undefined && old === kb.cardHashes[card]
      })
    })
    if (!unchanged) {
      fail(
        `会话 ${staleSessions.map((index) => index.session_id).join('、')} 的索引基于另一版本的知识库：被引用卡片的正文也变了，请重新索引后再校验`,
      )
    } else {
      for (const index of staleSessions) {
        warn(
          `会话 ${index.session_id} 的知识库已变更（${String(index.kb.fingerprint).slice(0, 16)} → ${kb.fingerprint.slice(0, 16)}），但被引用卡片正文未变：可继续，建议重新索引以刷新命中提示`,
        )
      }
    }
  }

  // 检索到了却没用：只对「正文确实提到该卡关键词」的情况报警，避免顺嘴一提就变噪音
  const bodyText = [
    String(data.summary ?? ''),
    ...items.map(({ item, bodyKeys }) => bodyKeys.map((key) => String(item[key] ?? '')).join(' ')),
  ].join('\n')
  const hitCounts = new Map()
  for (const index of Array.isArray(indexes) ? indexes : []) {
    for (const turn of Array.isArray(index.turns) ? index.turns : []) {
      for (const hit of Array.isArray(turn.term_hits) ? turn.term_hits : []) {
        if (!hit.card) continue
        hitCounts.set(hit.card, (hitCounts.get(hit.card) ?? 0) + 1)
      }
    }
  }
  const notes = unusedNotes && typeof unusedNotes === 'object' && !Array.isArray(unusedNotes) ? unusedNotes : {}
  for (const [card, count] of [...hitCounts.entries()].sort((a, b) => b[1] - a[1])) {
    if (cited.has(card) || hasOwn(notes, card)) continue
    const rec = kb.entries.get(card)
    const keywords = rec && Array.isArray(rec[cfg.keywords_field]) ? rec[cfg.keywords_field].map(String) : []
    const mentioned = keywords.filter((word) => word.trim() !== '' && bodyText.includes(word))
    if (mentioned.length === 0) continue
    warn(
      `分析正文提到「${mentioned.slice(0, 3).join('、')}」，但没有任何条目引用 ${card}（${rec && typeof rec[cfg.title_field] === 'string' ? rec[cfg.title_field] : ''}）：` +
        `索引里命中 ${count} 次；若要刻意不用，请在 kb_unused_notes 里写明理由`,
    )
  }

  // 引用了未签审条目：不阻断，但页面必须标注
  const drafts = [...cited].filter((card) => {
    const rec = kb.entries.get(card)
    const status = rec ? rec[cfg.review_status_field] : undefined
    return typeof status === 'string' && status.startsWith('draft')
  })
  if (drafts.length > 0) {
    warn(`引用了 ${drafts.length} 条未签审条目（${cfg.review_status_field}=draft_*）：${drafts.join('、')}；页面已标注「未经专业签审」`)
  }

  return { errors, warnings }
}

/** 机器可读的知识库体检（P2-7）：命中/引用/未解释/未签审/缺口/禁用卡/片段数。 */
export function kbReport(data, indexes = [], kb = null) {
  if (kb === null || kb === undefined) return { connected: false }
  const cited = new Set()
  for (const { item } of kbItems(data ?? {})) {
    if (Array.isArray(item.kb_refs)) for (const ref of item.kb_refs) cited.add(String(ref))
  }
  const hit = new Set()
  for (const index of Array.isArray(indexes) ? indexes : []) {
    for (const turn of Array.isArray(index.turns) ? index.turns : []) {
      for (const term of Array.isArray(turn.term_hits) ? turn.term_hits : []) if (term.card) hit.add(term.card)
    }
  }
  const notes = data && data.kb_unused_notes && typeof data.kb_unused_notes === 'object' && !Array.isArray(data.kb_unused_notes)
    ? data.kb_unused_notes
    : {}
  const gaps = data && Array.isArray(data.kb_gaps) ? data.kb_gaps : []
  const forbidden = new Set()
  for (const gap of gaps) {
    if (gap && typeof gap === 'object' && !Array.isArray(gap) && Array.isArray(gap.must_not_use_cards)) {
      for (const card of gap.must_not_use_cards) forbidden.add(String(card))
    }
  }
  const cfg = kb.cfg
  const drafts = [...cited].filter((card) => {
    const rec = kb.entries.get(card)
    const status = rec ? rec[cfg.review_status_field] : undefined
    return typeof status === 'string' && status.startsWith('draft')
  })
  return {
    connected: true,
    config_label: cfg.label,
    fingerprint: kb.fingerprint.slice(0, 16),
    records: kb.entries.size,
    terms: kb.terms.length,
    cards_hit: hit.size,
    cards_cited: cited.size,
    cards_hit_but_unused_with_notes: [...hit].filter((card) => !cited.has(card) && hasOwn(notes, card)).sort(),
    cards_hit_but_unused_unexplained: [...hit].filter((card) => !cited.has(card) && !hasOwn(notes, card)).sort(),
    draft_cited: drafts.sort(),
    gaps: gaps.length,
    forbidden_cards: [...forbidden].sort(),
    excerpts: kbItems(data ?? {}).reduce((sum, { item }) => sum + (Array.isArray(item.kb_excerpts) ? item.kb_excerpts.length : 0), 0),
  }
}

/** 本次 run 的知识库状态一句话（写进输出与页面页脚）。 */
export function kbStatusText({ kb, degraded = false, policy = 'error', dir = '', source = '' } = {}) {
  const sourceText = {
    param: '来源：本次输入显式指定的 knowledge_base_dir',
    config: '来源：行业配置的 knowledge_base.dirs 声明',
    out_dir: '来源：运行目录下自动发现',
    transcript_dir: '来源：转录目录自动发现',
  }[String(source)] ?? ''
  if (kb !== null && kb !== undefined) {
    return `${kb.cfg.label}：已接入 ${kb.entries.size} 条记录 / ${kb.terms.length} 个术语（指纹 ${kb.fingerprint.slice(0, 16)}${sourceText === '' ? '' : '；' + sourceText}）；引用必须带卡片原文片段。`
  }
  if (degraded) return `${KB_DEFAULTS.label}：不可用，已显式降级（kb_missing_policy=degrade）——本页不含任何知识依据。`
  if (typeof dir === 'string' && dir.trim() !== '') return `${KB_DEFAULTS.label}：未接入（给出的目录读不出来，kb_missing_policy=${policy}）。`
  return `${KB_DEFAULTS.label}：未接入——本页不含知识依据，行业解释只能来自转录原话与工作流。`
}

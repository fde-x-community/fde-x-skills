#!/usr/bin/env node
// 销售咨询简报（通用版）· 机械层
//
// 本脚本是 index.ts 声明的状态机里两个 script 节点的执行体：
//
//   --stage index   索引：转录 → 可追溯话轮（原始行号 + 输入 SHA-256），写到 <out_dir>
//   --stage render  校验 + 渲染：agent 节点（extract）提交的 analysis 在这里机械核对，
//                   零错误才渲染成离线内部 H5
//
// 它不做语义分析、不联网、不执行任何对客动作、不写业务系统。
// 语义结论由 agent 节点产出，脚本只核对与排版，绝不替模型下结论。

import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// 知识库接入（v0.8.0-kb）：只读、机械核对。全部领域相关的路径/字段名/词表都来自
// 行业配置的 knowledge_base 段，换行业不改本文件；不接知识库时行为与 v0.7.0 一致。
import {
  kbConfig,
  kbReport,
  kbStatusText,
  kbSummary,
  loadKb,
  termHits,
  termSuspects,
  validateKbAnalysis,
} from './kb.mjs'

export const SCHEMA_VERSION = '2.0'
export const SKILL_VERSION = '0.8.0-kb'
export const SKILL_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** 一行话轮：[hh:mm:ss] 发言人：正文 */
export const TURN_PATTERN = /^\[(\d{1,2}:\d{2}:\d{2})\]\s*([^：:]+)[：:]\s*(.*)$/

/** 会话代号会进索引文件名，只接受安全的文件名字符。 */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/

const POLICIES = ['unknown', 'allowed', 'restricted', 'stop_all']
const ROLE_STATUSES = ['confirmed', 'candidate', 'unknown', 'mixed']
const FACT_STATUSES = ['stated', 'other', 'inferred', 'unknown', 'pending_confirmation', 'conflict']
const TRANSACTION_KEYS_DEFAULT = ['payment', 'appointment', 'treatment']
const TRANSACTION_STATES = ['unknown', 'oral_only', 'opened', 'verified']
const PERMISSION_WORDS = ['许可', '同意', '授权']
const FACT_GROUPS = ['profiles', 'timeline', 'barriers']
const DECISION_STAGES_DEFAULT = [
  'awareness', 'exploration', 'comparison', 'consideration', 'price_blocked',
  'ready_for_next_step', 'verbally_agreed', 'opened', 'transaction_recorded',
  'deferred', 'declined', 'unknown',
]
const PROJECT_STATUSES_DEFAULT = ['mentioned', 'exploring', 'comparing', 'decided', 'declined', 'deferred', 'done', 'unknown']
const CLIENT_FACT_STATES_DEFAULT = ['confirmed_by_client', 'likely_client', 'staff_claim', 'unknown']
/**
 * 机构流程词表：这些词描述的是机构的动作或流程，必须在某条 evidence.quote 里出现过，
 * 否则就是凭空补齐机构流程（审计实例：C2 写"空腹要求"，原文 878 行零命中）。
 * 同理，"首诊/新客/首次"这类身份判定也必须能指到原话。
 */
const PROCESS_TERMS_DEFAULT = [
  '空腹', '忌口', '发票', '体检', '保密协议', '合同', '分期', '利息', '押金',
  '麻醉', '住院', '首诊', '新客', '首次',
]
const PROJECT_LABELS_DEFAULT = {
  mentioned: '仅机构提到',
  exploring: '客户在了解',
  comparing: '比价中',
  decided: '已定方案',
  declined: '明确不做',
  deferred: '明确延后',
  done: '本次已完成',
  unknown: '无法判断',
}
const FACT_STATE_LABELS_DEFAULT = {
  confirmed_by_client: '客户本人确认',
  likely_client: '疑为客户说法（待复听）',
  staff_claim: '仅机构说法',
  unknown: '未知/未问',
}

/**
 * 只支持数字、括号与 + - * / 的算式求值器。
 * 用途：把「报价链算术」变成可机械验算的字段，而不是靠审计事后发现「全文零算术」。
 * 遇到非法字符直接返回 null，不做任何 eval。
 */
export function evaluateExpr(expr) {
  const text = String(expr ?? '').replace(/\s+/g, '')
  if (text === '' || !/^[0-9+\-*/().]+$/.test(text)) return null
  let i = 0
  const peek = () => text[i]
  const parseFactor = () => {
    if (peek() === '(') {
      i += 1
      const value = parseExpr()
      if (peek() !== ')') throw new Error('paren')
      i += 1
      return value
    }
    const start = i
    while (i < text.length && /[0-9.]/.test(text[i])) i += 1
    if (start === i) throw new Error('number')
    return Number(text.slice(start, i))
  }
  const parseTerm = () => {
    let value = parseFactor()
    while (peek() === '*' || peek() === '/') {
      const op = text[i++]
      const right = parseFactor()
      value = op === '*' ? value * right : value / right
    }
    return value
  }
  function parseExpr() {
    let value = parseTerm()
    while (peek() === '+' || peek() === '-') {
      const op = text[i++]
      const right = parseTerm()
      value = op === '+' ? value + right : value - right
    }
    return value
  }
  try {
    const value = parseExpr()
    if (i !== text.length || !Number.isFinite(value)) return null
    return value
  } catch {
    return null
  }
}

const CN_DIGIT = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 }
const CN_UNIT = { 十: 10, 百: 100, 千: 1000 }
/**
 * 金额数字串（含有单位的混写）：「四百八十」「八百八」「四万九千八」「4万9千八」。
 * 录音里阿拉伯与中文常常混着写，所以字符集同时收两种数字。
 * 纯阿拉伯的「39320」也会被匹配到，但解析后没有单位、返回 null，不会被误当成金额。
 */
export const CN_NUMBER_RUN = /[0-9零〇一二两三四五六七八九十百千万亿]{2,}/g

/**
 * 把中文数字折算成数值。录音里的金额常写成「八百八」「四万九千八」，
 * 正文若照原文写法，单比阿拉伯数字会把同一个数判成两个。
 * 关键在口语省略：末尾孤立数字补的是上一单位的十分之一（八百八=880、三千五=3500），
 * 但中间出现过「零」时它就是各位（八百零八=808）。
 * 解析不了（太短、非数字）返回 null——「万一」「一个」这类词不能被当成钱。
 */
export function parseChineseNumber(raw) {
  const text = String(raw ?? '')
  if (text.length < 3) return null
  let total = 0
  let section = 0
  let number = 0
  let lastUnit = 1
  let zeroSeen = false
  let hasUnit = false
  for (const char of text) {
    if (char >= '0' && char <= '9') {
      number = Number(char)
      if (char === '0') zeroSeen = true
    } else if (char in CN_DIGIT) {
      number = CN_DIGIT[char]
      if (char === '零' || char === '〇') zeroSeen = true
    } else if (char in CN_UNIT) {
      hasUnit = true
      section += (number === 0 ? 1 : number) * CN_UNIT[char]
      lastUnit = CN_UNIT[char]
      number = 0
      zeroSeen = false
    } else if (char === '万') {
      hasUnit = true
      section += number
      total += section * 10000
      section = 0
      number = 0
      lastUnit = 10000
      zeroSeen = false
    } else if (char === '亿') {
      hasUnit = true
      section += number
      total = (total + section) * 100000000
      section = 0
      number = 0
      lastUnit = 100000000
      zeroSeen = false
    } else {
      return null
    }
  }
  // 没有「十百千万亿」的串就是纯阿拉伯数字（如 39320、58008），交给阿拉伯规则处理，不在这里解析
  if (!hasUnit) return null
  if (number > 0) section += zeroSeen ? number : number * (lastUnit / 10)
  const value = total + section
  return Number.isFinite(value) && value > 0 ? value : null
}
/** 完成态措辞 → 必须为 verified 的 transaction 字段。匹配时排除「未/没/不」开头的否定形态。 */
const COMPLETION_WORDS_DEFAULT = [
  ['成交', 'payment'],
  ['已付款', 'payment'],
  ['已支付', 'payment'],
  ['已刷卡', 'payment'],
  ['已转账', 'payment'],
  ['已预约', 'appointment'],
  ['已排定', 'appointment'],
  ['已排台', 'appointment'],
  ['已约好', 'appointment'],
  ['已约', 'appointment'],
  ['已治疗', 'treatment'],
  ['已注射', 'treatment'],
  ['已手术', 'treatment'],
]

const STAGE_LABELS_DEFAULT = {
  awareness: '刚了解',
  exploration: '摸底项目',
  comparison: '比价/比机构',
  consideration: '方案讨论',
  price_blocked: '卡在价格',
  ready_for_next_step: '谈实施条件',
  verbally_agreed: '口头同意未开局',
  opened: '已开单/已登记',
  transaction_recorded: '有正式收款或预约记录',
  deferred: '明确延后',
  declined: '明确拒绝',
  unknown: '无法判断',
}

const STATUS_LABELS_DEFAULT = {
  stated: '客户表达（角色需结合证据复核）',
  other: '他人说法',
  inferred: '分析推断',
  unknown: '待确认',
  pending_confirmation: '归属待复听',
  conflict: '存在冲突',
}
const ROLE_LABELS_DEFAULT = {
  confirmed: '身份有依据',
  candidate: '角色候选，待确认',
  unknown: '角色未知',
  mixed: '混合话轮，归属待确认',
}

// ── 行业配置：把领域相关的词表 / 标签 / 枚举抽成外部文件 ──────────────────────
// 默认值就是上面的 *_DEFAULT 常量（缺省值）。若 assets/industry-config.json 存在，
// 就用它的同名键覆盖；缺哪个键就回落默认值——所以没有配置文件时，行为与抽出前一致。
// 换行业只替换这个 JSON，run.mjs 一行不用改。
function loadIndustryConfig() {
  try {
    const raw = JSON.parse(readFileSync(join(SKILL_DIR, 'assets', 'industry-config.json'), 'utf8'))
    return isObject(raw) ? raw : {}
  } catch {
    return {} // 没有配置文件、或不是合法 JSON → 全部走默认值
  }
}

const INDUSTRY = loadIndustryConfig()
const INDUSTRY_LABELS = isObject(INDUSTRY.labels) ? INDUSTRY.labels : {}
const pickLabels = (name, fallback) => (isObject(INDUSTRY_LABELS[name]) ? INDUSTRY_LABELS[name] : fallback)

const TRANSACTION_KEYS = Array.isArray(INDUSTRY.transaction_keys) ? INDUSTRY.transaction_keys : TRANSACTION_KEYS_DEFAULT
const DECISION_STAGES = Array.isArray(INDUSTRY.decision_stages) ? INDUSTRY.decision_stages : DECISION_STAGES_DEFAULT
const PROJECT_STATUSES = Array.isArray(INDUSTRY.project_statuses) ? INDUSTRY.project_statuses : PROJECT_STATUSES_DEFAULT
const CLIENT_FACT_STATES = Array.isArray(INDUSTRY.client_fact_states) ? INDUSTRY.client_fact_states : CLIENT_FACT_STATES_DEFAULT
const PROCESS_TERMS = Array.isArray(INDUSTRY.industry_terms) ? INDUSTRY.industry_terms : (Array.isArray(INDUSTRY.process_terms) ? INDUSTRY.process_terms : PROCESS_TERMS_DEFAULT)
const COMPLETION_WORDS = Array.isArray(INDUSTRY.completion_words) ? INDUSTRY.completion_words : COMPLETION_WORDS_DEFAULT
const STAGE_LABELS = pickLabels('stage', STAGE_LABELS_DEFAULT)
const PROJECT_LABELS = pickLabels('project', PROJECT_LABELS_DEFAULT)
const FACT_STATE_LABELS = pickLabels('fact_state', FACT_STATE_LABELS_DEFAULT)
const STATUS_LABELS = pickLabels('status', STATUS_LABELS_DEFAULT)
const ROLE_LABELS = pickLabels('role', ROLE_LABELS_DEFAULT)
// 页面措辞：H5 的免责声明与页脚也走行业配置（page.notice / page.footer），
// 换行业时不改模板、不留「不构成医疗建议」这类行业口径残留。
const INDUSTRY_PAGE = isObject(INDUSTRY.page) ? INDUSTRY.page : {}
const PAGE_NOTICE = nonEmptyText(INDUSTRY_PAGE.notice)
  ? String(INDUSTRY_PAGE.notice)
  : '内部分析草稿 · 建议尚未执行 · 原话及角色需人工复核；不构成专业建议或正式交易确认。'
const PAGE_FOOTER = nonEmptyText(INDUSTRY_PAGE.footer)
  ? String(INDUSTRY_PAGE.footer)
  : '本页面含敏感信息，仅供授权内部使用。折叠证据不构成脱敏或访问控制。校验通过不等于事实、专业意见或授权已得到人工确认。'

// ── 本次 run 的行业配置：优先工作目录，技能包只作通用回落 ──────────────────────
// 设计约定（2026-11-04 修正）：行业配置由「行业配置冷启动」产出后落在当前工作目录，
// **不写回技能包**（assets/industry-config.json 必须保持通用，不能替换）。
// run.mjs 优先读 <out_dir>/industry-config.json 与 <out_dir>/industry-config/ 下的配置，
// 找不到才回落技能包自带配置——没有工作目录配置时行为与旧版一致。
export const RUN_INDUSTRY_CONFIG_CANDIDATES = [
  ['industry-config.json'],
  ['industry-config.draft.json'],
  ['industry-config', 'industry-config.json'],
  ['industry-config', 'industry-config.draft.json'],
]

/** 判定一个 JSON 是否是可用的行业配置：能解析且 industry_terms 为非空数组（与 preflight 判据一致）。 */
export function isUsableIndustryConfig(value) {
  return isObject(value) && Array.isArray(value.industry_terms) && value.industry_terms.length > 0
}

/** 在运行目录里找本次生效的行业配置（工作目录优先；找不到返回 undefined）。 */
export function findRunIndustryConfig(outDir) {
  for (const parts of RUN_INDUSTRY_CONFIG_CANDIDATES) {
    const candidate = join(outDir, ...parts)
    try {
      // 剥掉 BOM：PowerShell 5.1 的 Set-Content -Encoding UTF8 会带 BOM，否则一份写对了的配置会被当成非法 JSON。
      const parsed = JSON.parse(readFileSync(candidate, 'utf8').replace(/^\uFEFF/, ''))
      if (isUsableIndustryConfig(parsed)) return { config: parsed, path: candidate }
    } catch {
      // 不存在或非法 JSON：继续找下一个候选
    }
  }
  return undefined
}

/**
 * 本次 run 生效的行业配置：
 * - generic=true → 显式通用模式：配置视为空（行业词校验关闭）；
 * - 工作目录里有可用配置 → 用它（source=dir）；
 * - 否则 → 回落技能包自带通用配置（source=skill_default，保持技能包默认行为）。
 */
export function resolveRunIndustryConfig(outDir, industryMode) {
  const mode = isObject(industryMode) ? industryMode : undefined
  if (mode !== undefined && mode.generic === true) return { config: undefined, source: 'generic', path: '' }
  const found = findRunIndustryConfig(outDir)
  if (found !== undefined) return { config: found.config, source: 'dir', path: found.path }
  return { config: undefined, source: 'skill_default', path: '' }
}

// ── 本次 run 的「配置基准」：preflight 节点写在 <out_dir>/industry-mode.json ─────────
// 为什么需要它：行业词表只从技能包里读，en 于是脚本自己分不清「这份稿子是按行业配置出的」
// 还是「按通用词表出的、行业校验已关闭」。客户/销售看到 H5 时必须知道基准。
// 约定：文件缺失时**不改动**任何校验行为，只把基准记为 unknown（缺标注不等于通用）。
export const INDUSTRY_MODE_FILE = 'industry-mode.json'

/** 读 <out_dir>/industry-mode.json；缺失或非法时返回 present=false 的保守基准。 */
export function readIndustryMode(outDir) {
  const path = join(outDir, INDUSTRY_MODE_FILE)
  const fallback = {
    present: false,
    path,
    source: 'unknown',
    generic: false,
    industry_terms: PROCESS_TERMS.length,
    industry_label: typeof INDUSTRY._industry === 'string' ? INDUSTRY._industry : '',
    basis_note: '',
  }
  try {
    // PowerShell 的 Set-Content -Encoding UTF8 在 5.1 下会带 BOM：先剥掉再 parse，
    // 否则一份「写对了内容」的基准文件会被当成非法 JSON 静默回落成 unknown。
    const raw = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''))
    if (!isObject(raw)) return fallback
    const generic = raw.generic === true
    const declared = Number.isInteger(raw.industry_terms_count) ? raw.industry_terms_count : undefined
    return {
      present: true,
      path,
      source: nonEmptyText(raw.source) ? String(raw.source) : 'unknown',
      generic,
      industry_terms: generic ? 0 : (declared ?? PROCESS_TERMS.length),
      industry_label: nonEmptyText(raw.industry_label)
        ? String(raw.industry_label)
        : (typeof INDUSTRY._industry === 'string' ? INDUSTRY._industry : ''),
      basis_note: nonEmptyText(raw.basis_note) ? String(raw.basis_note) : '',
    }
  } catch {
    return fallback
  }
}

/** 生效的机构流程词表：显式通用模式下为空（行业词校验自动关闭）；本次生效配置优先于技能包默认。 */
export function resolveProcessTerms(industryMode, industryConfig = undefined) {
  if (isObject(industryMode) && industryMode.generic === true) return []
  const cfg = isObject(industryConfig) ? industryConfig : undefined
  return cfg !== undefined && Array.isArray(cfg.industry_terms) ? cfg.industry_terms : PROCESS_TERMS
}

/** 页首的配置基准横幅：让每个看到这份 H5 的人先知道「词表是不是行业适配过的」。 */
export function industryBasisBanner(industryMode) {
  const mode = isObject(industryMode) ? industryMode : undefined
  if (mode === undefined || mode.present !== true) {
    return '<div class="basis basis-warn"><b>配置基准未标注：</b>本次 run 没有写 industry-mode.json，无法确认词表是否行业适配；行业词校验按技能包现有配置照常执行，需人工确认。</div>'
  }
  const label = nonEmptyText(mode.industry_label) ? `「${escapeHtml(mode.industry_label)}」` : ''
  if (mode.generic === true) {
    return `<div class="basis basis-warn"><b>本次基于通用词表（未做行业适配）：</b>${label}行业流程词校验已关闭（industry_terms=0），词表/必问项与本行业无关；正文里的行业流程、费用项与身份标签不构成有原话支撑的断言，需人工复核。要按行业出稿，请先跑「行业配置冷启动」。</div>`
  }
  return `<div class="basis"><b>已按行业配置出稿：</b>${label}生效 industry_terms ${String(mode.industry_terms)} 个词（来源 ${escapeHtml(String(mode.source))}）。行业词断言仍需原话支撑，机械校验通过不等于语义核实。</div>`
}

/** 契约违约：三段式（问题/原因/修复）报给宿主，供下一轮修正。 */
export class SkillError extends Error {
  constructor(what, why, fix) {
    super(what)
    this.name = 'SkillError'
    this.what = what
    this.why = why
    this.fix = fix
  }
}

function isObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0
}

function hasOwn(target, key) {
  return Object.prototype.hasOwnProperty.call(target, key)
}

/** 相对路径的基准目录：宿主传入的用户工作目录优先，退回进程 cwd（运行时 = skill 目录）。 */
export function baseDir() {
  const fromEnv = process.env.DSH_SKILL_CWD
  return nonEmptyText(fromEnv) ? resolve(fromEnv) : process.cwd()
}

export function resolveUserPath(target, base) {
  const root = nonEmptyText(base) ? resolve(base) : baseDir()
  return isAbsolute(target) ? target : resolve(root, target)
}

export function readJson(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    throw new SkillError(`无法读取文件：${path}`, String(error && error.message), '确认路径存在、是文件且可读')
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new SkillError(`文件不是合法 JSON：${path}`, String(error && error.message), '修正 JSON 语法后重试；不要手工拼接残缺文档')
  }
}

export function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

// ── 1. 索引 ─────────────────────────────────────────────────────────────────

/**
 * 索引一份转录。只做格式解析：不判断说话人身份、不推断客户、不做语义归并。
 * @returns 索引文档（见 schemas/index.schema.json）
 */
export function indexTranscript({ transcriptPath, sessionId, kb = null, kb_cfg = undefined }) {
  let raw
  try {
    raw = readFileSync(transcriptPath)
  } catch (error) {
    throw new SkillError(`无法读取转录：${transcriptPath}`, String(error && error.message), '确认 path 指向真实存在的 txt 文件')
  }
  let text = raw.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  const cfg = kb_cfg !== undefined ? kb_cfg : kbConfig()
  const turns = []
  const unparsed = []
  const lines = text.split(/\r\n|\r|\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineNumber = index + 1
    if (line.trim().length === 0) continue
    const match = line.match(TURN_PATTERN)
    if (match === null) {
      unparsed.push({ line: lineNumber, text: line, possible_title: lineNumber <= 2 })
      continue
    }
    const turn = {
      turn_id: `L${lineNumber}@${match[1]}`,
      line: lineNumber,
      timestamp: match[1],
      speaker: match[2].trim(),
      text: match[3],
    }
    // 接入知识库时逐话轮记术语命中与已知误写提示。
    // 只做机械匹配：命中「正确写法」才算命中；误写只提示候选、原话一字不改。
    if (kb !== null && kb !== undefined) {
      const hits = termHits(turn.text, kb)
      if (hits.length > 0) turn.term_hits = hits
      const suspects = termSuspects(turn.text, kb, cfg)
      if (suspects.length > 0) turn.term_suspects = suspects
    }
    turns.push(turn)
  }
  if (turns.length === 0) {
    throw new SkillError(
      `转录没有可解析的话轮：${transcriptPath}`,
      '没有任何一行匹配 [hh:mm:ss] 发言人：文本；脚本不会把一整段正文静默当成解析成功',
      '先按该格式转换并人工核对，或修正输入后重新索引',
    )
  }
  return {
    session_id: sessionId,
    sha256: createHash('sha256').update(raw).digest('hex'),
    source_name: basename(transcriptPath),
    turns,
    unparsed_lines: unparsed,
  }
}

/**
 * 知识库目录的发现顺序（与词表配置同一套「工作目录优先」）：
 *   1. 本次输入显式给的 `knowledge_base_dir`（最高优先，给了就必须能读出来）
 *   2. 行业配置里声明的 `knowledge_base.dirs[]`（相对运行目录；冷启动可写这一条）
 *   3. 运行目录下的约定位置：`<out_dir>/knowledge-base`、`<out_dir>/industry-config/knowledge-base`
 *      （后者正是「行业配置冷启动」把知识库落在 industry-config 运行目录时的位置）以及若干别名
 *   4. 转录文件所在目录（及其上一级）里的 `知识库*` / `knowledge-base*` 目录
 * 判据不是「目录在不在」，而是**能读出 ≥1 条 id 合法的条目**（与词表的 isUsableIndustryConfig 同构）。
 */
export const RUN_KB_DIR_CANDIDATES = [
  ['knowledge-base'],
  ['knowledgebase'],
  ['industry-knowledge-base'],
  ['industry-kb'],
  ['kb'],
  ['知识库'],
  ['行业知识库'],
  ['industry-config', 'knowledge-base'],
  ['industry-config', '知识库'],
]

function safeIsDir(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

function listChildDirs(dir) {
  try {
    return readdirSync(dir).filter((name) => safeIsDir(join(dir, name)))
  } catch {
    return []
  }
}

/** 在运行目录 / 转录目录里找可用的知识库目录；找不到返回 source='none'。 */
export function findRunKnowledgeBase({ outDir, transcriptDirs = [], cfg = kbConfig() } = {}) {
  const seen = new Set()
  const tried = []
  const accept = (dir, source) => {
    const key = resolve(dir)
    if (seen.has(key)) return undefined
    seen.add(key)
    if (!safeIsDir(key)) {
      tried.push({ dir: key, source, usable: false, reason: '目录不存在' })
      return undefined
    }
    const kb = loadKb(key, cfg)
    if (kb === null) {
      tried.push({ dir: key, source, usable: false, reason: '读不出知识条目' })
      return undefined
    }
    return { dir: key, source, kb }
  }
  // 3. 运行目录下的约定位置（含冷启动的 industry-config/knowledge-base）
  for (const parts of RUN_KB_DIR_CANDIDATES) {
    const hit = accept(join(outDir, ...parts), 'out_dir')
    if (hit !== undefined) return { ...hit, tried }
  }
  // 3b. 运行目录里名字带「知识库 / knowledge base」的子目录（容忍“KB-行业-v2”这类命名）
  for (const name of listChildDirs(outDir)) {
    if (!/(知识库|行业知识|knowledge[-_ ]?base|^kb$|^kb[-_ .])/i.test(name)) continue
    const hit = accept(join(outDir, name), 'out_dir')
    if (hit !== undefined) return { ...hit, tried }
  }
  // 2. 行业配置声明的目录（相对运行目录解析）
  for (const rel of cfg.dirs ?? []) {
    const hit = accept(isAbsolute(rel) ? rel : join(outDir, rel), 'config')
    if (hit !== undefined) return { ...hit, tried }
  }
  // 4. 转录目录及其上一级：**只认名字像知识库的子目录**。
  // 不把转录目录本身当知识库——那会把「某个上层目录里恰好有 知识条目.jsonl」误判成接了库。
  for (const dir of transcriptDirs) {
    for (const base of [dir, dirname(dir)]) {
      for (const name of listChildDirs(base)) {
        if (!/(知识库|行业知识|knowledge[-_ ]?base|^kb$|^kb[-_ .])/i.test(name)) continue
        const hit = accept(join(base, name), 'transcript_dir')
        if (hit !== undefined) return { ...hit, tried }
      }
    }
  }
  return { dir: '', source: 'none', kb: null, tried }
}

/**
 * 本次 run 的知识库状态（与词表同构：显式参数优先 → 工作目录自动发现 → 未接入）。
 * - 显式给了 `knowledge_base_dir` 就必须能读出来（默认 error，degrade 才降级）；
 * - 自动发现失败**不报错**，只是「未接入」——和「工作目录没有行业配置」一样，是合法状态；
 * - 知识库的形状（entry_files/字段名/confusables）来自本次生效的行业配置（工作目录优先）。
 */
export function resolveRunKb(runInput, base, { outDir = '', industryConfig = undefined, transcriptDirs = [] } = {}) {
  const policy = nonEmptyText(runInput?.kb_missing_policy) ? String(runInput.kb_missing_policy).trim() : 'error'
  if (!['error', 'degrade'].includes(policy)) {
    throw new SkillError(`kb_missing_policy 无效：${policy}`, '只支持 error / degrade', '默认 error：给了知识库目录就必须能读出来；要显式降级请写 degrade')
  }
  const cfg = kbConfig(industryConfig)
  const rawDir = runInput && nonEmptyText(runInput.knowledge_base_dir) ? String(runInput.knowledge_base_dir).trim() : ''
  if (rawDir !== '') {
    const dir = resolveUserPath(rawDir, base)
    const kb = safeIsDir(dir) ? loadKb(dir, cfg) : null
    if (kb === null && policy === 'error') {
      throw new SkillError(
        `给了 knowledge_base_dir 但读不出知识库：${dir}`,
        '该目录里没有可解析的知识条目（默认找 02_结构化数据/知识条目.jsonl，或递归找「知识条目*.jsonl」）',
        '去掉 knowledge_base_dir，或修正目录；确实要按「未接入」继续请显式传 kb_missing_policy=degrade',
      )
    }
    return { kb, dir: kb === null ? '' : dir, source: 'param', policy, degraded: kb === null, cfg, tried: [] }
  }
  const found = findRunKnowledgeBase({ outDir, transcriptDirs, cfg })
  return { kb: found.kb, dir: found.kb === null ? '' : found.dir, source: found.source, policy, degraded: false, cfg, tried: found.tried }
}

/**
 * 把本次 run 的输入文档解析成「运行目录 + 每会话索引」，不写盘。
 * agent 节点的结果校验钩子与两个 script 阶段共用这一份逻辑，避免路径解析漂移。
 */
export function planIndexes(runInput, base) {
  if (!isObject(runInput)) {
    throw new SkillError('输入文档必须为 JSON 对象', `收到 ${typeof runInput}`, '按 manifest.inputs 传入 { transcripts, out_dir }')
  }
  const transcriptItems = Array.isArray(runInput.transcripts) ? runInput.transcripts : []
  if (transcriptItems.length === 0) {
    throw new SkillError('缺少转录输入', 'manifest.inputs 要求 transcripts 至少一条', '按 [{ session_id, path }] 传入，每份转录一个会话代号')
  }
  if (!nonEmptyText(runInput.out_dir)) {
    throw new SkillError('缺少 out_dir', '运行目录是索引、校验结果与 HTML 的落盘位置', '给一个技能包之外的私有目录路径')
  }

  const outDir = resolveUserPath(runInput.out_dir, base)
  // 知识库的形状配置来自**本次生效的行业配置**（工作目录优先，回落技能包通用模板）——
  // 与词表同一套解析，不是绕开它另读一份；知识库目录本身按「显式参数 → 工作目录 → 转录目录」发现。
  const kbIndustryMode = readIndustryMode(outDir)
  const kbRunIndustry = resolveRunIndustryConfig(outDir, kbIndustryMode)
  const transcriptDirs = transcriptItems
    .map((item) => (isObject(item) && nonEmptyText(item.path) ? dirname(resolveUserPath(item.path, base)) : ''))
    .filter((dir) => dir !== '')
  const runKb = resolveRunKb(runInput, base, { outDir, industryConfig: kbRunIndustry.config, transcriptDirs })
  const seenSessions = new Set()
  const indexes = []
  for (const [position, item] of transcriptItems.entries()) {
    if (!isObject(item)) {
      throw new SkillError(`transcripts[${position}] 必须为对象`, `收到 ${typeof item}`, '每个元素形如 { "session_id": "S1", "path": "转录.txt" }')
    }
    const sessionId = typeof item.session_id === 'string' ? item.session_id.trim() : ''
    if (sessionId.length === 0) {
      throw new SkillError(`transcripts[${position}].session_id 为空`, '会话代号是索引文件名的一部分，也是证据归属的锚点', '给每个会话一个唯一代号，如 S1、S2')
    }
    if (!SESSION_ID_PATTERN.test(sessionId)) {
      throw new SkillError(`transcripts[${position}].session_id 含非法字符：${sessionId}`, '会话代号会用于索引文件名，只接受字母数字下划线连字符', '改成如 S1、CASE-A 这类代号')
    }
    if (seenSessions.has(sessionId)) {
      throw new SkillError(`session_id 重复：${sessionId}`, '同一客户的多份转录必须用不同会话代号，否则索引会互相覆盖', '按咨询先后改成 S1、S2……并用 sequence 标注顺序')
    }
    seenSessions.add(sessionId)
    if (!nonEmptyText(item.path)) {
      throw new SkillError(`transcripts[${position}].path 为空`, '没有转录文件就没有索引', '给转录 txt 的路径')
    }
    indexes.push(
      indexTranscript({
        transcriptPath: resolveUserPath(item.path, base),
        sessionId,
        kb: runKb.kb,
        kb_cfg: runKb.cfg,
      }),
    )
  }
  // 知识库摘要与卡片正文哈希记进每个索引：既方便 render 阶段核对，也是「库变了但被引卡没变」
  // 那条降级通道的唯一依据（没有它，指纹一变就只能一律报错）。
  if (runKb.kb !== null) {
    const hitTurns = indexes.reduce((sum, index) => sum + index.turns.filter((turn) => Array.isArray(turn.term_hits) && turn.term_hits.length > 0).length, 0)
    const suspectTurns = indexes.reduce((sum, index) => sum + index.turns.filter((turn) => Array.isArray(turn.term_suspects) && turn.term_suspects.length > 0).length, 0)
    const summary = {
      ...kbSummary(runKb.kb),
      card_hashes: runKb.kb.cardHashes,
      term_hit_turns: hitTurns,
      term_suspect_turns: suspectTurns,
    }
    for (const index of indexes) index.kb = summary
  }
  return { outDir, indexes, kb: runKb.kb, kb_dir: runKb.dir, kb_source: runKb.source, kb_tried: runKb.tried, kb_policy: runKb.policy, kb_degraded: runKb.degraded, kb_cfg: runKb.cfg }
}

/** 分段稿每段的话轮数。长录音（如 876 话轮）一次性通读必然衰减，故切成可分段读的稿子。 */
export const SEGMENT_TURNS = 100

/** 契约允许的顶层字段。多一个就拒收：未校准的量化（概率、评分）比文字更危险，不能靠静默忽略。 */
export const ALLOWED_TOP_LEVEL = [
  'schema_version',
  'case_id',
  'summary',
  'decision_stage',
  'contact_policy',
  'contact_note',
  'transaction',
  'transaction_evidence',
  'money_math',
  'not_found_claims',
  'evidence',
  'profiles',
  'timeline',
  'barriers',
  'actions',
  'oral_quotes',
  'conflicts',
  'unknowns',
  'projects',
  'client_facts',
  'medical_review_questions',
  'analysis_meta',
  // v0.8.0-kb：知识库接入的可选字段（不接知识库时出现即判失败，防伪造行业依据）
  'kb_basis',
  'kb_gaps',
  'kb_unused_notes',
  'input_binding',
]

/**
 * 写出 `<session_id>.input-audit.json`：先审输入本身，再谈分析。
 * 目的是把「输入有问题」与「分析有问题」分开——说话人标签分布、疑似标题行、
 * 未解析行、时间轴首尾，这些在分析之前就该看得见。
 */
export function writeInputAudit(outDir, index) {
  const speakers = new Map()
  for (const turn of index.turns) {
    const key = String(turn.speaker ?? '?')
    speakers.set(key, (speakers.get(key) ?? 0) + 1)
  }
  const speakerTags = Object.fromEntries([...speakers.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0]))))
  const unparsedBody = index.unparsed_lines.filter((line) => line.possible_title !== true)
  const audit = {
    session_id: index.session_id,
    source_name: index.source_name,
    sha256: index.sha256,
    turns: index.turns.length,
    unparsed_lines: index.unparsed_lines.length,
    unparsed_body_lines: unparsedBody.slice(0, 20),
    suspected_title_lines: index.unparsed_lines.filter((line) => line.possible_title === true).map((line) => line.text),
    first_timestamp: index.turns[0]?.timestamp ?? null,
    last_timestamp: index.turns[index.turns.length - 1]?.timestamp ?? null,
    speaker_tags: speakerTags,
    // 说话人归属必须显式成表：编号不是身份。逐项填 role，填不出就留 unknown。
    speaker_map_skeleton: Object.fromEntries(Object.keys(speakerTags).map((tag) => [tag, 'unknown'])),
    notes: [
      'speaker_tags 只是转录里的编号分布，不代表身份；编号不能当角色依据。',
      '若某编号行内混有多个角色，角色应写 mixed，并在 analysis_meta.limitations 说明。',
      'unparsed_body_lines 非空时 render 阶段会判失败，需先修正转录格式。',
    ],
  }
  const auditPath = join(outDir, `${index.session_id}.input-audit.json`)
  writeJson(auditPath, audit)
  return { audit_path: auditPath }
}

/**
 * 写出 `<session_id>.segments.md`：把索引切成每段 SEGMENT_TURNS 话轮的 markdown。
 * 只重排索引里已有的话轮，不改一个字；turn_id 与索引一致，引用仍以索引为准。
 * 目的：让 agent 能分段通读并在每段记录要点，而不是把长转录压成一次泛读。
 */
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
    '> 供分段通读用：原话一字未改，turn_id 与索引一致。引用时必须从索引取 quote，不要从本稿改写。',
    '',
    ...parts,
  ].join('\n')
  const segmentsPath = join(outDir, `${index.session_id}.segments.md`)
  writeFileSync(segmentsPath, body, 'utf8')
  return { segments_path: segmentsPath, segments: total }
}

/** --stage index：索引写盘，产出 status=index_only 的输出文档。 */
export function runIndex(runInput, base) {
  const { outDir, indexes, kb, kb_degraded, kb_policy, kb_dir, kb_source, kb_tried } = planIndexes(runInput, base)
  mkdirSync(outDir, { recursive: true })
  const sessions = []
  for (const index of indexes) {
    const indexPath = join(outDir, `${index.session_id}.index.json`)
    writeJson(indexPath, index)
    // 分段稿与输入审计是为 agent 准备的通读/自检材料，不进输出契约（输出文档结构保持稳定）。
    writeSegments(outDir, index)
    writeInputAudit(outDir, index)
    sessions.push({
      session_id: index.session_id,
      turns: index.turns.length,
      unparsed_lines: index.unparsed_lines.length,
      index_path: indexPath,
      term_hit_turns: Array.isArray(index.kb) ? index.kb.term_hit_turns : 0,
    })
  }
  for (const index of indexes) {
    if (index.unparsed_lines.some((line) => line.possible_title !== true)) {
      process.stderr.write(`提醒：会话 ${index.session_id} 存在未解析正文行，render 阶段会校验失败；请先修正输入格式。\n`)
    }
  }
  // 接入知识库时给出可直接抄进 analysis 的 input_binding：转录 sha256 与知识库指纹都在这里，
  // 让 agent 不必自己去算（算错会被 render 判成「分析不是对着这份转录/这版知识库写的」）。
  const inputBinding = kb !== null && kb !== undefined
    ? {
        kb_fingerprint: kb.fingerprint.slice(0, 16),
        transcripts: Object.fromEntries(indexes.map((index) => [index.session_id, index.sha256])),
      }
    : undefined
  // 知识库基准落盘（与 industry-mode.json 同一套思路）：脚本知道「有什么」，读者要知道「按哪套基准、
  // 从哪发现的、试过哪些位置」。render 阶段读不到它也不改行为，横幅只显示「未标注」。
  writeJson(join(outDir, 'kb-mode.json'), {
    written_by: 'index',
    source: kb_source,
    connected: kb !== null && kb !== undefined,
    degraded: kb_degraded === true,
    policy: kb_policy,
    dir: kb_dir,
    records: kb !== null && kb !== undefined ? kb.entries.size : 0,
    terms: kb !== null && kb !== undefined ? kb.terms.length : 0,
    fingerprint: kb !== null && kb !== undefined ? kb.fingerprint.slice(0, 16) : '',
    tried: Array.isArray(kb_tried) ? kb_tried : [],
    note: kb === null || kb === undefined
      ? '本次没有可用知识库：页面不含任何知识依据。要让简报带知识依据，请先跑「行业配置冷启动」（它会产出 <out_dir>/knowledge-base），或显式给 knowledge_base_dir。'
      : '知识库形状配置来自本次生效的行业配置（工作目录优先）；知识库目录按「显式参数 → 工作目录 → 转录目录」发现。',
  })
  return {
    status: 'index_only',
    sessions,
    h5: '',
    validation: { checked: false, ok: false, errors: [] },
    kb: kbSummary(kb),
    kb_status: kbStatusText({ kb, degraded: kb_degraded, policy: kb_policy, dir: kb_dir, source: kb_source }),
    kb_source,
    kb_tried: Array.isArray(kb_tried) ? kb_tried : [],
    input_binding: inputBinding,
    execution_status: 'no_action_executed',
  }
}

// ── 2. 校验 ─────────────────────────────────────────────────────────────────

/**
 * 机械校验 analysis。只检查结构、引用是否存在、以及角色/交易的部分规则；
 * 不证明语义蕴含、不证明医学正确、不证明客户授权。返回错误文案数组（空数组=通过）。
 */
export function validateAnalysisDetailed(data, indexes, options = {}) {
  const errors = []
  const warnings = []
  const fail = (message) => errors.push(message)
  const warn = (message) => warnings.push(message)
  if (!isObject(data)) return { errors: ['分析结果必须为对象'], warnings }
  // 显式通用模式（preflight 写的 industry-mode.json 里 generic=true）→ 行业词校验自动关闭。
  // 词表/完成态/后续安排词都取「本次生效的行业配置」（工作目录优先），缺省回落技能包默认。
  const industryConfig = isObject(options.industry_config) ? options.industry_config : undefined
  const processTerms = resolveProcessTerms(isObject(options.industry_mode) ? options.industry_mode : undefined, industryConfig)
  const completionWords =
    industryConfig !== undefined && Array.isArray(industryConfig.completion_words) ? industryConfig.completion_words : COMPLETION_WORDS
  const postActionWords =
    industryConfig !== undefined && Array.isArray(industryConfig.post_action_words)
      ? industryConfig.post_action_words
      : (Array.isArray(INDUSTRY.post_action_words) ? INDUSTRY.post_action_words : ['后续安排'])

  if (data.schema_version !== SCHEMA_VERSION) fail(`schema_version 必须为 ${SCHEMA_VERSION}`)
  // 契约外的顶层字段一律拒收：多出来的字段会被下游静默忽略，
  // 而「成交概率 0.9」「意向评分 86」这类未校准的量化尤其危险——它看起来比文字更客观。
  const extraKeys = Object.keys(data).filter((key) => !ALLOWED_TOP_LEVEL.includes(key))
  if (extraKeys.length > 0) {
    fail(`出现契约外的顶层字段：${extraKeys.join('、')}——不生成成交概率或评分等未校准量化，也不需要自定义扩展字段`)
  }

  // ── not_found_claims：凡写「未说明/未提及」，都必须能被机械检索复核 ──
  // 真实教训：审计抓到「顾问未说明眼部两档差异依据」，而原文 L252/L253 讲得很清楚；
  // 也有「某附加项院方没答」，而同一话轮院方已明确回答。把「没读到」写成「不存在」最误导读者。
  const absenceWords = /(未说明|未提及|没有提到|没有说|未见|没有出现|未回答|没有回答|未涉及|没有正面|没有明确|未表态)/
  const textCorpus = [
    typeof data.summary === 'string' ? data.summary : '',
    ...['profiles', 'timeline', 'barriers'].flatMap((group) =>
      Array.isArray(data[group]) ? data[group].map((item) => `${item?.title ?? ''} ${item?.text ?? ''}`) : [],
    ),
    ...(Array.isArray(data.actions)
      ? data.actions.map((item) => `${item?.content ?? ''} ${item?.purpose ?? ''} ${item?.condition ?? ''} ${item?.done_when ?? ''}`)
      : []),
    ...(Array.isArray(data.unknowns) ? data.unknowns.map((item) => `${item?.item ?? ''} ${item?.why ?? ''}`) : []),
    ...(Array.isArray(data.conflicts)
      ? data.conflicts.flatMap((item) => [String(item?.note ?? ''), ...(Array.isArray(item?.versions) ? item.versions.map(String) : [])])
      : []),
    ...(Array.isArray(data.projects) ? data.projects.map((item) => String(item?.note ?? '')) : []),
    typeof data.contact_note === 'string' ? data.contact_note : '',
  ].join('\n')
  if (!Array.isArray(data.not_found_claims)) {
    fail('not_found_claims 必须为数组（正文写「未说明/未提及/没有回答」时必须逐条登记检索关键词；没有这类断言也要给空数组）')
  } else if (absenceWords.test(textCorpus) && data.not_found_claims.length === 0) {
    fail('正文出现「未说明/未提及/没有回答」类断言，但 not_found_claims 为空——这类断言必须登记：你用什么关键词检索、检索到了什么')
  } else {
    for (const [position, item] of data.not_found_claims.entries()) {
      const label = `not_found_claims[${position}]`
      if (!isObject(item)) {
        fail(`${label} 必须为对象`)
        continue
      }
      if (!nonEmptyText(item.claim)) fail(`${label}.claim 必须写清「什么未出现」`)
      const keywords = Array.isArray(item.keywords) ? item.keywords : []
      if (keywords.length === 0) {
        fail(`${label}.keywords 至少要给一个检索关键词`)
        continue
      }
      const usable = keywords
        .map((word) => String(word ?? '').trim())
        .filter((word) => word.length >= 2)
      if (usable.length === 0) {
        fail(`${label}.keywords 里的关键词至少要 2 个字符（太短的关键词搜不到有效结果）`)
        continue
      }
      const hits = []
      for (const index of indexes) {
        for (const turn of index.turns) {
          if (usable.some((word) => String(turn.text ?? '').includes(word))) hits.push(`${turn.turn_id}`)
        }
      }
      const uniqueHits = [...new Set(hits)]
      if (uniqueHits.length > 0) {
        const anchorId = item.evidence_id === undefined ? '' : String(item.evidence_id)
        const anchorItem =
          anchorId === '' || !Array.isArray(data.evidence)
            ? undefined
            : data.evidence.find((ev) => isObject(ev) && String(ev.id ?? '') === anchorId)
        const anchorQuote = anchorItem === undefined ? '' : String(anchorItem.quote ?? '')
        const anchored = anchorQuote !== '' && usable.some((word) => anchorQuote.includes(word))
        if (!anchored) {
          fail(
            `${label} 与转录冲突：你声称「${String(item.claim).slice(0, 40)}」，但关键词在这些话轮里出现过（${uniqueHits.slice(0, 5).join('、')}）。` +
              '如果这句话确实存在、只是出自另一方或别的条件，请把该原话收进 evidence 并在本条用 evidence_id 指向它、同时改写 claim；确实不存在才可保留。',
          )
        }
      }
    }
  }
  // 真实教训：三份独立分析都出现「全文零算术」——50008+8000 明明等于 58008 却被写成
  // 「无法闭合」，2999÷3 高于单价却被写成套餐划算。这类错只能靠把算式写出来才验得出。
  if (!Array.isArray(data.money_math)) {
    fail('money_math 必须为数组（出现两个以上金额时逐条写出算式；没有算式也要给空数组）')
  } else {
    for (const [position, item] of data.money_math.entries()) {
      const label = `money_math[${position}]`
      if (!isObject(item)) {
        fail(`${label} 必须为对象`)
        continue
      }
      if (!nonEmptyText(item.expr)) {
        fail(`${label}.expr 必须为只含数字、括号与 + - * / 的算式文本`)
        continue
      }
      if (typeof item.result !== 'number' || !Number.isFinite(item.result)) {
        fail(`${label}.result 必须为数字`)
        continue
      }
      const computed = evaluateExpr(item.expr)
      if (computed === null) {
        fail(`${label}.expr 不是可验算的算式：${item.expr}（只允许数字、括号与 + - * /）`)
        continue
      }
      if (Math.abs(computed - item.result) > 0.5) {
        fail(`${label} 算错：${item.expr} = ${computed}，但 result 写的是 ${item.result}`)
      }
    }
    // 算出来的结论必须落进会渲染的段落：否则读者在页面上看不到任何算术结果。
    // 真实教训：某次 7 条算式全对，但渲染后的 H5 里搜 999.67 / 749.75 / 130.25 零命中——
    // 算术只活在 json 字段里，等于没算。
    const conclusionWords = /(贵|省|不划算|划算|差额|相差|折|倍|多出|高于|低于)/
    for (const [position, item] of data.money_math.entries()) {
      if (!isObject(item) || typeof item.result !== 'number') continue
      if (!conclusionWords.test(String(item.note ?? ''))) continue
      const forms = [String(item.result), String(Math.round(item.result))]
      if (!forms.some((form) => textCorpus.includes(form))) {
        fail(
          `money_math[${position}] 的结论没写进正文：算式 ${String(item.expr)} = ${item.result}，但 summary/barriers/conflicts/actions 里都没出现这个数字——请把该结论写进会渲染的段落，不要只留在字段里`,
        )
      }
    }
  }
  for (const key of ['case_id', 'summary', 'contact_note']) {
    if (!nonEmptyText(data[key])) fail(`${key} 必须为非空文本`)
  }
  const policy = data.contact_policy
  if (!POLICIES.includes(policy)) fail('contact_policy 无效')

  // 会话表：会话归属的唯一事实源是索引，不是 analysis 的自述。
  const sessions = {}
  for (const index of indexes) {
    const sid = isObject(index) ? index.session_id : undefined
    if (!nonEmptyText(sid) || hasOwn(sessions, sid)) {
      fail('索引 session_id 为空或重复')
      continue
    }
    const turnMap = {}
    for (const turn of Array.isArray(index.turns) ? index.turns : []) {
      if (isObject(turn) && nonEmptyText(turn.turn_id)) turnMap[turn.turn_id] = turn
    }
    sessions[sid] = turnMap
    for (const line of Array.isArray(index.unparsed_lines) ? index.unparsed_lines : []) {
      if (!isObject(line) || line.possible_title === true) continue
      fail(`${sid} 有未解析正文行 ${line.line}，需先处理`)
    }
  }
  if (Object.keys(sessions).length === 0) fail('至少需要一个索引')

  const transaction = isObject(data.transaction) ? data.transaction : {}
  if (!isObject(data.transaction)) fail('transaction 必须为对象')
  const proofs = isObject(data.transaction_evidence) ? data.transaction_evidence : {}
  if (data.transaction_evidence !== undefined && !isObject(data.transaction_evidence)) fail('transaction_evidence 必须为对象')
  for (const key of TRANSACTION_KEYS) {
    if (!TRANSACTION_STATES.includes(transaction[key])) fail(`transaction.${key} 无效（unknown/oral_only/opened/verified）`)
    if (transaction[key] === 'verified' && !nonEmptyText(proofs[key])) fail(`${key} verified 缺少凭证描述`)
  }

  const evidenceList = Array.isArray(data.evidence) ? data.evidence : []
  if (!Array.isArray(data.evidence)) fail('evidence 必须为数组')
  const evidenceById = {}
  for (const [position, item] of evidenceList.entries()) {
    if (!isObject(item)) {
      fail(`evidence[${position}] 必须为对象`)
      continue
    }
    const id = item.id
    if (!nonEmptyText(id) || hasOwn(evidenceById, id)) {
      fail(`evidence[${position}] id 为空或重复`)
      continue
    }
    evidenceById[id] = item
    for (const key of ['session_id', 'turn_id', 'quote', 'role']) {
      if (!nonEmptyText(item[key])) fail(`${id}.${key} 必须为非空文本`)
    }
    if (!ROLE_STATUSES.includes(item.role_status)) fail(`${id}.role_status 无效`)
    const sessionTurns = hasOwn(sessions, item.session_id) ? sessions[item.session_id] : {}
    const turn = hasOwn(sessionTurns, item.turn_id) ? sessionTurns[item.turn_id] : undefined
    if (turn === undefined) {
      fail(`${id} 指向不存在的会话或话轮`)
    } else if (!nonEmptyText(item.quote) || !String(turn.text).includes(item.quote)) {
      fail(`${id} 引文不是原话连续子串`)
    }
  }

  const checkEvidenceIds = (group, position, item) => {
    const label = `${group}[${position}]`
    const ids = Array.isArray(item.evidence_ids) ? item.evidence_ids : []
    if (!Array.isArray(item.evidence_ids)) fail(`${label}.evidence_ids 必须为数组`)
    for (const id of ids) {
      if (!nonEmptyText(id) || !hasOwn(evidenceById, id)) fail(`${label} 引用了不存在的证据 ${id}`)
    }
    return ids
  }

  for (const group of FACT_GROUPS) {
    const items = data[group]
    if (!Array.isArray(items)) {
      fail(`${group} 必须为数组`)
      continue
    }
    for (const [position, item] of items.entries()) {
      const label = `${group}[${position}]`
      if (!isObject(item)) {
        fail(`${label} 必须为对象`)
        continue
      }
      for (const key of ['title', 'text', 'status']) {
        if (!nonEmptyText(item[key])) fail(`${label}.${key} 必须为非空文本`)
      }
      const ids = checkEvidenceIds(group, position, item)
      const status = item.status
      if (!FACT_STATUSES.includes(status)) fail(`${label}.status 无效`)
      if (['stated', 'other', 'inferred', 'conflict'].includes(status) && ids.length === 0) fail(`${label} 缺少证据`)
      if (status === 'stated') {
        const tainted = ids.some((id) => {
          const target = hasOwn(evidenceById, id) ? evidenceById[id] : undefined
          return target !== undefined && (target.role_status === 'mixed' || target.role_status === 'unknown')
        })
        if (tainted) fail(`${label} 客户表达不能使用混杂/未知角色证据`)
        // 归属倒置的机械拦截：stated 只能引用「角色名里标了客户」的证据。
        // 真实事故：院方在内部沟通里推断「她预算四万」，被写成客户的 stated 事实。
        const notCustomer = ids.filter((id) => {
          const target = hasOwn(evidenceById, id) ? evidenceById[id] : undefined
          if (target === undefined) return false
          const role = String(target.role ?? '')
          return !/客户/.test(role)
        })
        if (notCustomer.length > 0) {
          const detail = notCustomer
            .map((id) => `${id}（role=${String(evidenceById[id]?.role ?? '?')}）`)
            .join('、')
          fail(
            `${label} status=stated 引用了非客户证据：${detail}——顾问/院方的判断与转述不能写成客户表达，请改 status=other 或 pending_confirmation，或换成客户本人的原话证据`,
          )
        }
        // stated 条目的引号里只能放「本条证据」的原话。
        // 真实事故：C1 有 9 处 status=stated 的条目，正文「」里引的是顾问说的
        // 「全部消费都是透明的啊」「这个是4550杂费啊，我给咱写上杂费」，
        // 而条目自己的 evidence_ids 全是客户证据——引号落地只比对全案证据，于是全部放行，
        // 页面上这些条目还带着「客户表达」的标签。
        const ownQuotes = ids.map((id) => String(evidenceById[id]?.quote ?? ''))
        const statedBody = `${item.title ?? ''} ${item.text ?? ''} ${item.note ?? ''}`
        for (const match of statedBody.matchAll(/「([^」]+)」|“([^”]+)”|『([^』]+)』/g)) {
          const fragment = match[1] ?? match[2] ?? match[3] ?? ''
          if (fragment.length === 0) continue
          if (ownQuotes.some((quote) => quote.includes(fragment))) continue
          fail(
            `${label} status=stated，但引号里的「${fragment.slice(0, 24)}」不在本条目的证据里——客户表达只能引用客户本人的原话；若这句是顾问/院方说的，请改 status=other 并把该句收进本条 evidence_ids`,
          )
        }
      }
      // 归属断言与「归属未定」互斥，两种形态都要拦：
      //   (a) 同一条里既写「客户说…」又写「待复听/待确认」——既断言又免责；
      //   (b) 档位本身就是 pending_confirmation（已声明归属未定），正文却仍用「客户说/自述/侧说/连问」断言归属。
      // (b) 是 v0.5.5 初版漏掉的形态：真实事故里 C3 有 14 条 pending_confirmation，
      // 其中 4 条正文写「客户自述「…」」，但正文不含「待复听」字样，旧正则全部绕过。
      // (c) 是 v0.5.10 补的：v0.5.9 只查 text/note，标题里的断言漏网——
      // 真实事故：`barriers[2]` 标题写「活动价给得晚，客户抱怨没有提前告知」，档位却是 pending_confirmation。
      // 标题同样会渲染给销售看，所以必须和正文一起查。
      const attributionAssertion = /客户(?:自己)?(?:说|自述|表示|称|连问|侧说|提到|问到|抱怨|问过|想|觉得|认为|嫌|不满)(?!的)/
      const provisionalRole = /(待复听|待确认|归属未定|角色未定|尚未核实|尚待核实)/
      const factBody = `${item.title ?? ''} ${item.text ?? ''} ${item.note ?? ''}`
      const unresolvedAttribution = status === 'pending_confirmation'
      if (attributionAssertion.test(factBody) && (provisionalRole.test(factBody) || unresolvedAttribution)) {
        fail(
          `${label} 归属断言与档位矛盾：${
            provisionalRole.test(factBody)
              ? '正文既用「客户说…」断言归属，又写「待复听/待确认」'
              : '档位是 pending_confirmation（已声明归属未定），标题或正文却用「客户说/自述/抱怨/问过/想…」这类措辞断言归属（标题也算正文，它同样会渲染给销售看）'
          }——要么换成客户本人的 confirmed 证据再断言，要么保留未定档位并把正文改成「据待复听的记录，有『…』原话」这类不指定说话人的写法`,
        )
      }
    }
  }

  const actions = data.actions
  if (!Array.isArray(actions)) {
    fail('actions 必须为数组')
  } else {
    for (const [position, item] of actions.entries()) {
      const label = `actions[${position}]`
      if (!isObject(item)) {
        fail(`${label} 必须为对象`)
        continue
      }
      for (const key of ['title', 'content', 'purpose', 'condition', 'owner', 'done_when']) {
        if (!nonEmptyText(item[key])) fail(`${label}.${key} 必须为非空文本`)
      }
      if (typeof item.script !== 'string') fail(`${label}.script 必须为文本`)
      if (item.scope !== 'internal' && item.scope !== 'contact') fail(`${label}.scope 无效`)
      if (item.scope === 'internal' && nonEmptyText(item.script)) fail(`${label} 内部任务不能有对客话术`)
      if (policy === 'stop_all' && item.scope === 'contact') fail(`${label} 禁止联系时不能有对客任务`)
      if (item.scope === 'contact' && (policy === 'unknown' || policy === 'restricted')) {
        const condition = String(item.condition)
        if (!PERMISSION_WORDS.some((word) => condition.includes(word))) {
          fail(`${label} 联系授权未明或受限，执行条件必须要求许可`)
        }
      }
      const ids = checkEvidenceIds('actions', position, item)
      if (ids.length === 0) fail(`${label} 缺少依据`)
    }
  }

  // ── 阶段 / 覆盖声明 / 口头报价 / 口径冲突 / 未知待问 ────────────────────
  if (!DECISION_STAGES.includes(data.decision_stage)) {
    fail(`decision_stage 无效（须为 ${DECISION_STAGES.join('/')} 之一）`)
  }

  const meta = isObject(data.analysis_meta) ? data.analysis_meta : undefined
  if (meta === undefined) {
    fail('analysis_meta 必须为对象：至少写 coverage / turns_read / sessions / limitations')
  } else {
    if (meta.coverage !== 'full' && meta.coverage !== 'partial') fail('analysis_meta.coverage 必须为 full 或 partial')
    if (!Number.isInteger(meta.turns_read) || meta.turns_read < 1) fail('analysis_meta.turns_read 必须为正整数')
    if (!Number.isInteger(meta.sessions) || meta.sessions < 1) fail('analysis_meta.sessions 必须为正整数')
    if (!Array.isArray(meta.limitations)) {
      fail('analysis_meta.limitations 必须为数组')
    } else if (meta.coverage === 'partial' && meta.limitations.length === 0) {
      fail('coverage=partial 时 limitations 不能为空（必须写明抽样范围）')
    }
    const totalTurns = indexes.reduce((sum, index) => sum + (Array.isArray(index.turns) ? index.turns.length : 0), 0)
    if (Number.isInteger(meta.turns_read) && totalTurns > 0 && meta.turns_read !== totalTurns) {
      fail(`analysis_meta.turns_read=${String(meta.turns_read)} 与索引话轮数 ${String(totalTurns)} 不一致`)
    }
  }

  const oralQuotes = Array.isArray(data.oral_quotes) ? data.oral_quotes : []
  if (!Array.isArray(data.oral_quotes)) fail('oral_quotes 必须为数组')
  for (const [position, item] of oralQuotes.entries()) {
    const label = `oral_quotes[${position}]`
    if (!isObject(item)) {
      fail(`${label} 必须为对象`)
      continue
    }
    for (const key of ['item', 'amount', 'by']) if (!nonEmptyText(item[key])) fail(`${label}.${key} 必须为非空文本`)
    const ids = checkEvidenceIds('oral_quotes', position, item)
    const amount = String(item.amount ?? '')
    // amount 要照原文写法：不能夹带解释性括注
    if (amount.includes('（') || amount.includes('(')) {
      fail(`${label}.amount 不能夹带括注解释（把解释移到 note），amount 只放原文写法`)
    }
    // 数字回溯：amount 里的阿拉伯数字必须能在所引原话里找到
    const digits = amount.match(/\d{2,}/g)
    if (digits !== null && ids.length > 0) {
      const quotes = ids.map((id) => String((hasOwn(evidenceById, id) ? evidenceById[id].quote : '') ?? '')).join(' ')
      for (const run of digits) {
        if (!quotes.includes(run)) fail(`${label}.amount 里的数字 ${run} 在所引原话里找不到（金额必须来自原话）`)
      }
    }
  }
  if (oralQuotes.length > 0 && !String(data.summary).includes('口头')) {
    fail('存在 oral_quotes 时 summary 必须点明「口头」（否则金额会被读成正式价格）')
  }

  const conflicts = Array.isArray(data.conflicts) ? data.conflicts : []
  if (!Array.isArray(data.conflicts)) fail('conflicts 必须为数组')
  for (const [position, item] of conflicts.entries()) {
    const label = `conflicts[${position}]`
    if (!isObject(item)) {
      fail(`${label} 必须为对象`)
      continue
    }
    if (!nonEmptyText(item.item)) fail(`${label}.item 必须为非空文本`)
    if (!Array.isArray(item.versions) || item.versions.length < 2) {
      fail(`${label}.versions 至少要有两个版本（不允许把冲突抹平成一个数）`)
    }
    checkEvidenceIds('conflicts', position, item)
  }

  const unknowns = Array.isArray(data.unknowns) ? data.unknowns : []
  if (!Array.isArray(data.unknowns)) fail('unknowns 必须为数组')
  for (const [position, item] of unknowns.entries()) {
    const label = `unknowns[${position}]`
    if (!isObject(item)) {
      fail(`${label} 必须为对象`)
      continue
    }
    for (const key of ['item', 'why']) if (!nonEmptyText(item[key])) fail(`${label}.${key} 必须为非空文本`)
  }

  // evidence_ids 可选的三类：有就核对，没有不报错
  const takeOptionalIds = (label, item) => {
    if (item.evidence_ids === undefined) return []
    if (!Array.isArray(item.evidence_ids)) {
      fail(`${label}.evidence_ids 必须为数组`)
      return []
    }
    for (const id of item.evidence_ids) {
      if (!nonEmptyText(id) || !hasOwn(evidenceById, id)) fail(`${label} 引用了不存在的证据 ${id}`)
    }
    return item.evidence_ids
  }

  const projects = Array.isArray(data.projects) ? data.projects : []
  if (!Array.isArray(data.projects) || projects.length === 0) {
    fail('projects 至少要有一项（多项目客户不能只写主诉那一个）')
  }
  for (const [position, item] of projects.entries()) {
    const label = `projects[${position}]`
    if (!isObject(item)) {
      fail(`${label} 必须为对象`)
      continue
    }
    if (!nonEmptyText(item.name)) fail(`${label}.name 必须为非空文本`)
    if (!PROJECT_STATUSES.includes(item.status)) fail(`${label}.status 无效（${PROJECT_STATUSES.join('/')}）`)
    const ids = takeOptionalIds(label, item)
    if (item.status !== 'unknown' && ids.length === 0) fail(`${label} 标注了状态就必须给 evidence_ids`)
  }

  const clientFacts = Array.isArray(data.client_facts) ? data.client_facts : []
  if (!Array.isArray(data.client_facts)) fail('client_facts 必须为数组')
  /** 该条引用到的证据角色状态；用于判断"客户本人确认"是否站得住 */
  const rolesOf = (item) => (Array.isArray(item.evidence_ids) ? item.evidence_ids : [])
    .map((id) => (hasOwn(evidenceById, id) ? String(evidenceById[id].role_status ?? '') : ''))
  for (const [position, item] of clientFacts.entries()) {
    const label = `client_facts[${position}]`
    if (!isObject(item)) {
      fail(`${label} 必须为对象`)
      continue
    }
    if (!nonEmptyText(item.item)) fail(`${label}.item 必须为非空文本`)
    if (!CLIENT_FACT_STATES.includes(item.state)) fail(`${label}.state 无效（${CLIENT_FACT_STATES.join('/')}）`)
    const ids = takeOptionalIds(label, item)
    if (item.state === 'confirmed_by_client') {
      if (!nonEmptyText(item.value)) fail(`${label} 标为客户本人确认时必须写 value`)
      if (ids.length === 0) fail(`${label} 标为客户本人确认时必须给 evidence_ids`)
      // 客户本人确认要求证据角色也确认为客户；否则只会让人误读成已核实
      const roles = rolesOf(item)
      if (roles.length > 0 && roles.some((role) => role !== 'confirmed')) {
        fail(`${label} 标为客户本人确认，但它引用的证据角色是 ${roles.join('/')}：请改用 likely_client，或先把证据角色确认下来`)
      }
    } else if (item.state === 'likely_client') {
      if (!nonEmptyText(item.value)) fail(`${label} 标为疑为客户说法时必须写 value`)
      if (ids.length === 0) fail(`${label} 标为疑为客户说法时必须给 evidence_ids`)
    }
  }

  const medicalQuestions = Array.isArray(data.medical_review_questions) ? data.medical_review_questions : []
  if (!Array.isArray(data.medical_review_questions)) fail('medical_review_questions 必须为数组')
  for (const [position, item] of medicalQuestions.entries()) {
    const label = `medical_review_questions[${position}]`
    if (!isObject(item)) {
      fail(`${label} 必须为对象`)
      continue
    }
    for (const key of ['question', 'why']) if (!nonEmptyText(item[key])) fail(`${label}.${key} 必须为非空文本`)
    takeOptionalIds(label, item)
  }

  // ── 引用完整性：孤儿证据 / 引号内原话 / 完成态时态 ──────────────────────
  const used = new Set()
  const texts = [String(data.summary ?? ''), String(data.contact_note ?? '')]
  const takeIds = (item) => {
    if (!Array.isArray(item.evidence_ids)) return
    for (const id of item.evidence_ids) used.add(id)
  }
  for (const group of FACT_GROUPS) {
    for (const item of Array.isArray(data[group]) ? data[group] : []) {
      if (!isObject(item)) continue
      takeIds(item)
      texts.push(String(item.title ?? ''), String(item.text ?? ''))
    }
  }
  for (const item of Array.isArray(data.actions) ? data.actions : []) {
    if (!isObject(item)) continue
    takeIds(item)
    for (const key of ['title', 'content', 'purpose', 'condition', 'script', 'owner', 'done_when']) {
      texts.push(String(item[key] ?? ''))
    }
  }
  for (const item of oralQuotes) {
    if (!isObject(item)) continue
    takeIds(item)
    texts.push(String(item.item ?? ''), String(item.amount ?? ''), String(item.note ?? ''))
  }
  for (const item of conflicts) {
    if (!isObject(item)) continue
    takeIds(item)
    texts.push(String(item.item ?? ''), String(item.note ?? ''))
    for (const version of Array.isArray(item.versions) ? item.versions : []) texts.push(String(version))
  }
  for (const item of unknowns) {
    if (!isObject(item)) continue
    texts.push(String(item.item ?? ''), String(item.why ?? ''))
  }
  for (const item of projects) {
    if (!isObject(item)) continue
    takeIds(item)
    texts.push(String(item.name ?? ''), String(item.note ?? ''))
  }
  for (const item of clientFacts) {
    if (!isObject(item)) continue
    takeIds(item)
    texts.push(String(item.item ?? ''), String(item.value ?? ''), String(item.note ?? ''))
  }
  for (const item of medicalQuestions) {
    if (!isObject(item)) continue
    takeIds(item)
    texts.push(String(item.question ?? ''), String(item.why ?? ''))
  }

  for (const id of Object.keys(evidenceById)) {
    if (!used.has(id)) {
      fail(`evidence ${id} 没有被任何条目引用：先判断是不是漏了一条结论；若它确实与结论无关，请删除这条证据，不要硬挂到不相干条目上`)
    }
  }

  // 引号落地：中文书名号/双引号/单引号都要查（只查「」等于给对方留后门）
  const allQuotes = Object.values(evidenceById).map((item) => String(item.quote ?? ''))
  // 转录全文（不是证据引文）：用来区分「引文没落地」与「转录里根本没有」这两类完全不同的毛病
  const transcriptTexts = indexes.flatMap((index) =>
    Array.isArray(index?.turns) ? index.turns.map((turn) => String(turn?.text ?? '')) : [],
  )
  const transcriptHas = (term) => transcriptTexts.some((text) => text.includes(term))
  for (const text of texts) {
    for (const match of text.matchAll(/「([^」]+)」|“([^”]+)”|『([^』]+)』/g)) {
      const fragment = match[1] ?? match[2] ?? match[3] ?? ''
      if (fragment.length === 0) continue
      if (!allQuotes.some((quote) => quote.includes(fragment))) {
        fail(`引号内的片段「${fragment}」不是任何证据的原话子串（引号里只能放逐字引文，推断词请移到引号外）`)
      }
    }
  }

  // 正文数字必须有出处。真实事故：C2 在 conflicts 里写「摊到 24 期是每月约 658」「与口头的
  // 四百八十都对不上」——658 是从一笔错口径的相减（不含附加费的 43000 减含附加费的 58800）
  // 算出来的，转录、证据原话、算式结果、口头报价里全都查不到，却随 conflicts 渲染进了销售页面。
  // 出处处只认四种：证据原话、money_math 的算式与结果、oral_quotes 的金额写法、not_found_claims 关键词。
  // 推算出来的数（如 58800/24=2450）必须在 money_math 里写算式，不能只把结果写进叙述。
  const numberSources = [
    ...allQuotes,
    // 转录全文也算出处：引用时常常只摘半句，但那个数确实在录音里说过，不该因为 quote 没摘全就判成编造。
    ...(Array.isArray(indexes)
      ? indexes.flatMap((index) => (Array.isArray(index?.turns) ? index.turns.map((turn) => String(turn?.text ?? '')) : []))
      : []),
    ...(Array.isArray(data.oral_quotes)
      ? data.oral_quotes.map((item) => `${String(item?.amount ?? '')} ${String(item?.item ?? '')}`)
      : []),
    ...(Array.isArray(data.money_math)
      ? data.money_math.flatMap((item) => [String(item?.expr ?? ''), String(item?.result ?? '')])
      : []),
    ...(Array.isArray(data.not_found_claims)
      ? data.not_found_claims.flatMap((item) => (Array.isArray(item?.keywords) ? item.keywords.map(String) : []))
      : []),
    // 话轮数这类元信息不是金额，正文里写「全场 587 话轮已读完」不该被判成编造。
    String(isObject(data.analysis_meta) ? (data.analysis_meta.turns_read ?? '') : ''),
  ].join(' ')
  const knownNumbers = new Set()
  for (const match of numberSources.matchAll(/\d+(?:\.\d+)?/g)) {
    knownNumbers.add(match[0])
    if (Number.isFinite(Number(match[0]))) knownNumbers.add(String(Math.round(Number(match[0]))))
  }
  // 中文数字：录音里的金额常写成「八百八」「四万九千八」，正文若照原文写法，
  // 单纯比阿拉伯数字会把同一个数判成两个。这里把中文串折算成数值一起纳入出处。
  for (const match of numberSources.matchAll(CN_NUMBER_RUN)) {
    const value = parseChineseNumber(match[0])
    if (value !== null) knownNumbers.add(String(value))
  }
  // 行号（L120）、时间戳（01:23:45）、百分比（50%）不是金额，先剔掉再查
  const stripNonMoney = (text) =>
    String(text)
      .replace(/L\d+/g, ' ')
      .replace(/\d{1,2}:\d{2}(?::\d{2})?/g, ' ')
      .replace(/\d+(?:\.\d+)?%/g, ' ')
  const missingNumbers = new Set()
  for (const text of texts) {
    for (const match of stripNonMoney(text).matchAll(/\d+(?:\.\d+)?/g)) {
      const raw = match[0]
      const value = Number(raw)
      if (!Number.isFinite(value) || Math.abs(value) < 100) continue
      if (knownNumbers.has(raw) || knownNumbers.has(String(Math.round(value)))) continue
      missingNumbers.add(raw)
    }
    for (const match of stripNonMoney(text).matchAll(CN_NUMBER_RUN)) {
      const value = parseChineseNumber(match[0])
      if (value === null || Math.abs(value) < 100) continue
      if (knownNumbers.has(String(value))) continue
      missingNumbers.add(match[0])
    }
  }
  if (missingNumbers.size > 0) {
    fail(
      `正文出现找不到出处的数字「${[...missingNumbers].slice(0, 6).join('、')}」：正文里的每个金额/数量都要能追到一处——证据原话、转录原文、money_math 的算式或结果、或 oral_quotes 的金额写法。推算出来的数请在 money_math 里写出算式（如 58800/24=2450），不要只把结果写进叙述；若原话是中文写法（如「八百八」「四万九千八」），正文也请照原文写法，不要自行改成阿拉伯数字`,
    )
  }

  // 带单位的具体量必须能回引文：审计反复抓到「引文属实但支撑不了断言」。
  // 真实事故：medical_review_questions 断言「出血量不超过 10 毫升」，引的却是同一行后半句
  // 「因为那个仪器都是 3000 块钱叠加项」——数字在转录里有，但不在被引的那半句里。
  const measurePattern = /(\d+(?:\.\d+)?)\s*(毫升|ml|ML|毫克|毫米|厘米|cm|度|%)/g
  const missingMeasures = new Set()
  for (const text of texts) {
    for (const match of String(text).matchAll(measurePattern)) {
      const token = `${match[1]}${match[2]}`
      if (allQuotes.some((quote) => String(quote).includes(token))) continue
      missingMeasures.add(match[0].trim())
    }
  }
  if (missingMeasures.size > 0) {
    fail(
      `正文出现具体量「${[...missingMeasures].slice(0, 5).join('」「')}」，但没有任何 evidence.quote 包含它：把写这个数的原句收进 evidence——同一行常常前半句才是断言、后半句是另一件事，别引错半句`,
    )
  }

  // 单据类实体的状态断言必须能指到原话。
  // 真实事故：summary 写「00:16 单据已在顾问手上」，而同一话轮 L44 是顾问在问「啥子单子给你？」
  // ——问「哪一张单」恰恰证明单据没在手上。只查事实陈述组，不查 actions 的验收条件。
  const docClaimPattern = /(单据|小票|回执|收费单|发票)[^。；\n]{0,14}(已在|已经|已拿到|已出具|已生成|已开出|在手上)/
  const factTexts = [
    String(data.summary ?? ''),
    ...FACT_GROUPS.flatMap((group) =>
      Array.isArray(data[group])
        ? data[group].map((item) => `${item?.title ?? ''} ${item?.text ?? ''}`)
        : [],
    ),
  ]
  for (const text of factTexts) {
    if (!docClaimPattern.test(String(text))) continue
    const backed = allQuotes.some(
      (quote) => /(单据|小票|回执|收费单|发票)/.test(quote) && /(已在|已经|拿到|出具|生成|开出|手上)/.test(quote),
    )
    if (!backed) {
      fail(
        '正文断言单据「已在/已开出/已拿到」这类状态，但没有一条证据原话支持：把该话轮原话收进 evidence——顾问问「哪一张单」不等于单据已生成',
      )
    }
  }

  const transactionState = isObject(data.transaction) ? data.transaction : {}
  for (const [keyword, key] of completionWords) {
    const pattern = new RegExp(`(?<![未没不])${keyword}`)
    const hit = texts.some((text) => pattern.test(text))
    if (!hit) continue
    const state = transactionState[key]
    if (state !== 'verified') {
      fail(`正文出现完成态措辞「${keyword}」，但 transaction.${key}=${String(state)}：改成待核实表述，或给出可核验凭证后置 verified`)
    }
  }

  // 机构流程词：必须能指到原话，否则就是凭空补齐机构流程
  // 分两档：转录里说过、只是这条没引到 → 提醒补引文；转录里根本没有 → 拒收。
  // 混在一起报会把「引文未落地」说成「凭空断言」，实测三案里 6 条有 3 条是这类误报。
  for (const term of processTerms) {
    const usedIn = texts.filter((text) => text.includes(term))
    if (usedIn.length === 0) continue
    if (allQuotes.some((quote) => quote.includes(term))) continue
    if (transcriptHas(term)) {
      warn(
        `正文出现行业词「${term}」：转录里确实说过，但这条内容没有一条证据原话引到它——补一条含「${term}」的原话即可（引文未落地，不是凭空断言）`,
      )
    } else {
      fail(`正文出现行业词「${term}」，但没有任何证据原话包含它：要么补上支撑原话，要么删掉这类断言`)
    }
  }

  // 对客话术不得预设后续步骤：事情未发生时不讲"后续安排/回访/恢复期"
  // 词表取本次生效的行业配置（工作目录优先），技能包模板给的默认词，换成其它行业在行业配置的 post_action_words 里配。
  for (const item of Array.isArray(data.actions) ? data.actions : []) {
    if (!isObject(item) || !nonEmptyText(item.script)) continue
    const hitPost = postActionWords.find((word) => String(item.script).includes(word))
    if (hitPost !== undefined && transactionState.treatment === 'unknown') {
      fail(`actions 对客话术里出现「${hitPost}」，但 transaction.treatment=unknown：事情尚未发生时不能对客户讲后续安排`)
    }
  }

  // ── 知识库（v0.8.0-kb）─────────────────────────────────────────────────
  // 未接入时：出现任何 kb_refs / kb_excerpts / term_status 就判失败（防把模型常识写成企业知识）；
  // 接入时：引用必须真实存在、片段必须确在该卡正文里、缺口必须可追且不得拿相邻卡顶替、
  // 分析必须声明 input_binding（转录 sha256 + 知识库指纹）。
  const kbCheck = validateKbAnalysis(data, {
    kb: options.kb !== undefined ? options.kb : null,
    indexes,
    cfg: isObject(options.kb_cfg) ? options.kb_cfg : kbConfig(),
    degraded: options.kb_degraded === true,
  })
  for (const message of kbCheck.errors) fail(message)
  for (const message of kbCheck.warnings) warn(message)

  return { errors, warnings }
}

/** 只要错误、不要提醒的接口：既有调用方与测试按数组消费，不因新增 warnings 档而失效。 */
export function validateAnalysis(data, indexes) {
  return validateAnalysisDetailed(data, indexes).errors
}

// ── 3. 渲染 ─────────────────────────────────────────────────────────────────

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      default: return '&#39;'
    }
  })
}

function fillTemplate(template, values) {
  let output = template
  for (const [key, value] of Object.entries(values)) {
    output = output.split(`{{${key}}}`).join(value)
  }
  return output
}

function transactionState(value) {
  switch (value) {
    case 'verified': return '有凭证描述，待人工复核'
    case 'opened': return '已开单/已登记，未完成'
    case 'oral_only': return '仅口头，未核实'
    default: return '未核实'
  }
}

/**
 * 技术核对清单：**默认收起，放在页面最底部**。
 *
 * 定位变了：页面首先是一份可以直接看的成品，核对清单是给复核者留的尾巴，不是
 * 顶在读者脸上的免责条。所以：
 *   - 正文与证据照常渲染，第一屏就是简报本体；
 *   - 核对条目折叠进页底的 <details>，要复核对才展开；
 *   - 只有「agent 已尽力修掉、仍无法消除」的条目才会出现在这里（residual），
 *     其余能在页面语境内修掉的，应当由 polish 节点改掉而不是留给读者。
 */
function validationBanner(errors, warnings, residual) {
  const errorList = Array.isArray(errors) ? errors.map((item) => String(item)) : []
  const warningList = Array.isArray(warnings) ? warnings.map((item) => String(item)) : []
  const residualList = Array.isArray(residual) ? residual.map((item) => String(item)) : []
  if (errorList.length === 0 && warningList.length === 0 && residualList.length === 0) return ''
  const head = errorList.length > 0
    ? `技术核对：${errorList.length} 条未通过${warningList.length > 0 ? `，${warningList.length} 条提醒` : ''}（已折叠，不影响正文阅读）`
    : (warningList.length > 0
        ? `技术核对：${warningList.length} 条提醒（已折叠，不影响正文阅读）`
        : `技术核对：${residualList.length} 条待人工确认（已折叠）`)
  const blocks = []
  if (residualList.length > 0) {
    blocks.push(
      `<div class="vres"><h2>仍需人工确认（${residualList.length} 条）：修复环节已在页面语境内尝试消除，但无法在不编造内容的前提下改掉。</h2>` +
      `<ul>${residualList.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul></div>`,
    )
  }
  if (errorList.length > 0) {
    blocks.push(
      `<div class="vfail"><h2>机械核对未通过（${errorList.length} 条）：这些条目未通过引用、口径或完成态的机械核对。</h2>` +
      `<ol>${errorList.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol></div>`,
    )
  }
  if (warningList.length > 0) {
    blocks.push(
      `<div class="vwarn"><h2>需要人看一眼的提醒（${warningList.length} 条，不阻断渲染）</h2>` +
      `<ol>${warningList.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ol></div>`,
    )
  }
  return `<details class="vpanel"><summary>${escapeHtml(head)}</summary><div class="vpanel-body">${blocks.join('')}</div></details>`
}

/**
 * 机械渲染离线内部 H5。只做排版与转义，不改写任何结论；
 * 证据默认折叠展示——折叠不等于脱敏，也不构成访问控制。
 * `options` 可带 `{ errors, warnings, residual }`：校验没通过也照常渲染，
 * 核对清单折叠在页面最底部（见 validationBanner）。
 */
export function renderHtml(data, indexes, options = {}) {
  // 本次生效的行业配置（工作目录优先，缺省回落技能包默认）：标签与页面文案都从这里取。
  const cfg = isObject(options.industry_config) ? options.industry_config : undefined
  const cfgLabels = isObject(cfg?.labels) ? cfg.labels : {}
  const labelGroup = (name, fallback) => (isObject(cfgLabels[name]) ? Object.assign({}, fallback, cfgLabels[name]) : fallback)
  const stageLabels = labelGroup('stage', STAGE_LABELS)
  const projectLabels = labelGroup('project', PROJECT_LABELS)
  const factStateLabels = labelGroup('fact_state', FACT_STATE_LABELS)
  const statusLabels = labelGroup('status', STATUS_LABELS)
  const roleLabels = labelGroup('role', ROLE_LABELS)
  const cfgPage = isObject(cfg?.page) ? cfg.page : {}
  const pageNotice = nonEmptyText(cfgPage.notice) ? String(cfgPage.notice) : PAGE_NOTICE
  const pageFooter = nonEmptyText(cfgPage.footer) ? String(cfgPage.footer) : PAGE_FOOTER
  const evidenceById = {}
  for (const item of Array.isArray(data.evidence) ? data.evidence : []) evidenceById[item.id] = item
  const turnsBySession = {}
  for (const index of indexes) {
    const map = {}
    for (const turn of index.turns) map[turn.turn_id] = turn
    turnsBySession[index.session_id] = map
  }

  // 校验未通过时证据可能指向不存在的会话/话轮：渲染这里只降级成一行提示，不抛错——
  // H5 必须能生成，缺证据是「页面上看得见的问题」，不是「生不出页面」。
  const refs = (ids) => {
    if (!Array.isArray(ids) || ids.length === 0) return '<p class="muted">无直接引用，需复核</p>'
    const entries = ids.map((id) => {
      const evidence = evidenceById[id]
      if (!isObject(evidence)) return `<blockquote><p class="muted">证据 ${escapeHtml(String(id))} 在本页缺失（校验未通过），需复核。</p></blockquote>`
      const sessionTurns = isObject(turnsBySession[evidence.session_id]) ? turnsBySession[evidence.session_id] : {}
      const turn = sessionTurns[evidence.turn_id]
      const speaker = isObject(turn) && nonEmptyText(turn.speaker) ? turn.speaker : '话轮未找到'
      const roleLabel = roleLabels[evidence.role_status] ?? '角色状态未知'
      return `<blockquote><p>“${escapeHtml(evidence.quote)}”</p><small>${escapeHtml(evidence.session_id)} · ${escapeHtml(evidence.turn_id)} · ${escapeHtml(speaker)} · ${escapeHtml(evidence.role)} · ${escapeHtml(roleLabel)}</small></blockquote>`
    })
    return `<details class="ev"><summary>查看依据（${entries.length}）</summary>${entries.join('')}</details>`
  }

  // 折叠分区：默认只展开销售最需要的两块，其余关闭——内容一条不删，只是不再同层平铺。
  const fold = (id, title, items, body, open) => {
    const inner = items.length === 0 ? '<p class="empty">信息不足，暂未形成条目。</p>' : body
    return (
      `<details class="sect" id="${id}"${open ? ' open' : ''}>` +
      `<summary>${escapeHtml(title)}<span class="cnt">${items.length}</span>` +
      `<span class="hint">${open ? '默认展开' : '点击展开'}</span></summary>` +
      `<div class="body">${inner}</div></details>`
    )
  }
  const cards = (items, renderCard) => `<div class="grid">${items.map(renderCard).join('')}</div>`
  const rows = (items, renderRow) => `<ul class="plain">${items.map(renderRow).join('')}</ul>`
  const lines = (items, renderLine) => `<ol class="tl">${items.map(renderLine).join('')}</ol>`

  // ── 知识依据（v0.8.0-kb）：引了哪张卡 + 那张卡到底说了什么，都要能在这页上看到 ──
  // 未接入知识库时不渲染任何知识依据块；校验会把「未接入却写 kb_refs」判成失败。
  const kb = options.kb !== undefined ? options.kb : null
  const kbConnected = kb !== null && kb !== undefined
  const termBadge = (item) => {
    if (!kbConnected || !nonEmptyText(item.term_status)) return ''
    const map = {
      confirmed: `术语：知识库正确写法「${String(item.kb_term ?? '')}」`,
      candidate: '术语：候选写法（疑似，待核）',
      unknown: '术语：无法对应知识库条目（不猜）',
    }
    const text = map[item.term_status] ?? `术语：${String(item.term_status)}`
    return `<p class="muted">${escapeHtml(text)}${nonEmptyText(item.term_note) ? `　${escapeHtml(item.term_note)}` : ''}</p>`
  }
  const kbBlock = (item) => {
    const refsIds = Array.isArray(item.kb_refs) ? item.kb_refs : []
    const excerpts = Array.isArray(item.kb_excerpts) ? item.kb_excerpts : []
    if (refsIds.length === 0 && excerpts.length === 0) return termBadge(item)
    const parts = []
    for (const excerpt of excerpts) {
      const id = String(excerpt?.id ?? '')
      const card = kbConnected ? kb.entries.get(id) : undefined
      const title = card && nonEmptyText(card[kb.cfg.title_field]) ? String(card[kb.cfg.title_field]) : ''
      const draft = card && typeof card[kb.cfg.review_status_field] === 'string' && String(card[kb.cfg.review_status_field]).startsWith('draft')
      parts.push(
        `<blockquote><p>“${escapeHtml(String(excerpt?.quote ?? ''))}”</p>` +
          `<small>知识卡 ${escapeHtml(id)}${title === '' ? '' : ` · ${escapeHtml(title)}`}` +
          `${draft ? ' · 未经专业签审' : ''}` +
          `${nonEmptyText(excerpt?.used_for) ? ` · 支撑：「${escapeHtml(String(excerpt.used_for))}」` : ''}</small></blockquote>`,
      )
    }
    const missing = refsIds.filter((id) => !excerpts.some((excerpt) => String(excerpt?.id ?? '') === String(id)))
    const missingHint = missing.length > 0
      ? `<p class="muted">以下引用没有给出卡片原文片段：${escapeHtml(missing.join('、'))}（需回查）</p>`
      : ''
    return `${termBadge(item)}<details class="ev"><summary>知识依据（${excerpts.length} 段卡片原文）</summary>${parts.join('')}${missingHint}</details>`
  }

  const factCard = (item) =>
    `<article class="card"><span class="tag">${escapeHtml(statusLabels[item.status] ?? '状态未知')}</span><h3>${escapeHtml(item.title)}</h3><p>${escapeHtml(item.text)}</p>${kbBlock(item)}${refs(item.evidence_ids)}</article>`

  // 时间线是过程流水，压成一行一条；正文与依据放进条目内折叠。
  const timelineLine = (item) =>
    `<li><b>${escapeHtml(item.title)}</b><details class="ev"><summary>${escapeHtml(statusLabels[item.status] ?? '状态未知')} · 展开正文与依据</summary><p>${escapeHtml(item.text)}</p>${kbBlock(item)}${refs(item.evidence_ids)}</details></li>`

  const actionCard = (item) => {
    const script = nonEmptyText(item.script)
      ? `<p><b>建议话术：</b>${escapeHtml(item.script)}</p>`
      : '<p class="muted">内部处理，不提供对客话术。</p>'
    const scopeLabel = item.scope === 'internal' ? '内部处理' : '需符合联系许可'
    return `<article class="card"><span class="tag">${escapeHtml(scopeLabel)}</span><h3>${escapeHtml(item.title)}</h3><p><b>建议内容：</b>${escapeHtml(item.content)}</p><p><b>目的：</b>${escapeHtml(item.purpose)}</p><p><b>执行条件：</b>${escapeHtml(item.condition)}</p>${script}<p><b>建议负责人：</b>${escapeHtml(item.owner)}　<b>完成标志：</b>${escapeHtml(item.done_when)}</p>${kbBlock(item)}${refs(item.evidence_ids)}</article>`
  }

  const transaction = isObject(data.transaction) ? data.transaction : {}

  const meta = isObject(data.analysis_meta) ? data.analysis_meta : {}
  const metaText = [
    `覆盖：${meta.coverage === 'full' ? '全量' : (meta.coverage === 'partial' ? '抽样' : '未标注')}`,
    `话轮：${String(meta.turns_read ?? '?')}`,
    `会话：${String(meta.sessions ?? '?')}`,
  ].join(' · ')

  const profiles = Array.isArray(data.profiles) ? data.profiles : []
  const timeline = Array.isArray(data.timeline) ? data.timeline : []
  const barriers = Array.isArray(data.barriers) ? data.barriers : []
  const actions = Array.isArray(data.actions) ? data.actions : []
  const projects = Array.isArray(data.projects) ? data.projects : []
  const oralQuotes = Array.isArray(data.oral_quotes) ? data.oral_quotes : []
  const conflicts = Array.isArray(data.conflicts) ? data.conflicts : []
  const unknowns = Array.isArray(data.unknowns) ? data.unknowns : []
  const clientFacts = Array.isArray(data.client_facts) ? data.client_facts : []
  const medicalQuestions = Array.isArray(data.medical_review_questions) ? data.medical_review_questions : []

  // 一页速览只取前 3 条：销售先看到「卡在哪 / 下一步」，细节留在下面各分区，不重复渲染。
  const briefBarriers =
    barriers.length === 0
      ? '<p class="empty">本次未记录明显阻碍。</p>'
      : `<ol>${barriers.slice(0, 3).map((item) => `<li>${escapeHtml(item.title)}</li>`).join('')}</ol>`
  const briefActions =
    actions.length === 0
      ? '<p class="empty">本次未形成待办。</p>'
      : `<ol>${actions.slice(0, 3).map((item) => `<li>${escapeHtml(item.title)}<br><span class="muted">完成标志：${escapeHtml(item.done_when)}</span></li>`).join('')}</ol>`

  // 知识库两个分区（只有接入时才出现）：
  //   1) 知识依据：把全案引用的卡片摊平成一张表，销售/复核者不必逐条展开也能看到「引了什么、原话是什么」；
  //   2) 知识覆盖缺口：缺什么、为什么缺、该交给谁，以及缺口明确禁止拿来顶替的相邻卡。
  const kbGaps = Array.isArray(data.kb_gaps) ? data.kb_gaps : []
  const kbCitedItems = [...profiles, ...timeline, ...barriers, ...actions].filter(
    (item) => isObject(item) && ((Array.isArray(item.kb_refs) && item.kb_refs.length > 0) || (Array.isArray(item.kb_excerpts) && item.kb_excerpts.length > 0)),
  )
  const kbReportData = isObject(options.kb_report) ? options.kb_report : undefined
  const kbCheckBlock = kbConnected && kbReportData !== undefined
    ? fold(
        'kbcheck',
        '知识库体检（机器可读，供复核）',
        [kbReportData],
        rows(
          [
            ['知识库指纹', String(kbReportData.fingerprint ?? '')],
            ['记录 / 术语', `${String(kbReportData.records ?? '?')} 条 / ${String(kbReportData.terms ?? '?')} 个`],
            ['索引命中卡片', String(kbReportData.cards_hit ?? 0)],
            ['正文引用卡片', String(kbReportData.cards_cited ?? 0)],
            ['命中但未引用·已说明', (kbReportData.cards_hit_but_unused_with_notes ?? []).join('、') || '无'],
            ['命中但未引用·未说明', (kbReportData.cards_hit_but_unused_unexplained ?? []).join('、') || '无'],
            ['引用未签审条目', (kbReportData.draft_cited ?? []).join('、') || '无'],
            ['缺口数', String(kbReportData.gaps ?? 0)],
            ['缺口禁用卡', (kbReportData.forbidden_cards ?? []).join('、') || '无'],
            ['卡片原文片段数', String(kbReportData.excerpts ?? 0)],
          ],
          ([key, value]) => `<li><b>${escapeHtml(key)}</b>：${escapeHtml(value)}</li>`,
        ),
        false,
      )
    : ''
  const kbSections = kbConnected
    ? [
        fold(
          'kb',
          '行业知识依据（引用卡片 + 卡片原文片段）',
          kbCitedItems,
          kbCitedItems.length === 0
            ? '<p class="empty">本次没有引用任何知识卡片（接入知识库时必须写 kb_gaps 说明缺什么）。</p>'
            : `<div class="grid">${kbCitedItems
                .map((item) => `<article class="card"><h3>${escapeHtml(item.title ?? item.content ?? '')}</h3>${kbBlock(item)}</article>`)
                .join('')}</div>`,
          false,
        ),
        fold(
          'kbgap',
          '知识覆盖缺口（缺什么 · 降到谁那里 · 不得拿相邻卡顶替）',
          kbGaps,
          kbGaps.length === 0
            ? '<p class="empty">本次没有声明知识缺口。</p>'
            : rows(kbGaps, (gap) => {
                if (typeof gap === 'string') return `<li>${escapeHtml(gap)}</li>`
                const forbid = Array.isArray(gap.must_not_use_cards) ? gap.must_not_use_cards : []
                return (
                  `<li><b>${escapeHtml(String(gap.topic ?? '未命名缺口'))}</b>` +
                  `${nonEmptyText(gap.why_missing) ? `<p>${escapeHtml(gap.why_missing)}</p>` : ''}` +
                  `${nonEmptyText(gap.fallback) ? `<p class="muted">降级处理：${escapeHtml(gap.fallback)}</p>` : ''}` +
                  `${forbid.length > 0 ? `<p class="muted">不得拿这些卡顶替：${escapeHtml(forbid.join('、'))}</p>` : ''}</li>`
                )
              }),
          false,
        ),
        kbCheckBlock,
      ].join('')
    : ''

  const sections = [
    fold('barrier', '决策阻碍与待核问题', barriers, cards(barriers, factCard), true),
    fold('action', '行动建议与后续待办', actions, cards(actions, actionCard), true),
    fold('project', '项目状态一览', projects, rows(projects, (item) => `<li><b>${escapeHtml(item.name)}</b>：${escapeHtml(projectLabels[item.status] ?? '状态未知')}${nonEmptyText(item.note) ? `　<span class="muted">${escapeHtml(item.note)}</span>` : ''}${refs(item.evidence_ids)}</li>`), false),
    fold('oral', '口头报价（口头说法，非正式价格）', oralQuotes, rows(oralQuotes, (item) => `<li><b>${escapeHtml(item.item)}</b>：${escapeHtml(item.amount)}　<span class="muted">报价方：${escapeHtml(item.by)}${nonEmptyText(item.note) ? `　${escapeHtml(item.note)}` : ''}</span>${refs(item.evidence_ids)}</li>`), false),
    fold('conflict', '口径冲突（并列保留，未抹平）', conflicts, rows(conflicts, (item) => `<li><b>${escapeHtml(item.item)}</b><ul>${(Array.isArray(item.versions) ? item.versions : []).map((version) => `<li>${escapeHtml(version)}</li>`).join('')}</ul>${nonEmptyText(item.note) ? `<p class="muted">${escapeHtml(item.note)}</p>` : ''}${refs(item.evidence_ids)}</li>`), false),
    fold('profile', '客户画像与项目意向', profiles, cards(profiles, factCard), false),
    fold('timeline', '意向变化（按时间）', timeline, lines(timeline, timelineLine), false),
    fold('unknown', '未知待问（没问到 ≠ 没有）', unknowns, rows(unknowns, (item) => `<li><b>${escapeHtml(item.item)}</b>：${escapeHtml(item.why)}</li>`), false),
    fold('fact', '客户事实（既往史/过敏/作息/陪同人）', clientFacts, rows(clientFacts, (item) => `<li><b>${escapeHtml(item.item)}</b>：${nonEmptyText(item.value) ? escapeHtml(item.value) : '<span class="muted">未获取</span>'}　<span class="muted">${escapeHtml(factStateLabels[item.state] ?? '状态未知')}</span>${refs(item.evidence_ids)}</li>`), false),
    fold('medical', '须由医务人员书面回答', medicalQuestions, rows(medicalQuestions, (item) => `<li><b>${escapeHtml(item.question)}</b>　<span class="muted">${escapeHtml(item.why)}</span>${refs(item.evidence_ids)}</li>`), false),
    kbSections,
  ].join('')

  const navHtml = [
    ['brief', '速览'],
    ['barrier', '卡在哪'],
    ['action', '下一步'],
    ['project', '项目'],
    ['oral', '报价'],
    ['conflict', '冲突'],
    ['profile', '画像'],
    ['timeline', '时间线'],
    ['unknown', '待问'],
    ['fact', '客户事实'],
    ['medical', '医务'],
    ...(kbConnected ? [['kb', '知识依据'], ['kbgap', '知识缺口']] : []),
  ]
    .map(([id, label]) => `<a href="#${id}">${escapeHtml(label)}</a>`)
    .join('')

  const template = readFileSync(join(SKILL_DIR, 'assets', 'h5-template.html'), 'utf8')
  // 知识库接入状态必须让读者第一眼看到：接了什么库、指纹、以及「未接入/已降级」。
  const kbBannerText = kbStatusText({
    kb,
    degraded: options.kb_degraded === true,
    policy: options.kb_policy !== undefined ? String(options.kb_policy) : 'error',
    dir: options.kb_dir !== undefined ? String(options.kb_dir) : '',
    source: options.kb_source !== undefined ? String(options.kb_source) : '',
  })
  return fillTemplate(template, {
    VALIDATION_BANNER: validationBanner(options.errors, options.warnings, options.residual),
    INDUSTRY_BASIS: industryBasisBanner(options.industry_mode),
    KB_BANNER: `<p class="kb-basis${kbConnected ? '' : ' muted'}">${escapeHtml(kbBannerText)}</p>`,
    PAGE_NOTICE: escapeHtml(pageNotice),
    PAGE_FOOTER: escapeHtml(pageFooter),
    CASE_TITLE: escapeHtml(data.case_id),
    SUMMARY: escapeHtml(data.summary),
    STAGE: escapeHtml(stageLabels[data.decision_stage] ?? '未标注'),
    META: escapeHtml(metaText),
    CONTACT: escapeHtml(data.contact_note),
    PAYMENT: escapeHtml(transactionState(transaction.payment)),
    APPOINTMENT: escapeHtml(transactionState(transaction.appointment)),
    TREATMENT: escapeHtml(transactionState(transaction.treatment)),
    BRIEF_BARRIERS: briefBarriers,
    BRIEF_ACTIONS: briefActions,
    NAV: navHtml,
    SECTIONS: sections,
  })
}

// ── 4. render 阶段 ──────────────────────────────────────────────────────────

/**
 * 取出 agent 节点提交的 analysis 本体。**不抛错**：内容不合格一律交给
 * validateAnalysis 报成 needs_revision，让 run 正常终止——agent 节点没有可被
 * 拒绝的路径，状态机就不会停在不可回卷的 blocked 上（批量运行会因此断链）。
 */
export function submissionAnalysis(submission) {
  return isObject(submission) ? submission.analysis : undefined
}

/**
 * 提交里连 analysis 对象都没有（或渲染本身抛错）时的占位页。
 * 仍然生成 销售简报.html：页面只承载校验错误清单，不含任何分析结论——
 * 「没有可渲染的内容」也必须是看得见的产物，而不是一个空路径。
 */
export function renderFallbackHtml({ caseId = '', errors = [], warnings = [], residual = [], industry_mode = undefined, industry_config = undefined, kb = null, kb_degraded = false, kb_policy = 'error', kb_dir = '', kb_source = '' } = {}) {
  const template = readFileSync(join(SKILL_DIR, 'assets', 'h5-template.html'), 'utf8')
  const cfg = isObject(industry_config) ? industry_config : undefined
  const cfgPage = isObject(cfg?.page) ? cfg.page : {}
  const pageNotice = nonEmptyText(cfgPage.notice) ? String(cfgPage.notice) : PAGE_NOTICE
  const pageFooter = nonEmptyText(cfgPage.footer) ? String(cfgPage.footer) : PAGE_FOOTER
  const panel = validationBanner(errors, warnings, residual)
  return fillTemplate(template, {
    // 占位页没有正文可读，核对清单直接放进主区域；页底占位符留空避免重复。
    VALIDATION_BANNER: '',
    INDUSTRY_BASIS: industryBasisBanner(industry_mode),
    KB_BANNER: `<p class="kb-basis muted">${escapeHtml(kbStatusText({ kb, degraded: kb_degraded, policy: kb_policy, dir: kb_dir, source: kb_source }))}</p>`,
    PAGE_NOTICE: escapeHtml(pageNotice),
    PAGE_FOOTER: escapeHtml(pageFooter),
    CASE_TITLE: escapeHtml(nonEmptyText(caseId) ? caseId : '未命名'),
    SUMMARY: '本次提交没有可渲染的 analysis，或渲染过程出错：本页只承载校验错误清单，不含任何分析结论。',
    STAGE: '未标注',
    META: '覆盖：未标注 · 话轮：? · 会话：?',
    CONTACT: '未标注：没有 analysis，无法判断联系许可',
    PAYMENT: transactionState(undefined),
    APPOINTMENT: transactionState(undefined),
    TREATMENT: transactionState(undefined),
    BRIEF_BARRIERS: '<p class="empty">没有 analysis，无速览内容。</p>',
    BRIEF_ACTIONS: '<p class="empty">没有 analysis，无待办。</p>',
    NAV: '',
    SECTIONS: panel,
  })
}

/**
 * --stage render：把提交的 analysis 落盘、机械校验，**并且总是渲染 H5**。
 * 校验不通过时核对清单折叠在页底（不挡正文），status 仍是 needs_revision，
 * 但页面照常生成——「没有通过核对」和「没有页面」是两件事，前者应当被看见。
 * 之后的 polish 节点会按清单把能修的在页面语境内修掉，再由 finalize 复渲染。
 */
export function runRender({ runInput, submission, base }) {
  const plan = planIndexes(runInput, base)
  const { outDir, indexes, kb, kb_cfg, kb_degraded, kb_policy, kb_dir, kb_source, kb_tried } = plan
  mkdirSync(outDir, { recursive: true })
  const analysis = submissionAnalysis(submission)
  const analysisIsObject = isObject(analysis)
  for (const index of indexes) writeJson(join(outDir, `${index.session_id}.index.json`), index)
  const analysisPath = join(outDir, 'analysis.json')
  if (analysisIsObject) writeJson(analysisPath, analysis)
  // 配置基准：preflight 写的 industry-mode.json 决定「行业词校验开不开」与「页首横幅写什么」。
  const industryMode = readIndustryMode(outDir)
  // 本次生效的行业配置：工作目录优先（<out_dir>/industry-config.json 或 <out_dir>/industry-config/ 下）；
  // generic 模式下视为空（行业词校验关闭）；找不到工作目录配置才回落技能包自带通用配置。
  const runIndustry = resolveRunIndustryConfig(outDir, industryMode)
  const industryConfig = runIndustry.config

  const details = analysisIsObject
    ? validateAnalysisDetailed(analysis, indexes, {
        industry_mode: industryMode,
        industry_config: industryConfig,
        kb,
        kb_cfg,
        kb_degraded,
      })
    : { errors: ['提交里没有 analysis 对象：agent 节点必须提交 { "analysis": {...} }'], warnings: [] }
  const errors = details.errors
  const warnings = details.warnings
  const kbReportData = analysisIsObject ? kbReport(analysis, indexes, kb) : kbReport({}, indexes, kb)
  // case_id 锁定从原来的节点钩子挪到这里：不达标也是 needs_revision，不拒绝节点。
  const expectedCaseId = nonEmptyText(runInput.case_id) ? runInput.case_id.trim() : ''
  if (analysisIsObject && expectedCaseId.length > 0 && analysis.case_id !== expectedCaseId) {
    errors.push(`case_id 必须与本次 run 指定的代号一致（应为「${expectedCaseId}」，实际为「${String(analysis.case_id)}」）`)
  }
  // 无论如何都写出一份 H5：校验错误进页首清单，渲染异常降级成占位页并记进错误清单。
  const h5Path = join(outDir, '销售简报.html')
  const pageOptions = {
    errors,
    warnings,
    industry_mode: industryMode,
    industry_config: industryConfig,
    kb,
    kb_cfg,
    kb_degraded,
    kb_policy,
    kb_dir,
    kb_source,
    kb_report: kbReportData,
  }
  try {
    const page = analysisIsObject
      ? renderHtml(analysis, indexes, pageOptions)
      : renderFallbackHtml({ caseId: expectedCaseId, ...pageOptions })
    writeFileSync(h5Path, page, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    errors.push(`渲染时出错，已降级为占位页：${reason}`)
    writeFileSync(h5Path, renderFallbackHtml({ caseId: expectedCaseId, ...pageOptions }), 'utf8')
  }

  writeJson(join(outDir, '校验结果.json'), {
    analysis_path: analysisIsObject ? analysisPath : '',
    h5_path: h5Path,
    sessions: indexes.map((index) => ({ session_id: index.session_id, sha256: index.sha256, turns: index.turns.length })),
    checked: true,
    ok: errors.length === 0,
    errors,
    warnings,
    kb_report: kbReportData,
    kb_status: kbStatusText({ kb, degraded: kb_degraded, policy: kb_policy, dir: kb_dir, source: kb_source }),
    kb_source,
    kb_tried: Array.isArray(kb_tried) ? kb_tried : [],
    industry_basis: {
      source: industryMode.source,
      generic: industryMode.generic,
      industry_terms: industryMode.industry_terms,
      industry_label: industryMode.industry_label,
      mode_path: industryMode.present ? industryMode.path : '',
      config_path: runIndustry.path,
      config_source: runIndustry.source,
      note: industryMode.generic === true
        ? '本次按通用词表出稿（行业词校验已关闭）；正文的行业流程/费用/身份断言没有机械核对，需人工复核。'
        : (runIndustry.source === 'dir'
            ? `本次按工作目录里的行业配置出稿（${runIndustry.path}；行业词断言仍要求原话支撑）。`
            : '本次按技能包自带通用配置出稿（未在工作目录找到行业配置；行业词断言仍要求原话支撑）。'),
    },
    note: '机械校验通过不等于语义、医学、授权或业务状态已核实；仍需人工复核。H5 每次都会生成；校验未通过时页首列出错误清单，errors 为空才说明这页通过了机械核对。',
  })

  return {
    status: errors.length === 0 ? 'rendered' : 'needs_revision',
    sessions: indexes.map((index) => ({
      session_id: index.session_id,
      turns: index.turns.length,
      unparsed_lines: index.unparsed_lines.length,
      index_path: join(outDir, `${index.session_id}.index.json`),
    })),
    h5: h5Path,
    validation: { checked: true, ok: errors.length === 0, errors, warnings },
    kb_report: kbReportData,
    kb_status: kbStatusText({ kb, degraded: kb_degraded, policy: kb_policy, dir: kb_dir, source: kb_source }),
    kb_source,
    kb_tried: Array.isArray(kb_tried) ? kb_tried : [],
    industry_basis: {
      source: industryMode.source,
      generic: industryMode.generic,
      industry_terms: industryMode.industry_terms,
      industry_label: industryMode.industry_label,
      note: industryMode.generic === true
        ? '本次产出基于通用词表，不是行业特异配置；要按行业出稿请先跑「行业配置冷启动」。'
        : (runIndustry.source === 'dir'
            ? `本次产出按工作目录里的行业配置出稿（${runIndustry.path}）。`
            : '本次产出按技能包自带通用配置出稿（未找到工作目录行业配置；若需行业适配请先跑「行业配置冷启动」）。'),
    },
    execution_status: 'no_action_executed',
  }
}

/**
 * --stage finalize：polish 节点修完 analysis.json 之后复跑一次校验与渲染，
 * 产出**交付版**页面。
 *
 * 与 render 的差别只有两处：
 *   1. analysis 从 <out_dir>/analysis.json 读（polish 已就地改过），不是重新从提交信封取；
 *   2. 页面底部折叠面板里只呈现 **polish 明确声明修不掉** 的条目（residual），
 *      而不是把整张机械错误清单丢给读者——能在页面语境内修掉的问题，应当已经不存在。
 * 若仍有未修掉的校验错误，它们照常进面板（不能让「声称修了」变成「事实修了」）。
 */
export function runFinalize({ runInput, polish, base }) {
  const { outDir, indexes, kb, kb_cfg, kb_degraded, kb_policy, kb_dir, kb_source, kb_tried } = planIndexes(runInput, base)
  mkdirSync(outDir, { recursive: true })
  for (const index of indexes) writeJson(join(outDir, `${index.session_id}.index.json`), index)

  const analysisPath = join(outDir, 'analysis.json')
  let analysis
  try {
    analysis = readJson(analysisPath)
  } catch {
    analysis = undefined
  }
  const analysisIsObject = isObject(analysis)
  const industryMode = readIndustryMode(outDir)
  const runIndustry = resolveRunIndustryConfig(outDir, industryMode)
  const industryConfig = runIndustry.config
  const polishOutput = isObject(polish) ? polish : {}
  const polished = {
    status: nonEmptyText(polishOutput.status) ? String(polishOutput.status) : 'unknown',
    fixed: Array.isArray(polishOutput.fixed) ? polishOutput.fixed.map((item) => String(item)) : [],
    residual: Array.isArray(polishOutput.residual) ? polishOutput.residual.map((item) => String(item)) : [],
    notes: nonEmptyText(polishOutput.notes) ? String(polishOutput.notes) : '',
  }

  const details = analysisIsObject
    ? validateAnalysisDetailed(analysis, indexes, {
        industry_mode: industryMode,
        industry_config: industryConfig,
        kb,
        kb_cfg,
        kb_degraded,
      })
    : { errors: ['修复后仍没有可渲染的 analysis 对象：polish 节点必须把修好的文档写回 <out_dir>/analysis.json'], warnings: [] }
  const errors = details.errors
  const warnings = details.warnings
  const kbReportData = analysisIsObject ? kbReport(analysis, indexes, kb) : kbReport({}, indexes, kb)
  const expectedCaseId = nonEmptyText(runInput.case_id) ? runInput.case_id.trim() : ''
  if (analysisIsObject && expectedCaseId.length > 0 && analysis.case_id !== expectedCaseId) {
    errors.push(`case_id 必须与本次 run 指定的代号一致（应为「${expectedCaseId}」，实际为「${String(analysis.case_id)}」）`)
  }

  const h5Path = join(outDir, '销售简报.html')
  const pageOptions = {
    errors,
    warnings,
    residual: polished.residual,
    industry_mode: industryMode,
    industry_config: industryConfig,
    kb,
    kb_cfg,
    kb_degraded,
    kb_policy,
    kb_dir,
    kb_source,
    kb_report: kbReportData,
  }
  try {
    const page = analysisIsObject
      ? renderHtml(analysis, indexes, pageOptions)
      : renderFallbackHtml({ caseId: expectedCaseId, ...pageOptions })
    writeFileSync(h5Path, page, 'utf8')
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    errors.push(`渲染时出错，已降级为占位页：${reason}`)
    writeFileSync(h5Path, renderFallbackHtml({ caseId: expectedCaseId, ...pageOptions }), 'utf8')
  }

  const ok = errors.length === 0 && polished.residual.length === 0
  writeJson(join(outDir, '校验结果.json'), {
    analysis_path: analysisIsObject ? analysisPath : '',
    h5_path: h5Path,
    sessions: indexes.map((index) => ({ session_id: index.session_id, sha256: index.sha256, turns: index.turns.length })),
    checked: true,
    polished: true,
    ok,
    errors,
    warnings,
    residual: polished.residual,
    polish: { status: polished.status, fixed: polished.fixed, notes: polished.notes },
    kb_report: kbReportData,
    kb_status: kbStatusText({ kb, degraded: kb_degraded, policy: kb_policy, dir: kb_dir, source: kb_source }),
    kb_source,
    kb_tried: Array.isArray(kb_tried) ? kb_tried : [],
    industry_basis: {
      source: industryMode.source,
      generic: industryMode.generic,
      industry_terms: industryMode.industry_terms,
      industry_label: industryMode.industry_label,
      mode_path: industryMode.present ? industryMode.path : '',
      config_path: runIndustry.path,
      config_source: runIndustry.source,
    },
    note: '机械校验通过不等于语义、医学、授权或业务状态已核实；仍需人工复核。本页是 polish 环节修复后的交付版；页底折叠面板只列 agent 明确修不掉的条目。',
  })

  return {
    status: ok ? 'rendered' : 'needs_revision',
    sessions: indexes.map((index) => ({
      session_id: index.session_id,
      turns: index.turns.length,
      unparsed_lines: index.unparsed_lines.length,
      index_path: join(outDir, `${index.session_id}.index.json`),
    })),
    h5: h5Path,
    validation: { checked: true, ok, errors, warnings: [...warnings, ...polished.residual.map((item) => `待人工确认：${item}`)] },
    kb_report: kbReportData,
    kb_status: kbStatusText({ kb, degraded: kb_degraded, policy: kb_policy, dir: kb_dir, source: kb_source }),
    kb_source,
    kb_tried: Array.isArray(kb_tried) ? kb_tried : [],
    industry_basis: {
      source: industryMode.source,
      generic: industryMode.generic,
      industry_terms: industryMode.industry_terms,
      industry_label: industryMode.industry_label,
      note: industryMode.generic === true
        ? '本次产出基于通用词表，不是行业特异配置；要按行业出稿请先跑「行业配置冷启动」。'
        : (runIndustry.source === 'dir'
            ? `本次产出按工作目录里的行业配置出稿（${runIndustry.path}）。`
            : '本次产出按技能包自带通用配置出稿（未找到工作目录行业配置；若需行业适配请先跑「行业配置冷启动」）。'),
    },
    execution_status: 'no_action_executed',
  }
}

/** 本次 run 的输入文档路径（render/finalize 阶段需要它拿 transcripts/out_dir）：--run-input 优先，其次 FDEX_RUN_DIR。 */
export function resolveRunInputPath(cliPath) {
  if (nonEmptyText(cliPath)) return resolveUserPath(cliPath)
  const runDir = process.env.FDEX_RUN_DIR
  if (nonEmptyText(runDir)) return join(runDir, 'input.json')
  return undefined
}

// ── CLI ─────────────────────────────────────────────────────────────────────

function parseArgv(argv) {
  const positional = []
  let stage = 'index'
  let runInputPath
  let kb
  let kbMissingPolicy
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
    if (token === '--kb') {
      kb = argv[index + 1]
      index += 2
      continue
    }
    if (token === '--kb-missing-policy') {
      kbMissingPolicy = argv[index + 1]
      index += 2
      continue
    }
    positional.push(token)
    index += 1
  }
  return { stage, runInputPath, kb, kbMissingPolicy, inputPath: positional[0], outputPath: positional[1] }
}

/** 命令行给了 --kb / --kb-missing-policy 时覆盖输入文档里的同名字段（便于人工与批处理直跑）。 */
function withKbOverrides(runInput, parsed) {
  if (!isObject(runInput)) return runInput
  const merged = { ...runInput }
  if (nonEmptyText(parsed.kb)) merged.knowledge_base_dir = resolveUserPath(parsed.kb)
  if (nonEmptyText(parsed.kbMissingPolicy)) merged.kb_missing_policy = parsed.kbMissingPolicy
  return merged
}

function main(argv) {
  const parsed = parseArgv(argv)
  if (!nonEmptyText(parsed.inputPath) || !nonEmptyText(parsed.outputPath)) {
    throw new SkillError('缺少参数', 'node 入口需要 <input.json> <output.json>', '按 manifest.entrypoint 传入 inputPath 与 outputPath')
  }
  let output
  if (parsed.stage === 'index') {
    output = runIndex(withKbOverrides(readJson(resolveUserPath(parsed.inputPath)), parsed), baseDir())
  } else if (parsed.stage === 'render') {
    const runInputPath = resolveRunInputPath(parsed.runInputPath)
    if (runInputPath === undefined) {
      throw new SkillError('render 阶段找不到本次 run 的输入文档', '该阶段需要 run 的 transcripts 与 out_dir；运行时通过 FDEX_RUN_DIR 提供', '用 --run-input 显式给出本次 run 的 input.json 路径')
    }
    output = runRender({
      runInput: withKbOverrides(readJson(runInputPath), parsed),
      submission: readJson(resolveUserPath(parsed.inputPath)),
      base: baseDir(),
    })
  } else if (parsed.stage === 'finalize') {
    const runInputPath = resolveRunInputPath(parsed.runInputPath)
    if (runInputPath === undefined) {
      throw new SkillError('finalize 阶段找不到本次 run 的输入文档', '该阶段需要 run 的 transcripts 与 out_dir；运行时通过 FDEX_RUN_DIR 提供', '用 --run-input 显式给出本次 run 的 input.json 路径')
    }
    output = runFinalize({
      runInput: withKbOverrides(readJson(runInputPath), parsed),
      polish: readJson(resolveUserPath(parsed.inputPath)),
      base: baseDir(),
    })
  } else {
    throw new SkillError(`未知阶段：${parsed.stage}`, '只支持 index / render / finalize 三个阶段', '按 workflow 节点的 entrypoint 声明传 --stage index、--stage render 或 --stage finalize')
  }
  writeJson(resolveUserPath(parsed.outputPath), output)
  const validationNote = output.validation.checked
    ? (output.validation.ok ? '通过（不代表语义或医学已核实）' : `未通过 ${output.validation.errors.length} 条`)
    : '未执行（只做了索引）'
  process.stderr.write(`阶段：${parsed.stage}；状态：${output.status}；会话：${output.sessions.length}；校验：${validationNote}；HTML：${output.h5 === '' ? '未生成' : output.h5}\n`)
  return 0
}

const invokedDirectly = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2))
  } catch (error) {
    if (error instanceof SkillError) {
      process.stderr.write(`问题：${error.what}\n原因：${error.why}\n修复：${error.fix}\n`)
    } else {
      process.stderr.write(`问题：未预期的失败\n原因：${error instanceof Error ? error.message : String(error)}\n修复：检查输入文档与运行目录权限后重试\n`)
    }
    process.exitCode = 2
  }
}

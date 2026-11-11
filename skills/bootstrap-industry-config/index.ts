// 行业配置冷启动 —— skill 插件入口（受控状态机）
// index（脚本：切话轮 + 分段稿）→ bootstrap（agent：读转录抽候选词，产出配置草案）→ check（脚本：格式校验 + 干跑统计 + 报告）
// → kb-scan（脚本：知识库材料盘点与取样）→ kb-align（agent：决定字段映射/切分/机构事实/缺口）→ kb-apply（脚本：落成统一格式）
import { readFileSync } from 'node:fs'
import {
  SkillPlugin,
  type AgentNodePromptContext,
  type SkillAgentSpec,
  type SkillManifest,
  type SkillWorkflowSpec,
} from '@fdex/skill-framework'

const manifest = JSON.parse(
  readFileSync(new URL('./skill.manifest.json', import.meta.url), 'utf8'),
) as SkillManifest

export const EXTRACT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['draft'],
  properties: {
    draft: {
      type: 'object',
      description: '行业配置草案（industry-config.draft.json 的内容）',
    },
    questions: {
      type: 'array',
      maxItems: 5,
      description:
        '只能由业务方回答的问题：每条都要是「读转录看不出来、但不回答就没法定稿」的那种。只问最关键的，一条一句话。',
      items: { type: 'string', minLength: 1 },
    },
  },
}

/** kb-align 节点的提交信封：只锁「有 plan」这一层，plan 内部由 kb-apply 做兜底归一。 */
export const KB_ALIGN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['plan'],
  properties: {
    plan: {
      type: 'object',
      description:
        '知识库对齐计划：id_strategy / id_prefix / field_map / review_status_default / institution_fact_handling / term_rules / gaps / questions / notes（字段含义见 references/kb-alignment.md）。只做映射决策，不写正文。',
    },
    questions: {
      type: 'array',
      maxItems: 12,
      description: '只能由业务方回答的知识库问题（格式不支持、机构事实、同 ID 冲突、是否补材料）。',
      items: { type: 'string', minLength: 1 },
    },
  },
}

const PLAN_GUIDE = readText('./references/term-extraction.md')
const KB_GUIDE = readText('./references/kb-alignment.md')

function readText(relativePath: string): string {
  try {
    return readFileSync(new URL(relativePath, import.meta.url), 'utf8').trim()
  } catch {
    return ''
  }
}

function composeBootstrapPrompt(ctx: AgentNodePromptContext): string {
  const input = (ctx.input ?? {}) as Record<string, unknown>
  const outDir = typeof input.out_dir === 'string' ? input.out_dir : ''
  const sessions =
    (ctx.nodeOutputs['index'] as
      | { sessions?: Array<{ session_id?: string; segments_path?: string; index_path?: string; turns?: number }> }
      | undefined)?.sessions ?? []
  const previousDraft = input.draft !== undefined ? JSON.stringify(input.draft, null, 2) : ''
  const answers = input.answers !== undefined ? JSON.stringify(input.answers, null, 2) : ''

  const readList = sessions
    .map((session) => {
      const parts = [`- 会话 ${session.session_id ?? '(未知)'}（${session.turns ?? '?'} 话轮）`]
      if (session.index_path !== undefined) parts.push(`  - 索引：${session.index_path}`)
      if (session.segments_path !== undefined) parts.push(`  - 分段稿：${session.segments_path}`)
      return parts.join('\n')
    })
    .join('\n')

  return [
    '你在做「行业配置冷启动」：从真实对话转录里，为一个通用销售简报 skill 抽出并**逐步收敛**出这个行业的配置。',
    '',
    '## 你不做什​​么',
    '- 不产出销售简报，只产出**配置**。',
    '- 不做业务判断：一个词该不该拦，最终由业务负责人确认。你的任务是**提出候选、说明理由、并把必须由人回答的问题问出来**。',
    '',
    '## 本轮要读的文件',
    outDir.length > 0 ? `- 运行目录：${outDir}` : '- 运行目录：见本次 run 的 out_dir',
    readList.length > 0 ? readList : '- 索引与分段稿：见 index 节点产出',
    '',
    '抽词时**逐段读完**分段稿，不要只读开头。先看索引里各说话人编号的分布，判断谁是机构方、谁是客户。',
    '',
    previousDraft.length > 0
      ? [
          '## 这是多轮迭代的后续轮次（不要从零重抽）',
          '上一轮的草案如下，请**在它基础上增量修订**：该删的删、该补的补，保留上一轮已经确认过的词。',
          '```json',
          previousDraft,
          '```',
          answers.length > 0
            ? ['业务方对上一轮问题的回答：', '```json', answers, '```', '按这些回答改草案（例如标了 drop 的词要删掉，标了 keep 的保留并可在 questions 里请其确认判据）。'].join('\n')
            : '本轮没有带业务方的回答；如果上一轮的问题仍未确认，请在 questions 里再问一次，不要自己拍板。',
        ].join('\n')
      : '## 这是第一轮：从转录出发抽候选，不要凭行业印象编词',
    '',
    '## 你要产出什么',
    '一个对象，含 `draft` 与可选的 `questions`：',
    '',
    '```json',
    '{',
    '  "draft": {',
    '    "industry_terms": ["..."],',
    '    "completion_words": [["词", "payment|appointment|treatment"], "..."],',
    '    "post_action_words": ["..."],',
    '    "required_question_topics": ["..."],',
    '    "medical_review_topic": "须由专业人员书面回答的问题",',
    '    "page": { "notice": "...", "footer": "..." }',
    '  },',
    '  "questions": ["只能由业务方回答的问题，最多 5 条"]',
    '}',
    '```',
    '',
    '## 怎么抽词（核心）',
    PLAN_GUIDE.length > 0 ? PLAN_GUIDE : '(抽词指南缺失)',
    '',
    '## 产出要求',
    '1. `industry_terms` **只放通过三个判据的词**，宁少勿多；每个词至少 2 个字。',
    '2. `completion_words` 只在你的行业有专属完成态表达时补（付款/预约类通用词不必重复）。字段名只能取 payment / appointment / treatment。',
    '3. `required_question_topics` 写你这个行业成交前**必须问清但销售经常漏问**的项。',
    '4. `page.notice` / `page.footer` 换掉模板里的默认措辞，改成你这个行业的说法。',
    '5. `questions` 只问**读转录看不出来、但不回答就没法定稿**的事，例如：某个词在转录里没出现、但行业里其实很重要，要不要保留；这个行业还有哪些「没说过、但一旦写了就是编造」的词。',
    '',
    '抽词时注意区分：**哪些词是机构方说的**（通常是承诺/流程词，该进表）、**哪些是客户说的**（通常不是）。',
    '',
    ctx.feedback !== undefined && ctx.feedback.length > 0 ? `## 上一次提交被运行时拒绝，必须修正\n${ctx.feedback}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

/**
 * kb-align 节点的 prompt：知识库材料格式千奇百怪，字段映射必须显式决策，再交给脚本机械落盘。
 * 「不猜结构」是这一节的底线：解析不出结构就留原文并报未对齐，不允许编字段。
 */
function composeKbAlignPrompt(ctx: AgentNodePromptContext): string {
  const input = (ctx.input ?? {}) as Record<string, unknown>
  const outDir = typeof input.out_dir === 'string' ? input.out_dir : ''
  const scanOutput = ctx.nodeOutputs['kb-scan'] as
    | {
        kb_scan_path?: string
        provided?: number
        files?: number
        summary?: string
        unsupported?: number
        missing?: number
        suggested_plan?: Record<string, unknown>
      }
    | undefined
  const provided = input.knowledge_base !== undefined ? JSON.stringify(input.knowledge_base, null, 2) : '(未提供)'
  const previousKbDraft = input.kb_draft !== undefined ? JSON.stringify(input.kb_draft, null, 2) : ''
  const suggested = scanOutput?.suggested_plan !== undefined ? JSON.stringify(scanOutput.suggested_plan, null, 2) : ''

  return [
    '你在做「行业配置冷启动」的知识库对齐环节：把用户提供的知识库材料（格式可能非常多样，也可能根本没提供）**对齐成一个统一格式**，供通用版销售简报 skill 直接使用。',
    '',
    '## 你不做什么',
    '- 不抽取销售结论，也不写知识条目正文：正文来自用户材料原文，你只决定「怎么映射、怎么切分、哪些算机构事实、哪些是缺口」。',
    '- 不猜结构：解析不出结构就**如实报未对齐**（写进 gaps / questions），宁可少一条，也不把噪声抬成知识。',
    '- 不把机构价目/资质/排期当成行业知识：它们必须拆到机构事实层。',
    '',
    '## 本次 run 的材料',
    outDir.length > 0 ? `- 运行目录：${outDir}` : '- 运行目录：见本次 run 的 out_dir',
    provided.length > 0 ? ['用户传入的 knowledge_base：', '```json', provided, '```'].join('\n') : '',
    scanOutput?.kb_scan_path !== undefined ? `- 扫描结果（含每个文件的格式、字段频次、标题层级、样例片段）：${scanOutput.kb_scan_path}` : '- 扫描结果：见 kb-scan 节点产出',
    scanOutput?.summary !== undefined ? ['扫描摘要：', scanOutput.summary].join('\n') : '',
    suggested.length > 0 ? ['kb-scan 给出的**建议计划**（可以改，但改之前先读扫描结果确认理由）：', '```json', suggested, '```'].join('\n') : '',
    previousKbDraft.length > 0
      ? ['## 这是多轮迭代（不要从零重定）', '上一轮的 kb 计划如下，请**在它基础上增量修订**：', '```json', previousKbDraft, '```'].join('\n')
      : '## 这是第一轮：从扫描结果出发定映射，不要凭行业印象编结构',
    '',
    '## 你要产出什么',
    '一个对象，含 `plan` 与可选的 `questions`：',
    '',
    '```json',
    '{',
    '  "plan": {',
    '    "id_strategy": "seq | slug | from_field | title_hash",',
    '    "id_prefix": "K",',
    '    "field_map": { "id": [], "title": [], "content": [], "keywords": [], "institution_fact": [], "review_status": [] },',
    '    "review_status_default": "draft_needs_professional_review",',
    '    "institution_fact_handling": "separate_file | keep_in_industry",',
    '    "term_rules": { "from_titles": true, "from_keywords": true, "extra": [] },',
    '    "gaps": ["材料本身没覆盖的主题（下游必须显式声明缺口）"],',
    '    "questions": ["只能由业务方回答的问题"],',
    '    "notes": ["你做的取舍与理由"]',
    '  },',
    '  "questions": ["最多 12 条，去重后交给业务方"]',
    '}',
    '```',
    '',
    '## 对齐规则（必须遵守）',
    KB_GUIDE.length > 0 ? KB_GUIDE : '(对齐规则缺失：按「不猜结构、宁少勿多、机构事实拆出」三条底线处理)',
    '',
    '## 产出要求',
    '1. `field_map` 的每个键给**候选字段名数组**（按优先级），必须来自扫描结果里真实出现的键/列名；猜不到的键留空数组，不要编。',
    '2. `id_strategy`：材料里有稳定编号就用 `from_field`；否则 `seq`（`K001…`）。**同 ID 不同正文**由脚本保留首条并记冲突，你要在 questions 里问业务方怎么处理。',
    '3. `institution_fact_handling`：价目/资质/排期一律 `separate_file`（拆到机构事实层），不要混进行业条目。',
    '4. `gaps` 写**材料本身没覆盖**的主题；下游据此声明缺口，不允许拿相邻条目顶替。',
    '5. `questions` 只问材料与扫描结果看不出来、但不回答就定不了稿的事（格式不支持要不要导出、机构事实是否齐全、同 ID 冲突如何处理、是否还有别的知识库）。',
    '6. 用户**没提供知识库**也是合法情况：此时 plan 里把 `notes` 写成「未提供材料」即可，脚本会产出显式空库与缺口声明——不要编条目。',
    '',
    ctx.feedback !== undefined && ctx.feedback.length > 0 ? `## 上一次提交被运行时拒绝，必须修正\n${ctx.feedback}` : '',
  ]
    .filter((line) => line.length > 0)
    .join('\n')
}

export default class BootstrapIndustryConfig extends SkillPlugin {
  readonly manifest: SkillManifest = manifest

  override get agent(): SkillAgentSpec {
    return {
      display: { name: manifest.name, description: manifest.description },
      prompt: [
        `$${manifest.id} 是一台受控状态机：index（切话轮 + 分段稿）→ bootstrap（agent 抽候选词、产出配置草案）→ check（脚本校验格式 + 干跑统计）→ kb-scan（脚本盘点知识库材料）→ kb-align（agent 决定字段映射）→ kb-apply（脚本落成统一格式知识库）。`,
        '你的产出是**配置草案 + 对齐好的知识库**，不是销售简报。',
        '用 skill_run（skill_id=' + manifest.id + '）启动，参数是 transcripts 与 out_dir；可选 industry_name；**可选 `knowledge_base`**（一个或多个路径：文件或目录，格式可以是 jsonl/json/csv/md/txt/html；docx/pdf/xlsx 请先导出文本）。',
        'index 跑完后你会拿到分段稿与索引，读完后提交 { "draft": {...} }；kb-scan 之后你要提交 { "plan": {...} }（字段映射/切分/机构事实/缺口）。',
        'check 节点会统计每个词在转录里的真实出现次数，**从未出现的词会被标出来**——那不是让你删，是让你判断"这份转录是不是没覆盖到"。',
        'kb-apply 会把知识库落成 `knowledge-base/02_结构化数据/知识条目.jsonl`（含 retrieval_text、review_status、source-map），并产出 kb-report.md 与 kb-open-questions.md；**没有提供材料时产出显式空库**，让下游「未接入」可审计。',
        '配置与知识库**都留在本次运行目录**（out_dir），通用版 run 会从工作目录自动发现并采用；**不要替换通用版技能包里的任何模板**。如需固化行业能力，询问业务方后基于这份词表/知识库走 skill-creator 注册行业专用 skill。',
        '本 skill 不发送消息、不预约、不收款、不写业务系统。',
      ].join('\n'),
    }
  }

  get workflow(): SkillWorkflowSpec {
    return {
      // 3 次而不是 2 次（2026-11-05）：本 skill 的 bootstrap / kb-align 是 agent 节点，
      // 提交物是手写 JSON，一次笔误（类型写成数组、多塞一个键）就会消耗尝试次数；
      // 两次打满即 blocked，而 blocked 不可回卷，等于整轮冷启动白跑。
      // 语义是否正确不靠这条兜底（check / kb-apply 会机械核对），所以多给一次机会没有副作用。
      maxNodeAttempts: 3,
      nodes: [
        {
          kind: 'script',
          id: 'index',
          entrypoint: 'node scripts/run.mjs {{inputPath}} {{outputPath}} --stage index',
        },
        {
          kind: 'agent',
          id: 'bootstrap',
          outputSchema: EXTRACT_SCHEMA,
          prompt: composeBootstrapPrompt,
        },
        {
          kind: 'script',
          id: 'check',
          input: { fromNode: 'bootstrap' },
          entrypoint: 'node scripts/run.mjs {{inputPath}} {{outputPath}} --stage check',
        },
        {
          kind: 'script',
          id: 'kb-scan',
          entrypoint: 'node scripts/run.mjs {{inputPath}} {{outputPath}} --stage kb-scan',
        },
        {
          kind: 'agent',
          id: 'kb-align',
          outputSchema: KB_ALIGN_SCHEMA,
          prompt: composeKbAlignPrompt,
        },
        {
          kind: 'script',
          id: 'kb-apply',
          input: { fromNode: 'kb-align' },
          entrypoint: 'node scripts/run.mjs {{inputPath}} {{outputPath}} --stage kb-apply',
        },
      ],
    }
  }
}

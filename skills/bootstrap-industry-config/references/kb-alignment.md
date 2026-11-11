# 知识库对齐（kb-scan → kb-align → kb-apply）

冷启动不只抽词表，也把**用户提供的知识库材料**对齐成一个统一格式。理由与词表完全一样：通用版不能内置某个行业的知识，只能接受**可发现、可替换、可审计**的外部知识库。

## 〇、三段分工（谁做什么）

| 阶段 | 类型 | 做什么 | 不做 |
| --- | --- | --- | --- |
| `kb-scan` | script | 盘点材料：文件清单、格式判定、字段出现频次、标题层级、表格列、样例片段、不支持/不存在的路径 | 不产出任何条目 |
| `kb-align` | **agent** | 决定映射：`field_map`（哪个字段是标题/正文/关键词）、`id_strategy`、机构事实处理、术语派生规则、缺口与问题 | 不写正文、不编字段 |
| `kb-apply` | script | 按 plan 机械落盘：统一格式的 `知识条目.jsonl`、术语词典、机构事实层、源映射、报告、问题清单 | 不做语义判断 |

**为什么必须分三段**：格式多样性是常态（jsonl / json 数组 / md 标题分段 / txt 空行分段 / csv 表格 / html），而**映射错了比抽少了危险得多**——一条正文被映射成标题、把机构价目混进行业知识，下游会当成权威引用。所以映射决策要显式、可复核、可多轮修订。

## 一、统一格式（与通用版 sales-brief-generic 一致）

产物落在工作目录：

```
<out_dir>/knowledge-base/
  00_使用说明.md
  02_结构化数据/知识条目.jsonl                 # 每行一条
  02_结构化数据/术语与转录纠错词典.json         # [{term, related_card_id, resolution_status}]
  06_机构资料接入/机构事实录入模板.json         # 机构价目/资质/排期
  kb-source-map.json                         # 每条条目 ← 哪个源文件的哪一处
  kb-report.md
  kb-open-questions.md
```

`知识条目.jsonl` 每条的字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | ✅ | 稳定代号（`K001` 或材料自带编号）；同 ID 不同正文由脚本保留首条并记冲突 |
| `title` | ✅ | 条目名（项目/主题/问题） |
| `content` | ✅ | 正文（**来自材料原文，不改写**） |
| `sections` |  | 结构化小标题 → 段落（材料有层级时保留） |
| `keywords` |  | 检索关键词（用于「检索到了却没用」这类提醒） |
| `review_status` | ✅ | 默认 `draft_needs_professional_review`（材料几乎都是待签审的行业整理） |
| `institution_fact` | ✅ | 一律 `false`：机构价目/资质**不得**进行业层（它们拆到机构事实层） |
| `retrieval_text` | ✅ | 由 title + content + sections + keywords 机械拼成，供检索与片段核对 |
| `citation_label` | ✅ | `${id}@${version}`，页面上显示的引用标签 |
| `source_ref` | ✅ | `{file, anchor}`，来自 kb-source-map 的同一处 |

## 二、支持的格式与切分口径

| 格式 | 怎么切成条目 | 备注 |
| --- | --- | --- |
| `jsonl` | 每行一个对象；字段按 `field_map` 取 | 坏行跳过并进「未对齐」清单，不中断 |
| `json` | 数组（或对象里第一个对象数组）逐元素；单对象 → 一条 | 解析失败直接报「未对齐」，不做「尽力猜」 |
| `csv` / `tsv` | 表头 → 字段，数据行 → 条目 | 列名要进 `field_map` 候选 |
| `md` / `markdown` | 按标题层级切；一级标题 + 二级条目时取第二层作边界，更深层并入上一条正文 | 无标题的前言块记为「未成条目」 |
| `txt` | 按空行分段，首行当标题、其余当正文 | 整份文件只有一个文字块 → 标「未对齐」，请人工分段 |
| `html` | 先剥标签（保留段落与标题结构），再按 md 规则切 | 不解析脚本/样式 |
| `docx` / `pdf` / `xlsx` 等二进制 | **不支持**，进「不支持」清单并要求导出为文本 | 不假装能读二进制 |

## 三、plan 的字段（agent 提交）

| 字段 | 取值 | 说明 |
| --- | --- | --- |
| `id_strategy` | `seq` / `slug` / `from_field` / `title_hash` | 材料有稳定编号用 `from_field`；否则 `seq`（`K001…`） |
| `id_prefix` | 字符串 | `seq`/`title_hash` 时的前缀，默认 `K` |
| `field_map` | `{id, title, content, keywords, institution_fact, review_status}` 各为字符串数组 | **只能是扫描结果里真实出现的键/列名**；猜不到留空数组 |
| `review_status_default` | 字符串 | 默认 `draft_needs_professional_review` |
| `institution_fact_handling` | `separate_file` / `keep_in_industry` | 默认 `separate_file`（机构事实拆出） |
| `term_rules` | `{from_titles, from_keywords, extra[]}` | 术语词典如何派生；`extra` 可指定 `{term, related_card_id, resolution_status}` |
| `gaps` | 字符串或对象数组 | **材料本身没覆盖**的主题；下游据此声明缺口，不得拿相邻条目顶替 |
| `questions` | 字符串数组 | 只能由业务方回答的问题 |
| `notes` | 字符串数组 | 你的取舍与理由（可审计） |

## 四、三条底线

1. **不猜结构**：解析失败、无结构的长文、二进制文件，一律进「未对齐/不支持」清单并进 questions；不硬编字段、不把整段文字当标题。
2. **宁少勿多**：同一 id 冲突保留首条并记录；重复材料合并并记录；抽不准的不进库。误命中比漏项危险得多（与词表同一条结论）。
3. **机构事实与行业知识分层**：价目/资质/排期拆到 `06_机构资料接入/机构事实录入模板.json`，且金额必须补币种/单位/包含项/出处与 `valid_until` 才能当报价用（模板里这些字段留空，由业务方补）。

## 五、没有知识库也是合法输入

用户可能根本没提供材料。此时：

- `kb-scan` 报 `provided=0 / files=0`；
- `kb-apply` 产出**显式的空库**（空 `知识条目.jsonl`、空术语词典、`kb-report.md` 写明「本次没有可用知识库」、`kb-open-questions.md` 问「是暂时没有还是漏传了」）；
- 通用版 run 会判定「未接入」，页面不含任何知识依据，并在页首写明——**这是如实，不是失败**。

## 六、多轮收敛（与词表同一套）

- 带 `kb_draft`（上一轮的 plan）续跑：只改映射决策，不重走扫描；
- `answers`/`questions` 由业务方确认后写回：格式要不要导出、机构事实是否齐全、同 ID 冲突如何处理、是否还有别的知识库；
- 每一轮都覆盖写当前状态，历史只追加进 `dialog.jsonl`（与词表轮次共享同一份账本）。

## 七、与词表的同构关系（为什么这样设计）

| 词表层 | 知识库层 |
| --- | --- |
| `industry-config.json` 的 `industry_terms` | `knowledge-base/02_结构化数据/知识条目.jsonl` |
| 模板在技能包、实例在工作目录 | 模板（约定）在技能包、实例在工作目录 |
| 判据是能 `JSON.parse` 且 `industry_terms` 非空 | 判据是能读出 ≥1 条 `id` 合法的条目 |
| 冷启动从真实转录抽词 | 冷启动从用户材料对齐条目 |
| 两档校验：转录说过没引到 → 提醒；转录没有 → 拒收 | 两档校验：命中没引用 → 提醒；片段不在卡里 → 拒收 |
| `industry-mode.json` 落基准、页首横幅 | `kb-mode.json` + 页首知识库横幅（已接入 N 条 / 未接入 / 已降级） |
| 固化：问是否注册行业专用 skill | 同一条路径：配置＋知识库一起固化进新 skill |

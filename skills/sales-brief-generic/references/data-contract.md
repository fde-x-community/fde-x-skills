# 数据契约（通用版）

UTF-8 JSON 对象。顶层字段必须严格符合 `schemas/analysis.schema.json`——**多一个字段会被拒收，少一个必填字段也会**。

> 本契约的**结构**是行业无关的；**字段的业务语义**在少数几处与具体行业相关（见每节末尾的「需行业适配」提示与根目录《行业适配指南》）。

## 顶层

`schema_version` 固定 `2.0`；`case_id` 为非空代号（不要用真实姓名）；`summary` 是自然语言概览，**只能汇总下文有证据的项目**。

`decision_stage` 必填，回答"这单走到哪一步"：`awareness`（刚了解）、`exploration`（摸底需求）、`comparison`（比价/比方案）、`consideration`（进入方案讨论）、`price_blocked`（卡在价格）、`ready_for_next_step`（开始谈实施条件）、`verbally_agreed`（口头同意但未开局）、`opened`（已开单/已登记）、`transaction_recorded`（有正式收款或预约记录）、`deferred`（明确延后）、`declined`（明确拒绝）、`unknown`。阶段判断必须能在 `timeline` 里找到对应证据，不能凭文件名或印象。

`contact_policy` 为 `unknown`、`allowed`、`restricted`、`stop_all`；`allowed` 仅在转录里有**明确的同意原话**时使用，单方提议"来扫我"不算。`contact_note` 说明范围与依据缺失。

`transaction` 含三个键（键名由行业配置的 `transaction_keys` 提供，默认 `payment` / `appointment` / `treatment`），各取四档之一：

| 值 | 含义 |
| --- | --- |
| `unknown` | 没有任何线索 |
| `oral_only` | 只有口头意愿或口头安排 |
| `opened` | 已开单 / 已登记 / 已占位，但未完成 |
| `verified` | 有可核验凭证，且必须在 `transaction_evidence` 给凭证描述 |

口头意愿、工作人员拟安排、文件名标签一律不算 `verified`。**开单不等于收款，占位不等于系统预约，准备开始不等于已完成。**

> **需行业适配**：三个键名与「什么算已完成」的定义。换行业时在 `industry-config.json` 的 `transaction_keys` 里给出新键名，并同步改 schema。

## evidence

每项 `{id, session_id, turn_id, quote, role, role_status}`。`quote` 必须是对应原话的**连续子串**；`turn_id` 从索引原样抄；`role_status` 为 `confirmed`、`candidate`、`unknown`、`mixed`，`confirmed` 只用于有可靠身份依据的情况，合并话轮写 `mixed`。

**每一条 evidence 都必须至少被一个条目引用一次。** 收了不用的证据会被拒收——孤儿证据往往正是被丢掉的关键事实。

但"有归宿"不等于"硬挂"。一条证据找不到归宿时，只有两个合规出口：

1. **它指向一条你漏掉的结论** → 补上那条结论（这是绝大多数情况）；
2. **它确实与任何结论无关** → **删掉这条证据**。

不允许第三种做法：挂到不相干的条目上凑数。**孤儿检查只能证明"有归宿"，证明不了"归宿对"**，最后这一步判断必须由作者自己做。

## profiles / timeline / barriers

每项 `{title, text, status, evidence_ids}`，`status` 为：

| status | 用途 |
| --- | --- |
| `stated` | 客户本人表达。不得引用 `mixed`/`unknown` 证据，也不得把机构口径写成客户话 |
| `other` | 他人说法：销售人员报价、管理人员判断、推销话术、转述 |
| `inferred` | 分析推断，须让读者看出这是推断 |
| `unknown` | 待确认 |
| `pending_confirmation` | 归属待复听（`role_status` 为 `candidate`/`mixed` 时用这一档，且**不得在此档写"客户明确…"**，标题也不行） |
| `conflict` | 同一事实存在冲突版本，详细并列写进 `conflicts` |

**引号只能放逐字引文**：正文里每个 `「…」`片段都必须是**该条目自己 `evidence_ids` 所引证据**的连续子串。推断词（"避免""与…无关""明确""只认"）不能塞进引号。

**完成态必须对得上**：正文出现完成态词（`industry-config.json` 的 `completion_words`）时，`transaction` 对应项必须是 `verified`（"未成交""还没付款"这类否定形态不触发）。

## actions

每项 `{title, content, purpose, condition, script, owner, done_when, scope, evidence_ids}`；`scope` 为 `internal` 或 `contact`，`internal` 的 `script` 必须为空串。`stop_all` 时不允许 `contact`；`unknown`/`restricted` 时 `contact` 的 `condition` 必须写明须先取得该范围的许可。

## oral_quotes

口头报价单列，每项 `{item, amount, by, evidence_ids}`（可选 `note`）。`amount` **按原文写法照抄**。**只要 `oral_quotes` 非空，`summary` 里就必须出现「口头」**，否则金额会被读成正式价格。

## conflicts

同一事实的多口径并列，每项 `{item, versions, evidence_ids}`（可选 `note`）。`versions` **至少两个版本**，各带来源。**不允许私自抹平成一个数**——同一件事的三种说法都必须并列保留。

## unknowns

未知待问清单，每项 `{item, why}`。**没问到的不等于没有**：`industry-config.json` 的 `required_question_topics` 里列的必问项，凡转录里没出现的都写进来，并说明为什么未知、该怎么问。

> **需行业适配**：`required_question_topics`（必问项清单）是行业相关的——不同行业该问的东西完全不同。

## projects

项目/标的物状态一览，至少一项，每项 `{name, status, evidence_ids}`（可选 `note`）。`status` 为 `mentioned`（仅机构提到）、`exploring`（客户在了解）、`comparing`（比较中）、`decided`（已定）、`declined`（明确不做）、`deferred`（明确延后）、`done`（本次已完成）、`unknown`。标了状态就必须给证据。

**多项目客户不能只写主诉那一个。** 加推的、被明确暂缓的同样是销售资产——它们该有自己的一条状态，而不是消失。

> **需行业适配**：「项目」这个概念的实体名（服务项目 / 房源 / 课程 / 商品）。字段名 `projects` 可保留，但语义要重新说明。

## client_facts

结构化客户事实，每项 `{item, state}`（可选 `value`/`note`/`evidence_ids`）。`state` 四档：`confirmed_by_client`（客户本人说过**且证据角色为 `confirmed`**，必须给 value 与证据）、`likely_client`（疑为客户说法——证据角色是 `candidate`/`mixed` 时用这一档）、`staff_claim`（只有机构说法）、`unknown`（没问过或无法确认）。

**没问过也要列出来并标 `unknown`**——"未提及"和"没有"是两件事，读简报的人需要知道哪些是真没有、哪些是根本没问。

> **需行业适配**：`industry-config.json` 的 `required_question_topics` 决定问哪些。

## medical_review_questions

**须由专业人员书面回答的问题**，每项 `{question, why}`（可选 `evidence_ids`）。凡是涉及专业判断、资质边界、风险责任的事项都进这里，**不得由销售侧直接下判断**。

判据：如果这个问题答错了会有法律/医疗/财务后果，它就该进这里，而不是写在正文里。

> **需行业适配**：字段名可保留；`industry-config.json` 的 `medical_review_topic` 决定页面上这一栏的标题（如房产的「须转法务回答的问题」）。

## analysis_meta

`{coverage, turns_read, sessions, limitations}`。`coverage` 为 `full` 或 `partial`；`turns_read` 必须等于索引话轮数；`partial` 时 `limitations` 不能为空。这份元数据是"覆盖声明"，读简报的人据此判断结论能信到什么程度。

## 知识库扩展字段（v0.8.0-kb，可选；接入知识库时启用）

下述字段在**不接知识库时全部省略**；一旦本次 run 给了 `knowledge_base_dir`，按下表校验。规则细节见 [kb-integration.md](kb-integration.md)。

| 位置 | 字段 | 类型 | 规则 |
| --- | --- | --- | --- |
| 顶层 | `kb_basis` | 对象 | 可选。声明本次依据的知识库摘要；`connected=true` 而未提供知识库目录 → 失败 |
| 顶层 | `kb_gaps` | 数组 | **接入知识库时必需**（没缺口写 `[]`）。每项可为字符串，或对象 `{topic, why_missing, fallback, must_not_use_cards[], evidence_turns[]}` |
| 顶层 | `kb_unused_notes` | 对象 | 可选，`{卡片id: 为什么刻意不用它}`；键必须是真实存在的卡片 |
| 顶层 | `input_binding` | 对象 | **接入知识库时必需**：`{kb_fingerprint, transcripts:{session_id: sha256}}`。index 阶段的输出里已给出可直接抄的值 |
| profiles / timeline / barriers / actions 条目 | `kb_refs` | 字符串数组 | 引用的知识条目 id，必须存在于**当次**知识库；不得指向机构事实层（`institution_fact=true`）；不得引用缺口 `must_not_use_cards` 点名的卡 |
| 条目 | `kb_excerpts` | 数组 | 有 `kb_refs` 就必须有：每项 `{id, quote, used_for}`。`quote` 必须是该卡正文的连续片段（比对忽略空白与全半角标点）；`used_for` 必须是本条标题或正文的子串 |
| 条目 | `term_status` | `confirmed` / `candidate` / `unknown` | 术语三态。涉及项目名/品牌名/方法名时必填 |
| 条目 | `kb_term` | 字符串 | `term_status=confirmed` 时必需：知识库里的正确写法 |
| 条目 | `term_note` | 字符串 | `candidate`/`unknown` 时必需；`candidate` 还必须含「疑似/待核」字样 |

三态的含义（不要与 `status` 混用：`status` 说的是"谁说的"，`term_status` 说的是"这个名字是不是它"）：

- `confirmed`：文本里的写法就是知识库的术语，可直接引用其项目卡。
- `candidate`：疑似为某术语（同音/近音/字序/漏字），**原话保留不改写**，正文以"疑似/待核"表述。
- `unknown`：认不出对应哪个术语，不得猜、不得静默当成已知品牌。

## 底线

页面显示校验通过 ≠ 事实/专业意见/授权/交易状态已核实。机械校验只覆盖结构、引用与上述可判定的规则；语义蕴含、角色归属、专业判断与客户授权仍需人工复核。

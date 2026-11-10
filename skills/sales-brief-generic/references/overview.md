# 销售咨询简报 · 通用版（设计说明）

> 这是 sales-brief-generic 的设计说明。触发条件、执行步骤与停止边界见 [../SKILL.md](../SKILL.md)。

`sales-brief-generic` —— 一个 FDE-X skill 包（行业无关骨架）：把销售咨询转录索引成可追溯的原话话轮，由 agent 节点做语义分析，再由脚本机械校验、并按本次生效的行业配置渲染成离线内部销售简报 H5；没有行业配置时按通用词表出稿，页首标注「不是行业特异」。

**可选接入企业行业知识库**（只读）：接入后逐话轮产出术语命中，引用的知识卡片必须带卡片原文片段，缺口必须结构化声明，页面多出「知识依据 / 知识缺口 / 知识库体检」三块。

## 为什么是状态机

| 节点 | 类型 | 干什么 | 失败会怎样 |
| --- | --- | --- | --- |
| `preflight` | **agent** | 行业配置自检：**工作目录**里有没有可用的 `industry-config*.json`（判据是 `industry_terms` 非空）与可读的行业知识库；两者都是可选项，缺配/需完善就问用户要不要配一次，同意则先跑「行业配置冷启动」——产物留在工作目录（不替换技能包） | 节点不拒绝；用户不配就以现有配置/通用词表继续，结论写进 `notes` |
| `index` | script | 转录 → 索引（原始行号 + 输入 SHA-256），输出 `status=index_only` | 退出码 2 + 三段式原因 |
| `extract` | **agent** | 读索引 + 分析指南 + 数据契约，产出 analysis 并提交 `{ analysis }` | 节点本身不拒绝（见下）；内容不合格交给 render/polish 消化 |
| `render` | script | 校验 `fromNode: extract` 的提交，**并且总是渲染 H5** | 校验不过 → `status=needs_revision`，H5 照常生成、核对清单折叠在页底 |
| `polish` | **agent** | 读 render 的核对清单与已渲染页面，就地修 `analysis.json`（算式结论落进正文、归属措辞与档位对齐、对客话术去掉未发生的后续安排等），交回 `{ status, fixed, residual }` | 不拒绝；修不掉的一条条写进 `residual`，不许既不修也不报 |
| `finalize` | script | 读回修好的 `analysis.json` 复跑校验与渲染，产出**交付版** | 仍有错误/residual → `status=needs_revision`，页面照常生成，页底折叠面板只列这些条目 |

### 启动时的行业配置自检（`preflight`）

本 skill 的行业能力全部来自**行业配置**（词表 / 枚举 / 标签 / 必问项 / 页面文案），但**行业配置是可选项**：

- **有配置**（工作目录里的 `industry-config*.json`）→ 按该行业出稿：词表与必问项贴合，行业词校验也更严。
- **没有配置** → 直接按通用词表出稿，照样跑完；页面与 run 输出都标注「基于通用词表、不是行业特异」，不会让它看起来像适配过。**这是正常路径，不是失败。**
- **想要行业特异、但手上还没有配置** → 跑一次 `bootstrap-industry-config`（冷启动），从你自己的转录里抽出词表 / 必问项 / 页面措辞，产物落在工作目录，不替换技能包。

行业配置属于「当前工作目录」，技能包只带一份通用模板。所以 `preflight` 的第一件事是确认「这个行业配好了没有」，再决定**要不要问你要不要配一次**：

| 检查项 | 判定真值 | 找不到时 |
| --- | --- | --- |
| 行业字段替换文件（工作目录） | `out_dir` 或其 `industry-config/` 子目录里的 `industry-config*.json`（也兼容转录目录 / 其上一级 / pwd），能被 `JSON.parse` 且 `industry_terms` 非空——**工作目录优先** | 询问是否先跑 `bootstrap-industry-config` |
| 行业知识库 | `知识条目.jsonl`、`02_结构化数据/`、目录名含「知识库/行业知识」、`*知识库*.json`，且能读出 ≥1 条 | 只记录「没有」，不阻断（知识库是加分项，不是必需） |
| 技能包自带配置 | `assets/industry-config.json` 只是**通用模板**（`_industry` 含 generic/未适配 就算没适配过），**永远不被行业配置替换** | 等同「没有配置」 |

判定结果决定问不问（`industry_check` 参数可覆盖）：**没配置** → 问「要不要先跑冷启动」；**已有配置但本次是新转录** → 问「要不要用冷启动做一轮完善（带上一轮 draft 续跑）」；**同行业配置已可用** → 不问，直接开跑。

用户同意后，`preflight` 会按顺序做这几件事：`skill_run(bootstrap-industry-config)` 跑一轮冷启动（同一批转录、`<out_dir>/industry-config` 作为运行目录）→ 在它的 `bootstrap` 节点逐段读分段稿提交 `draft` → **把冷启动留下的待定问题用一次 `ask_user_question` 逐条问全**，拿到答复或明确同意 → 产物留在工作目录（`<out_dir>/industry-config/industry-config.draft.json`，run.mjs 自动发现）→ **问一次「要不要基于这份词表注册行业专用 skill」** → **明确告诉你「已完成行业适配（industry_terms N 个词，配置在 `<out_dir>/industry-config/…`），接下来按 `<industry>` 出销售简报」** → 写 `<out_dir>/industry-mode.json` → 才继续 `index → extract → render`。全程不修改技能包的 `assets/industry-config.json`。

用户选择不跑（或传 `industry_check=generic`）时走通用词表：`industry-mode.json` 记 `generic=true`，`render` 把行业词校验关掉，H5 页首顶一条红底横幅「本次基于通用词表（未做行业适配）」，`run.output.industry_basis` 里也写明「不是行业特异」——**不会让它看起来像适配过**。

规则只有一份：[industry-preflight.md](industry-preflight.md)。它同时被 `preflight` 节点和 `extract` 节点的第 0 步引用——**插件是应用启动时挂载的，改了 `index.ts` 要重启 FDE X 才会出现 `preflight` 节点**；在那之前，`extract` 会按同一份规则先做检查（节点存在时则直接沿用它的结论，不重复问）。没有 `industry-mode.json` 时，`render` 在页首写明「配置基准未标注」，而不是假装按行业配置跑过。

参数 `industry_check` 用来覆盖默认询问行为：`auto`（默认，按上表判断并询问）/ `skip`（不问，直接用现有配置，适合批量）/ `bootstrap`（不问，强制先冷启动）/ `generic`（不问，强制按通用词表出稿，并在页面与输出里标注）。

## 分工

| 谁 | 做什么 |
| --- | --- |
| `index.ts`（插件） | 声明六个节点、`extract` 与 `polish` 的 prompt 与（只锁信封的）outputSchema |
| agent 节点 | 语义：客户要什么、卡在哪、意向怎么变、下一步该做什么；以及按核对清单修复交付稿 |
| `scripts/run.mjs` | 索引、机械校验、离线 H5 渲染、三个 script 阶段（index / render / finalize）的 CLI |
| 人 | 复核语义、医学、授权与视觉；处理残留在页底的 `residual` 条目 |

## 目录

以下都是**包内路径**（相对 skill 根目录）；运行时产物写在 `out_dir`，不在包里。

```
SKILL.md                     触发条件、执行步骤、停止边界（模型入口）
agents/openai.yaml           宿主界面展示名、短描述与默认调用提示
logs/                        运行日志契约 + 合成事件样例（不含真实日志）
index.ts                     插件入口：声明六个节点 + extract / polish 的 prompt/outputSchema + 提交校验钩子
skill.manifest.json          运行时契约（inputs/outputs/entrypoint/timeout）
scripts/run.mjs              索引 / 校验 / 渲染 / finalize + --stage index|render|finalize 的 CLI
scripts/kb.mjs               知识库接入：读取/指纹/术语命中/引用与缺口校验/体检报告
assets/h5-template.html      H5 骨架与样式（渲染时填占位符；核对清单折叠面板在页底）
assets/industry-config.json  行业配置通用模板（永不被行业配置替换）
schemas/                     analysis.json 与 index.json 的结构声明
references/                  analysis-guide / data-contract / kb-integration / industry-preflight / usage / overview 等
examples/golden|edge|failed  行为样例；fixtures 是合成转录与合成 analysis
tests/                       node:test 回归（run.test.mjs + kb.test.mjs）+ cases.json + scenario-matrix.json
VERSION.json                 发布元数据
```

## 可选：接入企业行业知识库

本 skill 可以**可选**接入企业行业知识库（只读）。

```jsonc
{
  "transcripts": [{ "session_id": "S1", "path": "D:\\data\\转录.txt" }],
  "out_dir": "D:\\data\\run-01",
  "knowledge_base_dir": "D:\\data\\行业知识库",   // 可选；只读。给了就必须能读出来
  "kb_missing_policy": "error"                    // 可选：error（默认，读不出就失败）| degrade（显式降级）
}
```

| 阶段 | 接入知识库后多做什么 |
| --- | --- |
| `index` | 逐话轮写 `term_hits`（只认知识库正确写法）、可选 `term_suspects`（配置里声明的已知误写，只提示不改写）；索引头记知识库指纹与每张卡的正文哈希；输出给出可直接抄的 `input_binding` |
| `extract` | 语义分析额外产出：`kb_refs` + `kb_excerpts{id, quote, used_for}`（双可回查）、`kb_gaps{topic, why_missing, fallback, must_not_use_cards, evidence_turns}`、术语三态、`input_binding` |
| `render` / `finalize` | 机械校验引用存在性/层级、片段是否真在该卡正文里、`used_for` 是否落在本条正文上、缺口是否可追且未过期、禁用卡是否被引用、指纹绑定是否一致；页面增加「知识依据 / 知识缺口 / 知识库体检」三块与页首知识库横幅；输出附 `kb_report` |

**不接知识库时**：页面照旧，只是写明「未接入」，不含任何知识依据；**接了却读不出来**默认直接失败（不允许「以为接了其实没接」），只有显式 `degrade` 才降级并在页首标注「不可用，已显式降级」。完整规则、判定顺序与覆盖边界见 [kb-integration.md](kb-integration.md)。

**知识库与词表同构**：不需要把绝对路径塞进输入——库目录按「显式参数 → 运行目录约定位置（含冷启动落点 `<out_dir>/industry-config/knowledge-base`）→ 运行目录里名字像知识库的子目录 → 行业配置 `knowledge_base.dirs` → 转录目录」自动发现，判据是能读出 ≥1 条合法条目；库的形状配置来自本次生效的行业配置（工作目录优先）；index 阶段把基准写进 `<out_dir>/kb-mode.json`（来源 / 指纹 / 记录数 / 试过的候选），页首横幅写明来源。没有知识库仍是合法状态（如实「未接入」）。

知识库目录的既定约定是 `02_结构化数据/知识条目.jsonl`（每行一条、至少 `id`）+ 可选的 `术语与转录纠错词典.json`；库的形状不同时改行业配置的 `knowledge_base` 段（`entry_files` / `text_fields` / `title_field` / `keywords_field` / `institution_fact_field` / `review_status_field` / `confusables`），代码不用动。

## 调用

```json
{
  "transcripts": [{ "session_id": "S1", "path": "D:\\data\\转录.txt", "sequence": 1, "session_date": "2026-01-01" }],
  "out_dir": "D:\\data\\run-SYN-01",
  "case_id": "SYN-01",
  "knowledge_base_dir": "D:\\data\\行业知识库"
}
```

`skill_run`（skill_id=`sales-brief-generic`）按 preflight → index → extract → render → polish → finalize 推进；详细说明见 [usage.md](usage.md)。

## 边界

- 只吃 `[HH:MM:SS] 发言人：文本`；其他格式需先转换并人工核对。
- 校验通过只说明结构与引用规则成立，不证明语义正确、医学正确，也不证明客户授权或凭证真实。
- **知识库引用同理**：`kb_excerpts` 只能证明「这段卡片原文被认为支撑这句结论」，不能证明语义蕴含；被引条目多为待签审的行业整理，引用它不等于专业审核通过。术语命中是字面匹配，同义词/简称/拼音误写不保证命中（除非在行业配置里声明 `confusables`）。
- 页面为内部分析草稿，含敏感资料；折叠证据不等于脱敏或访问控制。
- 合成样例的逐条分析由人预先编写，不是程序独立推理。
- 未机械化的三类（逐条列在 `VERSION.json` 的 `known_limits` 里）：报价链被称「闭合」但实际有差额、同一事实被标两种互斥档位、漏收客户主动提出的诉求——需要语义判断，硬做规则会误伤，只能靠人审。
- 不联网，不发消息、不预约、不收款、不写业务系统。
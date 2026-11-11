# 行业配置冷启动（bootstrap-industry-config）

> 这是 bootstrap-industry-config 的设计说明。触发条件、执行步骤与停止边界见 [../SKILL.md](../SKILL.md)。

`bootstrap-industry-config` —— 一个 FDE-X skill 包：从某行业的真实对话转录出发，围绕已有转录与 agent 的多轮问答，逐步收敛出一份可用的**行业配置**（词表 / 必问项 / 页面措辞），让通用版销售咨询简报 `sales-brief-generic` 在该行业跑得动、说得准；它不产出简报，只产出配置。

**本 skill 是可选组件。** 通用版**没有行业配置也能出稿**——按通用词表生成，页面与 run 输出都会标注「基于通用词表、不是行业特异」。所以只有在你想要「行业特异」、而手上还没有配置时，才需要跑一次本 skill；跑完的配置落在当前工作目录，由通用版自动发现。

## 为什么是状态机

冷启动不是「让 agent 读一遍转录抽一批词」：那样换一次会话就重来一次，抽出来的词也没有人确认，更不知道什么时候算收敛。所以把它做成状态机——机器先切话轮、给每一轮留下可核对的数据，agent 只在「读分段稿、按判据抽词」这个固定节点出现，抽出的词还要经过脚本按格式与真实命中话轮数核对，收敛判定同样由脚本给出：

| 节点 | 类型 | 干什么 | 失败会怎样 |
| --- | --- | --- | --- |
| `index` | script | 转录 → 话轮索引（原始行号 + 输入 SHA-256）+ 每 100 话轮切分的分段通读稿 | 退出码 2 + 三段式原因 |
| `bootstrap` | **agent** | 先读索引里的说话人编号分布判断谁是机构方，再逐段通读，按「三个判据」抽候选词，提交 `{ draft }` | 节点本身不拒绝；草案不合格由 check 判 |
| `check` | script | 校验草案格式，统计每个词在转录里的**真实出现话轮数**（0 命中会被标出并给处置选项），写 `bootstrap-report.md` / `open-questions.md`，给出收敛判定 `ready_for_review` / `needs_more_rounds` | 只返回判定与清单，不抛错；run 正常收尾 `status=drafted` |

确定性部分都在 [../scripts/run.mjs](../scripts/run.mjs) 里，规则说明见 [term-extraction.md](term-extraction.md) 与 [kb-alignment.md](kb-alignment.md)。

### 多轮怎么收敛

冷启动的产物是「待业务确认的草案」，不是最终配置，所以状态机按轮推进：一次 run 推进一轮，带上一轮的 `draft` 与业务方对上一轮问题的 `answers` 续跑，`check` 给出收敛判定 `ready_for_review` 或 `needs_more_rounds`。当前状态文件覆盖写（内容不变就不写），历史只追加进 `dialog.jsonl`，索引按转录 SHA-256 幂等复用——**目录里始终只有当前状态 + 一个 dialog.jsonl**。

`open-questions.md` 里的问题读转录看不出来，只能由业务方回答；它们不计入机械收敛判定，但直接决定这份配置能不能定稿。

### 每一轮留下什么（都在 out_dir）

| 文件 | 内容 |
| --- | --- |
| `<session_id>.index.json` | 话轮索引（原始行号 + 输入 SHA-256，引用一律以它为准） |
| `<session_id>.segments.md` | 分段通读稿（每 100 话轮一段） |
| `industry-config.draft.json` | 行业配置草案（`_industry` / `industry_terms` / `completion_words` / `required_question_topics` / `page` 等） |
| `bootstrap-report.md` | 逐词出现次数、0 命中说明、下一步 |
| `open-questions.md` | 待业务确认问题（含 agent 提出的建议确认项） |
| `dialog.jsonl` | 多轮历史，每轮追加一行，文件数不随轮数增长 |

## 分工

| 谁 | 做什么 |
| --- | --- |
| `index.ts`（插件） | 声明六个节点、`bootstrap` 与 `kb-align` 的 prompt 与（只锁信封的）outputSchema |
| agent 节点 | 判断谁是机构方、逐段通读按三个判据抽词、提出只有业务方能回答的问题 |
| [scripts/run.mjs](../scripts/run.mjs) | 话轮切分、分段稿、干跑统计、草案校验、报告生成，以及 index / check / kb-scan / kb-apply 四个 script 阶段的 CLI |
| [scripts/kb.mjs](../scripts/kb.mjs) | 知识库材料盘点（格式/字段/样例）、按 plan 机械落成统一格式、报告与待确认问题生成 |
| 人 | 回答 `open-questions.md`、确认词表能不能拦、决定是否基于词表注册行业专用 skill |

## 目录

```text
SKILL.md                     触发条件、执行步骤与停止边界（模型入口）
agents/openai.yaml           界面元数据与默认调用话术
index.ts                     插件入口：workflow 节点声明 + bootstrap / kb-align 的 prompt/outputSchema
skill.manifest.json          运行时契约（inputs/outputs/entrypoint/timeout）
scripts/run.mjs              index / check / kb-scan / kb-apply 四个 script 阶段的 CLI
scripts/kb.mjs               知识库对齐：盘点 → 解析 → 落盘 → 报告 → 问题清单
assets/industry-config.template.json  行业配置模板（字段说明见本文件与 term-extraction.md）
references/overview.md                本文件：设计说明与取舍
references/term-extraction.md         抽词指南（三个判据 + 词的三类 + 禁区 + 抽取流程 + 自检）
references/kb-alignment.md            知识库对齐规则（格式矩阵、plan 字段、三条底线、与词表的同构关系）
schemas/industry-config.schema.json   配置结构声明
examples/golden|edge|failed           行为样例；fixtures 是合成转录
tests/                       node:test 回归（run.test.mjs + kb.test.mjs）+ cases.json + scenario-matrix.json
logs/                        日志契约与合成样例
VERSION.json                 发布元数据
```

## 调用

```json
{
  "transcripts": [
    { "session_id": "S1", "path": "D:\\data\\transcript-01.txt" },
    { "session_id": "S2", "path": "D:\\data\\transcript-02.txt" }
  ],
  "out_dir": "D:\\data\\industry-bootstrap",
  "industry_name": "<industry_name>"
}
```

- `transcripts`：该行业的真实对话转录（至少一份，越多抽得越准），格式每条一行 `[hh:mm:ss] 发言人N：文本`。
- `out_dir`：索引、分段稿、草案与报告都写在这里。
- 可选：`industry_name`（不给由 agent 从转录推断）；`draft`（上一轮草案，续跑时优先用 bootstrap 节点提交物，没有才回落到它）；`answers`（对上一轮 open-questions 的回答，只影响收敛判定）；`round`（显式轮次号，默认按 `dialog.jsonl` 行数 + 1）；`keep_snapshot`（额外保存一份轮次快照，默认 false）。
- 可选：`knowledge_base`（一个路径或路径数组，文件或目录，目录会递归展开；支持 `.jsonl/.json/.md/.txt/.csv/.tsv/.html`，docx/pdf/xlsx 会进「不支持」清单）；`kb_draft`（上一轮的知识库对齐计划，续跑时只改映射、不重扫材料）。

`skill_run`（skill_id=`bootstrap-industry-config`）即按 index → bootstrap → check → kb-scan → kb-align → kb-apply 推进；详细说明见 [term-extraction.md](term-extraction.md) 与 [kb-alignment.md](kb-alignment.md)。离线调试可用：

```text
node scripts/run.mjs <input.json> <output.json> --stage index
node scripts/run.mjs <node-bootstrap.json> <output.json> --stage check --run-input <input.json>
```

## 知识库对齐：为什么也要放进冷启动

词表解决「哪些词必须有原话支撑」，知识库解决「哪些项目/主题的说法是权威的」。两者是同一件事的两面，所以用同一套设计：

| 词表层 | 知识库层 |
| --- | --- |
| 模板在技能包、实例在工作目录 | 模板（统一格式约定）在技能包、实例在工作目录 `<out_dir>/knowledge-base/` |
| 判据是能 `JSON.parse` 且 `industry_terms` 非空 | 判据是能读出 ≥1 条合法条目 |
| 从真实转录抽词 | 从用户材料对齐条目 |
| `open-questions.md` 问业务方 | `kb-open-questions.md` 问业务方 |
| 通用版按工作目录自动发现配置 | 通用版按工作目录自动发现知识库（含 `<out_dir>/industry-config/knowledge-base`） |

用户材料格式千奇百怪，**先对齐、再使用**：

1. `kb-scan`（脚本）：只盘点不产条目——文件清单、格式判定、字段出现频次、标题层级、表格列、样例片段、不支持/不存在的路径；
2. `kb-align`（agent）：决定 `field_map`（哪个字段是标题/正文/关键词）、`id_strategy`、机构事实处理、术语派生规则、缺口与问题。**不猜结构**：解析不出就报「未对齐」；
3. `kb-apply`（脚本）：机械落盘成统一格式——`知识条目.jsonl`（含 `retrieval_text`/`review_status`/`source_ref`）+ 术语词典 + 机构事实层 + `kb-source-map.json` + `kb-report.md` + `kb-open-questions.md`，并写 `kb-mode.json` 基准。

三条底线：**不猜结构**（坏行/二进制/无结构长文进「未对齐」清单）、**宁少勿多**（同 ID 冲突保留首条并记录；重复材料合并）、**机构事实与行业知识分层**（价目/资质/排期拆到机构事实层，金额待业务方补币种/单位/包含项/出处与有效期）。

**没提供知识库也是合法输入**：此时产出显式空库（空 `知识条目.jsonl` + 报告写明「本次没有可用知识库」+ 问题清单问「是暂时没有还是漏传」），通用版会判定「未接入」——这是如实，不是失败。

## 边界

- 只在需要行业适配时使用：只想先拿到一份稿子、适配以后再说 → 直接用 `sales-brief-generic`，传 `industry_check=generic` 按通用词表出稿，页首会标注「不是行业特异」。
- 转录格式不规范（非 `[hh:mm:ss] 发言人N：文本`）→ 先转换并人工核对，否则说话人归属与抽词都会失真。
- 只回答「配置格式对不对」「这个词在转录里出现过几次」，不做业务判断；词表最终由业务负责人确认。
- 0 命中的词不一定要删：可能是这份转录没覆盖到，也可能是模型最容易凭空写出的词——报告里两种解读都写明，由人决定。
- 不联网、不发送消息、不写业务系统。
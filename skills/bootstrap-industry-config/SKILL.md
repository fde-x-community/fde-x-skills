---
name: bootstrap-industry-config
description: 从某行业的真实对话转录与多轮业务问答冷启动出一份可用的行业配置（词表、必问项、页面措辞、知识库对齐），供 sales-brief-generic 按行业特异出稿；仅在已有转录、想要行业特异而尚无配置、或需要继续收敛上一版草案时使用，它不产出销售简报。
---

# 行业配置冷启动

本 skill 是 `sales-brief-generic` 的可选组件：通用版**没有行业配置也能出稿**，只是按通用词表生成并在页首标注「不是行业特异」。只有在明确想要行业特异、而工作目录里还没有配置时，才跑本 skill。它交付的是**待业务确认的配置草案**（词表 / 必问项 / 页面措辞 / 知识库），不是简报，也不是「已完成的行业适配」。

## 目标

从 `[hh:mm:ss] 发言人N：文本` 格式的真实对话转录出发，按固定状态机产出：

1. `industry-config.draft.json`：`industry_terms`、`completion_words`、`post_action_words`、`required_question_topics`、`page.notice`、`page.footer` 等字段；
2. `bootstrap-report.md`：逐词真实命中话轮数、0 命中说明、下一步；
3. `open-questions.md`：只有业务方能回答的问题；
4. 可选的知识库统一格式（写在 `out_dir/knowledge-base/`）。

产出交给业务方确认后，由 `sales-brief-generic` 在工作目录自动发现并使用。

## 触发条件

- 用户要为某行业做**行业特异**出稿，但工作目录里没有行业配置；此时至少提供一份该行业的真实对话转录即可。
- 已有一版 `industry-config.draft.json`，用户带回了对 `open-questions.md` 的回答，要继续收敛。
- 业务方提供了价目表、项目清单、FAQ 等材料，要接成通用版能发现的知识库。
- 转录不是 `[hh:mm:ss] 发言人N：文本` 格式时，先转换并人工核对，再进入本流程。

**如果只是想要一份销售简报，不要用本 skill**：直接用 `sales-brief-generic`，传 `industry_check=generic`，页首会如实标注「基于通用词表、不是行业特异」。

## 资源路由

| 需要什么 | 读哪里 |
| --- | --- |
| 抽词判据、词的三类、禁区、自检清单 | [references/term-extraction.md](references/term-extraction.md)（`bootstrap` 节点 prompt 已内置，人工核对时再读） |
| 知识库格式矩阵、plan 字段、三条底线 | [references/kb-alignment.md](references/kb-alignment.md)（`kb-align` 节点 prompt 已内置） |
| 设计取舍与状态机说明 | [references/overview.md](references/overview.md) |
| 配置字段模板 | [assets/industry-config.template.json](assets/industry-config.template.json) |
| 配置结构声明 | [schemas/industry-config.schema.json](schemas/industry-config.schema.json) |
| 运行日志字段 | [logs/log-contract.md](logs/log-contract.md) |

不要一次加载全部参考资料，按当前节点取用。

## 执行步骤

### Step 1 判断该不该跑

先看工作目录有没有可用的行业配置或知识库。已有配置、用户只是要出稿 → 转 `sales-brief-generic`。没有配置、且能提供真实转录 → 继续。

### Step 2 把输入整理成标准 JSON

不要让用户填脚本参数，从对话里提取后写成 UTF-8 JSON：

```json
{
  "transcripts": [
    { "session_id": "S1", "path": "D:\\data\\transcript-01.txt" }
  ],
  "out_dir": "D:\\data\\industry-bootstrap",
  "industry_name": "K12 课程顾问"
}
```

- `transcripts`：至少一份，越多抽得越准；每条一行 `[hh:mm:ss] 发言人N：文本`。
- `out_dir`：索引、分段稿、草案、报告都写这里。
- 可选：`industry_name`（不给由 agent 从转录推断）；`draft`（上一轮草案）；`answers`（对上一轮 `open-questions.md` 的回答，只影响收敛判定）；`round`（默认按 `dialog.jsonl` 行数 + 1）；`keep_snapshot`（默认 false）；`knowledge_base`（一个路径或路径数组，支持 `.jsonl/.json/.md/.txt/.csv/.tsv/.html`，docx/pdf/xlsx 进「不支持」清单）；`kb_draft`（上一轮知识库对齐计划）。

### Step 3 按状态机执行，不要手算

六个节点固定顺序：`index → bootstrap → check → kb-scan → kb-align → kb-apply`。`index / check / kb-scan / kb-apply` 是确定性脚本，`bootstrap / kb-align` 是需要模型的 agent 节点；一次 run 推进一轮。

离线调试直接用 CLI，不要复述脚本里的切分、计数与校验逻辑：

```text
node scripts/run.mjs input.json output-index.json --stage index
node scripts/run.mjs bootstrap-submission.json output-check.json --stage check --run-input input.json
node scripts/run.mjs input.json output-kb-scan.json --stage kb-scan
node scripts/run.mjs kb-align-submission.json output-kb-apply.json --stage kb-apply --run-input input.json
```

- `check` 与 `kb-apply` 只拿到节点提交物，必须用 `--run-input`（或运行时注入的 `FDEX_RUN_DIR`）找到本次 run 的 `input.json`；找不到会以退出码 2 失败。
- 退出码 2 时脚本在 stderr 给三段式「问题 / 为什么 / 怎么改」，并把 `status=needs_revision` 加 `error` 写进 `output.json`；不要把它当成功。
- `index` 按转录 SHA-256 幂等复用，转录变了才重切；`bootstrap` 先读索引里的说话人编号分布判断谁是机构方，再逐段通读，按三个判据抽词；`check` 校验草案格式、统计每个词的真实出现话轮数、写报告与收敛判定（`ready_for_review` / `needs_more_rounds`）。

### Step 4 处理 0 命中与子串重叠

`bootstrap-report.md` 会把 0 命中的词标成「需人工判断」，并给出两种相反解读（可能该删 / 可能正是要防的）。不要自动删除，也不要自动保留。互为子串的词（例如「合同」与「购房合同」）单列提示，由人决定留长的还是全留；不要静默去重。

### Step 5 知识库对齐（有材料才做）

`kb-scan` 只盘点不产条目；`kb-align` 决定 `field_map`、`id_strategy`、机构事实处理、术语派生与缺口；`kb-apply` 机械落成统一格式。三条底线：不猜结构、宁少勿多、机构事实与行业知识分层。没提供知识库也是合法输入：产出显式空库并写明「本次没有可用知识库」，不要伪造条目。

### Step 6 走到收敛再交付

`check` 判定 `needs_more_rounds` 时，把 `open-questions.md` 的问题交给业务方；拿到回答后连同上一轮 `draft` 再跑一轮。`ready_for_review` 只代表机械收敛，不代表业务正确。最终词表取舍、必问项完整性、以及「这个行业还有哪些零出现但危险的词」必须由业务负责人确认。

## 输出

每轮固定写进 `out_dir`：

| 文件 | 内容 |
| --- | --- |
| `S1.index.json`、`S1.segments.md` | 话轮索引（原始行号 + 输入 SHA-256）与每 100 话轮分段稿 |
| `industry-config.draft.json` | 配置草案 |
| `bootstrap-report.md` | 逐词命中数、0 命中说明、下一步 |
| `open-questions.md` | 待业务确认问题（含 agent 建议确认项） |
| `dialog.jsonl` | 多轮历史，每轮追加一行，文件数不随轮数增长 |
| `kb-scan.json`、`knowledge-base/`、`kb-report.md`、`kb-open-questions.md` | 知识库盘点与统一格式（做了对齐才有） |

CLI 输出 JSON 必须符合 [schemas/industry-config.schema.json](schemas/industry-config.schema.json) 与 `skill.manifest.json` 的 `outputs`：`status` 只取 `index_only / drafted / needs_revision / kb_scanned / kb_applied`，`execution_status` 恒为 `no_action_executed`。

## 停止与权限边界

- 缺 `transcripts`、缺 `out_dir`、`session_id` 不符合 `[A-Za-z0-9_-]+`、转录没有可解析话轮、`check` 找不到 run 输入 → 脚本以退出码 2 失败，按三段式修输入；不要伪造空索引或空报告。
- 转录格式不规范 → 先转换并人工核对，否则说话人归属与抽词都会失真。
- 只回答「格式对不对」「词在转录里出现过几次」，不做业务判断；不要替业务方拍板词表。
- 不联网、不发送消息、不写业务系统；报告里只出现词与计数，不复制客户个人信息。
- 草案不合格一律以 `status=needs_revision` 正常收尾，不要把 run 停在 `blocked`（`blocked` 不可回卷，会让批量运行断链）。

## 不适用场景

- 用户只想要一份销售简报：直接用 `sales-brief-generic`（`industry_check=generic`），本 skill 不产出简报。
- 输入不是带时间戳的对话转录（价目表、会议纪要、只有音频）：先转写或整理成规定格式；不要从标题行硬造话轮。
- 用户要求改业务系统数据、直接定稿配置、或承诺某个词一定安全：本 skill 只出草案，最终由业务负责人确认。
- 只想复核一份已有配置的格式：本 skill 的 `check` 需要本次 run 的输入与草案，不替代通用版运行。

## 已知限制

- 换行业要重新冷启动；目前只在少数真实行业样例上跑过，尚未逐行业实测。
- 多轮收敛只在合成夹具上验过（30 个用例），尚未在真实转录上跑完整的 3 轮往返。
- 干跑统计只能回答「这个词在这份转录里出现几次」，无法判断一个词该不该拦；0 命中的词需要人判断两种相反解读。
- 「零出现但危险」的词（防编造词）原理上无法从转录抽出，只能来自事故复盘或业务方补充。
- C2/C3 多出的 6 条拦截只确认了「规则语义上属未支撑断言」，没有逐条回读正文判断该提及是否属于实质性断言。
- 冷启动召回有限：对照人工 14 词表，冷启动命中 5 个，人工独有 9 个在转录里 0 命中，同时多抽出 16 个词；词表质量依赖转录覆盖度。
# 使用说明（状态机怎么跑，以及人该看什么）

本 skill 是一台六节点受控状态机，由运行时代码推进，不由模型自由发挥：

> analysis 用契约 v2：多了 `decision_stage`（意向阶段）、`oral_quotes`（口头价）、`conflicts`（口径冲突）、`unknowns`（未知待问）、`analysis_meta`（覆盖声明）；页面顶部显示意向阶段与覆盖情况，证据块显示 `L行号@时间戳` 便于回原文核对。

| 节点 | 类型 | 干什么 | 不合格会怎样 |
| --- | --- | --- | --- |
| `preflight` | **agent** | 行业配置自检：**工作目录**里有没有可用的 `industry-config*.json`（判据是 `industry_terms` 非空）与可读的行业知识库；缺配/需完善时询问是否先跑「行业配置冷启动」（bootstrap-industry-config），同意就先跑冷启动再继续 | 不拒绝；拿不到配置就以现有配置继续，结论写进 `notes` |
| `index` | script | 转录 → 索引（原始行号 + 输入 SHA-256），落 `<out_dir>/<session_id>.index.json`，输出 `status=index_only` | 退出码 2 + 三段式（run 变 `failed`） |
| `extract` | **agent** | 读索引，按分析指南做语义分析，按数据契约产出 analysis，提交 `{ analysis }` | 节点本身不拒绝；内容不合格交给 render/polish 消化 |
| `render` | script | 机械校验 `input: { fromNode: "extract" }` 的提交，**并且总是渲染** `<out_dir>/销售简报.html`（核对清单折叠在页底） | `status=needs_revision`，页面照常生成 |
| `polish` | **agent** | 读核对清单与已渲染页面，就地修 `analysis.json`，提交 `{ status, fixed, residual }` | 修不掉的写进 `residual`，不许既不修也不报 |
| `finalize` | script | 读回修好的 `analysis.json` 复跑校验与渲染，产出交付版；页底折叠面板只列 `residual` | 仍有错误/residual → `status=needs_revision`，页面照常生成 |

语义结论只能由 `extract`（agent）产出：脚本不做语义判断，索引也不能当分析结果。

**任何 run 都会正常结束**（`succeeded` 或 `failed`），不会停在 `blocked`：`blocked` 在运行时是不可回卷的终态，批量运行时一旦出现，主 agent 只能丢上下文另起新 run。所以这里刻意不给 agent 节点留「被打回」的路径——分析内容的问题一律以 `needs_revision` 随 run 一起交回。

## 1. 启动

用 `skill_run`（skill_id=`sales-brief-generic`），输入按 manifest.inputs：

```json
{
  "transcripts": [{ "session_id": "S1", "path": "D:\\data\\转录.txt", "sequence": 1, "session_date": "2026-01-01" }],
  "out_dir": "D:\\data\\run-SYN-01",
  "case_id": "SYN-01"
}
```

- `session_id` 只接受字母数字下划线连字符（它是索引文件名的一部分）；同一客户多次咨询用 S1、S2 分开。
- `path` 建议绝对路径：运行时的相对路径基准是 skill 目录，不是你的工作目录。
- `case_id` 可选：给了就锁定 `analysis.case_id`，agent 交别的代号会被判为 `needs_revision`。
- 只支持 `[HH:MM:SS] 发言人：文本` 一行一条话轮；其他格式需先转换并人工核对。

## 2. 机器会自动推进

- `index` 跑完，`extract` 的 prompt 会自动带上：运行目录、`case_id`、会话与索引清单、分析指南、数据契约、analysis 的 JSON-Schema、逐条硬性要求。
- `extract` 提交后由 `render` 节点校验并渲染第一版（核对清单折叠在页底、不挡正文）；随后 `polish` 按清单把能修的在页面语境内修掉，`finalize` 复渲染交付版。
- 主 agent（或人）拿 `output.validation` 决定：还有 residual 就逐条转人工确认；run 本身已经结束，不占用任何停等槽位。

## 3. 三种 status 的含义

| status | 含义 | 下一步 |
| --- | --- | --- |
| `index_only` | `index` 节点的产出（中间态：只索引，未校验未渲染） | 等 `extract` 交分析 |
| `rendered` | polish 修复后复跑校验通过、已生成交付版 H5（页底无技术尾巴） | 人工复核语义与视觉，别把「校验通过」当核实 |
| `needs_revision` | finalize 阶段仍有校验错误或 residual（polish 明确修不掉的条目），H5 照常生成、页底折叠面板列出这些条目 | 读 `validation.errors`/`校验结果.json`，人工处理残余后再重跑 |

`execution_status` 恒为 `no_action_executed`：本 skill 从不发消息、不预约、不收款、不写 CRM。

## 4. 交付前的自查（人）

- 每条结论都能在 H5 里展开看到原话与角色候选状态；
- 页面标注仍是「内部分析草稿 · 建议尚未执行」；
- 索引里的未解析行、跨会话归属、口头报价与正式价格的差别，都已交给人工确认；
- 医学判断与适应证没有被写成结论或建议；
- `needs_revision` 的 run：先看页底折叠面板里的 residual（那是 polish 已判断修不掉的），能补信息的补、不能的转人工；残余处理后重新发起运行。不要靠改写原话让清单变空。

## 5. 离线跑单个阶段（调试用）

```text
node scripts/run.mjs <input.json> <output.json> --stage index
node scripts/run.mjs <node-extract.json> <output.json> --stage render --run-input <input.json>
node scripts/run.mjs <node-polish.json> <output.json> --stage finalize --run-input <input.json>
```

`--stage render` 的第一个参数就是 `extract` 的提交物（结构 `{ "analysis": {...} }`）；`--stage finalize` 的第一个参数是 `polish` 的提交物（`{ status, fixed, residual }`），它从 `<out_dir>/analysis.json` 读修复后的文档再复渲染。运行时这两个路径由 `fromNode` 自动指向 `<runDir>/node-*.json`，`--run-input` 缺省读 `FDEX_RUN_DIR/input.json`。

违约时退出码 2，stderr 固定三段：`问题 / 原因 / 修复`。照「修复」那一行改，不要用改原话的方式让校验通过。

### 接知识库（v0.8.0-kb，可选）

输入文档加两个可选字段即可，不用改任何命令：

```jsonc
{
  "transcripts": [{ "session_id": "S1", "path": "D:\\data\\转录.txt" }],
  "out_dir": "D:\\data\\run-01",
  "knowledge_base_dir": "D:\\data\\行业知识库",            // 可选；只读
  "kb_missing_policy": "error"                             // 可选：error（默认）| degrade
}
```

- 离线跑也可以从命令行给：`--kb <dir>`、`--kb-missing-policy error|degrade`（会覆盖输入文档里的同名字段）。
- 不给 `knowledge_base_dir` → 行为与 v0.7.0 完全一致（页面不含知识依据，页首写「未接入」）。
- 给了却读不出来 → 默认**直接失败**（退出码 2）；显式 `degrade` 才降级为未接入并在页首标注「不可用，已显式降级」。
- 接入后：`index` 阶段输出的 `input_binding` 原样抄进 analysis；引用要写 `kb_refs` + `kb_excerpts{id, quote, used_for}`；缺口写 `kb_gaps`（含 `evidence_turns` 与 `must_not_use_cards`）。规则与字段见 [kb-integration.md](kb-integration.md) 与 [data-contract.md](data-contract.md)。
- 知识库目录里只要有 `02_结构化数据/知识条目.jsonl`（每行一条、至少 `id`）就能用；术语词典可选。库的形状不同时，改 `assets/industry-config.json`（或工作目录配置）里的 `knowledge_base` 段。

## 6. run 悬挂、锁被占、被中断了怎么办

**submit 是唯一不可省的步骤**。真实的失败案例：执行者读完素材、写完 1300 行稿、又去写预检脚本，预算耗尽时还没提交——稿子全白做，run 永久悬在 `extract`，而且**它占着 skill 锁，其他案子也起不来**。

顺序永远是：**写稿落盘 → 立刻提交 → 之后才复核打磨**。允许一次 `needs_revision`，重来一次 run 的代价远小于永不提交。

### 锁被占
- 本 skill 同一时刻只允许一个 `queued/running` 的 run。
- 报「已有运行中的 run」时，**直接再调一次 `skill_run`**（先做一步别的操作再试，最多 5 次）。
- **不要写轮询循环**（`while` / `setInterval` / 递归 sleep）。有执行者这么干过，结果把执行工具自己锁死，反而永远等不到。
- **不要凭旧结论继续等**：锁可能早已释放。另一个执行者盯着一把释放了的锁等了一整轮，从未重新发起 run。判断依据只能是**再调一次 `skill_run` 的返回值**。

### 接手一个停靠的 run
某个执行者中断后，它的 run 会停在 `extract` 等待提交。此时任何人（人或 agent）都可以接管：

```text
skill_run(skill_id="sales-brief-generic", run_id="<anchor_run_id>")
```

这会**重新获取该节点任务，不新建 run、不消耗尝试次数**。拿到任务后照常 `skill_submit_node` 提交即可。如果它已经把稿子落在 `out_dir`，直接投递那份稿子，不要重写。

### 想做离线预检（可选）
`run-code` 这类执行工具对**工作区外路径默认拒绝**，而技能装在 `~/.fdex/skills/<id>`（通常在工作区外），所以直接 `import` 技能模块会被拒。要这么做，得让执行工具显式声明允许根：

```json
{ "root": "D:\\work", "cwd": ".", "allow_roots": ["C:\\Users\\<user>\\.fdex\\skills\\sales-brief-generic"], "code": "..." }
```

拿不到这个能力就**跳过预检直接提交**——预检是可选的，提交不是。

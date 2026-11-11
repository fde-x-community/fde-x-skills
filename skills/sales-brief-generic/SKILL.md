---
name: sales-brief-generic
description: 把销售咨询录音的转录（每行 [HH:MM:SS] 发言人：文本）索引成可逐字回溯的话轮，由 agent 节点做语义分析、脚本机械校验并渲染离线内部销售简报 H5，产出意向阶段、口头报价链、决策阻碍、未知待问与下一步行动；用户要求整理销售/咨询/面诊/导购录音、出客户跟进简报、核对报价与原话证据，或按某个行业词表生成可追溯的销售分析时使用。
---

# 销售咨询简报（通用版）

## 目标

把一份或多份销售咨询转录交成一份**离线内部销售简报 H5**，给销售本人与其主管在下次沟通前用：客户要什么、卡在哪、意向走到哪一步、钱说过哪些数、下一步做什么、还缺什么。每条结论都带可逐字回溯的原话与话轮号。语义结论只能由 agent 节点产出，脚本只负责索引、机械校验与排版。

本 skill 是六节点受控状态机：`preflight`（行业配置自检）→ `index`（索引转录）→ `extract`（agent 语义分析）→ `render`（机械校验 + 渲染 H5）→ `polish`（agent 按核对清单就地修 analysis）→ `finalize`（复校验复渲染交付版）。行业能力来自**工作目录里的行业配置**，没有配置也能按通用词表出稿，这是正常路径。

## 触发条件

- 用户给出咨询/面诊/导购录音的转录文本，说「帮我整理一下这次沟通」「出个客户跟进简报」「分析客户意向和顾虑」。
- 用户要求把同一客户多次咨询（S1、S2 两份转录）归并成一份简报，或要求「每条结论都要能指回原话」。
- 用户说「按我们的行业词表出简报」，或问「这个行业配好了没有、要不要先跑行业配置冷启动」。
- 用户给出一份 `analysis.json` 或一次失败的 run，要求「按核对清单修到能交付」。

## 资源路由

按当前步骤只读需要的那一份，不要一次加载全部。

| 当前在做什么 | 读 |
| --- | --- |
| 第 0 步行业配置自检、要不要先跑冷启动、`industry_check` 四值怎么判 | [references/industry-preflight.md](references/industry-preflight.md) |
| 写 analysis 时字段怎么填（四档取值、金额口径、日期、证据规则） | [references/data-contract.md](references/data-contract.md)；结构事实源 [schemas/analysis.schema.json](schemas/analysis.schema.json) |
| 语义分析的视角与六类高发错误（归属倒置、待办写成已完成、加因果词…） | [references/analysis-guide.md](references/analysis-guide.md) |
| 提交前的 14 项窄口径自检 | [references/independent-check.md](references/independent-check.md) |
| 接入企业行业知识库（条目引用双可回查、缺口结构化、指纹绑定） | [references/kb-integration.md](references/kb-integration.md) |
| 怎么跑、被锁、被中断后接管、离线跑单个 stage | [references/usage.md](references/usage.md) |
| 验收要求落实在哪、三层指标怎么报 | [references/acceptance.md](references/acceptance.md) |
| 真实翻车案例库（B01–B25，写稿前对照同类症状） | [references/retrospective.md](references/retrospective.md) |
| ASR 同音噪声怎么处理 | [references/asr-normalization.md](references/asr-normalization.md) |
| 设计与目录结构说明 | [references/overview.md](references/overview.md) |

## 执行步骤

### Step 0：行业配置自检（preflight）

规则唯一事实源是 [references/industry-preflight.md](references/industry-preflight.md)。要做的只有三件事：

1. 判断工作目录里有没有可用行业配置：`<out_dir>/industry-config*.json` 或 `<out_dir>/industry-config/` 下的配置，能解析且 `industry_terms` 是非空数组才算有。技能包自带的 `assets/industry-config.json` 只是通用模板，永远不当作行业配置。
2. 缺配或需要完善时，用一次 `ask_user_question` 问要不要先跑「行业配置冷启动」（`skill_run({ skill_id: "bootstrap-industry-config", ... })`），产物留在工作目录。`industry_check=auto|skip|bootstrap|generic` 可覆盖询问行为。
3. 把本次基准写进 `<out_dir>/industry-mode.json`（`source` / `generic` / `industry_terms_count` / `industry_label`），并对用户说清这份稿子按哪套词表出。`render` 读这个文件决定行业词校验开不开与页首横幅；**不写它，页首只会显示「配置基准未标注」**。

差旅判断不要自己发明：有配置就 `reused`；跑了冷启动就 `bootstrapped`；用户选择不跑就 `user_skipped`；参数强制通用就 `generic`。后两者必须写 `generic=true`。

### Step 1：索引转录（script）

调用 `node scripts/run.mjs <input.json> <output.json> --stage index`。运行时由入口声明的 script 节点自动执行，离线复算同一条命令。产物是每个会话一份 `<session_id>.index.json`、`<session_id>.input-audit.json` 与 `<session_id>.segments.md`（每 100 话轮一段的逐字通读稿），输出 `status=index_only`。

不要自己切话轮、不要改写原话、不要跳过未解析行：索引脚本只接受 `[HH:MM:SS] 发言人：文本`；解析不出的正文行会让后续校验失败，正确做法是回头修输入格式。

### Step 2：语义分析（extract，agent）

这是本 skill 的核心，按顺序做：

1. 先读 `<session_id>.input-audit.json`：话轮数、未解析行、时间轴首尾、每个发言人编号的话轮量，以及全 `unknown` 的 `speaker_map_skeleton`。编号不是身份，归属判断要逐个编号写进 `analysis_meta.limitations`。
2. 读索引文件（`turn_id`、`line`、`timestamp`、`speaker`、`text`）。话轮超过 150 的会话**必须**分段读 `.segments.md`，一段一段记下金额、日期、承诺、拒绝与客户亲口问过的问题，最后再汇总；真实事故是 876 话轮里整条报价链被跳读漏掉。
3. 按 [references/analysis-guide.md](references/analysis-guide.md) 与 [references/data-contract.md](references/data-contract.md) 组装 analysis，按 [schemas/analysis.schema.json](schemas/analysis.schema.json) 对齐字段（多一个字段会被判 `needs_revision`）。
4. 逐项过 [references/independent-check.md](references/independent-check.md) 的 14 项自检。
5. 用 `skill_submit_node` 提交 `{ "analysis": {...} }`。先把 analysis 写到 `out_dir` 下的稿子文件再提交，提交之后再打磨；没提交等于零。

接入知识库时按 [references/kb-integration.md](references/kb-integration.md) 写 `kb_refs` + `kb_excerpts`、`kb_gaps`、`input_binding`；不接入时**不要出现任何 kb_ 字段**。

### Step 3：机械校验与首版渲染（script）

调用 `node scripts/run.mjs <node-extract.json> <output.json> --stage render --run-input <input.json>`。它把 `extract` 的提交物落盘成 `analysis.json`，逐条核对引用连续子串、会话归属、角色档位、引号落地、正文数字出处、算术（`money_math`）、未出现断言（`not_found_claims`）、行业词与原话支撑，并**总是**渲染 `<out_dir>/销售简报.html`；核对清单折叠在页底，不挡正文。

校验不过时 `status=needs_revision`，页面照常生成。**不要为了让清单变空而删条目、改写原话或放宽规则**，正确的修法在 Step 4。

### Step 4：按清单修复（polish，agent）

读已经渲染的 H5（读者实际看到什么）+ 核对清单 + `<out_dir>/analysis.json`，就地修 analysis：把算式结论写进正文、把归属措辞改到与档位一致、把对客话术里未发生的后续安排删掉、把引号换成证据原话、把行业词补上原话支撑。改完覆盖写回 `analysis.json`，提交 `{ "status": "fixed|partially_fixed|nothing_to_fix", "fixed": [...], "residual": [...] }`。

修不掉的（缺原话、缺授权、需要业务方或专业人员书面确认）一条条写进 `residual` 并说清为什么修不掉。不许既不修也不报，也不许编造凭证或授权来过校验。

### Step 5：复渲染交付版（script）

调用 `node scripts/run.mjs <node-polish.json> <output.json> --stage finalize --run-input <input.json>`。它读回修好的 `analysis.json` 复跑校验与渲染，产出交付版页面：页底折叠面板只列 `residual`，修干净时页面没有任何技术尾巴。输出 `status` 为 `rendered` 或 `needs_revision`。

### Step 6：交付前人工复核

- 读 run 输出的 `status`、`validation.errors`、`validation.warnings`、`industry_basis`；`needs_revision` 时逐条看 `residual`。
- 每条结论都能在 H5 里展开看到原话与角色候选状态；页面仍是「内部分析草稿 · 建议尚未执行」。
- 角色归属、语义蕴含、医学问题、凭证真实性一律交给人工复核，校验全绿不等于事实已核实。
- 需要补信息的转人工，不要靠改写原话让清单变空。

遇到 skill 锁被占、run 被中断需要接管、或想离线单跑某阶段，按 [references/usage.md](references/usage.md) 处理：直接再调一次 `skill_run`，不要写轮询循环；接管停靠的 run 用 `skill_run` 带 `run_id`，不新建、不消耗尝试次数。

## 输出

产物写在 `<out_dir>`（含敏感资料，应放在技能包之外的授权私有目录）：

| 产物 | 说明 |
| --- | --- |
| `<session_id>.index.json` | 逐话轮索引：原始行号 + 输入 SHA-256，结构见 [schemas/index.schema.json](schemas/index.schema.json) |
| `<session_id>.input-audit.json` | 输入审计：话轮数、未解析行、时间轴首尾、发言人编号分布 |
| `<session_id>.segments.md` | 每 100 话轮一段的逐字通读稿 |
| `analysis.json` | 结构化分析，结构见 [schemas/analysis.schema.json](schemas/analysis.schema.json) |
| `销售简报.html` | 交付页；`finalize` 后为交付版 |
| `校验结果.json` | 机械校验的逐条结果 |
| `industry-mode.json` | 本次行业配置基准（preflight 写，render 读） |
| `kb-mode.json`、`kb_report` | 仅接入知识库时：库来源 / 指纹 / 记录数与知识库体检 |

run 输出按 [skill.manifest.json](skill.manifest.json) 的 `outputs` 契约：`status`（`index_only` / `rendered` / `needs_revision`）、`sessions`、`h5`、`validation`、`industry_basis`，`execution_status` 恒为 `no_action_executed`。

## 停止与权限边界

- **校验不通过且修不掉**：`finalize` 后仍有错误或 `residual` 非空时，把页面与逐条残余交人处理，不重复重跑碰运气，更不改写原话、删条目、放宽规则来过校验。
- **转录格式不合规**：没有任何一行匹配 `[HH:MM:SS] 发言人：文本`，或存在成段无时间戳正文时，停下来说明所需格式，要求先转写或转换并人工核对；不编造话轮、不假装听过录音、不静默上传外部转写服务。
- **要外发、付款、预约或写生产系统**：一律拒绝，把请求转成内部动作（如「生成给专业人员的问题清单」「写一条待执行的内部任务」）。本 skill 不联网、不发消息、不预约、不收款、不写 CRM。
- **专业判断与授权**：适应证、风险、疗效承诺、资质边界进 `medical_review_questions` 交专业人员书面回答；`contact_policy` 为 `stop_all` 时不给任何联系动作，`unknown`/`restricted` 时联系动作必须先取得该范围的许可。
- **隐私**：正文与页面用 `case_id`，不写手机号、证件号、完整住址或真实姓名；证据折叠不等于脱敏。
- **run 停在 blocked 或锁被占**：不写轮询循环、不凭旧结论等待；按 [references/usage.md](references/usage.md) 再调一次 `skill_run` 或带 `run_id` 接管。

## 不适用场景

- 输入不是带时间戳的咨询转录：价目表、会议纪要、客服工单、只有音频文件——先转写成规定格式，本 skill 不负责转写。
- 要写 CRM / 排期系统 / 收款系统的请求：本 skill 只产出内部草稿页，不做任何业务写入。
- 要可直接发送给客户的话术成品或营销文案：这里只产出内部行动建议，`scope: internal` 的行动不带对客话术。
- 医学诊断、疗效承诺、用药或手术方案：不在本 skill 范围内，转专业人员。
- 与销售咨询无关的报表、数据清洗、网页抓取：属于别的工具链。

## 已知限制

- 只吃 `[HH:MM:SS] 发言人：文本` 一种格式；相对日期不做换算，跨行或合并话轮需要人工判断。
- 机械校验通过只说明结构与引用规则成立，**不证明语义正确、医学正确，也不证明客户授权或凭证真实**。
- 知识库引用同理：`kb_excerpts` 只证明「这段卡片原文被认为支撑这句结论」，不证明语义蕴含；被引条目多为待签审的行业整理，引用它不等于专业审核通过。术语命中是字面匹配，同义词、简称、拼音误写不保证命中（除非在行业配置里声明 `confusables`）。
- 页面是内部分析草稿，含敏感资料；证据折叠不等于脱敏或访问控制。
- 合成样例（`examples/`）的逐条分析由人预先编写，不是程序独立推理。
- **未机械化的三类**：报价链被称「闭合」但实际有差额、同一事实被标两种互斥档位、漏收客户主动提出的诉求——需要语义判断，硬做规则会误伤，只能靠人审。
- 行业配置是可选项：按通用词表出稿时行业流程词校验关闭，结论里不得把通用稿说成「已适配」。
- 行业配置自检依赖插件在应用启动时挂载；改了 `index.ts` 需重启才出现 `preflight` 节点，那之前由 `extract` 承接第 0 步。
- agent 节点故意不设「被打回重做」路径：分析不合格以 `needs_revision` 随 run 正常结束，不会自动重做；只有提交物不是 JSON 对象才会消耗重试预算。
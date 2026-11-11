# 行业配置自检（preflight）

本 skill 的行业能力全部来自**行业配置**（词表 / 枚举 / 标签 / 必问项 / 页面文案），而**这份配置是可选项**：

| 手上的情况 | 怎么办 |
| --- | --- |
| 有可用的行业配置 | 按该行业出稿（词表与必问项贴合，行业词校验更严） |
| 没有配置 | 按**通用词表**出稿，页面与 run 输出标注「基于通用词表、不是行业特异」——这是正常路径，不是降级 |
| 没有配置、但想要行业特异 | 跑一次「行业配置冷启动」（`bootstrap-industry-config`），从真实转录里生成配置 |

出简报之前的第一步是确认**这个行业配好了没有**，据此决定要不要问用户配一次；**用户不配也必须能继续跑完**。

本文件既是 `preflight` 节点的作业单，也是 `extract` 节点的第 0 步：两处共用同一份规则。
`preflight` 未挂载（插件在应用启动时挂载，改了代码要重启才生效）时，extract 按同样的规则先做一遍检查。

## 〇、行业配置落在工作目录，不替换通用版（2026-11-04 设计修正）

- **行业配置属于「当前工作目录」**：由「行业配置冷启动」产出后落在 `<out_dir>/industry-config/` 下（或直接 `<out_dir>/industry-config.json`），run.mjs 出稿时会自动按工作目录里的配置读取。
- **技能包自带的 `assets/industry-config.json` 只是通用模板，永远保持通用**：不要用某个行业的词表替换它。冷启动产物、业务方改过的词表都留在工作目录。
- 需要把行业配置「固化」时，不要覆盖通用版，而是**询问用户是否基于这份行业词表注册一个行业专用 skill**（例如「sales-brief-<industry>」——行业配置放进新 skill 的 assets，通用版保持行业无关）。

## 一、查什么（机械检查 + 判读，判据不是「文件在不在」）

| 检查项 | 判据（真值） | 找不到时 |
| --- | --- | --- |
| 行业字段替换文件（工作目录） | 名为 `industry-config.json` / `industry-config.draft.json` / `*industry*config*.json`，位于 `out_dir` 或其 `industry-config/` 子目录；能 `JSON.parse`，且 `industry_terms` 是**非空数组** | 询问是否先跑「行业配置冷启动」 |
| 技能包自带配置 | `assets/industry-config.json` 永远存在，但它是**通用模板**（`_industry` 含 generic/未适配 就等于没适配过）；它不承载任何行业词表 | 按「没有行业配置」处理，**绝不拿它冒充行业配置** |
| 行业知识库 | `知识条目.jsonl`、`02_结构化数据/`、名字含「知识库」「行业知识」「knowledge-base」的目录（含冷启动落点 `<out_dir>/industry-config/knowledge-base`）；能读出 **≥1 条**可用条目 | 只记录「没有」，**不阻断**（知识库是加分项）；若用户手上有材料但没有库，问是否先跑冷启动的知识库对齐 |

查找顺序：**`out_dir` 及其 `industry-config/` 子目录优先（工作目录）** → 每个转录文件所在目录 → 上述目录的上一级 → 当前工作目录（pwd）。
配置的 `_industry` / `_comment` 用来看它适配的是哪个行业；本次转录明显是另一个行业时，按「没有该行业配置」处理。

只读不写——例外只有两个：用户同意冷启动后把产物落地到工作目录（见第三节），以及把本次配置基准写进 `<out_dir>/industry-mode.json`（见第五节；不写它，H5 页首会显示「基准未标注」）。

## 二、怎么决定（`industry_check` 参数可覆盖）

| 情况 | 动作 |
| --- | --- |
| 工作目录里有**已适配**配置（`industry_terms` 非空、行业对得上） | 采用它，**不要重复问**；结论写 `status=reused` |
| 工作目录里没有配置，或只有技能包通用模板 | 用 `ask_user_question` **问一次**：是否先跑「行业配置冷启动」。用户说不用 → 按下一行「用户选择不跑」处理，不再追问 |
| 已有适配配置，但本次是新转录样本（配置里没有覆盖这批转录） | 问一次：要不要用冷启动做一轮完善（带上一轮 draft 续跑，只改配置，产物仍留工作目录）；用户说不完善 → 就用现有配置出稿 |
| 用户选择不跑 | **按通用词表出稿**：`status=user_skipped`，把 `generic=true` 写进 `industry-mode.json`；口头上明确说「本次按通用词表出稿，行业词校验关闭，H5 页首与 run 输出都会标注不是行业特异」——**不要说成「已适配」** |
| `industry_check=skip` | 一律不问，直接用现有配置（哪怕现有配置是别的行业的） |
| `industry_check=bootstrap` | 一律不问，直接跑冷启动 |
| `industry_check=generic` | 一律不问，直接按通用词表出稿（`status=generic`，写 `generic=true`） |

问题模板（一问就问全，不要连问）：

- 缺失：`本次目录里没有该行业的配置（词表/必问项），是否先用「行业配置冷启动」跑一轮？一轮出草案 + 待确认问题；同意后我用本次转录做行业适配，配置会落在本次工作目录（不替换通用版），然后按该行业出简报。`
- 完善：`目录里已有 <industry> 配置（<N> 个词，冷启动于 <date>），本次是新的转录样本。要不要带上一轮草案续跑一轮做完善？（只改配置，不产出简报；改动仍落在工作目录）`

选项至少有：推荐项（上表的默认行为）、「先跑冷启动」、「这次直接用现有配置」。

## 三、用户同意后怎么跑（把两个 skill 串起来）

1. `skill_run({ skill_id: "bootstrap-industry-config", input: {...} })` 启动冷启动：
   - `transcripts`：本次同一批转录（`session_id` + `path` 原样带上，不要改写）；**若目录里还找到同行业的历史转录，一并加进来**（冷启动的判据是「至少一份，越多抽得越准」），并在 `notes` 里写清加了哪几份
   - `out_dir`：`<out_dir>/industry-config`（工作目录内的子目录，与简报产物分开）
   - `industry_name`：从转录推断，并在结论文里写清依据
   - 需要完善时带上 `draft`（读工作目录里上一轮的配置原文）与 `answers`（业务方对上一轮 `open-questions.md` 的回答；没有就省略）
   - 找到了行业知识库但它进不了冷启动的输入契约（冷启动只读转录）：在 `notes` 里写明「知识库存在但未参与词表抽取」，并在 `questions_for_business` 里问是否要把它转成转录格式或人工补词
2. 冷启动停在 `bootstrap` 节点时你是它的执行者：**逐段读完** `<out_dir>/industry-config/*.segments.md`，按三段判据抽词，提交 `{ draft, questions }`；随后 `check` 自动跑干跑统计。
3. 收敛判定：`status=drafted` 且 `open-questions.md` 没有待答问题 → 可落地；否则把必须由业务方回答的问题**原样转述**（最多 5 条），并注明「配置为草稿态」。
   - **转述不是终点**：这 5 条要用一次 `ask_user_question` 问全（逐条给名称、含义、可选项），拿到答复或「先按草案跑」的明确同意才能继续。
4. **落地（不是安装）**：冷启动产物本来就在工作目录里——`<out_dir>/industry-config/industry-config.draft.json`，本次 run 的 run.mjs 会自动发现并采用它，**不需要、也不允许复制进技能包**。
   - 想更规矩的文件名，可复制为 `<out_dir>/industry-config.json`（同样留在工作目录）。
   - 业务方对词表另有取舍（删词/加品牌名/改必问项）→ 按新口径重跑一轮冷启动（带 `draft` + `answers`）或直接改工作目录里的配置，并在结论里写清改了哪几条；**不要只改对话、配置不动**，更不要改技能包 `assets/industry-config.json`。
   - ⚠️ 工作目录配置里一旦给了 `completion_words` 就会整份覆盖脚本内默认值：通用完成态（成交/已付款/已支付/已刷卡/已转账/已预约/已排定/已排台/已约好/已治疗/已注射/已手术）必须原样保留，漏一条那条检查就静默消失。
5. **问一次「要不要注册行业专用 skill」**：行业配置落在工作目录、本次出稿确认采用之后，用一次 `ask_user_question` 问用户是否要基于这份行业词表注册该行业的专用 skill（如「sales-brief-<industry>」，行业配置固化进新 skill 的 assets）。同意 → 走 skill-creator 创建专属 skill；不同意 → 本次 run 直接按工作目录配置出稿，通用版技能包保持通用。把问答结果写进 `notes`，不要重复问。
6. 装完（落地后）再提交节点——不要「配置在但没提交」；提交前把 `industry-mode.json` 写好（见第五节）。
7. 冷启动失败（转录读不到、index 报错）时**不要重试第二遍**：把原因写进 `notes`，按「用现有配置继续」处理。

## 四、结论怎么写

- `status`：`reused` / `bootstrapped` / `user_skipped` / `generic`
- `action`：一行结论（用了哪个配置、`industry_terms` 几个词、为什么；通用模式下写清「不是行业特异」；bootstrapped 时写清配置落在工作目录的哪个路径）
- `industry_config`：`{ source: dir|skill_default|bootstrapped, path, industry_terms: <actual_term_count>, industry_label }`（path 指向**工作目录**里的实际生效配置；skill_default=回落的技能包通用模板）
- `knowledge_base`：`{ found: <bool>, paths: [...], source: <param|workdir|config|transcript_dir>, records, terms, fingerprint }`（含识别依据；没找到就写 `found=false` 并说明「本次未接入，页面不含知识依据」）
- `questions_for_business`（可选）：冷启动留下、必须由业务方回答的问题
- `notes`（可选）：兜底行为、草稿态提示、是否注册了行业专用 skill、背景本

**`industry_terms` 必须是实际生效那份配置里的词数，不是你以为的数。**

## 五、配置基准落盘：`<out_dir>/industry-mode.json`（必做）

脚本只知道「工作目录里有没有配置」与「技能包里写的默认值」，**不知道这次到底该按哪套基准出稿**。
所以 preflight 必须把结论落盘，render 阶段读它来决定「行业词校验开不开」和「H5 页首横幅写什么」：

```json
{
  "source": "reused | bootstrapped | user_skipped | generic",
  "generic": false,
  "industry_terms_count": 27,
  "industry_label": "<industry_name>",
  "written_by": "preflight"
}
```

- `generic=true` → `industry_terms` 视为 0，行业流程词校验关闭；H5 页首显示红底横幅「本次基于通用词表（未做行业适配）」。
- `generic=false` → H5 页首显示「已按行业配置出稿：<label>，生效 industry_terms N 个词（来源 …）」。
- **文件缺失**（例如 preflight 节点未挂载、由 extract 承接第 0 步时忘了写）→ 页首显示「配置基准未标注」，校验行为不变。缺标注不是通用，别让读者以为它适配过。

## 六、两条必须说出口的话

| 路径 | 必须对用户说的话 |
| --- | --- |
| 跑了冷启动且配置落在工作目录 | 「已完成行业适配（industry_terms N 个词，配置在 <out_dir>/industry-config/…），接下来按 <industry> 出销售简报。」——说在提交节点之前 |
| 知识库已接入 | 「知识库已就位：N 条记录 / M 个术语（指纹 …，来源 …）；简报里的行业依据会带卡片原文片段，可以直接回查。」 |
| 没有知识库 | 「本次没有知识库：简报里不含知识依据，行业解释只能来自转录原话与工作流；需要的话可以先跑冷启动做一轮知识库对齐。」 |
| 不跑 / `generic` | 「本次按通用词表出稿：行业流程词校验关闭，H5 页首与 run 输出的 industry_basis 都会标注『基于通用词表、不是行业特异』。」 |

两句都是**结论的一部分**，不是寒暄：用户要在看到 H5 之前就知道这份稿子是按哪套词表出的。

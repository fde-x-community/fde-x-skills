# 知识库接入（v0.8.0-kb，可选）

本 skill 原本是**行业无关骨架**：只吃转录，行业知识靠 `industry-config.json` 的词表与页面措辞。v0.8.0-kb 起，它也能**可选接入企业行业知识库**：索引时逐话轮记术语命中、分析时引用必须双可回查、缺口必须结构化、渲染时把知识依据与缺口摊开给销售看。（这套机制来自一套医美专用实现，本次发布只提供抽掉领域词之后的通用形态。）

原则只有一条：

> **知识库只登记正确的东西（正确写法 + 卡片边界）；转录说了什么、说错了什么，由 agent 判断。**

## 1. 谁负责什么

| 事项 | 企业知识库 | 本 skill |
|---|---|---|
| 正确写法（品牌、项目、方法、流程名） | ✅ 唯一权威 | 只读取，不改写 |
| 项目卡（原理 / 边界 / 禁忌 / 面诊问题 / 费用维度） | ✅ | 引用其 id 作为「知识依据」 |
| 转录里的同音/近音误写 | ❌ 不收录 | 索引里只做提示（`term_suspects`），原话不改；agent 判术语三态 |
| 「这个词到底是哪个东西」的判断 | ❌ | `term_status: confirmed / candidate / unknown` |
| 机构的价目、资质、排期 | ❌（不在行业层） | 一律当缺口写进 `kb_gaps`，不得写进 `kb_refs` |

## 2. 目录约定（只读）

```
<knowledge_base_dir>/
  02_结构化数据/知识条目.jsonl            # 必需：每行一条 JSON，至少要有 id
  02_结构化数据/术语与转录纠错词典.json    # 可选：[{term, related_card_id, resolution_status}]
```

- 路径与字段名**全部可配**，见 `assets/industry-config.json` 的 `knowledge_base` 段（`entry_files` / `entry_fallback` / `terms_file` / `text_fields` / `title_field` / `keywords_field` / `institution_fact_field` / `review_status_field` / `confusables`）。
- 换行业、换库结构只改配置，`run.mjs` 与 `scripts/kb.mjs` 一行不用动。
- 读不出任何条目 → 视为「读不出来」，按下面的降级规则处理；**本 skill 对知识库全程只读，不落任何文件**。


## 2.5 目录怎么被发现（v0.8.1-kb：与词表同一套「工作目录优先」）

知识库不该靠「把绝对路径塞进输入」才能用——那和词表要把配置拷进技能包一样别扭。发现顺序：

| 顺序 | 位置 | 说明 |
| --- | --- | --- |
| 1 | 输入的 `knowledge_base_dir` | **最高优先，给了就必须能读出来**（读不出默认直接失败，`degrade` 才降级） |
| 2 | 运行目录下的约定位置 | `<out_dir>/knowledge-base`、`<out_dir>/industry-config/knowledge-base`（**行业配置冷启动的落点**）、以及 `知识库/行业知识库/industry-kb/kb` 等别名 |
| 3 | 运行目录里名字像知识库的子目录 | 容忍 `KB-<industry>-v2` 这类命名（匹配「知识库 / 行业知识 / knowledge-base / kb-」） |
| 4 | 行业配置 `knowledge_base.dirs[]` 声明的目录 | 相对运行目录解析；冷启动可以在配置里写这一条 |
| 5 | 转录文件所在目录（及其上一级）里名字像知识库的子目录 | 材料与录音放一起时能直接发现 |

判据不是「目录在不在」，而是**能读出 ≥1 条 id 合法的条目**（与词表的 `isUsableIndustryConfig` 同构）。
自动发现失败**不报错**——「工作目录没有知识库」与「没有行业配置」一样是合法状态，只是页面会如实写「未接入」。

## 2.6 基准落盘：`<out_dir>/kb-mode.json`

只让页面上写「已接入 N 条」不够：复核者还需要知道**这份稿子按哪一版知识库、从哪发现的**。所以 index 阶段写一份基准文件：

```json
{
  "written_by": "index",
  "source": "param | out_dir | config | transcript_dir | none",
  "connected": true,
  "degraded": false,
  "policy": "error",
  "dir": "D:\\data\\run-01\\knowledge-base",
  "records": 160,
  "terms": 431,
  "fingerprint": "bc4b81c23a40c76e",
  "tried": [{ "dir": "...", "source": "out_dir", "usable": false, "reason": "读不出知识条目" }],
  "note": "..."
}
```

- 页首横幅会写清来源（显式参数 / 工作目录自动发现 / 配置声明）；
- `tried` 记下试过但读不出的候选，便于排查「为什么没接上」；
- 文件缺失不改行为，横幅只显示「未接入」——不假装接过。

## 3. 三个阶段怎么用知识库

### index（脚本，机械）

- 每个话轮产出 `term_hits`：知识库术语的**精确命中**（只认正确写法），带 `card` / `normalized_candidate` / `resolution_status`。
- 可选 `term_suspects`：行业配置里 `confusables` 声明的已知误写只作提示（原话保留、不自动改写）。
- 索引头部写 `kb` 摘要（记录数、术语数、**指纹**、命中话轮数、每张卡片的正文哈希），供后两阶段核对。
- index 阶段的输出文档给出可直接抄进 analysis 的 `input_binding`（转录 sha256 + 知识库指纹）。

### extract（agent，语义）

- 术语三态：`confirmed`（就是知识库这条，必须给 `kb_term`）/ `candidate`（疑似，必须写 `term_note` 且含「疑似/待核」）/ `unknown`（认不出，必须写 `term_note`，不猜）。
- 引用卡片写 `kb_refs`，并且**必须配 `kb_excerpts: [{id, quote, used_for}]`**：`quote` 是该卡正文里的连续片段，`used_for` 是本条标题/正文里被支撑的那一句。
- 知识库没覆盖的主题写进 `kb_gaps`：`{topic, why_missing, fallback, must_not_use_cards[], evidence_turns[]}`，`evidence_turns` 必须落在本条分析的证据里。
- 索引命中了某张卡却刻意不引用时，在 `kb_unused_notes` 里写理由。
- **空着比编造好**：没有可引用的卡就不写 `kb_refs`，把主题写进 `kb_gaps` 并把结论降级为「给医生/机构的问题」。

### render / finalize（脚本，机械）

校验（均为 `needs_revision` 级错误，页面照常渲染、清单折叠在页底）：

| 检查 | 判据 |
|---|---|
| 引用存在性 | `kb_refs` / `kb_excerpts[].id` 必须在**当次**知识库里 |
| 引用层级 | 不得引用 `institution_fact=true` 的机构事实条目 |
| 片段落地 | `kb_excerpts[].quote` 归一化（去空白、全半角标点）后必须是该卡正文的连续子串 |
| 引用支撑 | `kb_excerpts[].used_for` 必须是本条标题/正文的子串 |
| 成对 | 有 `kb_refs` 就必须有 `kb_excerpts` |
| 缺口可追 | 每条结构化 `kb_gaps` 必须带 `evidence_turns`，且每个 turn 都在这条分析的 evidence 里 |
| 缺口不过期 | 缺口主题与某张卡标题高度重合（整张标题出现 / LCS ≥3 / 关键词占主题一半以上）而该卡未列入 `must_not_use_cards` → 判「可能已过期」 |
| 禁用卡 | `kb_gaps[].must_not_use_cards` 里点名的卡，任何条目引用它都失败 |
| 术语三态 | `confirmed` 缺 `kb_term`、`candidate/unknown` 缺 `term_note`、候选写成定论 → 失败 |
| 输入绑定 | 必须有 `input_binding = {kb_fingerprint, transcripts:{sid: sha256}}`，且与索引一致（防「拿旧索引写分析」） |
| 未接入 | 未接知识库却出现 `kb_refs` / `kb_excerpts` / `term_status` / `kb_basis.connected=true` → 失败（防把模型常识伪装成企业知识） |
| 库内冲突 | 知识库同 ID 正文不同 → 失败，先修库 |

提醒（不阻断，但渲染在页底折叠面板与页面横幅）：

- 检索到了却没用（正文提到该卡关键词、索引也命中，却没有引用，也没在 `kb_unused_notes` 说明）；
- 引用了未签审条目（`review_status=draft_*`）——页面标注「未经专业签审」；
- 疑似装饰性引用（片段与正文几乎没有共同实词）；
- **知识库变了但被引卡片正文没变** → 降级为提醒（可继续，建议重新索引）；被引卡片正文变了或被删 → 报错，必须重新索引。

## 4. 指纹、绑定、过期的判定顺序（别把三件事混成一件）

1. `input_binding.kb_fingerprint` 对齐的是**建索引那一刻**的知识库：它回答「这份分析是不是对着这次索引写的」。
2. 当前库与索引不一致本身**不是**错误；由「索引指纹 vs 当前库」这一步找出受影响会话，再看**被引卡片正文哈希**：没变 → 提醒；变了或被删 → 报错。
3. 卡片被删一定会落到「引用不存在的条目」错误上，与指纹无关；指纹只是提前给出「你用的是旧库」的解释。

> 反面教材：如果把第 1 条写成「与当前库比对」，第 2 条的降级分支就永远走不到——一个机制把另一个机制彻底遮蔽。

## 5. 降级规则

| 情况 | 行为 |
|---|---|
| 不给 `knowledge_base_dir` | 完全按 v0.7.0 行为运行：页面不含任何知识依据，页首横幅写「行业知识库：未接入」 |
| 给了但读不出来，`kb_missing_policy=error`（默认） | 本 run 直接失败（退出码 2，三段式原因）——不允许「以为接了其实没接」 |
| 给了但读不出来，`kb_missing_policy=degrade` | 显式降级为未接入继续跑：页首标注「不可用，已显式降级」，且**不允许出现任何知识依据** |
| 库能读但某主题没卡 | 正常出稿，`kb_gaps` 显式声明缺口（可点名 `must_not_use_cards`），页面列出「知识覆盖缺口」 |
| 引用了已删除/不存在的卡片 | 校验失败并列出具体 id |
| 索引与知识库版本不一致 | 见第 4 节 |

## 6. 与医美专用实现的差别（设计取舍）

本版是**行业无关**的移植，保留机制、抽掉领域词：

| 机制 | 医美专用实现 | 通用版 v0.8.0-kb |
|---|---|---|
| 知识库目录/字段 | 写死 02_结构化数据 约定 | 从 `industry-config.json` 的 `knowledge_base` 段读，可换库结构 |
| 术语命中 | 词表 + 拼音同音召回（74 字表） | 只做精确命中；误写提示来自配置里的 `confusables`（不自带领域词表） |
| 卡片原文片段 | `kb_excerpts[{id, quote, used_for}]` | 同 |
| 缺口禁用卡 | `kb_gaps[].must_not_use_cards` | 同 |
| 输入绑定 | `input_binding` | 同；index 阶段的输出给出可直接抄的值 |
| 机构事实层（价目） | `--institution-facts` + `if_refs` | **未移植**：本版把机构价目/资质一律当缺口，避免把机构事实混进行业知识 |
| 页面 | 知识依据 / 缺口 / 体检三个折叠分区 | 同（另加页首知识库状态横幅） |

## 7. 覆盖边界（不假装）

- 术语命中是**字面**匹配：同义词、简称、拼音误写不保证命中；没有配置 `confusables` 就没有误写提示。
- `used_for` 只能证明「这段卡片原文被认为支撑这句结论」，**不能证明语义蕴含**；真假仍由人复核。
- 知识库条目多为待签审的行业整理，引用它不等于医学审核通过；页面已标注。
- 缺口是否真的存在、是否该降级给医生，属于语义判断，脚本只拦「明显已过期」这一种硬错。

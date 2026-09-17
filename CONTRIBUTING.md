# 贡献指南

fdex-skills 收集可复用的 agent skill。任何人都可以提 PR,但每个 skill 必须满足
同一套结构约定——这样使用者才能信任仓库里的任何一条,而不必逐个人肉审查作者。

## 五分钟上手

```bash
# 1. Fork 并 clone
git clone https://github.com/<you>/fdex-skills && cd fdex-skills

# 2. 从模板生成骨架
node scripts/new-skill.mjs my-skill --author <你的 GitHub handle>

# 3. 填内容(见下面"要填什么")
$EDITOR skills/my-skill/SKILL.md

# 4. 跑一遍 CI 完全相同的检查
node scripts/validate.mjs
node scripts/test-all.mjs
node scripts/build-index.mjs

# 5. 提交 PR
git checkout -b add-my-skill
git add skills/my-skill README.md && git commit -m "Add skill: my-skill"
```

## 要填什么

### `SKILL.md`

frontmatter **只允许 `name` 和 `description` 两个字段**。

这不是风格偏好。Agent Skills 规范之外的顶层字段会被严格解析器**拒绝并丢弃整个 skill**
——不是忽略,是让这个 skill 在那些 harness 上彻底消失。作者、版本、回滚点写进
`VERSION.json`。

`description` 是模型判断是否触发本 skill 的**唯一依据**。写清"做什么 + 什么时候用":

```yaml
# 差:没有被调用的机会
description: 处理 PDF。

# 好:说明能力和触发场景
description: 从 PDF 中提取文本和表格并导出为 CSV 或 JSON。当用户处理 PDF 文档,
  或提到 PDF、表单、文档提取、扫描件时使用。
```

正文控制在 500 行以内。详细知识放 `references/`,并在正文里直接链接。

### 十二层结构

```
skills/<name>/
├── SKILL.md              触发、目标、步骤、输出、停止条件、资源路由
├── VERSION.json          版本、成熟度、作者、回滚点
├── agents/openai.yaml    display_name / short_description / default_prompt
├── references/           ┐
├── scripts/              ├ 可豁免
├── assets/               ┘
├── schemas/              输入输出契约,每个字段只有一个规范定义
├── examples/golden/      专家认可的好行为
├── examples/edge/        缺料、冲突、边界时的安全默认
├── examples/failed/      真实观察到的失败、成因、修复、回归用例
├── tests/                可执行测试 + 场景矩阵
└── logs/                 日志契约 + 合成模板
```

**`references/`、`scripts/`、`assets/`** 可以在责任确实不存在时豁免,需要在
`anatomy-waivers.json` 里写明理由、替代证据、**一个和申请人不同的批准人**,以及
到期时间或复核触发条件。模板见 `templates/skill/assets/anatomy-waivers-template.json`。

**其余各层不可豁免。** 空目录、占位符和作者自写的 `pass` 都不算数。

### 包内禁止

- **`README.md`、`CHANGELOG.md` 等**——面向人的文档放进 `references/`
- 压缩包(`.zip` / `.tar` / `.gz`)——提交解压后的内容
- `.env`、`credentials.json`、`cookies.json` 等凭证类文件
- 真实凭证、客户机密材料、生产日志、个人联系信息

### 测试

测试文件命名为 `*.test.mjs`,`scripts/test-all.mjs` 靠这个约定发现它们。

场景矩阵(`tests/scenario-matrix.json`)要覆盖六类:`trigger`、`non_trigger`、`quality`、
`safety`、`regression`、`end_to_end`。矩阵里的 `status` 只是声明——**只有 `tests/` 下真的
跑过、退出码为 0 才算通过**。

## 成熟度:PR 停在 `draft` 是正常的

`VERSION.json` 的 `status` 有三档:

| status | 含义 |
|---|---|
| `draft` | 结构完整(或已按规则豁免),证据尚未全部通过。**PR 默认停在这里。**
| `package_validated` | 机器契约、执行过的测试、校验报告和包回读可被独立复核 |
| `operationally_validated` | 在冻结环境下相对基线有配对证据 |

在 PR 里就把 `status` 写成 `package_validated` 或以上,会被 CI 拒绝——除非同时提供
`validation.release_evidence` 指向的证据文件。**作者自己写的一句"测试通过"不构成证据。**

## 审查

- **结构校验**由 CI 自动完成,不过就是不过,不靠 reviewer 记规则。
- **`scripts/` 逐行人审。** 这是社区 skill 里唯一会真正执行代码的地方,也是最大的风险面。
  CI 的正则扫描只能挡最粗糙的情况,真实的信任边界是人的 review。
- 修改 `scripts/` 或 `schemas/` 的 PR 需要两位维护者批准;纯文档改动一位即可。

## 不支持的能力

依赖 `hooks/` 或 `context: fork` 的 skill **不接收**。这些只有少数 harness 支持,
放进这个仓库会破坏"装到哪儿都能用"的前提。

## 废弃

不要直接删目录。把 `(已废弃,改用 <替代 skill>)` 写进 `description`——`description`
才是模型判断是否触发的依据,写在那里才能让这个 skill 真正停止被调用,同时给使用者
留出迁移窗口。

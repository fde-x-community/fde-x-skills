# Skill frontmatter 兼容性调研

调研日期：2026-09-25。这里只讨论 `SKILL.md` 的元数据与公开可核对的分发要求；平台收录审核、版权和客户授权仍需单独处理。

| 来源 | 必需字段 | 可选字段或平台约定 | 对本仓库的决定 |
| --- | --- | --- | --- |
| [Agent Skills 开放规范](https://agentskills.io/specification) | `name`、`description` | `license`、`compatibility`、`metadata`、实验性的 `allowed-tools` | 本仓库只收前两项，主动放弃这些可选字段 |
| [OpenAI Skills API](https://developers.openai.com/api/docs/guides/tools-skills) | 按 Agent Skills 规范校验 | 包可以含 `references/`、`scripts/`、`assets/`；上传和版本化另有流程 | 不把 OpenAI 发布元数据写成标准 frontmatter 必需项 |
| [OpenAI 插件 Skill](https://developers.openai.com/plugins/build/skills) | `name`、`description` | 插件工具依赖等信息可写在独立的 `agents/openai.yaml` | 保留现有独立文件，但不声称其他平台会读取它 |
| [GitHub Copilot](https://docs.github.com/en/copilot/how-tos/copilot-on-github/customize-copilot/customize-cloud-agent/add-skills) | `name`、`description` | 文档列出可选 `license`、`allowed-tools`；安装工具可能写入来源元数据 | 若安装器回写这些字段，回传的包会与本仓库校验冲突 |
| [Vercel Skills CLI / skills.sh](https://github.com/vercel-labs/skills/blob/main/README.md) | `name`、`description` | `metadata.internal` 是该工具的额外约定；能发现 `skills/<name>/SKILL.md` | 当前目录可被发现，但不能在本仓库使用 `metadata.internal` |

## 执行策略

1. `SKILL.md` 的 `name` 和 `description` 必填。`description` 写清能力与使用时机；这对各平台发现与触发最重要。
2. 本仓库校验器只接受 `name` 和 `description`。这是收录取舍，不是开放规范或市场的通用限制。也不将 `allowed-tools` 作为安全控制的唯一依据。
3. 不将作者、仓库成熟度、评估状态塞进 frontmatter；这些是本仓库的治理信息，继续放在 `VERSION.json`。`agents/openai.yaml` 负责 OpenAI 侧展示或依赖配置。
4. **潜在冲突：** 开放规范的 `license`、`compatibility`、`metadata`、`allowed-tools`；Copilot 的 `license`、`allowed-tools` 和可能写回的来源元数据；Vercel 的 `metadata.internal`。这些字段本身可能被目标平台接受，却会被本仓库拒绝。OpenAI 的 `agents/openai.yaml` 是独立文件，不与该 frontmatter 约束冲突。
5. 未来接入某个市场时，先用一个真实 Skill 验证导入、目录发现、许可与审核流程。若市场必须向 `SKILL.md` 写入额外字段，应讨论放宽本仓库规则，或在发布阶段生成不回写源仓库的适配包；不能直接声称当前源包已完整支持该市场。

这份表是对**公开文档中的格式与发现规则**的核对，不等于任何市场已经接受或上架了本仓库的 Skill。

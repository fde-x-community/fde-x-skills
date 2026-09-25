# AI 辅助需求澄清方案

目标：让需求方从一句自然语言开始，在对话中逐步明确指标、口径、计算与边界规则以及成果必需内容，而不是一次填完长表单。

## 现在即可使用的路径

GitHub Copilot 的[创建或更新 Issue 功能](https://docs.github.com/en/copilot/how-tos/copilot-on-github/copilot-for-github-tasks/use-copilot-to-create-or-update-issues)允许用户用自然语言和图片起草 Issue，使用仓库 Issue 表单，并通过后续提示修改草稿，最后由用户检查并提交。该功能仍处于公开预览，且取决于用户是否有相应访问权限。

对有访问权限的用户，可从 GitHub Copilot 开始，输入：

> 在 `fde-x-community/fde-x-skills` 帮我起草一份“企业需求”Issue。先根据我的描述提出最关键的澄清问题，不要编造指标口径或计算规则。逐步确认：业务场景、涉及指标及其口径、计算和边界规则、成果必须包含的内容。对未确认的部分标为“待澄清”。生成草稿后让我检查脱敏情况，再由我决定是否发布。

没有该功能的用户，直接使用[企业需求表单](../.github/ISSUE_TEMPLATE/enterprise-demand.yml)：只要求先填写一段业务问题描述，其余字段可在 Issue 评论中与维护者逐步补充。

## 自建 AI 助手的可行边界

- **Issue 发布后继续对话：可行。** GitHub Actions 支持 `issues` 和 `issue_comment` 事件，可由自建服务或工作流读取 Issue 与评论、调用模型、提出澄清问题、在评论中回写结构化摘要。需设计触发身份、频率限制、模型密钥、最小权限、敏感信息处理和人工审核。参考 [GitHub Actions 事件文档](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)。
- **Issue 发布前的原生表单内实时对话：现有 Issue Form 不提供这种自定义交互。** 表单支持静态字段和必填校验；如果希望所有用户都能在发布前使用自建 AI 逐轮澄清，需要独立网页或 GitHub App 等入口，再把用户确认的结果写入 Issue。
- **PR 自动解析：也可用评论事件与工作流处理。** 但 Skill PR 已经是交付评审阶段，最好在需求 Issue 阶段澄清业务问题；PR 的 AI 辅助更适合检查遗漏、提议澄清问题，不应自动认定业务效果或替代人工审查。

## 建议实施顺序

1. 先试运行“简短 Issue 表单 + 人工评论澄清”；有 Copilot 访问权限的参与者可以对比其起草体验。
2. 观察需求方常漏哪些信息、维护者平均追问几轮，以及哪些问题适合 AI 提问。
3. 再做发布后评论助手的最小试点：只生成问题和摘要，不自动改 Issue、不开 PR、不发布 Skill。模型输出必须标注“待需求方确认”。
4. 若试点证明有效且确有发布前对话需求，再评估独立入口。届时需要确定运行与模型费用、数据保留、公开仓库中的敏感信息处置和维护责任。

不要把任何客户原始资料直接交给公开仓库或未经批准的模型服务。AI 应帮助发现未定义的口径和边界，不能替用户臆造它们。

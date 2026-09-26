# fde-x-skills
FDE X 社区开源的企业级 skill 集合。每个 skill 都从一次真实的企业任务里长出来,遵循
[Agent Skills](https://agentskills.io/specification) 开放标准,可以被 39+ 个 harness 直接读取

**本仓库收录的skill来自于真实的企业业务，已有企业内部的实际使用与验证。具体使用场景详见skill内部**

Skill 包遵循 [Agent Skills 开放规范](https://agentskills.io/specification)，但本仓库另有质量和证据要求。

## 从需求到 Skill：

> 以下是一个为了说明工作方法的案例
某企业的客户成功团队每周需要整理客户会议纪要，识别待跟进事项。原流程依赖人工判断：谁负责、何时到期、哪些表述只是建议而非承诺。对应 Skill 可以接收脱敏纪要与团队规则，生成待办草稿，并把负责人不明、日期冲突或含敏感信息的条目标记为待人工确认。
通过验证不同纪要上的误判，漏项评价skill的好坏，并最终成功帮助企业负责人省下大量时间。

这个例子中，可复用的是识别与标记不确定性这套流程；
## 收录的 Skill

<!-- SKILLS:START -->
_这里收录从真实企业任务中提炼的 Skill,欢迎从一个真实企业需求开始贡献_
<!-- SKILLS:END -->

## 怎么参与

- **有业务问题：** 用[企业需求表单](.github/ISSUE_TEMPLATE/enterprise-demand.yml)描述问题
- **有领域经验：** 帮助澄清指标口径与边界规则
- **想实现 Skill：** 阅读[贡献指南](CONTRIBUTING.md)，关联需求并提出方案。

公开提交只包含脱敏摘要或合成样例，不提交客户机密等原始材料。

## 怎么用

每个 skill 是一个自包含目录,复制进你的 harness 技能目录即可。没有构建步骤,也不依赖这个
仓库的其他部分。


## 详细文档

- [从企业需求到 Skill](docs/从企业需求到Skill.md)：仓库价值、任务实践、提炼过程与虚构示意。
- [Skill 结构与验证](docs/Skill结构与验证.md)：包结构、质量检查、成熟度和本地命令。
- [贡献指南](CONTRIBUTING.md)：提案、提交与审查约定。

## 许可

[MIT](LICENSE)。

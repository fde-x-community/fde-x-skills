# Skill 结构与验证

## 一个 skill 里有什么

本仓库采用十二层 `strict_full` 结构
```
skills/<name>/
├── SKILL.md              任务主线:触发条件、输入、步骤、什么时候停止或交给人
├── agents/openai.yaml    harness 侧的展示名、简介、默认提示词
├── references/           业务知识和 SOP
├── scripts/              固定计算与格式转换
├── assets/               产出物模板
├── schemas/              输入输出契约
├── examples/golden/      专家认可的好行为
├── examples/edge/        缺料、冲突、边界时的安全默认
├── examples/failed/      真实观察到的失败、成因、修复、回归用例
├── tests/                可执行测试 + 场景矩阵
├── logs/                 日志契约 + 合成模板——事后查得到到底发生了什么
└── VERSION.json          版本、作者、成熟度、回滚点
```

**做全、做好、好用是我们的要回答的三个问题** :

- 内容缺项 → 查 `SKILL.md`、`schemas/`、`examples/`
- 结果不够好 → 查业务判断,以及"什么叫好"有没有在 `examples/` 里写成共识
- 换个场景就跑不动 → 查 `scripts/`、`tests/`、`logs/`


## 凭什么相信这个仓库里的东西

- **CI 结构守门。** `node scripts/validate.mjs` 检查十二层是否齐全、frontmatter 是否只有
  `name` 和 `description`、有没有残留占位符和凭证、场景矩阵有没有覆盖六类评估。
- **测试是真的跑过。** 场景矩阵里标 `pass` 不算数,`tests/` 下真的执行过、退出码为 0 才算。
- **成熟度如实标注。** `VERSION.json` 的 `status` 把"结构完整"和"验证过"分开:`draft` 是
  正常状态,不是失败;要写更高的档,就得拿出可独立复核的证据。已经完成的部分和还没验证的
  设想,不混为一谈。

## 贡献

在真实任务里验证过的方法,都欢迎提 PR。五分钟上手、十二层约定和审查标准见
[贡献指南](../CONTRIBUTING.md)。

```bash
node scripts/new-skill.mjs my-skill --author <your-handle>
node scripts/validate.mjs && node scripts/test-all.mjs && node scripts/build-index.mjs
```

不需要 `npm install` —— 工具链是零依赖的 Node 脚本,CI 跑的就是这三条命令。

`scripts/` 是一个 skill 里唯一会真正执行代码的地方,也是 review 的重点:修改它的 PR 由人
逐行看。任务做完、方法稳定下来并提交进这里的同学,有机会成为本仓库的 contributor。

## 仓库结构

```
skills/<name>/        每个 skill 一个目录,十二层 strict_full 结构
templates/skill/      可复制填写的骨架
scripts/              结构守门、脚手架、测试运行器、索引生成
```

frontmatter 仅接受 `name` 与 `description` 是仓库收录约定，比 Agent Skills 开放规范更严格。没有 Skill 或没有测试时，命令正常退出不代表任何 Skill 已验证；测试退出码为 0 也不自动证明企业业务效果。具体验证范围与成熟度以各 Skill 的记录为准。

参见[从企业需求到 Skill](从企业需求到Skill.md)。

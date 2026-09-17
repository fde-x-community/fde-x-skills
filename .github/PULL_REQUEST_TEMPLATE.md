<!--
  标题格式:Add skill: <name> / Update skill: <name> / Fix skill: <name>
-->

## 变更类型

- [ ] 新增 skill
- [ ] 更新现有 skill
- [ ] 修复 skill 问题
- [ ] 废弃 skill
- [ ] 仓库工具链 / 文档

## Skill 信息

- **名称**:
- **作者(GitHub handle)**:
- **一句话说明做什么、什么时候用**:

## 本地校验

提交前请确认下面三条都在本地跑过。CI 跑的是完全相同的命令。

- [ ] `node scripts/validate.mjs` 通过
- [ ] `node scripts/test-all.mjs` 通过
- [ ] `node scripts/build-index.mjs` 已运行且 README 变更包含在本 PR 中

## 结构检查清单

- [ ] `SKILL.md` frontmatter **只有 `name` 和 `description`** 两个字段
      (规范之外的顶层字段会被严格解析器拒绝并丢弃整个 skill)
- [ ] `name` 与目录名一致,且是 kebab-case
- [ ] `description` 写清了"做什么 + 什么时候用"
- [ ] 十二层齐全,或缺失层已在 `anatomy-waivers.json` 中按规则豁免
- [ ] 没有占位符(`TODO` / `FIXME` / `TBD` / 待替换文字)
- [ ] 没有硬编码凭证;`logs/` 中没有真实日志或个人联系信息
- [ ] 包内没有 `README.md` —— 面向人的文档放在 `references/`
- [ ] `tests/` 下有可执行测试且真的跑过(不是只在 scenario-matrix 里标 `pass`)
- [ ] `VERSION.json` 的 `status` 保持 `draft`

## 安全声明

- [ ] 这个 skill 的 `scripts/` 我逐行看过,没有网络外发、删除、提权或读取凭证的行为
- [ ] 没有把真实凭证、客户机密材料或生产日志放进包里

<!--
  scripts/ 是社区 skill 里唯一会真正执行代码的地方,也是 review 的重点。
  如果这个 PR 修改了 scripts/,请在下面说明改了什么、为什么。
-->

## 其他说明

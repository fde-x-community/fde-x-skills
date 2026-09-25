---
name: ${skill_name}
description: ${description}
---

# ${display_name}

<!--
  模板说明(提交前删除本注释块)

  本仓库的 frontmatter 只收录 name 和 description。这比开放规范更严格，
  因而不能把 license、compatibility、metadata、allowed-tools 写在这里。
  仓库治理用的作者、版本、回滚点写进 VERSION.json。

  description 是模型判断是否触发本 skill 的唯一依据,写"做什么 + 什么时候用"。
  正文控制在 500 行以内,详细知识放进 references/ 并按需链接。
-->

## 目标

<一句话说明这个 skill 交付什么,以及交付给谁。>

## 资源路由

<按路线列出需要读取的 references/ 文件。不要一次加载全部参考资料。>

- <路线 A>:读取 [references/method.md](references/method.md)

## 执行步骤

1. <可执行的步骤,不要写元话术。>
2. <需要确定性计算、转换或校验时,调用 scripts/ 下的脚本而不是复述逻辑。>
3. <产出物按 assets/output-template.md 的形态组织。>

## 输出

按 [schemas/output.schema.json](schemas/output.schema.json) 的契约产出。

## 停止与权限边界

<列出必须停下来交还给人或标记为 blocked 的条件。
没有明确授权的外发、付款、删除、生产写入一律改做只读、离线或草稿。>

- <停止条件一>

## 不适用场景

<列出与本 skill 相邻但应当路由到别处的请求,用于非触发测试。>

## 已知限制

<如实列出当前不能覆盖的范围。缺证据时保留在分母里,不要静默降低验收条件。>

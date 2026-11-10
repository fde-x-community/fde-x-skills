# 运行日志契约

可分发的 skill 包里**只放这份契约和合成模板**。真实执行日志写到 skill 包之外的任务目录，不进仓库。

本 skill 的每次 run 由宿主生成 `run_id`，日志按 JSONL 追加，每行一个事件。

## 必需事件类

| 事件 | 何时记录 | 额外必填字段 |
| --- | --- | --- |
| `run` | run 启动、正常结束、异常结束时各记一条 | `input_binding`（转录的哈希与 `session_id`）、`status`（`index_only` / `rendered` / `needs_revision`） |
| `stage_boundary` | 进入或离开六个节点中的任意一个（`preflight`、`index`、`extract`、`render`、`polish`、`finalize`） | `node`、`attempt`、耗时毫秒数 |
| `validator_verdict` | `render` 与 `finalize` 完成机械校验时 | `errors` 条数、`warnings` 条数、`residual` 条数、`校验结果.json` 的路径 |
| `refusal` | 因违反停止边界而拒绝执行时（外发、付款、预约、写业务系统、专业判断） | 拒绝的边界名、用户原请求的摘要 |
| `human_handoff` | 把问题交人时（`needs_revision` 且 `residual` 非空、角色归属、医学问题、凭证核验） | 交办的对象与逐条残余 |
| `tool_error` | 脚本退出码非 0、节点提交被拒、锁被占 | 命令、退出码、stderr 的前 3 行 |
| `tool_attempt` | 每次调用 `scripts/run.mjs` 或 `skill_run` 前 | 目标节点、是否为重试 |
| `final_review` | 交付前人工复核完成 | 复核人与结论（`pass` / `fail`） |
| `human_interaction` | 与用户的关键问答（行业配置自检、model 变体、隐私授权） | 问题摘要与用户的回答 |
| `environment_fingerprint` | 每次 run 启动 | Node 版本、是否挂载了 `preflight` 节点、技能包版本 |

所有事件都带 `event_id`、`timestamp`、`mission_id`、`run_id`。

## 状态词汇

只用这些取值，不自造：`pass`、`fail`、`partial`、`blocked`、`not_run`、`not_in_scope`。

- 工具返回成功但无法回读核验的，不算 `pass`；回读结果不一致记 `fail` 并把两次结果都写进证据引用。
- 这些是**评估状态**，不是阶段状态；阶段状态另由 run 输出的 `status` 表达。
- 一项检查没做就写 `not_run`，不要留空，也不要用 `partial` 掩盖未检查。

## 隐私

- 记 ID 与证据引用（`session_id`、`turn_id`、文件哈希），不记隐藏思维链。
- 不记密码、Cookie、会话令牌、联系方式、原始敏感文档。
- 不把代理 IP 轮换与身份伪装记为执行手段。
- 运行期追加式 JSONL 在审查时另生成带版本摘要的文件，便于定位改动。
- 记录中出现的客户一律用 `case_id`，不写真实姓名、手机号、证件号。
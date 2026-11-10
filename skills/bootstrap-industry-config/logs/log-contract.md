# bootstrap-industry-config 运行日志契约

可分发的 skill 包里**只放这份契约和合成样例**。真实执行日志写到 skill 包之外的任务目录，
不进仓库，也不写进 `out_dir` 之外的共享位置。

## 日志落点

每次 run 的机械事实以 `out_dir` 里的文件为准：`S1.index.json`（话轮索引与输入 SHA-256）、
`bootstrap-report.md`（逐词命中数与 0 命中说明）、`open-questions.md`、`dialog.jsonl`
（每轮一行，含 `round`、`verdict`、`validation_errors`、`zero_hit`、`hits`、`answers`、`previous_draft`、`draft`）。
外部任务目录里的 JSONL 只记录事件与证据引用，不重抄这些内容。

## 必需事件类

| 事件 | 何时记录 | 额外必填字段 |
|---|---|---|
| `run` | 一次 index / check / kb-scan / kb-apply 或完整 skill_run 开始、结束 | `task_phase`、`mission_outcome`、`event_result`、`evidence_refs` |
| `refusal` | 请求超出授权或范围（要简报、要改业务系统、要替业务方拍板） | `requested_action`、`authority_gap`、`safe_fallback` |
| `human_handoff` | 需要业务方回答 `open-questions.md`、确认词表取舍或机构事实 | `handoff_to`、`decision_needed`、`resume_condition` |
| `tool_error` | 脚本退出码非 0、转录无可解析话轮、知识库材料无法对齐 | `tool`、`error_class`、`retry_count`、`fallback`、`final_effect` |
| `final_review` | 交付草案前的审查 | `primary_user`、`verdict`、`acceptance_refs`、`blocking_gaps` |
| `human_interaction` | 业务方澄清、纠正词表、补充答案或批准定稿 | `interaction_type`、`required_by_policy`、`avoidable`、`human_minutes`、`rework_count` |

可选事件：

| 事件 | 何时记录 | 额外必填字段 |
|---|---|---|
| `stage_boundary` | 状态机从一个节点进入下一个节点 | `from_node`、`to_node`、`convergence_verdict` |
| `validator_verdict` | `check` 给出格式校验、命中统计或收敛判定 | `verdict`、`zero_hit_words`、`open_question_count` |

所有事件都带 `event_id`、`timestamp`、`mission_id`、`run_id`。

## 状态词汇

`event_result` 只用 `pass`、`fail`、`partial`、`blocked`、`not_run`、`not_in_scope`。
工具返回成功但无法回读核验时**不算 `pass`**；`needs_more_rounds` 记 `partial`，等待业务方回答的手交记 `partial`，不要记成 `blocked`。

这些是评估状态，不是阶段状态。`task_phase`、`mission_outcome`、`artifact_maturity`、
`release_state` 各自独立，一个字段的值不得复制进另一个字段。

## 隐私

- 记录 ID 和证据引用，不记录隐藏思维链；`evidence_refs` 指向 `out_dir` 里的文件名与位置即可。
- 不记录密码、Cookie、会话令牌、联系方式或原始敏感文档；转录里的客户原话与个人信息不进日志，只记词与计数。
- 不把代理/IP 轮换、身份伪装记为执行手段——这些是禁止项，不是遥测特性。
- 运行期用追加式 JSONL，审查时另生成带版本的摘要。
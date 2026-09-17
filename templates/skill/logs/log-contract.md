# ${skill_name} 运行日志契约

可分发的 skill 包里**只放这份契约和合成模板**。真实执行日志写到 skill 包之外的
任务目录,不进仓库。

## 必需事件类

| 事件 | 何时记录 | 额外必填字段 |
|---|---|---|
| `run` | 一次基线、重跑或回归开始/结束 | `task_phase`、`mission_outcome`、`event_result`、`evidence_refs` |
| `refusal` | 请求超出授权或策略 | `requested_action`、`authority_gap`、`safe_fallback` |
| `human_handoff` | 需要人判断、批准或不可逆操作 | `handoff_to`、`decision_needed`、`resume_condition` |
| `tool_error` | 工具失败或返回不可核验结果 | `tool`、`error_class`、`retry_count`、`fallback`、`final_effect` |
| `tool_attempt` | 一次有界执行尝试开始/结束 | `tool_tier`、`failure_class`、`attempt`、`max_attempts`、`risk_signal`、`backoff_source`、`resume_checkpoint`、`blocker_scope` |
| `dependency_bundle` | 集中请求一批依赖 | `snapshot_ref`、`items`、`request_mode=batch_once`、`continued_subtasks` |
| `final_review` | 交付前审查 | `primary_user`、`verdict`、`acceptance_refs`、`blocking_gaps` |
| `human_interaction` | 澄清、纠正、批准、交接或接管 | `interaction_type`、`required_by_policy`、`avoidable`、`human_minutes`、`rework_count` |
| `environment_fingerprint` | 冻结一次运行的环境 | `artifact_digest`、`model`、`harness`、`tools`、`policy_bundle`、`dataset`、`evaluator` |

所有事件都带 `event_id`、`timestamp`、`mission_id`、`run_id`。完整事件词汇表见
task-to-skill-loop 的 `logs/log-contract.md`。

## 状态词汇

只用 `pass`、`fail`、`partial`、`blocked`、`not_run`、`not_in_scope`。
工具返回成功但无法回读核验时**不算 `pass`**。

这些是评估状态,不是阶段状态。`task_phase`、`mission_outcome`、`artifact_maturity`、
`release_state` 各自独立,一个字段的值不得复制进另一个字段。

## 隐私

- 记录 ID 和证据引用,不记录隐藏思维链。
- 不记录密码、Cookie、会话令牌、联系方式或原始敏感文档。
- 不把代理/IP 轮换、身份伪装记为执行手段——这些是禁止项,不是遥测特性。
- 运行期用追加式 JSONL,审查时另生成带版本的摘要。

# 运行日志契约

本目录只存放日志字段说明和合成样例，不提交真实采集日志、浏览器资料或用户输入。

名单运行器在输出目录保存 `run_result.json` 和逐步骤的 `*.log`。`run_result.json` 至少标出 `status`、`steps` 和所请求商品；采集或复用步骤结束后记录 `verified_prices`，成功时给出 `dashboard` 路径。单步日志保留步骤名、退出码与日志文件路径。商品身份不明确时使用 `clarification.json` 的 `status=needs_clarification` 与 `questions`，不伪造一份成功报告。

对外分享或提交前应移除本机绝对路径、个人资料、Cookie、令牌以及可能包含用户会话的页面正文。截图和原始日志作为本地证据保存；公开样例只演示字段结构，不冒充实测报价。

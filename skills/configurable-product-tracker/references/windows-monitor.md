# Windows 历史价格监测流程

这是 Skill 的可选执行流程。维护源位于 `scripts/monitoring/`；以下命令从 `scripts/` 执行。包内若缺少对应文件，应报告未提供该能力，不从已废除 Demo 导入旧代码。

## 启用前与用户约定

明确列出本轮已核验商品、SKU/默认颜色和成功镜片配置，说明只支持普通眼镜的单光测试处方，不支持太阳镜。先取得用户持续监测同意，再生成配置和注册任务；单次输入商品、运行回放或打开 Skill 不算同意。新增商品仍需同意。

本次已经配置并验证的默认行为：本机每天 11:00，错过后由 Windows 尽快补跑；失败退出码为 1，任务计划程序在失败结束后每隔 30 分钟重试，最多三次。单商品采集超时 30 分钟、身份检查 4 分钟、任务上限两小时；同日重试保留成功路径，只补失败项。失败通过独立 Windows 弹窗提示网络/代理或采集错误，120 秒自动关闭。用当前登录用户、普通权限运行，不保存密码；必须已登录，关机不能采集，锁屏弹窗可能解锁后才可见。补跑不保证开机后立即执行。

历史和证据保存在本地，配置相同才比价；不结账、不付款。当前没有飞书机器人。后台使用 `pythonw.exe`，子进程隐藏窗口；这些执行方式应如实告知用户。

## 配置与验证

发布包包含监测脚本，但不附带 Python、Playwright 或浏览器。使用已安装 Playwright 的 Python 解释器，并按 `SKILL.md` 安装 Chromium；先确认所选解释器能导入 Playwright。把实际解释器和本轮真实采集生成的 `verified_prices.json` 路径填入变量，不使用附件回放作为用户新商品的监测清单。

```powershell
$monitorPython = (Get-Command python.exe).Source
$verifiedPrices = '../assets/runs/实际运行目录/scripts/vooglam_products/verified_prices.json'
& $monitorPython monitoring/setup_config.py --source $verifiedPrices --consent --channel chromium
& $monitorPython monitoring/test_monitor.py
& $monitorPython monitoring/monitor.py --smoke --no-popup
& $monitorPython monitoring/monitor.py --simulate-failure --no-popup
& $monitorPython monitoring/monitor.py --popup-test
```

`--consent` 只在用户已经同意后传入。生成器核对基线证据文件，保留原始观测时间并导入 `history.sqlite3`，创建固定清单 `config.json`；已有配置会拒绝覆盖。仓库中的 `config.example.json` 仅记录旧示例，不进入 Skill 包，也不能当作启用配置。单路径 smoke 必须确认商品身份、价格和证据；模拟失败预期返回 1，弹窗测试不采集商品。测试目录独立，不算完整日采验证。

完成测试后注册任务；不得因缺少 Python 或网络而声称任务配置成功。

```powershell
powershell -NoProfile -File monitoring/install_task.ps1 -PythonPath $monitorPython
Get-ScheduledTask -TaskName 'Vooglam-Local-Price-Monitor'
Get-ScheduledTaskInfo -TaskName 'Vooglam-Local-Price-Monitor'
```

安装脚本使用解释器旁的 `pythonw.exe`，拒绝覆盖同名任务，注册日程、错过补跑、30 分钟三次重试与两小时限时。已过当天 11:00 时首个日程设为次日；需要立即全量采集时另行执行手动启动。交付报告实际任务状态与下一次运行时间；完整日采和实际重试周期未验证时明确标注。

## 历史、控制与更新

`monitoring/history.sqlite3` 追加记录真实价格，即使价格不变也保留新日期。Skill 根目录 `assets/m/YYYYMMDD/` 保存价格、比较、状态、日志和截图；比较包含上一成功同配置观测及其证据。失败不覆盖成功历史；不同材料、处方、币种或商品不能直接比价。最近正式状态见 `monitoring/latest_status.json`，任务被外部终止时结合 `LastTaskResult` 判断。

演示最新价格和历史时执行 `python monitoring/build_report.py`，生成 `monitoring/reports/YYYYMMDD/index.html`、完整历史 JSON 和同名 ZIP，包含可迁移的证据副本。未刷新配置保留原观测日期；涨跌只与同配置上一观测日比较，新商品明确显示无跨日基期。

历史报告和证据仅保存在本机；标准 Skill 包不附带离线演示报告。若单独交付报告，应先核对观测日期、来源和可分享范围。

## 将旧环境历史导入已运行过的新环境

不要覆盖新环境的 `history.sqlite3`：这会丢失新环境已经保存的观测，旧库中的截图路径也可能失效。旧环境从 Skill 的 `scripts/` 目录导出，迁移包包含已入库的 Vooglam 报价、购物车截图/正文证据和只供查看的商品配置快照：

```powershell
python monitoring/transfer_history.py export --output D:\transfer\eyewear-history.zip
```

把 ZIP 复制到新环境，再从新 Skill 的 `scripts/` 目录导入；即使新环境已有历史，也按观测内容去重并追加，证据复制到新 Skill 的 `scripts/monitoring/imported_evidence/`：

```powershell
python monitoring/transfer_history.py import --input D:\transfer\eyewear-history.zip
```

导入结果报告新增与重复条数。旧商品配置另存为 `history_view_config_*.json`，不会改动新环境的 `config.json`、定时任务或持续监测授权；若要用旧配置查看历史，给 `monitoring/build_report.py` 传该文件的 `--config`。若要把旧商品加入新环境定时监测，仍需另行取得用户同意。此迁移工具只处理 Vooglam 监测历史；Firmoo 的单次采集结果保存在各运行目录，不在此库中。

```powershell
Disable-ScheduledTask -TaskName 'Vooglam-Local-Price-Monitor' # 暂停
Enable-ScheduledTask -TaskName 'Vooglam-Local-Price-Monitor'  # 恢复
Start-ScheduledTask -TaskName 'Vooglam-Local-Price-Monitor'   # 手动完整采集
Unregister-ScheduledTask -TaskName 'Vooglam-Local-Price-Monitor' -Confirm:$false # 移除，保留历史
```

原始采集目录包含累计 JSON 时，可用 `python monitoring/export_run.py --run-dir 原始脚本运行目录` 导出 `vooglam_products/verified_prices.json`，只纳入身份/可见标价已核验且已到购物车的观测，检查日期和证据。不从失败记录生成价格。加 `--archive` 可把部分成功观测追加到历史，重复导入同一观测会去重。

用户要求扩展镜片范围时，复用 `scripts/vooglam_comparison_seeds.json` 的九条 Single Vision 种子路径，运行现有 `vooglam_incremental_batch.py --url 已确认URL --seed-file 种子JSON --max-paths 80`，让实际技术与材料选项进入队列；扩展阶段不加 `--no-expand`，不运行 `--all`。每个商品独立累计目录，保留已有成功价格；并行只限不同商品，同款不可多进程同时写累计 JSON。首次队列结束后，用相同脚本的 `--plan-remaining remaining.json --seed-file 种子JSON --url 已确认URL` 离线生成尚未完成的已观察技术/材料及尚未验证的种子，再以该文件为种子补采。不能因为默认档已成功就宣称同路径所有档位完成。队列未完成、页面未提供的分支与实际失败分别记录，新增款不能长期只监测四档而不说明采集范围。

用户同意新增商品后，从新增款式的真实采集 JSON 执行 `monitoring/setup_config.py --source 新增采集价格.json --consent --append`。只追加已到购物车并有证据的组合，保留原清单和历史，拒绝同 ID 的身份变化。已有任务每次读取配置，不需要重建任务来增加商品。`--channel` 用于首次配置；追加时保留原浏览器设置。

改时间/重试间隔须同步更新配置和 Windows 任务设置，仅改 JSON 不会更新任务。不要直接覆盖已有配置或移除历史；先暂停，核对现有清单与用户授权范围，再明确更新。打包时只包含复用代码和此流程，不包含示例商品清单、本机启用配置、任务 XML、数据库、日志、历史报告、截图或每日运行目录。

处方填写不再枚举支持度数：固定双眼 SPH/CYL 0.00、PD 66，已选目标值时跳过下拉，未选时直接定位目标并验证；不可将未填项当作零，也不可用其他 PD 替代。

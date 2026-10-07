# 竞对商品看板测试包

输入为每行一件的“品牌 - 商品名/型号”列表，输出为 `run-output/dashboard/index.html`。当前实时采集支持 Vooglam 美国站普通配镜默认配色与 Firmoo 美国/英国站 Non-Prescription；默认使用较快的经典档，并保留未完成配置和失败日志。不会将未到购物车的标价当成已核验报价。

## Windows 直接测试

1. 解压 ZIP，在解压目录新建 UTF-8 名单文件 `products.txt`，每行写一件商品，例如 `Vooglam - Okinawa`。也可使用下文的 JSON 请求文件。
2. 安装 Python 3.10+，在解压目录运行 `python -m pip install -r scripts/skill/requirements.txt` 和 `python -m playwright install chromium`。Firmoo 采集还需要本机 Chrome 或 Edge。
3. 进入解压目录的 `scripts/`，运行 `python -m skill.run_list --input ../products.txt --output ../run-output --tier classic`。输出目录必须是新目录；较大档位可改为 `medium` 或 `full`，会耗时更久。
4. 返回解压目录，双击 `run-output/dashboard/index.html`。商品、证据截图和趋势检索尝试日志都保存在输出目录，可以离线查看。

指定默认展示日期可加 `--start 2026-08-01 --end 2026-08-31`；不指定时，历史窗口是运行前一日止的最近 30 个完整自然日，看板默认还包含本次当天已核验报价。明确指定日期时按该范围展示；范围外的报价会提示调整日期查看。已有同日监测报价且覆盖所选档位时会复用；要求重新采集可加 `--force-refresh`。

先验证名单解析可在 `scripts/` 运行 `python -m skill.run_list --input ../products.txt --output ../dry-run --dry-run`。此命令不会联网、核价或占用输出目录；如 `runtime_issues` 非空，先按提示补齐依赖，再用同一输出目录执行正式采集。

## 新商品

名单只需品牌和名称。若名称不在包内的已核验官网链接目录，程序会写 `clarification.json`，不擅自选择搜索结果。将核对后的官网商品链接写成 JSON，再运行同一入口，例如：

```json
{"products":[{"merchant":"Vooglam","product":"准确商品名","market":"US","url":"https://www.vooglam.com/goods-detail/12345"}]}
```

在 Codex 中使用本 Skill 时，直接发送品牌－商品名列表；Codex 应先搜索并核对新商品的官网名称、型号、配色和购买方式，生成带 URL 的请求，再调用 `skill.run_list`。如果商品身份不唯一，应把候选和分歧返回给用户，不能用其他商品替代。

## 输出状态

`run_result.json` 记录每步日志、已核验报价数和最终状态。`completed` 表示所需采集或复用步骤均成功；`partial` 表示已有报价但仍有步骤失败；零条购物车核价为 `failed`。趋势页只展示有日志的检索尝试；网页搜索线索或品牌推广不自动成为需求趋势。月环比仅在有同口径的连续月份数据时出现；演示商品含明确标注的虚构月累计案例。

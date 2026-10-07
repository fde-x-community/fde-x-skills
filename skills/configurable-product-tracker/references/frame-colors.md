# Vooglam 配色发现与最小核价

1. 仅给名称时先用已验证可用的 agent-reach 网页搜索寻找官方候选 URL，不能自动采用第一条；用户直接给 URL 仍要核验。用官网商品名、页面标题、Product Code、详情颜色和购买方式确认代表 URL。同名多版本无法确认时请用户澄清，不用相似商品替换。普通眼镜且显示 Select Lenses 才进入该流程；太阳镜和预配镜片停止。
2. 在 Color 下读取 `.goods-detail-relations-item a[href*='/goods-detail/']` 的**实际 href**，保存图片 URL、标签、选中状态和页面证据。`scripts/vooglam_product_probe.py` 在商品身份中保存 `color_options`。不要通过商品 ID +1 猜 URL。每条候选 URL 都打开并再次核对名字、SKU、`Frame Color`、US/USD 镜框价和购买方式；同色不同 SKU 均保留。缩略图标签与详情不一致时记录差异、以详情为准。
3. 代表 URL 完整采集；其他配色先各采一条 Single Vision → Standard Lenses 的首个实际技术档，固定测试处方双眼 SPH/CYL 0.00、PD 66。每款独立到 Cart 核对镜框＋镜片＝优惠前单件小计，保存购物车截图/正文及观测时间；未成功不得借用代表配色的价格。这个结果不能推及其他技术、材料或镜片类型。

可在 Skill 根目录准备隔离运行目录，复制 `scripts/vooglam_product_probe.py`、`vooglam_lens_tree.py`、`vooglam_incremental_batch.py`、`vooglam_five_product_report.py` 到目录内。将代表 URL 写入 `urls.json`，运行 probe，再从保存的 `color_options` 生成去重且排除代表 URL 的 `variant_urls.json`；逐个 probe 这些变体。已经核实的变体身份必须存在于目录内的 `vooglam_products/{ID}/vooglam_lens_tree_master.json`。把本轮实际 URL 同时写入 `vooglam_five_urls.json`，供报表模块导入。浏览器依赖按项目环境安装；Windows 可选 `--channel chrome`，Playwright 自带 Chromium 可选 `--channel chromium`。

```powershell
python vooglam_color_standard.py --run-dir '实际运行目录' --channel chromium
```

脚本每个变体最多尝试一个 Standard Lenses 配置，成功结果可复用；输出 `color_standard_prices.json`、逐 URL 日志、累计 JSON、截图和正文。区分三种状态：购物车实测、仅身份/页面报价已核验、失败。失败不覆盖成功，保留失败阶段并有限重试。没有用户持续监测同意时只做本次采集，不修改 Windows 定时任务。

2026-09-27 三款真实样例：Okinawa 链接 9992/9996/9999，Niseko 9989/9990/9991/9993，Meguro 10003/10004，故 +1 仅部分成立。9991 缩略图标签 Gold，但详情页 `Frame Color` 为 Champagne。六个其他版本的首档购物车抽测成功，证据在项目根目录 `m/c20260927/color_check_summary.json`；这不是完整镜片树验证。

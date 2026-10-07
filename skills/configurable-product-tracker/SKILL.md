---
name: configurable-product-tracker
description: 将自然语言中的 Vooglam、Firmoo 商品名单和监测时间整理为标准输入，核验官网商品身份，实时采集镜框与镜片购物车报价并生成商品看板；也可读取历史或在明确要求时配置持续监测。
---

# 跨境配镜商品调研

## 触发条件

- 用户给商品名、型号或 URL，要求核验 Vooglam 或 Firmoo 普通眼镜及镜片价格：核验商品身份并按用户表述选择采集档位，再把实际核价结果送入商品维度看板。
- 用户要求查看已有报价、跨日历史或生成看板：组装现有数据，不冒充本次实时采集。
- 用户明确要求持续监测已核验商品：说明运行范围并取得同意后，配置或更新 Windows 任务。仅查询历史不等于同意启用后台任务。

用户只需提供品牌与商品名称/型号名单，市场和日期范围可选；默认 US/USD、运行前一日截止最近 30 个完整自然日。Firmoo US/USD 与 UK/GBP 可同在看板，但分开标记，不折算或混比。Vooglam 仅支持普通配镜、默认配色、Single Vision 双眼 SPH/CYL 0.00 与 PD 66；Firmoo 当前只支持 Non-Prescription 与所给商品 URL 的配色。太阳镜及预配镜片标为不支持。只有购物车商品行的镜框＋镜片＝优惠前单件小计，且有时间、路径、截图和正文证据，才算已核价；不结账或支付。税费、运费和优惠成交价未验证。

## 自然语言转标准输入

不要让用户填写脚本参数。先从句子中提取品牌、每个品牌下的商品名/型号、明确给出的市场、日期范围与采集档位；“和、及、再看”连接的是多个商品，不是商品名的一部分。保留商品名原拼写，不用近似型号替换。普通的“看一下、查一下、盯一下”先表示本次查询，同时要问用户是否希望把本轮已核价的商品及配置加入持续监测清单；只有用户明确同意持续监测，才进入后台监测流程。

用户未指定档位或持续监测意向时，在核验商品身份的同时主动合并问一次：“本次用经典（每款先看 3 类）、中档还是全量采集？核价后要把已核验配置加入持续监测清单吗？”不要把脚本参数抛给用户。档位有明确回答就依回答；在合理等待后仍未回答，可按经典档完成本次查询并说明默认值。监测意向未回答不能视为同意，也不能自行启用后台任务。用户说“盯一下”时尤其要区分一次查询与持续监测。

| 用户未说明的字段 | 标准值 |
| --- | --- |
| 市场 | US；Vooglam 仅 US，Firmoo 如明确 UK 则记 UK/GBP；两个市场都要看时写两条商品项。 |
| 监测时间 | 运行前一日止最近 30 个完整自然日；用户给出日期或“最近 N 天”时计算实际 `start`、`end`，看板默认展示该范围。日期是展示与外部数据查询窗口，实时价格仍是实际采集时点，不伪造窗口内历史。 |
| 采集档位 | 先主动询问；未得到回答而仍需完成本次查询时默认 `classic`。“中档/更全面”用 `medium`，“全部支持配置”用 `full`。如用户明确指定配置或数量，按其范围执行并在结果中写明覆盖缺口。 |

例如“帮我看一下 Vooglam 的 Vorpal 和 Aurum，再盯一下 Firmoo 的 Grace20210”，应拆成三个商品项：`Vooglam/Vorpal/US`、`Vooglam/Aurum/US`、`Firmoo/Grace20210/US`，本次实时采集、默认日期范围；先问档位和是否持续监测。先查本 Skill 的 `scripts/skill/known_products.json`；未收录的名称搜索官方候选，逐一核对页面名称、型号、配色和购买方式，取得已确认的 URL 后才写入请求。此例中的三个 URL 均不能由示例推定。只有身份有多个合理候选或购买方式不受支持时才请用户澄清；搜索后端不可用时记录缺口，不把未核验候选送去采集。

把核验结果写成 UTF-8 JSON（以下 URL 仅表示字段位置，运行时换成实际核验的官网链接）：

```json
{
  "products": [
    {"merchant": "Vooglam", "product": "Vorpal", "market": "US", "url": "已核验的官网链接"},
    {"merchant": "Vooglam", "product": "Aurum", "market": "US", "url": "已核验的官网链接"},
    {"merchant": "Firmoo", "product": "Grace20210", "market": "US", "url": "已核验的官网链接"}
  ]
}
```

从 `scripts/` 运行 `python -m skill.run_list --input 请求文件.json --output 全新运行目录 --tier classic`。名单入口会先检查本机 Vooglam 定时监测库：若同商品 URL、名称、SKU、处方口径与所选经典/中档路径在今天均有购物车核价和完整证据，直接复用并标明实际观测时间；未覆盖的商品仍实时采集。全量档不会用固定监测清单代替遍历；用户明确要求重新刷新时加 `--force-refresh`。Firmoo 目前没有定时监测库，仍实时采集。用户没指定日期时不要写 `monitoring_period`，运行器会采用默认历史窗口，并让看板额外显示本次当天已核验报价。用户明确给出日期时才写 `"monitoring_period":{"start":"YYYY-MM-DD","end":"YYYY-MM-DD"}`；文本名单可改用 `--start YYYY-MM-DD --end YYYY-MM-DD`。明确日期只控制用户选定的展示范围，若当天报价在范围外，看板会提示可调整筛选。先用 `--dry-run` 检查标准输入、官方 URL 解析、`reused_today`、`needs_collection` 和 `runtime_issues`；它不创建输出目录，因此正式采集可使用同一 `--output` 路径。若有运行环境问题，先在执行脚本的同一个 Python 环境安装依赖或补齐安装包，再运行正式采集；输出为 `dashboard/index.html`、`run_result.json` 和各步日志。未取得唯一官网链接时，程序生成 `clarification.json`，不要把它当成已完成看板。只需已有历史时改用下文的历史回放入口。

## 工具使用规则

先定位本 SKILL.md 所在的 Skill 根目录，再进入其 `scripts/` 运行以下命令；不猜测当前工作目录。`references/` 是按需阅读的说明，`assets/` 保存模板、样例和本地运行资料。

| 任务 | 工具 | 规则 |
| --- | --- | --- |
| 商品名找官方候选 | 当前可用的网页搜索；可选 `python -m skill.resolve_products` | 搜索只提供候选；核对官网商品名、SKU、颜色和购买方式后才确认 URL。不能自动选第一条。 |
| 混合品牌名单实时采集 | `python -m skill.run_list` | 接收标准 JSON 或“品牌 - 商品名”文本，逐品牌采集后合成一个看板；保留每步失败日志。 |
| Vooglam 实时核价 | `python -m skill.live`、`scripts/` 中的采集器、Playwright | 使用根目录当前采集器，隔离运行，固定零度处方；按已选档位运行，失败不覆盖成功。 |
| Firmoo 实时核价 | `firmoo_lens_tree.py`、`firmoo_build_report.py` | 美/英站分别确认商品 URL 和型号；按已选档位点击实际可见选项，到购物车核价。 |
| 商品维度看板与分析 | `analytics.run_monitoring`、`skill.run`、Session 3、`dashboard/` | 以仓库当前分析和商品维度看板为准；筛选不重算价格，跨市场/币种/口径不合并。 |
| 其他配色 | [配色发现流程](references/frame-colors.md) | 按实际商品页链接和 SKU 核验；其他配色默认只抽测 Standard Lenses 首个实际技术档。 |
| 失败与缺口 | [采集失败规则](references/collection-errors.md) | 保留原始证据和未完成队列；不补造未提供或未核价的价格。 |
| 后台监测 | [Windows 监测流程](references/windows-monitor.md) | 只在用户明确同意后使用已核价组合建清单；报告实际任务状态。 |

## 主流程

### Step 1：录入与身份核验

Vooglam 将品牌和准确商品名写入请求文件，运行候选搜索，核验官方页面后在 `resolved_request.json` 中填写 URL。Firmoo 分别确认美/英站的商品 URL 与页面型号，传给相应市场参数。用户直接给 URL 时也核验身份；模糊名称或多版本返回澄清，不替换商品。原站 Color 的图片与实际链接是配色来源，不按商品编号加一，也不按颜色名称去重；同色不同 SKU 分开记录。

实时采集需要执行脚本的那个 Python 环境安装 Playwright，并有可用的 Chrome/Edge；运行前检查 `--dry-run` 的 `runtime_issues`，有问题先修复，不要继续生成零报价看板。名称查找可直接使用当前可用的网页搜索，不依赖 agent-reach；只有选择运行 `skill.resolve_products` 时才需要该脚本的 agent-reach 搜索后端，缺失时可改用网页搜索并人工核验 URL，不阻塞采集。只做已有数据组装时不用启动浏览器。

```powershell
python -m pip install -r skill/requirements.txt
python -m playwright install chromium
```

如需批量生成 Vooglam URL 候选且已配置 agent-reach，可选运行 `python -m skill.resolve_products --input request.json --output resolved_request.json`；无论搜索方式如何，候选都要人工核对后再用于采集。

### Step 2：选择采集或复用方式

**按用户表述和追问结果选择档位。** 未指定时先问；无回答而需要继续时使用经典档。用户明确指定中档、全量、配置或数量时按其范围执行。档位决定尝试范围，不承诺固定成功条数；交付时分别报发现、尝试、购物车核价、失败及待采数量。看板 Vooglam 商品卡固定突出经典三类，其他已核价路径在“更多配置”中；这只是展示方式，过去的 `--max-paths 3` 是队列前三个任务，不能代表经典三类已采齐。Firmoo 商品卡展示六个一级品类。

| 档位 | Vooglam（Single Vision、默认配色） | Firmoo（Non-Prescription、所给配色；每个市场分别执行） |
| --- | --- | --- |
| 经典 | Standard Lenses、Blue Light Blocking、Driving Lenses；各尝试页面首个显示技术/默认材料，共 3 条种子。 | 对应 Clear、Blue-light Blocking、Driving；每类取首个显示二级项及后续首个显示选项，共最多 3 条完整路径。 |
| 中档 | 9 条种子：经典三类，Photochromic 的 2 个子类，Transitions® 的 3 个子类，Polarized Lenses；各取首个显示技术/默认材料。 | 六个一级品类下每个可见二级项各采一条完整路径；后续颜色、折射率、镀膜取页面首个显示选项。 |
| 全量 | 从上述 9 条种子继续展开实际可见的技术与材料，直到队列完成；不包含 Color Tint、其他处方、其他配色。 | 六类下每个可达二级项以及后续实际可见的组合都尝试到购物车；不包含其他配色或处方。 |

首个显示选项不保证可选；点击失败时保存错误证据并计入缺口，不改选另一种配置冒充成功。中档或全量的实际条数取决于该商品页面及市场，不沿用另一款商品的数量。

**方式 A：本次 Vooglam 实时核价。** 用已确认的 `resolved_request.json` 和用户所选 `--tier classic|medium|full` 运行根目录采集器。全量为当前支持场景的全量，不是整站所有镜片；可用 `--max-paths` 显式限制任务数，但要在交付时标为部分采集。结果写入新的隔离目录，包含 `verified_prices.json`、商品维度 `dashboard/index.html` 和运行清单。原 Demo 的外部 Exa/Jina 链保留为独立的 `external/external_bundle.json`，来源失败不抹掉已核价结果；只需价格时可加 `--external offline`。

```powershell
python -m skill.live --input resolved_request.json --tier classic --channel chromium
```

**方式 B：本次 Firmoo 实时核价。** 美站和英站的官方商品 URL 均需核实，不能假定两个站的同编号就是同一型号。按用户所选档位运行；采集器保存商品页、镜片配置页、购物车截图及正文，并点击商品页左栏的非模特镜框缩略图，确认主图加载且无遮挡后保存单独商品图。先检查每个市场的失败和待采队列，再用汇总脚本生成已核价导出；`--tier full` 可能需要较长时间，不能因部分路径成功就宣称全量完成。

```powershell
python firmoo_lens_tree.py --market both --us-url 已确认美站URL --uk-url 已确认英站URL --tier medium --output firmoo_run
python firmoo_build_report.py --input firmoo_run
```

**方式 C：已有监测历史及 Firmoo 已验证资料。** 先用当前监测脚本导出价格历史，再通过 Session 3 适配、分析和商品维度看板生成结果。`--firmoo` 仅在有已核验文件时使用；英国站数据保持 GBP/UK 来源标记，不与 USD 报价混算。

```powershell
python monitoring/build_report.py
python -m analytics.run_monitoring monitoring/reports/YYYYMMDD/prices.json ../assets/dashboard/current-report
```

**方式 D：已有 Session 3 数据。** `skill.run` 只组装已给的规范化数据与分析 JSON，不在线采集。商品身份不唯一时输出 `clarification.json`，不得生成另一商品的替代报告。

```powershell
python -m skill.run --input request.json --dataset normalized_dataset.json --analysis analysis_bundle.json --output report
```

### Step 3：按需配置历史监测

只有用户明确同意商品、默认颜色与固定镜片组合、每天本机 11:00、失败弹窗和每隔 30 分钟最多三次重试、本地历史与证据保存后，才按[Windows 监测流程](references/windows-monitor.md)执行 `monitoring/setup_config.py` 与 `install_task.ps1`。新增商品仍须同意，只追加已到购物车的组合。手动运行不能证明定时或重试周期已验证。

旧环境的 Vooglam 监测历史要迁入已有数据的新环境时，按[历史迁移命令](references/windows-monitor.md#将旧环境历史导入已运行过的新环境)导出 ZIP 并追加导入；不要直接覆盖 SQLite 库，也不要把历史导入视为同意启动定时任务。

### Step 4：核验与交付

每次运行后先读 `run_result.json`、各步日志以及 `coverage`、`errors[]` 和购物车核价数；命令退出码 0 或生成 `dashboard/index.html` 都不等于采集成功。零条已核价必须按失败处理，不能把网页标价当购物车报价交付。Vooglam 的身份状态为 `unavailable` 时先看 `identity.log` 与原始错误：网络拒绝或超时并非身份不匹配；真实的名称、SKU 或购买方式不匹配才停止该商品。对网络、弹窗或超时等可恢复失败，按[采集失败规则](references/collection-errors.md)修复运行环境并有界重试，使用新输出目录保留旧证据；Firmoo 有失败队列时可按同档位续跑。重试后仍失败才报告原因、尝试过程和缺口。

交付商品维度 `index.html`、规范化明细、分析结果、运行清单及可访问的截图/正文证据。区分实时观测、历史回放、报告生成时间和外部来源月份；无跨日记录不画变化趋势，缺失不填零。价格变化只在同商品、SKU、处方、路径、技术、材料、币种和报价口径下比较。来源按钮能追溯原记录；无可靠发现时如实说明。HTML 是主交付，打印 PDF 仅为补充；浏览器本地行动记录在迁移前需导出 JSON。

# FDE-X-Skills

**English** | [简体中文](README.md)

<img src="assets/fde-x-logo-4x3.png" alt="FDE-X" width="320">

> **FDE, Forward Deployed Engineer** <br> Understands AI, and goes beyond it into real business scenarios; understands why a problem happens, and turns AI into reusable, deliverable results.


FDE-X Skill is an enterprise-grade skill repository open-sourced by the [FDE-X community](https://fde-x.com), following the [Agent Skills](https://agentskills.io/specification) open standard.


## Skill Catalog

**Every skill comes from a real enterprise need, and is used and validated in real enterprise settings**. 

<!-- SKILLS:START -->
| Skill | Description | Version | Maturity | Author |
|---|---|---|---|---|
| [`bootstrap-industry-config`](skills/bootstrap-industry-config/) | 从某行业的真实对话转录与多轮业务问答冷启动出一份可用的行业配置（词表、必问项、页面措辞、知识库对齐），供 sales-brief-generic 按行业特异出稿；仅在已有转录、想要行业特异而尚无配置、或需要继续收敛上一版草案时使用，它不产出销售简报。 | 0.3.0 | draft | weiweiweizizi |
| [`configurable-product-tracker`](skills/configurable-product-tracker/) | 将自然语言中的 Vooglam、Firmoo 商品名单和监测时间整理为标准输入，核验官网商品身份，实时采集镜框与镜片购物车报价并生成商品看板；也可读取历史或在明确要求时配置持续监测。 | 0.1.0 | draft | qinruipeng |
| [`sales-brief-generic`](skills/sales-brief-generic/) | 把销售咨询录音的转录（每行 [HH:MM:SS] 发言人：文本）索引成可逐字回溯的话轮，由 agent 节点做语义分析、脚本机械校验并渲染离线内部销售简报 H5，产出意向阶段、口头报价链、决策阻碍、未知待问与下一步行动；用户要求整理销售/咨询/面诊/导购录音、出客户跟进简报、核… | 0.8.1 | draft | weiweiweizizi |
<!-- SKILLS:END -->

## Enterprise Needs

> Bring a real problem in

If you have a real enterprise scenario or a pain point in landing AI, describe it through the [enterprise demand form](.github/ISSUE_TEMPLATE/enterprise-demand.yml) or [enterprise co-creation](https://fde-x.com/#enterprise).

## Open Source Contribution

> Be someone who solves the problem with us

Read the [contribution guide](CONTRIBUTING.md), link your work to a need, and propose a solution.

## FDE-X Community

- **If you are deeply interested in AI**

  Join the community. There are top-tier roles and real work you can talk about in interviews — your results go directly to the business owners who set the problem.

- **If you have deep experience landing AI and a distinct understanding of AI application scenarios**

  Join the mentor group. More than 30 mentors have joined: 10+ HRDs from publicly listed tech companies, 20+ AI algorithm and FDE leads from major tech firms, plus investors and entrepreneurs.

- **If you have deep technical expertise in AI**

  Become a technology partner. We have members from the AI labs at Fudan University, Shanghai Jiao Tong University, and the Gaoling School of Artificial Intelligence at Renmin University of China, as well as the DeepSeek AI and Shanda AI teams.

Follow the FDE-X official WeChat account and leave us a message there, or add WeChat 「AnyHelper_FDE」 to get in touch.


![FDE-X official WeChat account / WeChat AnyHelper_FDE](assets/wechat-qr.jpg)

## About Us

- **Founding members**

  From DeepSeek, Tencent Hunyuan, Doubao, Zhipu, and ByteDance, plus leading teams and universities such as Shanghai Jiao Tong University, Fudan University, Peking University, Tianjin University, and Carnegie Mellon University.

- **Mentors**

  Professors and experts who understand AI, HR leads at publicly listed tech companies who understand hiring, and investors who understand startups.

- **Technical review committee and partners**

  AI labs at Fudan University, Shanghai Jiao Tong University, and the Gaoling School of Artificial Intelligence at Renmin University of China, plus the DeepSeek AI and Shanda AI teams.

## Documentation

- [From Enterprise Needs to Skills](docs/从企业需求到Skill.md) (Chinese): demand intake, task practice, and the distillation process
- [Skill Structure and Verification](docs/Skill结构与验证.md) (Chinese): skill structure, quality checks, and maturity assessment

## License

[MIT](LICENSE).

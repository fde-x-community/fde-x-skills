# agent-reach 最小配置

此包不携带本机账号、Cookie、Token 或工具安装目录。AI 在目标环境先检查 `agent-reach doctor --json`、`node --version`、`mcporter --version`。已有工具但 PATH 找不到时先定位实际可执行文件，不重复安装。

缺少 agent-reach 时，阅读并遵循当前[官方安装说明](https://raw.githubusercontent.com/Panniantong/agent-reach/main/docs/install.md)。优先使用用户级独立虚拟环境或 pipx 安装。官方安装源：`https://github.com/Panniantong/agent-reach/archive/main.zip`。

只配置本 Skill 用到的公开网页与 Exa 搜索，不安装全部社交渠道。`agent-reach install --env=auto` 默认只检查；不要把检查当作已安装后端。缺少 mcporter 时安装该工具；缺少 Exa 配置时运行 `mcporter config add exa https://mcp.exa.ai/mcp --scope home`。这些基础配置属于用户要求的 demo 准备；环境要求额外权限时按实际权限处理，不关闭安全保护。

完成后实际验证：

```bash
agent-reach doctor --json
mcporter call exa.web_search_exa query="site:vooglam.com/goods-detail Spine" numResults=5
curl --fail --location "https://r.jina.ai/https://www.vooglam.com/goods-detail/9253"
```

agent-reach 是路由与环境检查工具；搜索使用上游 Exa/mcporter，网页读取使用 Jina Reader。安装成功与后端可用是两件事。无网络、Node、工具执行权限或上游额度时记录失败，继续可运行的模块。付费或登录来源保持待接入；不自行取得凭据。

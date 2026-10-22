# Team MCP Manager

面向团队的 MCP 管理器开发原型，提供 MCP 服务目录、用户与用户组、工具级授权策略，以及管理配置审计界面。目标是让 AI 客户端连接统一网关，由网关集中认证、授权并转发到团队部署的 MCP 服务。

## 当前包含

- MCP 服务登记、类别、远程地址和传输方式维护
- 连接 Streamable HTTP MCP 服务并同步工具清单（优先支持 2026-07-28 协议，旧版服务回退到初始化握手）
- 服务状态与工具清单展示
- 用户组级工具授权策略：允许、需审批、拒绝
- 演示用户管理和本地配置变更审计
- 单机管理台 API 与响应式网页界面

## 跨平台可执行文件

程序不需要在目标电脑预装 Node.js。使用 Node.js 24 和 npm 在项目目录运行：

```sh
npm install
npm run build:all
```

`dist/` 中会生成以下平台版本：

- Windows x64：`TeamMcpManager.exe`
- macOS Intel：`team-mcp-manager-macos-x64`
- macOS Apple 芯片：`team-mcp-manager-macos-arm64`
- Linux x64：`team-mcp-manager-linux-x64`
- Linux ARM64：`team-mcp-manager-linux-arm64`

只构建单个平台时，可使用 `npm run build:win`、`npm run build:mac` 或 `npm run build:linux`。双击/运行相应程序后会启动本机管理器并尝试打开浏览器；如果没有自动打开，请访问 `http://127.0.0.1:4173`。运行数据按操作系统和当前用户分别保存：Windows 在 `%LOCALAPPDATA%\TeamMcpManager\data\manager.json`，macOS 在 `~/Library/Application Support/team-mcp-manager/data/manager.json`，Linux 在 `$XDG_DATA_HOME/team-mcp-manager/data/manager.json`（未设置 `XDG_DATA_HOME` 时使用 `~/.local/share`）。

GitHub Actions 会在 Windows、macOS 和 Linux 构建机上分别构建并提供可下载的构建产物。macOS 版本需要遵从 macOS 的应用安全提示；如需正式对外分发，后续还应配置 Apple Developer ID 签名与公证。

## 开发模式本机运行

需要 Node.js 20 或更高版本。不需要安装第三方 npm 依赖。

```sh
npm start
```

浏览器打开 `http://127.0.0.1:4173`。首次启动时会在 `data/manager.json` 创建演示数据。可通过环境变量 `MCP_MANAGER_PORT` 更改本地端口。

## 重要安全边界

- 服务只绑定 `127.0.0.1`，用于本机开发预览。
- 此版本没有登录或用户认证；演示身份不能用于真实员工访问。
- 工具同步只读取服务元数据；管理器尚未代理工具调用，权限策略不能拦截真实调用。
- 不要向演示界面输入密码、访问令牌或其他秘密信息。
- 需要登录的下游 MCP 服务暂不可同步；员工身份传递、个人凭据保管、数据库写入/删除授权、审批和云之家登录尚未实现。
- 本项目目前不能直接部署为团队生产服务，也不能用于保护真实数据。

## 后续开发方向

1. 接入团队身份提供方和管理员登录。
2. 增加远程 MCP 网关、OAuth 客户端接入和调用级权限校验。
3. 使用安全凭据库保存目标服务的个人身份凭据。
4. 接入首个 SQL Server MCP，并实现资源范围、审批及调用审计。
5. 完成 HTTPS、访问边界、备份、监控与生产部署。

欢迎通过 GitHub Issues 讨论功能或报告问题。发布版本和许可条款会在后续阶段补充。


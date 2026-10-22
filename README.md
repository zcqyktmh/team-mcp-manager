# Team MCP Manager

面向团队的 MCP 管理器开发原型，提供 MCP 服务目录、用户与用户组、工具级授权策略，以及管理配置审计界面。目标是让 AI 客户端连接统一网关，由网关集中认证、授权并转发到团队部署的 MCP 服务。

## 当前包含

- MCP 服务登记、类别、远程地址和传输方式维护
- 连接 Streamable HTTP MCP 服务并同步工具清单（优先支持 2026-07-28 协议，旧版服务回退到初始化握手）
- 提供 MCP 管理工具端点，AI 可提交服务上架申请并查询状态
- 指定平台管理员审核；通过后只登记为服务草稿，不自动执行安装或开放调用
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

AI 客户端可连接 `http://127.0.0.1:4173/mcp`（Streamable HTTP），使用 `submit_mcp_publication` 提交已部署 MCP 服务的名称、类别、地址、用途、申请人账号和指定审核人账号；`get_mcp_publication_status` 可查询申请状态。审核页面位于“发布审批”。审核通过后服务以草稿登记，仍需连接服务同步工具并由管理员启用。

## 重要安全边界

- 服务只绑定 `127.0.0.1`，用于本机开发预览。
- 此版本没有登录或用户认证；演示身份不能用于真实员工访问。
- 工具同步只读取服务元数据；管理器尚未代理工具调用，权限策略不能拦截真实调用。
- “发布审批”目前完成申请、指定审核、通过后登记草稿的流程；不会在服务器安装第三方代码或执行部署命令。
- MCP 提交人账号和审核人账号当前是本机预览中的自报/模拟身份，审核人选择不能替代登录认证。
- 不要向演示界面输入密码、访问令牌或其他秘密信息。
- 需要登录的下游 MCP 服务暂不可同步；员工身份传递、个人凭据保管、数据库写入/删除授权、审批和云之家登录尚未实现。
- 本项目目前不能直接部署为团队生产服务，也不能用于保护真实数据。

## 后续开发方向

1. 接入云之家登录，使用可信员工身份限制申请与审核。
2. 完成受控部署执行器和专人审核后的服务器部署流程。
3. 增加远程 MCP 网关、调用级权限校验与审批拦截。
4. 使用安全凭据库保存目标服务的个人身份凭据，并接入 SQL Server MCP。
5. 完成 HTTPS、访问边界、备份、监控与生产部署。

欢迎通过 GitHub Issues 讨论功能或报告问题。发布版本和许可条款会在后续阶段补充。


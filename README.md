# Team MCP Manager 1.0.0

公司内部使用的 MCP 管理台和员工工具访问网关，提供网页后台、员工自助工作台、云之家登录、发布审核、工具权限及个人凭据管理。

**1.0.0 为首个功能发布版，不代表已经完成生产安全审计或真实企业系统联调。** 当前采用单进程本地文件存储，建议先在隔离环境试用。

## 功能

- MCP 服务登记、配置弹窗、启停、工具同步和连接状态。
- 员工工作台：公司市场、个人工具权限、使用申请、个人凭据和提交记录。
- 公开 / 受限 MCP 和 Skill；管理员审核发布与员工使用申请。
- 员工提交已部署的远程 MCP 地址、上传 Skill ZIP；指定管理员审核。
- 用户组维护、用户组和个人工具授权、管理页面访问控制。
- 云之家官方扫码 / 轻应用登录与账号预绑定；首位管理员扫码获取身份并人工确认。
- 浏览器登录缓存最长 7 天；会话和个人凭据加密保存在服务端。
- 员工服务专属 Bearer 令牌：有效期 30 天，只显示一次，支持撤销。
- 网关 `/gateway/<服务ID>/mcp`：过滤工具清单、逐次鉴权、使用员工本人下游凭据。
- 后台运行日志与配置审计；可收起侧栏、表格编辑和弹窗表单。

## 下载与运行

在 [Releases](https://github.com/zcqyktmh/team-mcp-manager/releases) 下载相应平台文件。打包版内置 Node.js，无需另行安装运行环境。

| 平台 | 文件 |
| --- | --- |
| Windows x64 | `TeamMcpManager.exe` |
| Linux x64 | `team-mcp-manager-linux-x64` |
| Linux ARM64 | `team-mcp-manager-linux-arm64` |
| macOS Intel | `team-mcp-manager-macos-x64` |
| macOS Apple 芯片 | `team-mcp-manager-macos-arm64` |

Windows 运行 EXE；Linux / macOS 先赋予执行权限 `chmod +x <文件>`，再运行。macOS 版本未配置 Developer ID 签名和公证，下载后需在 Mac 上执行 `codesign --force --sign - <文件>` 进行本机 ad-hoc 签名后再运行。未对所有平台进行运行验证。

程序默认只监听 `127.0.0.1:4173`。打开 `http://127.0.0.1:4173`。首次启动为本机演示模式；企业使用前必须启用企业身份认证。公司服务器对外服务需要另行配置 HTTPS 反向代理与网络访问边界。

## 开发与构建

源码运行需要 Node.js 20+；构建建议 Node.js 24。

```sh
npm ci
npm start
```

```sh
npm run build:win
npm run build:linux
npm run build:mac
npm run build:all
```

产物位于 `dist/`；GitHub Actions 也提供各平台构建产物。

## 数据位置

- 源码运行：项目的 `data/`。
- Windows 打包版：`%LOCALAPPDATA%/TeamMcpManager/data/`。
- macOS 打包版：`~/Library/Application Support/team-mcp-manager/data/`。
- Linux 打包版：`$XDG_DATA_HOME/team-mcp-manager/data/`；未设置时为 `~/.local/share/team-mcp-manager/data/`。
- `MCP_MANAGER_DATA_DIR` 可指定数据目录；`MCP_MANAGER_PORT` 可更改端口。

`data/`、`.env`、截图和构建文件不会提交源码仓库。备份时需保护完整数据目录（包括签名密钥），限制服务账号和备份访问权限。

## 配置企业登录

后台“集成登录”填写云之家应用资料、回调地址及管理员身份，先保存草稿，再扫码并确认首位管理员身份，最后启用并重启。员工手机号由企业管理员核验，并绑定企业成员稳定身份；不按姓名自动匹配。管理器不收集云之家密码。

配置文件 `data/auth-settings.json` 含应用密钥，请勿上传仓库。其他平台（企业微信、钉钉、飞书、QQ、微信）暂为规划 / 配置草稿，不可作为已支持登录方式。

## 员工连接 MCP

1. 管理员登记远程服务，同步工具，启用并发布到市场。
2. 管理员授予用户组或个人具体工具权限；没有授权默认拒绝，明确拒绝优先。
3. 员工登录“我的 MCP”，配置本人下游服务凭据。
4. 在“AI 工具连接”创建令牌，复制服务器地址和 Bearer 令牌到支持自定义授权头的 Streamable HTTP 客户端。
5. 客户端连接 `https://公司管理器域名/gateway/<服务ID>/mcp`，设置 `Authorization: Bearer <个人令牌>`。

令牌不增加工具权限。网关每次检查最新用户、服务和权限状态；浏览器 Cookie 不能代替客户端令牌。生产网络应限制下游 MCP 仅允许网关服务器访问，防止绕过鉴权。

## 当前限制

- 尚未实现客户端 OAuth 浏览器授权；启用企业登录后旧 `/mcp` 发布工具端点拒绝匿名访问。员工资源提交请使用工作台。
- 服务器自助部署、容器执行器、外部市场导入、Skill 客户端自动同步尚未实现。MCP 审核通过后仅登记草稿。
- 网关目前开放工具清单与调用，不支持资源、提示词、服务端采样或长连接推送。
- 数据范围由下游 MCP 和数据源权限执行；尚无 SQL 语义检查、行级策略或删除逐次审批。通用 SQL 工具权限不能代替数据库账号权限。
- 下游 `none` 认证不能保证员工身份。使用 Basic / Bearer 时每人分别绑定凭据，不共享管理员凭据。
- Skill ZIP 检查仅为静态检查，不执行脚本，也不能替代恶意软件检测。
- 本地 JSON 存储适用于试用，不支持多进程 / 多副本一致性；并发授权修改、容灾、生产审计和真实下游联调仍需完善。
- 跨平台打包成功不等于已完成各平台安装、签名或运行验证。

## 文档

- [员工网关说明](docs/employee-gateway.md)
- [统一登录与身份源规划](docs/identity-provider-plan.md)
- [员工市场和部署规划](docs/employee-marketplace-plan.md)
- [Skill 分发规划](docs/skill-distribution-plan.md)

欢迎通过 Issues 反馈问题。仓库公开可见，目前未指定开源许可证；公开展示不自动授予额外的使用或分发许可。

# WinCodex

WinCodex 是面向 Windows 10/11 的本机只读 MCP 文件服务。React 界面由本机 Fastify 服务提供；服务只监听 `127.0.0.1`，Tunnel 使用出站 TLS 连接。用户明确授权目录后，MCP 工具才能读取其中受支持的文本和文档。

## 启动

1. 安装 Windows 10/11、Microsoft Edge，以及 Node.js **22.21.x 或 24.5 及以上版本**（Node.js 23 不受支持）。
2. 双击项目根目录的 [`启动WinCodex.cmd`](./启动WinCodex.cmd)；也可以双击 [`WinCodex.lnk`](./WinCodex.lnk)。启动脚本会检查依赖、构建前后端、启动隐藏的本机服务，等待健康检查通过后打开独立的 WinCodex Edge 应用窗口。重复双击会切回已有窗口，不会重复启动服务。
3. 关闭应用时双击 [`停止WinCodex.cmd`](./停止WinCodex.cmd)。它会关闭 WinCodex 的 Edge 应用窗口和本机服务，不会关闭日常使用的 Edge 窗口。

快捷方式、启动脚本和停止脚本均位于项目目录。首次安装依赖需要 npm 能访问配置的包源。即使没有 Tunnel 凭据，也可以打开界面、管理目录和使用本地文件浏览器。

## 本地开发与验证

在项目根目录运行：

```powershell
npm install
npm run build
npm test
npm audit --audit-level=high
```

`npm run dev` 可并行启动 Fastify 与 Vite 开发服务。运行环境和正式构建仍使用 `127.0.0.1` 本地服务。

## 能力

- 五个中文页面：首页、目录授权、文件管理、运行日志和设置。
- 10 个只读 MCP 工具：`list_roots`、`list_directory`、`stat_file`、`search_files`、`search_file_contents`、`read_text`、`read_document`、`read_file_chunk`、`get_connection_status` 和 `get_capabilities`。
- 使用 Windows 文件夹选择器或本地绝对路径添加多个授权根；可测试、暂停和移除。每次文件访问都会再次检查授权状态。
- 文件操作通过 Windows 句柄取得最终路径并拒绝越界路径和 reparse point。图片只返回元数据，不读取图片正文。
- 文本支持 UTF-8、BOM、UTF-16 和 GB18030；PDF、DOCX、XLSX、PPTX 只提取文本，并限制输入、展开数据和输出规模。
- 设置保存在 `data/state.json`，日志保存在 `data/logs.jsonl`。Runtime API Key 和可选 MCP Bearer 使用当前 Windows 用户的 Credential Manager，不写入普通 JSON 文件。
- Secure MCP Tunnel 使用官方协议的 metadata、长轮询和 response 流程。界面分别显示 Tunnel 状态和 ChatGPT 连接器注册提示。

## 首次配置 Tunnel

在“设置”页填写连接器名称、Tunnel ID 和 Runtime API Key；密钥保存至 Windows Credential Manager。可选 MCP Bearer 用于保护本机 MCP HTTP 端点。先在“目录授权”页添加一个范围较小的测试目录，再启动 Tunnel。

双击启动器会让 WinCodex 后端通过迷雾通 HTTP 代理 `http://127.0.0.1:9910` 访问 Tunnel API。代理端口变化时，修改 `scripts/launch.ps1` 中的 `$proxyUrl`。

“设置”页的“测试连接”会验证 Runtime API Key 的 Tunnel metadata 认证及本地 MCP 工具发现；首页显示实时长轮询状态。ChatGPT 网页端连接器注册仍需在 ChatGPT 中确认，应用不会把本机运行状态显示成 ChatGPT 已连接。

## 数据与临时文件

- `data/state.json`、`data/logs.jsonl`、`data/server.lock`：本机设置、诊断日志和后台进程锁。不要手工编辑运行中的状态文件。
- `.tmp/`：运行时端口信息、服务输出日志及 WinCodex 专用 Edge 配置目录。用 `npm run clean:tmp` 清理脚本识别的临时文件；它保留运行状态、Edge 配置目录、锁、凭据、正式日志和用户数据。
- `apps/server/dist/`、`apps/web/dist/`、`node_modules/`：构建与依赖目录，可由 npm 构建或安装重新生成。

## 安全边界

服务默认绑定 `127.0.0.1`，检查本机请求的 Host/Origin，并以会话 CSRF token 保护写操作；没有开放 CORS。MCP 文件工具保持只读，不提供文件写入、删除、命令执行或脚本执行功能。运行在同一 Windows 用户会话中的其他本机进程仍可能访问本地 HTTP 服务；请保护本机账户，并只授权必要目录。

更多说明见 [`docs/ANALYSIS.md`](docs/ANALYSIS.md)、[`docs/FEATURE_PARITY.md`](docs/FEATURE_PARITY.md)、[`docs/SECURITY.md`](docs/SECURITY.md) 和 [`docs/TESTING.md`](docs/TESTING.md)。

## 主要依赖

React、Vite、Fastify、TypeScript、Lucide、`fast-xml-parser`、`yauzl`、`iconv-lite` 和 `pdfjs-dist`。依赖及其许可证清单和协议参考见 [`docs/ANALYSIS.md`](docs/ANALYSIS.md)。

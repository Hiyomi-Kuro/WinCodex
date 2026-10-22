# Androdex 源码分析与移植决策

## 阅读范围

参考项目：`D:\Download\AndroidStudioProjects\Androdex`。分析覆盖 Android 应用图与 ViewModel、数据模型、10 个 MCP 工具及参数验证、Secure MCP Tunnel 客户端/生命周期/错误策略、文件授权与文档解析、路径策略、凭据与设置、日志脱敏、五个 Compose 页面和现有测试。实现判断以 Kotlin 源码和测试为准；项目文档用于了解原始意图。

WinCodex 把 Android 生命周期替换为 Windows 本地服务，把 SAF 授权替换为显式目录白名单，把 Android Keystore 替换为 Windows Credential Manager。功能与状态逐项映射见 [`FEATURE_PARITY.md`](FEATURE_PARITY.md)。

## Android 行为与 Windows 对应实现

| Androdex 模块 | 核心行为 | WinCodex 对应模块 |
|---|---|---|
| `MainActivity`、`AndrodexApplication`、`AppGraph`、`MainViewModel`、`Models` | 构造依赖图、持有屏幕状态、协调用户操作和服务状态 | `apps/server/src/index.ts` 组合 Fastify、文件服务、MCP 和 Tunnel；`apps/web/src/App.tsx` 获取真实后端快照和处理页面操作 |
| `McpToolRegistry`、`McpRequestHandler`、`McpToolExecutor`、`McpResponseLimiter`、`McpRuntimePorts` | 工具 schema、MCP JSON-RPC、参数拒绝、执行边界和输出限制 | `apps/server/src/mcp/` 注册十个工具、校验参数、兼容 legacy 与 stateless discovery、调用文件服务并限制响应 |
| `TunnelClient`、`TunnelConnectionManager`、`TunnelErrorPolicy`、`TunnelProtocol`、`ConnectionService` | HTTPS 控制平面请求、长轮询、任务分发、响应关联、状态与重试 | `apps/server/src/tunnel/` 实现 metadata、poll、response、命令时限、并发和退避；与 Web 服务的启停状态分离 |
| `FileAccessManager`、`PermissionManager`、`PathNormalizer`、`AbsolutePathResolver`、`ReadAccessPolicy` | SAF/显式路径授权、根内相对路径、安全检查、错误映射 | `apps/server/src/file-service.ts`、`apps/server/src/safe-fs.ts` 与 `scripts/safe-fs.ps1`：持久根 ID、Win32 句柄最终路径验证、范围检查和结构化错误 |
| `FileContentReader`、`DocumentParser` | 编码检测、字符/行/字节分页、Office/PDF 文本提取和资源限制 | `apps/server/src/file-service.ts` 流式读取和分页；`apps/server/src/document-parser.ts` 解析文本内容和限制 ZIP/XML/PDF 资源 |
| `SecureCredentialStore`、`SettingsRepository` | 密钥安全保存；普通设置持久化、默认值和范围校验 | `apps/server/src/credential-store.ts` 调用 Windows Credential Manager；`apps/server/src/state-store.ts` 原子保存非秘密设置与运行统计 |
| `DiagnosticsManager`、`SecretRedactor` | 有界日志，隐去密钥和文件正文 | `apps/server/src/diagnostics.ts`、`apps/server/src/redaction.ts` 将脱敏事件写入 `data/logs.jsonl` |
| `HomeScreen`、`PermissionsScreen`、`FileManagerScreen`、`LogsScreen`、`SettingsScreen` | 服务状态、授权根、文件浏览、诊断和配置 | `apps/web/src/App.tsx` 的五个中文页面；React 通过受 CSRF 保护的本机 API 读写后端 |

## 关键语义

- 10 个工具名称、参数 schema 和主要返回分页字段保持与 Androdex 一致。字符偏移、行偏移与字节偏移分别处理。
- `read_document` 提取 PDF、DOCX、XLSX、PPTX 文本；图片只提供文件元数据。
- 根目录授权不是对磁盘的自动授权。请求同时携带根 ID 和根内相对路径，后端会再次检查根是否启用、仍可访问且路径未离开根目录。
- Tunnel 和 MCP 工具执行保留真实后端路径。协议单测使用模拟控制平面验证请求结构与状态机，不将模拟测试描述为官方账户认证。
- Android 的前台服务、通知与电池优化改为 Windows 隐藏 Node 进程、显式启动/停止脚本和 HTTP 健康检查；Web 服务仍可在 Tunnel 停止时管理设置。

## 文档与源码差异

Androdex `ARCHITECTURE.md` 提及默认单文件读取上限为 5 MiB，但 `SettingsRepository.kt` 实际默认值和最大值为 64 MiB。移植遵循实际设置仓库代码，WinCodex 默认单文件读取上限为 64 MiB，并在界面和解析器中保留对应边界。

## Secure MCP Tunnel 协议依据

核对了 OpenAI `tunnel-client` 官方协议文档，并按 `2026-08-25` wire 版本实现 plural endpoint、metadata、长轮询上限与超时、shard token 和 response 关联。协议可能继续演进，升级前应重新核对官方文档：[Tunnel protocol](https://github.com/openai/tunnel-client/blob/master/docs/protocol.md)。MCP JSON-RPC 与工具 schema 参考官方 [TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)；项目实现按 Androdex 工具行为保留自身访问控制，不直接执行任意 SDK server 示例代码。

## 直接依赖与许可证

| 组件 | 项目用途 | 许可证 |
|---|---|---|
| React / React DOM | 五个交互页面 | MIT |
| Vite / `@vitejs/plugin-react` | 前端开发与构建 | MIT |
| Fastify | 本机 HTTP API、路由和请求钩子 | MIT |
| TypeScript | 服务端与前端静态类型 | Apache-2.0 |
| Lucide React | 界面图标 | ISC |
| `fast-xml-parser` | Office XML 安全解析 | MIT |
| `yauzl` | Office Open XML ZIP 容器读取 | MIT |
| `iconv-lite` | GB18030 文本解码 | MIT |
| `pdfjs-dist` 6.4.299 | PDF 文本提取 | Apache-2.0 |
| `tsx`、`npm-run-all2` | TypeScript 测试执行与并行脚本 | MIT |

依赖版本固定在 `package-lock.json`。PDF.js 官方安全公告影响 5.6.83 至 6.2.107；WinCodex 使用 6.4.299，并仅用 Node 文本提取 API，不创建可执行脚本的 PDF viewer：[Mozilla advisory](https://github.com/mozilla/pdf.js/security/advisories/GHSA-hq66-cqwq-w95j)、[PDF.js releases](https://github.com/mozilla/pdf.js/releases)。

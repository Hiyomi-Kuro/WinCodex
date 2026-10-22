# Androdex → WinCodex 功能对照

参考 Androdex 的 Kotlin 实现、现有测试和项目文档；以源码行为为准。Windows 版本将 Android SAF、Keystore 与前台服务分别替换为 Windows 本地目录白名单、Credential Manager 和独立隐藏进程。详细来源与协议决策见 [ANALYSIS.md](ANALYSIS.md)。

**状态含义：** `自动测试通过`＝实现已由本机自动化覆盖；`本机实测`＝桌面/Windows 启动或 UI 流程已实测；`Mock 验证`＝协议状态机通过模拟控制平面测试；`外部待验证`＝需要真实 OpenAI/ChatGPT 账户；`Windows 替代`＝Android 专属行为按 Windows 生命周期替换。

## 架构与只读工具

| 功能 | Androdex 行为 | WinCodex 对应实现 | 状态 |
|---|---|---|---|
| 应用架构 | Compose、MVVM、Repository、AppGraph | React/Vite + Fastify，API 连接文件、设置、MCP 与 Tunnel 层 | 自动测试通过 |
| 后台生命周期 | 前台服务、常驻通知、网络状态 | 隐藏 Node 进程；Web 服务和 Tunnel 分开启停 | 本机实测 |
| 只读边界 | 不写入/删除/执行；图片只给元数据 | 十个 MCP 工具只读；图片只给元数据 | 自动测试通过 |
| Android 权限/电池/通知 | SAF、通知、前台服务权限 | Windows 目录选择器、本地进程状态和启停脚本 | Windows 替代 |
| `list_roots` | 返回当前已授权根 | 持久根 ID、启用与实时可访问状态 | 自动测试通过 |
| `list_directory` | 元数据、分页、可选递归 | 句柄校验后的元数据分页 | 自动测试通过 |
| `stat_file` | 单项元数据 | 大小、类型、时间、图片标识 | 自动测试通过 |
| `search_files` | 限深递归文件名搜索 | 有界递归、结果上限和大小写选项 | 自动测试通过 |
| `search_file_contents` | 返回匹配行和行号，有扫描限制 | 流式解码、字节预算、逐文件和结果上限 | 自动测试通过 |
| `read_text` | Unicode 字符偏移与行分页 | UTF-8/BOM、UTF-16、GB18030 和字符/行游标 | 自动测试通过 |
| `read_document` | PDF/DOCX/XLSX/PPTX 文本提取 | PDF.js 文本提取、受限 ZIP/XML 解析 | 自动测试通过 |
| `read_file_chunk` | 字节偏移和 UTF-8/UTF-16 安全边界 | 有界字节页和正确字符解码 | 自动测试通过 |
| `get_connection_status` | Tunnel 实际状态；不臆测 ChatGPT 注册 | 本机服务状态、Tunnel 状态和 ChatGPT 注册分别呈现 | 自动测试通过 |
| `get_capabilities` | Android API/SAF/格式与限制 | Windows 平台、只读格式与授权根范围 | 自动测试通过 |

## MCP 与 Secure MCP Tunnel

| 功能 | Androdex 行为 | WinCodex 对应实现 | 状态 |
|---|---|---|---|
| MCP 初始化 | legacy initialize 与现代发现 | 兼容 legacy `initialize`、stateless `server/discover` | 自动测试通过 |
| 工具发现/调用 | schema、参数类型与必填字段校验 | 十个 schema、JSON-RPC 错误和响应大小限制 | 自动测试通过 |
| Bearer 验证 | 可选 Bearer、常量时间比较 | Credential Manager 读取，页面不能回读明文 | 自动测试通过 |
| Tunnel metadata | Bearer + TLS 元数据 GET | 官方协议 plural endpoint 与 `2026-08-25` wire 版本 | Mock 验证 |
| Tunnel 长轮询 | 15 秒 poll、并发与命令期限 | 最多 25 条提示、15 秒长轮询、命令期限、三路并发 | Mock 验证 |
| Tunnel response | 请求 ID、shard token、channel 关联 | 官方 response 结构、逐命令回传 | Mock 验证 |
| 重试与认证错误 | 指数退避；认证/配置错误不紧密重试 | 上限退避与 401/403/404 分类 | Mock 验证 |
| 官方 Tunnel 认证/长轮询 | 真实账户验证 | 正式客户端实现已完成；此环境没有真实密钥和 Tunnel ID | 外部待验证 |
| ChatGPT 连接器注册 | Tunnel API 无法可靠查询 | 说明需要在 ChatGPT 网页确认 | 外部待验证 |

## Windows 授权、文件、数据

| 功能 | Androdex 行为 | WinCodex 对应实现 | 状态 |
|---|---|---|---|
| 多根授权 | SAF 或显式路径白名单 | Windows 文件夹选择器和绝对路径添加，GUID root ID | 自动测试通过；原生选择器待手动确认 |
| 启用/暂停/删除 | 单根开关和释放 SAF 权限 | 持久化授权，每次访问重新验证 | 自动测试通过 |
| 路径安全 | 规范化、根边界与沙箱拒绝 | Win32 句柄最终路径、边界比较和 reparse point 拒绝 | 自动测试通过 |
| 文件异常 | 撤权、缺失、不可读、超限结构化报告 | 稳定错误码和日志脱敏 | 自动测试通过 |
| 编码 | UTF-8/BOM、UTF-16 BOM、GB18030 合理检测 | 有界流式解码和 Unicode 分页 | 自动测试通过 |
| PDF/Office | 页数、ZIP/XML 和字符资源限制 | PDF 页、ZIP 展开字节、XML 体积与总文本限制 | 自动测试通过 |
| 设置 | SharedPreferences | `data/state.json` 原子落盘；密钥另存 | 自动测试通过 |
| 凭据 | Android Keystore AES/GCM | 当前 Windows 用户 Credential Manager | 自动测试通过；真实密钥由用户配置 |
| 诊断日志 | 有界、脱敏、不记正文 | `data/logs.jsonl` 有界持久化，密钥/正文不写日志 | 自动测试通过 |

## 五个页面、启动和维护

| 页面/功能 | Androdex 对应行为 | WinCodex 对应实现 | 状态 |
|---|---|---|---|
| 首页 | Android、根、MCP、Tunnel、最近请求 | Windows 主机、根、连接状态、计数与最近事件 | 本机实测 |
| 目录 | 添加、测试、开关、删除 | 原生选择器/路径添加、访问测试、暂停、删除 | 本机实测；原生选择器待手动确认 |
| 文件 | 浏览、元数据、预览和复制路径 | 分页文件表格、面包屑、只读预览 | 本机实测 |
| 日志 | 事件、时间、耗时、字节与清除 | 脱敏、持久化、筛选、刷新和清除 | 本机实测 |
| 设置 | Tunnel、密钥、读取上限、主题和说明 | Credential Manager、运行参数、三态主题、ChatGPT 说明 | 本机实测 |
| 本机 Web 防护 | 无入站 Web listener | `127.0.0.1`、Host/Origin、无 CORS、CSRF | 自动测试通过 |
| 双击启停 | Android launcher | 启动 CMD 幂等启动隐藏服务并打开独立 Edge 应用窗口；停止 CMD 关闭该窗口和服务，不干扰用户 Edge 配置 | 本机实测 |
| 临时清理 | 无 Windows 临时目录要求 | 白名单清理 `.tmp` 临时文件，保留运行数据 | 本机实测 |

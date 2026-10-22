# WinCodex 测试记录

## 自动化与构建

最终在本项目 Windows 环境（Node.js 24.18.0）运行：

| 命令 | 结果 |
|---|---|
| `npm test` | 14/14 通过，0 失败、0 跳过 |
| `npm run build` | TypeScript 服务端构建成功；Vite 构建成功（1579 modules） |
| `npm audit --audit-level=high` | 0 vulnerabilities |
| `npm audit --omit=dev --audit-level=high` | 0 vulnerabilities |

测试覆盖真实 Windows 文件句柄和目录分页、中文路径、根边界、junction 越权拒绝、UTF-8/BOM、UTF-16、GB18030、字符/行/字节分页、PDF/DOCX/XLSX/PPTX 提取和资源上限、十个 MCP 工具、legacy/modern MCP、Bearer、错误与输出限制、脱敏、当前用户 Credential Manager 临时条目读写删除，以及 Secure MCP Tunnel 模拟服务的 metadata/poll/response、shard token、超时、401 和退避/停止。

## Edge 浏览器冒烟

用独立临时 Edge profile 打开正式构建后的本机服务，检查首页、页面导航、手动授权临时目录、文件分页与文本预览、深色主题保存并刷新恢复、日志显示和 390px 窄屏溢出。结果：全部通过，运行期异常 0 个。测试目录、Profile 和截图已清理；应用计数恢复为运行测试前的值。

## Windows 启停和维护

- 真实 Windows `.lnk` 由 `WScript.Shell` 创建，并通过 COM 检查 PowerShell 目标、项目工作目录和启动参数。通过根目录启动脚本启动后，Edge 使用 `.tmp/edge-profile` 中的独立配置打开 WinCodex 应用窗口；重复启动会切回已有窗口，Node 服务 PID 不变且只有一个服务实例。
- 双击停止脚本后，WinCodex Edge 配置对应的应用窗口及服务进程退出，`.tmp/server.json`、`.tmp/web.json` 和 `data/server.lock` 清除；默认 Edge 配置下的进程仍在运行。即使服务运行状态文件缺失，停止脚本也会按项目服务入口与独立 Edge 配置定位并关闭对应进程。
- `启动WinCodex.cmd` 和 `停止WinCodex.cmd` 均由 Windows 双击执行检查；根目录快捷方式文件仍存在。
- `scripts/clean-temp.ps1` 清除了白名单服务日志、截图和测试临时文件；额外放置的非白名单 `.tmp` 文件及 `data/` 设置、日志均保留。
- 根目录 `WinCodex.lnk` 最终版本已重新生成并验证目标与工作目录存在；`launch.ps1` 会在快捷方式缺失时尝试恢复它。`.tmp/edge-profile` 是停止脚本管理的专用浏览器配置，不属于白名单清理内容。

## 尚需外部/人工验收

- 没有真实 OpenAI Runtime API Key 和 Tunnel ID，因此官方 Tunnel metadata 认证与真实长轮询未在账户上验证；模拟服务测试不代表官方认证成功。
- ChatGPT 自定义连接器注册和端到端工具调用需要在用户 ChatGPT 页面确认。
- Windows 原生文件夹选择器代码已接入，但这次桌面冒烟通过手动路径添加授权；选择器的实际选择/取消交互仍待人工操作确认。
- 没有专门预占端口制造冲突；生产服务使用动态本机端口，并通过健康检查读取实际端口。

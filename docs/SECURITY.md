# 安全设计与信任边界

## 本机服务

- Fastify 绑定 `127.0.0.1`，不监听 `0.0.0.0`；请求钩子检查本机 Host/Origin。
- 不开放跨域 CORS。写操作需要 `/api/session` 提供的 CSRF token，并通过 `X-WinCodex-CSRF` 提交。
- 运行期安全响应头包含 Content Security Policy。前端不加载远程脚本。
- 同一 Windows 用户会话内的其他进程仍可能连接 loopback 服务；该应用不把 localhost 当作用户隔离边界。不要将服务暴露到局域网，也只授权确实需要的目录。

## 文件访问

- 后端拒绝 UNC、设备路径、备用数据流和越界相对路径；不依赖单纯字符串前缀判断根目录范围。
- PowerShell Win32 helper 打开目录和目标文件句柄，取得文件系统最终路径，比较根目录边界，并检查路径组件中的 reparse point，再通过已验证的句柄读取或枚举。
- 每次请求重新确认根目录存在、启用且可访问。失效授权返回稳定错误，不自动扩大访问范围。
- 搜索和读取具备深度、条目数、扫描字节、单文件大小、解析展开量、页数、输出字符和并发限制。超限时停止并返回结构化错误。
- MCP 暴露只读列表、元数据、搜索和文本读取能力；没有写入、删除、任意命令、脚本或进程执行工具。图片不读正文。

## 凭据、设置与日志

- Runtime API Key 和可选 MCP Bearer 存入当前 Windows 用户 Credential Manager Generic Credentials。API 只返回凭据是否存在，不回读秘密值。
- `data/state.json` 保存非秘密配置；`.tmp/server.json` 仅保存本机 PID、端口、URL 与本次进程 CSRF token。
- `data/logs.jsonl` 记录有限的运行事件。日志脱敏 Authorization/Bearer、凭据和敏感参数，不记录文件正文。
- Credential Manager 凭据随 Windows 用户账户和系统凭据保护机制管理；保护 Windows 登录账户和本机访问仍然重要。

## 文档解析依赖

PDF.js 的 5.6.83 至 6.2.107 版本有 Mozilla 公告的高危安全问题。WinCodex 使用 `pdfjs-dist` 6.4.299，依赖锁文件固定版本；只调用 Node 文本提取 API，不启动 PDF.js viewer 或脚本执行管理器。更新依赖时重新执行 `npm audit --audit-level=high` 和文档测试。参考 [Mozilla advisory](https://github.com/mozilla/pdf.js/security/advisories/GHSA-hq66-cqwq-w95j)。

## 运行期数据和临时清理

`scripts/clean-temp.ps1` 只接受 `.tmp` 下枚举白名单中的临时文件名，并检查解析后的目标仍位于项目 `.tmp` 内。它不会递归删除目录，也不会触碰 `data/`、Credential Manager、源码或 Androdex 项目。服务运行状态与业务日志有意不属于垃圾清理范围。

## 剩余验证边界

本地 API 与文件权限不能抵御同一 Windows 用户上下文内已被攻陷的恶意进程。真实 Secure MCP Tunnel 需要用户的 OpenAI Runtime API Key 与 Tunnel ID 才能验证；ChatGPT 连接器的注册和端到端调用必须在 ChatGPT 网页中由用户确认。Mock 网络测试不代替这两项验收。

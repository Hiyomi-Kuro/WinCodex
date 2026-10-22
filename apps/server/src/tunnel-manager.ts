import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { getCredential, credentialStatus } from './credentials.js';
import { isValidTunnelId } from './file-service.js';
import { handleMcpRequest, type ConnectionSnapshot } from './mcp-handler.js';
import { getSettings, getState, logEvent, sanitize } from './store.js';
import type { McpResponse, TunnelState } from './types.js';

const OPENAI_API = 'https://api.openai.com';
const WIRE_VERSION = '2026-08-25';
const MCP_SERVER_INFO = JSON.stringify({ version: 2, channels: [{ name: 'main', stateless: true }] });
const MAX_POLL_BYTES = 2 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_PARALLEL_COMMANDS = 3;

export interface TunnelCommand {
  request_id: string; shard_token: string; command_type: string; channel?: string;
  headers?: Record<string, string | string[]>; jsonrpc?: unknown; response_timeout?: unknown;
  receivedAt: number;
}

export class TunnelManager {
  private state: TunnelState = 'STOPPED';
  private active = false;
  private controller?: AbortController;
  private lastError?: string;
  private connectedAt?: string;
  private lastToolCall?: string;
  private loopPromise?: Promise<void>;
  private backoffSeconds = 2;
  private readonly fetcher: typeof fetch;

  constructor(private readonly requestHandler: typeof handleMcpRequest, fetcher: typeof fetch = fetch, private readonly runtimeKeyReader: () => Promise<string | undefined> = () => getCredential('runtimeApiKey')) { this.fetcher = fetcher; }

  snapshot(): ConnectionSnapshot {
    const settings = getSettings();
    const stats = getState();
    return {
      serviceActive: this.active, tunnelState: this.state, tunnelId: settings.tunnelId,
      ...(this.lastError ? { lastError: this.lastError } : {}), ...(this.connectedAt ? { connectedAt: this.connectedAt } : {}),
      ...(this.lastToolCall ? { lastToolCall: this.lastToolCall } : {}), filesRead: stats.filesRead, toolCalls: stats.toolCalls,
    };
  }

  async start(): Promise<void> {
    if (this.active) return;
    this.active = true;
    this.lastError = undefined;
    this.backoffSeconds = 2;
    this.controller = new AbortController();
    this.setState('STARTING');
    await logEvent('服务', '用户启动 Secure MCP Tunnel 服务；正在检查配置');
    this.loopPromise = this.runLoop(this.controller.signal);
  }

  async stop(): Promise<void> {
    if (!this.active && this.state === 'STOPPED') return;
    this.active = false;
    this.controller?.abort();
    this.controller = undefined;
    this.setState('STOPPED');
    await logEvent('连接断开', '用户停止 Tunnel 服务');
    await this.loopPromise?.catch(() => undefined);
  }

  async reconnect(): Promise<void> { await this.stop(); await this.start(); }

  async testConnection(): Promise<{ ok: boolean; tunnel: string; mcp: string; chatgpt: string }> {
    const settings = getSettings();
    if (!isValidTunnelId(settings.tunnelId)) throw new Error('Tunnel ID 格式无效');
    const key = await this.runtimeKeyReader();
    if (!key) throw new Error('尚未配置 Runtime API Key');
    await this.metadataCheck(settings.tunnelId, key);
    const mcpBearer = await getCredential('mcpBearer');
    const headers: Record<string, string> = mcpBearer ? { Authorization: `Bearer ${mcpBearer}` } : {};
    const init = await this.requestHandler({ jsonrpc: '2.0', id: 'local-test', method: 'initialize', params: { protocolVersion: '2025-11-25' } }, headers, () => this.snapshot());
    const discovery = await this.requestHandler({ jsonrpc: '2.0', id: 'local-tools', method: 'tools/list', params: {} }, headers, () => this.snapshot());
    if (init.statusCode !== 200 || discovery.statusCode !== 200 || !Array.isArray((discovery.body?.result as Record<string, unknown> | undefined)?.tools)) throw new Error('本地 MCP 初始化或工具发现测试失败');
    await logEvent('连接测试', 'Tunnel 元数据认证与本地 MCP initialize/tools/list 测试通过');
    return { ok: true, tunnel: 'OpenAI Tunnel API 已认证并可读取 Tunnel 元数据', mcp: `${Array.isArray((discovery.body?.result as Record<string, unknown>).tools) ? '10' : '0'} 个只读工具可发现`, chatgpt: '未验证；需在 ChatGPT 网页端确认连接器注册' };
  }

  private async runLoop(signal: AbortSignal): Promise<void> {
    try {
      while (this.active && !signal.aborted) {
        try {
          const settings = getSettings();
          const key = await this.runtimeKeyReader();
          if (!isValidTunnelId(settings.tunnelId)) throw Object.assign(new Error('Tunnel ID 格式无效'), { auth: true });
          if (!key) throw Object.assign(new Error('尚未配置 Runtime API Key'), { auth: true });
          if (!this.connectedAt) {
            this.setState('STARTING');
            await this.metadataCheck(settings.tunnelId, key, signal);
          }
          const poll = await this.poll(settings.tunnelId, key, signal, settings.networkTimeoutSeconds);
          const receivedAt = performance.now();
          if (poll.status === 204) {
            if (this.state !== 'CONNECTED') {
              this.connectedAt = new Date().toISOString();
              await logEvent('连接成功', '已收到 OpenAI Secure MCP Tunnel 长轮询响应');
            }
            this.lastError = undefined; this.setState('CONNECTED'); this.backoffSeconds = 2;
            continue;
          }
          if (poll.status !== 200) throw await apiError(poll);
          const raw = await readBoundedText(poll, MAX_POLL_BYTES);
          const payload = raw ? JSON.parse(raw) as { commands?: unknown } : {};
          const commands = Array.isArray(payload.commands) ? payload.commands.flatMap((value) => parseCommand(value, receivedAt)) : [];
          if (this.state !== 'CONNECTED') {
            this.connectedAt = new Date().toISOString(); await logEvent('连接成功', '已收到 OpenAI Secure MCP Tunnel 长轮询响应');
          }
          this.lastError = undefined; this.setState('CONNECTED'); this.backoffSeconds = 2;
          for (let index = 0; index < commands.length; index += MAX_PARALLEL_COMMANDS) {
            const group = commands.slice(index, index + MAX_PARALLEL_COMMANDS);
            await Promise.all(group.map((command) => this.process(command, key, settings.networkTimeoutSeconds, signal)));
          }
        } catch (error) {
          if (signal.aborted || !this.active) break;
          const status = statusCode(error);
          const authFailure = Boolean((error as { auth?: boolean }).auth) || status === 401 || status === 403 || status === 404;
          const safe = error instanceof Error ? sanitize(error.message) : 'Tunnel 连接失败';
          this.lastError = safe;
          this.setState(authFailure ? 'AUTH_ERROR' : 'DISCONNECTED');
          await logEvent('错误', safe, { error: true });
          this.connectedAt = undefined;
          const retryable = isRetryable(error);
          if (authFailure || !retryable || !getSettings().autoReconnect) {
            this.active = false;
            break;
          }
          await delay(this.backoffSeconds * 1000 + Math.floor(Math.random() * 1000), signal);
          this.backoffSeconds = Math.min(60, this.backoffSeconds * 2);
        }
      }
    } catch (error) {
      if (!signal.aborted) {
        this.lastError = error instanceof Error ? sanitize(error.message) : 'Tunnel 服务异常';
        this.setState('SERVICE_ERROR');
        await logEvent('错误', this.lastError, { error: true });
      }
    } finally {
      if (!this.active && this.state !== 'AUTH_ERROR' && this.state !== 'SERVICE_ERROR' && this.state !== 'DISCONNECTED') this.setState('STOPPED');
    }
  }

  private async metadataCheck(tunnelId: string, key: string, signal?: AbortSignal): Promise<void> {
    const response = await this.fetcher(`${OPENAI_API}/v1/tunnels/${encodeURIComponent(tunnelId)}`, {
      method: 'GET', headers: this.headers(key), signal: mergeTimeout(signal, getSettings().networkTimeoutSeconds * 1000),
    });
    if (!response.ok) throw await apiError(response);
    await readBoundedText(response, MAX_RESPONSE_BYTES);
  }

  private async poll(tunnelId: string, key: string, signal: AbortSignal, seconds: number): Promise<Response> {
    const query = new URLSearchParams({ limit: '25', timeout_ms: '15000' });
    return this.fetcher(`${OPENAI_API}/v1/tunnels/${encodeURIComponent(tunnelId)}/poll?${query}`, {
      method: 'GET', headers: this.headers(key), signal: mergeTimeout(signal, (15 + seconds + 10) * 1000),
    });
  }

  private async process(command: TunnelCommand, key: string, configuredSeconds: number, signal: AbortSignal): Promise<void> {
    const deadline = timeoutMilliseconds(command.response_timeout);
    if (deadline !== undefined && performance.now() - command.receivedAt >= deadline) {
      await logEvent('MCP 请求', `丢弃已过期的 Tunnel 命令 ${command.command_type}`); return;
    }
    if (!command.request_id || !command.shard_token) { await logEvent('MCP 请求', '忽略缺少关联标识的 Tunnel 命令', { error: true }); return; }
    let response: McpResponse;
    if (command.command_type === 'session_termination') {
      response = { body: null, statusCode: 204, responseType: 'session_termination_response', headers: {} };
    } else if (command.command_type === 'jsonrpc' && command.jsonrpc && typeof command.jsonrpc === 'object' && !Array.isArray(command.jsonrpc)) {
      response = await this.requestHandler(command.jsonrpc, command.headers ?? {}, () => this.snapshot());
    } else {
      await logEvent('MCP 请求', '忽略不支持的 Tunnel 命令类型'); return;
    }
    if (signal.aborted || !this.active || (deadline !== undefined && performance.now() - command.receivedAt >= deadline)) {
      await logEvent('MCP 请求', 'MCP 处理完成但服务已停止或命令已过期，未提交响应'); return;
    }
    const payload: Record<string, unknown> = {
      request_id: command.request_id, ...(command.channel ? { channel: command.channel } : {}),
      ...(response.body ? { resp_json: response.body } : {}),
      ...(Object.keys(response.headers).length ? { resp_headers: response.headers } : {}),
      resp_code: response.statusCode, resp_type: response.responseType,
    };
    const startedAt = performance.now();
    await this.postResponse(command, key, payload, signal, Math.min(configuredSeconds * 1000, deadline === undefined ? Infinity : Math.max(1, deadline - (performance.now() - command.receivedAt))));
    this.lastToolCall = new Date().toISOString();
    const responseBytes = Buffer.byteLength(JSON.stringify(response.body ?? {}), 'utf8');
    await logEvent('MCP 请求', `已完成 ${command.command_type} 命令，HTTP ${response.statusCode}`, { durationMs: performance.now() - startedAt, bytes: responseBytes });
  }

  private async postResponse(command: TunnelCommand, key: string, payload: Record<string, unknown>, signal: AbortSignal, deadlineMs: number): Promise<void> {
    let attempt = 0;
    const tunnelId = getSettings().tunnelId;
    while (!signal.aborted) {
      const controller = mergeTimeout(signal, Math.max(1, Math.min(120_000, deadlineMs)));
      const response = await this.fetcher(`${OPENAI_API}/v1/tunnels/${encodeURIComponent(tunnelId)}/response`, {
        method: 'POST', headers: { ...this.headers(key), 'Content-Type': 'application/json', 'X-Tunnel-Shard-Token': command.shard_token },
        body: JSON.stringify(payload), signal: controller,
      });
      if (response.ok || response.status === 204 || response.status === 404) { await readBoundedText(response, MAX_RESPONSE_BYTES); return; }
      if (![408, 429, 502, 503, 504].includes(response.status)) throw await apiError(response);
      const retryAfter = parseRetryAfter(response.headers.get('Retry-After'));
      await readBoundedText(response, MAX_RESPONSE_BYTES);
      if (attempt >= 4) throw await apiError(response);
      const waitMs = Math.min(30_000, Math.max(retryAfter, 500 * 2 ** attempt + Math.random() * 500));
      if (waitMs >= deadlineMs) throw new Error('Tunnel 响应重试期限已过');
      await delay(waitMs, signal);
      attempt++;
    }
    throw new Error('Tunnel 服务已停止');
  }

  private headers(key: string): HeadersInit {
    return {
      Authorization: `Bearer ${key}`,
      Accept: 'application/json',
      'X-Tunnel-Client-Name': 'wincodex-windows',
      'X-Tunnel-Client-Version': '0.1.0',
      'X-Tunnel-Client-Wire-Protocol-Version': WIRE_VERSION,
      'X-Tunnel-Client-Instance-Id': getState().instanceId,
      'X-Tunnel-MCP-Server-Info': MCP_SERVER_INFO,
    };
  }

  private setState(state: TunnelState): void {
    if (this.state === state) return;
    this.state = state;
    void logEvent('服务状态', `Tunnel 状态：${state}`);
  }
}

export async function validateTunnelId(id: string): Promise<void> {
  if (!isValidTunnelId(id)) throw new Error('Tunnel ID 格式无效');
  if (!await getCredential('runtimeApiKey')) throw new Error('尚未配置 Runtime API Key');
}

function parseCommand(value: unknown, receivedAt: number): TunnelCommand[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  const item = value as Record<string, unknown>;
  const type = typeof item.command_type === 'string' ? item.command_type : '';
  if (type !== 'jsonrpc' && type !== 'session_termination') { void logEvent('MCP 请求', '忽略未支持的 Tunnel 命令类型'); return []; }
  if (typeof item.request_id !== 'string' || typeof item.shard_token !== 'string') return [];
  const headers: Record<string, string | string[]> = {};
  if (item.headers && typeof item.headers === 'object' && !Array.isArray(item.headers)) {
    for (const [name, raw] of Object.entries(item.headers as Record<string, unknown>)) {
      if (typeof raw === 'string') headers[name] = raw;
      else if (Array.isArray(raw)) headers[name] = raw.filter((value): value is string => typeof value === 'string');
    }
  }
  return [{ request_id: item.request_id, shard_token: item.shard_token, command_type: type, ...(typeof item.channel === 'string' ? { channel: item.channel } : { channel: 'main' }), headers, ...(item.jsonrpc !== undefined ? { jsonrpc: item.jsonrpc } : {}), ...(item.response_timeout !== undefined ? { response_timeout: item.response_timeout } : {}), receivedAt }];
}

function timeoutMilliseconds(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.length < 2 || value.length > 64) return undefined;
  const match = /^([0-9]+)(ns|us|ms|s|m|h)$/.exec(value);
  if (!match) return undefined;
  try {
    const unit = { ns: 0.000001, us: 0.001, ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] as 'ns' | 'us' | 'ms' | 's' | 'm' | 'h'];
    const result = Number(BigInt(match[1]!) * BigInt(Math.round(unit * 1_000_000))) / 1_000_000;
    return Number.isFinite(result) ? Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, result)) : undefined;
  } catch { return undefined; }
}

async function apiError(response: Response): Promise<Error & { status: number; retryable: boolean }> {
  const status = response.status;
  const message = status === 401 ? 'Runtime API Key 认证失败，请检查密钥'
    : status === 403 ? 'Runtime API Key 缺少此 Tunnel 所需的 Tunnels Read + Use 权限'
      : status === 404 ? 'Tunnel ID 不存在或当前账号无法访问'
        : status === 429 ? 'Tunnel 请求被限流，请稍后重试'
          : status >= 500 ? 'OpenAI Secure MCP Tunnel 暂时不可用'
            : `Secure MCP Tunnel 请求失败（HTTP ${status}）`;
  const error = new Error(message) as Error & { status: number; retryable: boolean };
  error.status = status;
  error.retryable = [408, 425, 429].includes(status) || status >= 500;
  return error;
}

async function readBoundedText(response: Response, maximum: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
  while (true) {
    const next = await reader.read(); if (next.done) break;
    total += next.value.length;
    if (total > maximum) { await reader.cancel(); throw new Error('Tunnel API 响应超过安全大小限制'); }
    chunks.push(next.value);
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

function statusCode(error: unknown): number | undefined { return error && typeof error === 'object' && 'status' in error ? Number((error as { status: number }).status) : undefined; }
function isRetryable(error: unknown): boolean {
  if (error && typeof error === 'object' && 'retryable' in error) return Boolean((error as { retryable: boolean }).retryable);
  return !(error instanceof TypeError && /invalid/i.test(error.message));
}
function mergeTimeout(signal: AbortSignal | undefined, ms: number): AbortSignal { const timeout = Math.max(1, Math.ceil(ms)); return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout); }
function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => { const timer = setTimeout(done, Math.max(0, Math.ceil(ms))); const onAbort = () => done(); function done() { clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(); } signal.addEventListener('abort', onAbort, { once: true }); });
}
function parseRetryAfter(value: string | null): number {
  if (!value) return 0;
  if (/^\d+$/.test(value)) return Math.min(30_000, Number(value) * 1000);
  const time = Date.parse(value);
  return Number.isFinite(time) ? Math.max(0, Math.min(30_000, time - Date.now())) : 0;
}


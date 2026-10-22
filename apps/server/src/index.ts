import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { access, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { addAuthorizedRoot, absolutePath, browse, getRootViews, isValidTunnelId, previewFile, removeRoot, testRoot, toggleRoot } from './file-service.js';
import { credentialStatus, setCredential, clearCredential, type CredentialName } from './credentials.js';
import { handleMcpRequest } from './mcp-handler.js';
import { clearLogs, dataDir, getLogs, getRoots, getSettings, getState, initializeStore, logEvent, saveSettings, tempDir } from './store.js';
import { TunnelManager } from './tunnel-manager.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../../..');
const runtimeFile = path.join(tempDir, 'server.json');
const lockFile = path.join(dataDir, 'server.lock');
const csrfToken = randomBytes(32).toString('hex');
const recentHits = new Map<string, { start: number; count: number }>();
let server: FastifyInstance;
let port = 0;
let shutdownStarted = false;
const tunnel = new TunnelManager(handleMcpRequest);

await initializeStore();
await acquireInstanceLock();
server = Fastify({ logger: false, bodyLimit: 1024 * 1024, trustProxy: false });
server.addHook('onRequest', requestGuard);
server.addHook('onSend', async (_request, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  reply.header('Cache-Control', 'no-store');
  return payload;
});
server.setErrorHandler(async (error, request, reply) => {
  const statusCode = error && typeof error === 'object' && 'statusCode' in error ? Number((error as { statusCode: number }).statusCode) : 500;
  if (statusCode === 413) return reply.code(413).send({ error: '请求超过 1 MiB 大小限制' });
  await logEvent('错误', `本地 API ${request.method} 请求失败`, { error: true });
  return reply.code(statusCode >= 400 ? statusCode : 500).send({ error: '请求处理失败' });
});

server.get('/api/health', async () => ({ ok: true, service: 'WinCodex', localMcp: 'ready', tunnelState: tunnel.snapshot().tunnelState }));
server.get('/api/session', async () => ({ csrfToken }));
server.get('/api/state', async () => ({
  settings: getSettings(),
  credentials: await credentialStatus(),
  roots: await getRootViews(),
  tunnel: tunnel.snapshot(),
  stats: { filesRead: getState().filesRead, toolCalls: getState().toolCalls, lastToolCall: tunnel.snapshot().lastToolCall ?? null },
  recentLogs: getLogs().slice(-8).reverse(),
  system: { platform: 'Windows', version: os.version(), architecture: os.arch(), node: process.version },
}));
server.get('/api/settings', async () => ({ settings: getSettings(), credentials: await credentialStatus() }));
server.post('/api/settings', async (request, reply) => {
  const body = objectBody(request.body);
  if (typeof body.tunnelId === 'string' && body.tunnelId && !isValidTunnelId(body.tunnelId.trim())) return reply.code(400).send({ error: 'Tunnel ID 格式无效' });
  const settings = await saveSettings(body);
  await logEvent('设置', '运行设置已保存');
  return { settings, credentials: await credentialStatus() };
});

server.post('/api/credentials/:name', async (request, reply) => {
  const name = (request.params as { name: string }).name;
  if (!isCredentialName(name)) return reply.code(404).send({ error: '凭据类型无效' });
  const secret = objectBody(request.body).secret;
  if (typeof secret !== 'string') return reply.code(400).send({ error: '密钥内容无效' });
  await setCredential(name, secret);
  await logEvent('设置', name === 'runtimeApiKey' ? 'Runtime API Key 已安全保存' : 'MCP Bearer 已安全保存');
  return { credentials: await credentialStatus() };
});
server.delete('/api/credentials/:name', async (request, reply) => {
  const name = (request.params as { name: string }).name;
  if (!isCredentialName(name)) return reply.code(404).send({ error: '凭据类型无效' });
  await clearCredential(name);
  await logEvent('设置', name === 'runtimeApiKey' ? 'Runtime API Key 已清除' : 'MCP Bearer 已清除');
  return { credentials: await credentialStatus() };
});

server.get('/api/tunnel', async () => tunnel.snapshot());
server.post('/api/tunnel/start', async () => { await tunnel.start(); return tunnel.snapshot(); });
server.post('/api/tunnel/stop', async () => { await tunnel.stop(); return tunnel.snapshot(); });
server.post('/api/tunnel/reconnect', async () => { await tunnel.reconnect(); return tunnel.snapshot(); });
server.post('/api/tunnel/test', async (_request, reply) => {
  try { return await tunnel.testConnection(); }
  catch (error) { const message = error instanceof Error ? error.message : 'Tunnel 测试失败'; await logEvent('连接测试', message, { error: true }); return reply.code(400).send({ error: message }); }
});

server.get('/api/roots', async () => ({ roots: await getRootViews() }));
server.post('/api/roots', async (request, reply) => {
  const body = objectBody(request.body);
  if (typeof body.path !== 'string') return reply.code(400).send({ error: '请选择或输入一个绝对目录路径' });
  const root = await addAuthorizedRoot(body.path);
  return reply.code(201).send({ root });
});
server.post('/api/roots/choose', async (_request, reply) => {
  const selected = await chooseFolder();
  if (!selected) return reply.code(204).send();
  const root = await addAuthorizedRoot(selected);
  return reply.code(201).send({ root });
});
server.patch('/api/roots/:id', async (request, reply) => {
  const id = (request.params as { id: string }).id;
  const enabled = objectBody(request.body).enabled;
  if (typeof enabled !== 'boolean') return reply.code(400).send({ error: '目录状态无效' });
  const root = await toggleRoot(id, enabled);
  if (!root) return reply.code(404).send({ error: '授权目录不存在' });
  return { root };
});
server.delete('/api/roots/:id', async (request, reply) => {
  const removed = await removeRoot((request.params as { id: string }).id);
  return removed ? { removed: true } : reply.code(404).send({ error: '授权目录不存在' });
});
server.post('/api/roots/:id/test', async (request) => {
  const body = objectBody(request.body);
  return testRoot((request.params as { id: string }).id, typeof body.file === 'string' ? body.file : undefined);
});

server.get('/api/files', async (request) => {
  const query = request.query as { rootId?: string; path?: string; offset?: string; limit?: string };
  if (!query.rootId) throw Object.assign(new Error('请选择授权目录'), { statusCode: 400 });
  return browse(query.rootId, query.path ?? '', parseInt(query.offset ?? '0', 10) || 0, parseInt(query.limit ?? '100', 10) || 100);
});
server.get('/api/files/preview', async (request) => {
  const query = request.query as { rootId?: string; path?: string };
  if (!query.rootId || typeof query.path !== 'string') throw Object.assign(new Error('缺少文件路径'), { statusCode: 400 });
  return previewFile(query.rootId, query.path);
});
server.get('/api/files/absolute-path', async (request) => {
  const query = request.query as { rootId?: string; path?: string };
  if (!query.rootId) throw Object.assign(new Error('缺少授权目录'), { statusCode: 400 });
  return { path: await absolutePath(query.rootId, query.path ?? '') };
});

server.get('/api/logs', async () => ({ logs: getLogs().slice().reverse() }));
server.delete('/api/logs', async () => { await clearLogs(); return { cleared: true }; });
server.post('/api/shutdown', async (_request, reply) => {
  await reply.send({ stopping: true });
  if (!shutdownStarted) { shutdownStarted = true; setTimeout(() => { void shutdown(); }, 100); }
});

server.get('/', async (_request, reply) => sendStatic(reply, 'index.html'));
server.get('/*', async (request, reply) => {
  const routePath = decodeURIComponent((request.params as { '*': string })['*'] ?? '');
  if (routePath.startsWith('api/')) return reply.code(404).send({ error: 'Not found' });
  const requested = path.resolve(projectRoot, 'apps/web/dist', routePath || 'index.html');
  const dist = path.resolve(projectRoot, 'apps/web/dist');
  const relative = path.relative(dist, requested);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return reply.code(403).send({ error: 'Forbidden' });
  try { await access(requested); return sendStatic(reply, path.relative(dist, requested)); }
  catch { return sendStatic(reply, 'index.html'); }
});

await server.listen({ host: '127.0.0.1', port: 0 });
const address = server.server.address();
if (!address || typeof address === 'string') throw new Error('无法读取本地监听端口');
port = address.port;
await writeFile(runtimeFile, JSON.stringify({ pid: process.pid, port, url: `http://127.0.0.1:${port}`, csrfToken, startedAt: new Date().toISOString() }, null, 2), { encoding: 'utf8', mode: 0o600 });
await logEvent('服务', `WinCodex Web 服务已启动，端口 ${port}`);

process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
process.on('uncaughtException', async (error) => { await logEvent('错误', 'WinCodex 后端发生未处理异常', { error: true }); await shutdown(1); });
process.on('unhandledRejection', async () => { await logEvent('错误', 'WinCodex 后端发生未处理异步错误', { error: true }); });

async function requestGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  const host = request.headers.host?.toLowerCase();
  const allowedHost = `127.0.0.1:${port}`;
  if (port && host !== allowedHost) { await reply.code(403).send({ error: '仅允许通过本机地址访问 WinCodex' }); return; }
  if (!request.url.startsWith('/api/')) return;
  const origin = request.headers.origin;
  const expectedOrigin = `http://127.0.0.1:${port}`;
  if (origin && origin !== expectedOrigin) { await reply.code(403).send({ error: '跨站请求已拒绝' }); return; }
  const ip = request.ip;
  const now = Date.now(); const bucket = recentHits.get(ip) ?? { start: now, count: 0 };
  if (now - bucket.start > 60_000) { bucket.start = now; bucket.count = 0; }
  bucket.count++; recentHits.set(ip, bucket);
  if (bucket.count > 300) { await reply.code(429).send({ error: '本机 API 请求过于频繁' }); return; }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    if (origin ? origin !== expectedOrigin : request.headers['x-wincodex-csrf'] !== csrfToken) {
      await reply.code(403).send({ error: '本机请求校验失败，请刷新 WinCodex 页面后重试' }); return;
    }
    if (origin && request.headers['x-wincodex-csrf'] !== csrfToken) { await reply.code(403).send({ error: '缺少本机请求校验令牌' }); return; }
  }
}

async function sendStatic(reply: FastifyReply, relative: string): Promise<FastifyReply> {
  const target = path.resolve(projectRoot, 'apps/web/dist', relative);
  const ext = path.extname(target).toLowerCase();
  const type: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2' };
  return reply.type(type[ext] ?? 'application/octet-stream').send(createReadStream(target));
}

async function chooseFolder(): Promise<string | undefined> {
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.join(projectRoot, 'scripts', 'folder-picker.ps1');
  const child = spawn(executable, ['-STA', '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout: Buffer[] = []; child.stdout.on('data', (value: Buffer) => stdout.push(value));
  const code = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', (status) => resolve(status ?? 1)); });
  if (code !== 0) throw new Error('Windows 文件夹选择器无法打开');
  const value = Buffer.concat(stdout).toString('utf8').trim();
  return value || undefined;
}

async function acquireInstanceLock(): Promise<void> {
  await mkdir(dataDir, { recursive: true }); await mkdir(tempDir, { recursive: true });
  try {
    const handle = await open(lockFile, 'wx');
    await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    await handle.close();
  } catch {
    try {
      const existing = JSON.parse(await readFile(lockFile, 'utf8')) as { pid?: number };
      if (typeof existing.pid === 'number') process.kill(existing.pid, 0);
      throw new Error('WinCodex 后端实例已存在');
    } catch (error) {
      if (error instanceof Error && error.message === 'WinCodex 后端实例已存在') throw error;
      await rm(lockFile, { force: true });
      const handle = await open(lockFile, 'wx');
      await handle.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      await handle.close();
    }
  }
}

async function shutdown(exitCode = 0): Promise<void> {
  if (shutdownStarted && !server.server.listening) return;
  shutdownStarted = true;
  await tunnel.stop();
  await server.close().catch(() => undefined);
  await rm(runtimeFile, { force: true });
  try {
    const lock = JSON.parse(await readFile(lockFile, 'utf8')) as { pid?: number };
    if (lock.pid === process.pid) await rm(lockFile, { force: true });
  } catch { /* lock was already removed */ }
  process.exit(exitCode);
}

function objectBody(value: unknown): Record<string, unknown> { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function isCredentialName(value: string): value is CredentialName { return value === 'runtimeApiKey' || value === 'mcpBearer'; }

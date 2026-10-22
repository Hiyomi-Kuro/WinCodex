import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerSecret } from './store.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../../..');
const script = path.join(projectRoot, 'scripts', 'credential-store.ps1');
const names = { runtimeApiKey: 'WinCodex/RuntimeApiKey', mcpBearer: 'WinCodex/McpBearer' } as const;
export type CredentialName = keyof typeof names;

export async function credentialStatus(): Promise<{ hasRuntimeApiKey: boolean; hasMcpBearer: boolean }> {
  const [runtimeApiKey, mcpBearer] = await Promise.all([getCredential('runtimeApiKey'), getCredential('mcpBearer')]);
  return { hasRuntimeApiKey: Boolean(runtimeApiKey), hasMcpBearer: Boolean(mcpBearer) };
}

export async function getCredential(name: CredentialName): Promise<string | undefined> {
  const value = await invoke({ operation: 'read', target: names[name] });
  const secret = typeof value === 'string' && value.length > 0 ? value : undefined;
  registerSecret(secret);
  return secret;
}

export async function setCredential(name: CredentialName, value: string): Promise<void> {
  if (typeof value !== 'string' || value.length > 2_500) throw new Error('凭据内容无效或超过 Windows Credential Manager 的安全长度限制');
  if (!value.trim()) return clearCredential(name);
  await invoke({ operation: 'write', target: names[name], value });
  registerSecret(value);
}

export async function clearCredential(name: CredentialName): Promise<void> {
  await invoke({ operation: 'delete', target: names[name] });
}

async function invoke(input: Record<string, string>): Promise<unknown> {
  if (process.platform !== 'win32') throw new Error('凭据安全存储仅支持 Windows Credential Manager');
  const executable = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(input), 'utf8');
  const code = await new Promise<number>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (status) => resolve(status ?? 1));
  });
  if (code !== 0) throw new Error('Windows Credential Manager 操作失败');
  const output = Buffer.concat(stdout).toString('utf8').trim();
  if (!output) return undefined;
  try { return JSON.parse(output) as unknown; } catch { throw new Error('Windows Credential Manager 返回了无效结果'); }
}


import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { PassThrough, type Readable } from 'node:stream';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, '../../..');
const helper = path.join(projectRoot, 'scripts', 'safe-fs.ps1');
const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

export interface SafeInfo { finalPath: string; isDirectory: boolean; size: number; modified: string }
export interface SafeChild { name: string; path: string; type: 'directory' | 'file' | 'blocked_reparse'; size: number; modified: string | null }

export function canonicalRoot(candidate: string): Promise<string> {
  return runText(['-Operation', 'canonical-root', '-TargetPath', candidate]);
}
export async function inspect(root: string, target: string): Promise<SafeInfo> {
  return JSON.parse(await runText(['-Operation', 'info', '-RootPath', root, '-TargetPath', target])) as SafeInfo;
}
export async function listDirectory(root: string, target: string, offset = 0, limit = 500): Promise<{ entries: SafeChild[]; total: number }> {
  const safeOffset = Math.max(0, Math.trunc(offset));
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit) || 500));
  const value = JSON.parse(await runText(['-Operation', 'list', '-RootPath', root, '-TargetPath', target, '-ListOffset', String(safeOffset), '-ListLimit', String(safeLimit)])) as { entries?: SafeChild[]; total?: number };
  return { entries: Array.isArray(value.entries) ? value.entries : [], total: Number.isSafeInteger(value.total) ? Number(value.total) : 0 };
}

export function openReadStream(root: string, target: string, maxBytes: number, offset = 0, length = maxBytes): Readable {
  const child = start(['-Operation', 'read', '-RootPath', root, '-TargetPath', target, '-MaxBytes', String(maxBytes), '-Offset', String(offset), '-Length', String(length)]);
  return stdoutStream(child);
}

function runText(args: string[]): Promise<string> {
  const child = start(args);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolve, reject) => {
    child.once('error', () => reject(new Error('无法启动 Windows 文件安全检查器')));
    child.once('close', (code) => {
      if (code !== 0) {
        const detail = Buffer.concat(stderr).toString('utf8').trim().slice(0, 240);
        const match = /^WC:([a-z_]+):(.*)$/s.exec(detail);
        reject(Object.assign(new Error(match?.[2]?.trim() || 'Windows 文件系统安全检查失败'), match ? { code: match[1] } : {}));
      }
      else resolve(Buffer.concat(stdout).toString('utf8').trim());
    });
  });
}

function start(args: string[]): ChildProcessWithoutNullStreams {
  if (process.platform !== 'win32') throw new Error('Win32 安全文件访问仅支持 Windows');
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, ...args], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stdin.end();
  return child;
}

function stdoutStream(child: ChildProcessWithoutNullStreams): Readable {
  const output = new PassThrough();
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString('utf8')).slice(-1200); });
  child.stdout.on('data', (chunk: Buffer) => { if (!output.write(chunk)) child.stdout.pause(); });
  output.on('drain', () => child.stdout.resume());
  child.once('error', () => output.destroy(new Error('无法启动 Windows 安全文件读取器')));
  child.once('close', (code) => {
    if (code === 0) output.end();
    else output.destroy(fileSystemError(stderr.trim().slice(0, 240)));
  });
  output.once('close', () => { if (child.exitCode === null) child.kill(); });
  return output;
}

function fileSystemError(detail: string): Error {
  const match = /^WC:([a-z_]+):(.*)$/s.exec(detail);
  return Object.assign(new Error(match?.[2]?.trim() || 'Windows 文件读取安全检查失败'), match ? { code: match[1] } : {});
}

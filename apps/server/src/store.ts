import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AuthorizedRoot, LogEntry, PersistedState, Settings } from './types.js';
import { defaultSettings } from './types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const projectRoot = path.resolve(here, '../../..');
export const dataDir = process.env.WINCODEX_DATA_DIR ? path.resolve(process.env.WINCODEX_DATA_DIR) : path.join(projectRoot, 'data');
export const tempDir = process.env.WINCODEX_TEMP_DIR ? path.resolve(process.env.WINCODEX_TEMP_DIR) : path.join(projectRoot, '.tmp');
const stateFile = path.join(dataDir, 'state.json');
const logFile = path.join(dataDir, 'logs.jsonl');
const logMemory: LogEntry[] = [];

let state: PersistedState;
const secretValues = new Set<string>();

export async function initializeStore(): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  await mkdir(tempDir, { recursive: true });
  try {
    const raw = JSON.parse(await readFile(stateFile, 'utf8')) as Partial<PersistedState>;
    state = {
      version: 1,
      settings: { ...defaultSettings, ...(raw.settings ?? {}) },
      roots: Array.isArray(raw.roots) ? raw.roots : [],
      instanceId: typeof raw.instanceId === 'string' ? raw.instanceId : randomUUID(),
      filesRead: Number.isFinite(raw.filesRead) ? Number(raw.filesRead) : 0,
      toolCalls: Number.isFinite(raw.toolCalls) ? Number(raw.toolCalls) : 0,
      startedAt: typeof raw.startedAt === 'string' ? raw.startedAt : new Date().toISOString(),
    };
  } catch {
    state = { version: 1, settings: { ...defaultSettings }, roots: [], instanceId: randomUUID(), filesRead: 0, toolCalls: 0, startedAt: new Date().toISOString() };
    await persist();
  }
  try {
    const lines = (await readFile(logFile, 'utf8')).split(/\r?\n/).filter(Boolean).slice(-300);
    for (const line of lines) {
      try { logMemory.push(JSON.parse(line) as LogEntry); } catch { /* discard malformed old log records */ }
    }
  } catch { /* first run */ }
}

export function getState(): PersistedState { return structuredClone(state); }
export function getSettings(): Settings { return structuredClone(state.settings); }
export function getRoots(): AuthorizedRoot[] { return structuredClone(state.roots); }
export function getLogs(): LogEntry[] { return structuredClone(logMemory); }

export async function saveSettings(input: Partial<Settings>): Promise<Settings> {
  const theme = input.theme;
  state.settings = {
    ...state.settings,
    ...input,
    pluginName: (typeof input.pluginName === 'string' ? input.pluginName : state.settings.pluginName).trim().slice(0, 48) || 'WinCodex',
    tunnelId: typeof input.tunnelId === 'string' ? input.tunnelId.trim() : state.settings.tunnelId,
    networkTimeoutSeconds: clampInt(input.networkTimeoutSeconds, state.settings.networkTimeoutSeconds, 10, 120),
    maxReadBytes: clampInt(input.maxReadBytes, state.settings.maxReadBytes, 256 * 1024, 64 * 1024 * 1024),
    maxReadChars: clampInt(input.maxReadChars, state.settings.maxReadChars, 100_000, 20_000_000),
    maxOutputChars: clampInt(input.maxOutputChars, state.settings.maxOutputChars, 4_096, 262_144),
    autoReconnect: typeof input.autoReconnect === 'boolean' ? input.autoReconnect : state.settings.autoReconnect,
    debugLogging: typeof input.debugLogging === 'boolean' ? input.debugLogging : state.settings.debugLogging,
    theme: theme === 'light' || theme === 'dark' || theme === 'system' ? theme : state.settings.theme,
  };
  await persist();
  return getSettings();
}

export async function addRoot(root: AuthorizedRoot): Promise<void> {
  state.roots = [...state.roots.filter((item) => item.path.toLocaleLowerCase() !== root.path.toLocaleLowerCase()), root];
  await persist();
}
export async function updateRoot(id: string, patch: Partial<AuthorizedRoot>): Promise<AuthorizedRoot | undefined> {
  const index = state.roots.findIndex((item) => item.id === id);
  if (index < 0) return undefined;
  state.roots[index] = { ...state.roots[index]!, ...patch, id, path: state.roots[index]!.path };
  await persist();
  return structuredClone(state.roots[index]);
}
export async function deleteRoot(id: string): Promise<boolean> {
  const before = state.roots.length;
  state.roots = state.roots.filter((item) => item.id !== id);
  if (state.roots.length === before) return false;
  await persist();
  return true;
}

export function registerSecret(secret: string | undefined | null): void {
  if (secret && secret.length > 0) secretValues.add(secret);
}

export function sanitize(value: string): string {
  let clean = value;
  for (const secret of secretValues) clean = clean.split(secret).join('[已隐藏]');
  clean = clean
    .replace(/(?i:Bearer\s+)[^\s,;]+/g, 'Bearer [已隐藏]')
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, '[已隐藏]')
    .replace(/(api[_ -]?key|token)\s*[:=]\s*[^\s,;]+/gi, '$1=[已隐藏]');
  return clean.slice(0, 800);
}

export async function logEvent(kind: string, message: string, options: { error?: boolean; durationMs?: number; bytes?: number } = {}): Promise<void> {
  const entry: LogEntry = {
    id: randomUUID(), time: new Date().toISOString(), kind: kind.slice(0, 48), message: sanitize(message),
    ...(options.durationMs !== undefined ? { durationMs: Math.max(0, Math.round(options.durationMs)) } : {}),
    ...(options.bytes !== undefined ? { bytes: Math.max(0, Math.round(options.bytes)) } : {}),
    ...(options.error ? { error: true } : {}),
  };
  logMemory.push(entry);
  if (logMemory.length > 300) logMemory.splice(0, logMemory.length - 300);
  await appendFile(logFile, `${JSON.stringify(entry)}\n`, { encoding: 'utf8' });
}

export async function clearLogs(): Promise<void> {
  logMemory.splice(0, logMemory.length);
  await writeFile(logFile, '', 'utf8');
}

export async function recordToolCall(read = false): Promise<void> {
  state.toolCalls += 1;
  if (read) state.filesRead += 1;
  await persist();
}

export async function recordFileRead(): Promise<void> {
  state.filesRead += 1;
  await persist();
}

async function persist(): Promise<void> {
  const temporary = path.join(tempDir, `state-${randomUUID()}.tmp`);
  await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, stateFile);
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? Math.max(min, Math.min(max, Math.trunc(num))) : fallback;
}


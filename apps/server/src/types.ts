export type ThemeMode = 'system' | 'light' | 'dark';
export type TunnelState = 'STOPPED' | 'STARTING' | 'CONNECTED' | 'DISCONNECTED' | 'AUTH_ERROR' | 'SERVICE_ERROR';

export interface Settings {
  pluginName: string;
  tunnelId: string;
  networkTimeoutSeconds: number;
  autoReconnect: boolean;
  maxReadBytes: number;
  maxReadChars: number;
  maxOutputChars: number;
  debugLogging: boolean;
  theme: ThemeMode;
}

export interface AuthorizedRoot {
  id: string;
  name: string;
  path: string;
  enabled: boolean;
  createdAt: string;
  lastCheckAt?: string;
  lastIssue?: string;
}

export interface LogEntry {
  id: string;
  time: string;
  kind: string;
  message: string;
  durationMs?: number;
  bytes?: number;
  error?: boolean;
}

export interface PersistedState {
  version: 1;
  settings: Settings;
  roots: AuthorizedRoot[];
  instanceId: string;
  filesRead: number;
  toolCalls: number;
  startedAt: string;
}

export interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'blocked_reparse';
  size_bytes: number;
  modified_iso: string | null;
  extension: string;
  image_metadata_only: boolean;
}

export interface McpOutput {
  structured: Record<string, unknown>;
  text: string;
  isError?: boolean;
}

export interface McpResponse {
  body: Record<string, unknown> | null;
  statusCode: number;
  responseType: string;
  headers: Record<string, string[]>;
}

export const defaultSettings: Settings = {
  pluginName: 'WinCodex',
  tunnelId: '',
  networkTimeoutSeconds: 120,
  autoReconnect: true,
  maxReadBytes: 64 * 1024 * 1024,
  maxReadChars: 10_000_000,
  maxOutputChars: 262_144,
  debugLogging: false,
  theme: 'system',
};


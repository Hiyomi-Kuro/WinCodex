import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, join, win32 } from 'node:path';
import { getRoots, getSettings, addRoot, updateRoot, deleteRoot, logEvent, recordFileRead } from './store.js';
import { canonicalRoot, inspect, listDirectory as nativeList, openReadStream, type SafeChild } from './safe-fs.js';
import { decodeBuffer, detectTextEncoding, readLinePage, readTextPage, searchTextStream } from './text-reader.js';
import { parseDocument } from './document-parser.js';
import type { AuthorizedRoot, FileEntry, McpOutput } from './types.js';

const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'xml', 'yaml', 'yml', 'csv', 'log', 'html', 'htm', 'css', 'js', 'ts', 'py', 'java', 'kt', 'kts', 'sql', 'sh', 'ini', 'toml', 'properties', 'gradle', 'gradle.kts']);
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'heic', 'heif', 'avif', 'tif', 'tiff']);
const DOCUMENT_EXTENSIONS = new Set(['pdf', 'docx', 'xlsx', 'pptx']);
const MAX_TRAVERSED = 2_000;
const MAX_SEARCH_FILES = 1_000;
const MAX_CONTENT_BYTES = 16 * 1024 * 1024;
const MAX_CONTENT_FILE_BYTES = 1024 * 1024;

export interface RootView extends AuthorizedRoot { accessible: boolean; issue?: string }
export interface BrowseResult { root_id: string; path: string; entries: FileEntry[]; total_entries: number; offset: number; next_offset: number | null; recursive: boolean }

export function isValidTunnelId(value: string): boolean {
  return /^tunnel_(?:[a-z0-9]{32}|[a-z0-9]{4}_[a-z0-9]{32})$/.test(value);
}

export function normalizeRelative(input: string): string {
  if (input.length > 4096) throw coded('invalid_path_or_argument', '路径过长');
  if (/[\u0000-\u001f\u007f]/.test(input)) throw coded('invalid_path_or_argument', '路径包含控制字符');
  if (input.includes('\\')) throw coded('invalid_path_or_argument', '相对路径必须使用 / 分隔');
  if (input.includes('%')) throw coded('invalid_path_or_argument', '路径不能包含 URL 编码');
  if (input.startsWith('/') || /^[a-zA-Z]:/.test(input)) throw coded('invalid_path_or_argument', '只能访问授权目录内的相对路径');
  const parts = input.split('/');
  if (parts.some((part) => part === '..')) throw coded('invalid_path_or_argument', '不允许使用 .. 离开授权目录');
  const clean = parts.filter((part) => part && part !== '.');
  for (const part of clean) {
    if (part.includes(':') || /[<>"|?*]/.test(part) || /[. ]$/.test(part)) throw coded('invalid_path_or_argument', '路径包含 Windows 不支持的字符或备用数据流');
    if (/^(con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\..*)?$/i.test(part)) throw coded('invalid_path_or_argument', '路径包含 Windows 保留设备名称');
  }
  return clean.join('/');
}

export function pathInside(root: string, target: string): boolean {
  const relative = win32.relative(root, target);
  return relative === '' || (!win32.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${win32.sep}`));
}

export async function addAuthorizedRoot(rawPath: string): Promise<AuthorizedRoot> {
  if (process.platform !== 'win32') throw coded('invalid_argument', '目录授权仅支持 Windows');
  if (typeof rawPath !== 'string' || !rawPath.trim() || rawPath.length > 4096) throw coded('invalid_argument', '目录路径不能为空或过长');
  const value = rawPath.trim();
  if (/[\u0000-\u001f%]/.test(value) || value.startsWith('\\\\') || value.startsWith('//') || value.startsWith('\\?\\') || value.startsWith('\\.\\')) {
    throw coded('invalid_argument', '不支持 UNC、设备路径、URL 编码或控制字符');
  }
  if (!win32.isAbsolute(value) || !/^[a-zA-Z]:\\/.test(value)) throw coded('invalid_argument', '请输入 Windows 本地磁盘上的绝对目录路径');
  const canonical = await canonicalRoot(value);
  if (canonical.startsWith('\\\\')) throw coded('invalid_argument', '不支持网络或 UNC 目录');
  const existing = getRoots().find((root) => root.path.localeCompare(canonical, undefined, { sensitivity: 'accent' }) === 0 || root.path.toLocaleLowerCase() === canonical.toLocaleLowerCase());
  if (existing) throw coded('root_exists', '此目录已经添加');
  const root: AuthorizedRoot = { id: randomUUID(), name: basename(canonical) || canonical, path: canonical, enabled: true, createdAt: new Date().toISOString() };
  await addRoot(root);
  await logEvent('目录授权', `已添加只读目录：${root.name}`);
  return root;
}

export async function getRootViews(): Promise<RootView[]> {
  return Promise.all(getRoots().map(async (root) => {
    try { await checkRoot(root); return { ...root, accessible: root.enabled }; }
    catch (error) { return { ...root, accessible: false, issue: messageOf(error) }; }
  }));
}

export async function toggleRoot(id: string, enabled: boolean): Promise<AuthorizedRoot | undefined> {
  const root = getRoots().find((item) => item.id === id);
  if (!root) return undefined;
  if (enabled) await checkRoot({ ...root, enabled: true });
  const updated = await updateRoot(id, { enabled, lastIssue: enabled ? undefined : '目录已由用户暂停', lastCheckAt: new Date().toISOString() });
  if (updated) await logEvent('目录授权', `${enabled ? '已启用' : '已暂停'}目录：${updated.name}`);
  return updated;
}

export async function removeRoot(id: string): Promise<boolean> {
  const root = getRoots().find((item) => item.id === id);
  const removed = await deleteRoot(id);
  if (removed) await logEvent('目录授权', `已删除目录授权：${root?.name ?? '授权目录'}`);
  return removed;
}

export async function testRoot(id: string, testFile?: string): Promise<{ message: string; count?: number }> {
  const root = requireRoot(id, true);
  await checkRoot(root);
  if (testFile?.trim()) {
    const entry = await resolve(root, testFile);
    if (entry.type !== 'file') throw coded('invalid_argument', '测试路径必须指向文件');
    const stream = openReadStream(root.path, absolute(root, entry.path), getSettings().maxReadBytes, 0, Math.min(4096, getSettings().maxReadBytes));
    for await (const _chunk of stream) { /* reading confirms the current ACL and safe handle work */ break; }
    await logEvent('目录测试', `已读取测试文件 ${entry.name}`);
    return { message: `目录可读，测试文件“${entry.name}”可读取。` };
  }
  const page = await nativeList(root.path, root.path, 0, 1);
  await logEvent('目录测试', `目录可读，检查到 ${page.total} 个目录项`);
  return { message: `目录可读，目录项 ${page.total} 个。`, count: page.total };
}

export async function browse(rootId: string, rawPath = '', offset = 0, limit = 100): Promise<BrowseResult> {
  const root = requireRoot(rootId, true);
  const relative = normalizeRelative(rawPath);
  const target = absolute(root, relative);
  const info = await inspect(root.path, target);
  if (!info.isDirectory) throw coded('not_directory', '指定路径不是文件夹');
  const safeOffset = Math.max(0, Math.trunc(offset));
  const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit) || 100));
  const page = await nativeList(root.path, target, safeOffset, safeLimit);
  const children = page.entries.map((child) => childEntry(root, relative, child))
    .sort((a, b) => typeSort(a.type) - typeSort(b.type) || a.name.localeCompare(b.name, 'zh-CN', { sensitivity: 'base' }));
  return { root_id: rootId, path: relative, entries: children, total_entries: page.total, offset: safeOffset, next_offset: safeOffset + children.length < page.total ? safeOffset + children.length : null, recursive: false };
}

export async function previewFile(rootId: string, rawPath: string, maxChars = 65_536): Promise<Record<string, unknown>> {
  const root = requireRoot(rootId, true);
  const entry = await resolve(root, rawPath);
  if (entry.type !== 'file') throw coded(entry.type === 'directory' ? 'not_file' : 'unsupported_path', '此路径不是可预览的普通文件');
  if (entry.image_metadata_only) throw coded('image_metadata_only', '图片仅提供元数据，不读取图片正文');
  const settings = getSettings();
  const maxOutput = Math.min(Math.max(1, maxChars), settings.maxOutputChars);
  if (isText(entry.name)) return readText(root, entry, { offset: 0, limit: Math.min(50_000, settings.maxReadChars), max_chars: maxOutput });
  if (DOCUMENT_EXTENSIONS.has(entry.extension)) return readDocument(root, entry, { start_offset: 0, max_chars: maxOutput });
  throw coded('unsupported_format', '此文件格式不支持预览');
}

export async function absolutePath(rootId: string, rawPath: string): Promise<string> {
  const root = requireRoot(rootId, true);
  const entry = await resolve(root, rawPath);
  return absolute(root, entry.path);
}

export async function executeFileTool(name: string, args: Record<string, unknown>): Promise<McpOutput> {
  try {
    let result: Record<string, unknown>;
    let description = '';
    switch (name) {
      case 'list_roots': {
        const roots = await getRootViews();
        result = { roots: roots.map(({ id, name, path, enabled, accessible, issue }) => ({ root_id: id, name, path, kind: 'windows', enabled, accessible, ...(issue ? { issue } : {}) })), count: roots.length, scope: '仅限此列表中当前启用且有效的目录' };
        description = `已授权目录 ${roots.length} 个。`;
        break;
      }
      case 'list_directory': {
        const rootId = requiredString(args, 'root_id');
        const page = await browse(rootId, optionalString(args, 'path') ?? '', optionalInt(args, 'offset') ?? 0, optionalInt(args, 'limit') ?? 100);
        if (optionalBoolean(args, 'recursive')) {
          const all = await collectFiles(requireRoot(rootId, true), page.path, MAX_TRAVERSED);
          const limit = clamp(optionalInt(args, 'limit') ?? 100, 1, 500);
          const offset = Math.max(0, optionalInt(args, 'offset') ?? 0);
          const selected = all.slice(offset, offset + limit);
          result = { root_id: rootId, path: page.path, entries: selected, entry_count: selected.length, total_entries: all.length, next_offset: offset + selected.length < all.length ? offset + selected.length : null, recursive: true };
        } else {
          result = { root_id: page.root_id, path: page.path, entries: page.entries, entry_count: page.entries.length, total_entries: page.total_entries, next_offset: page.next_offset, recursive: false };
        }
        description = `目录中返回 ${(result.entries as FileEntry[]).length} 项，共 ${Number(result.total_entries)} 项。`;
        await logEvent('文件访问', `列出授权目录 ${page.path || '/'}`);
        break;
      }
      case 'stat_file': {
        const rootId = requiredString(args, 'root_id'); const entry = await resolve(requireRoot(rootId, true), requiredString(args, 'path'));
        result = { ...entry, root_id: rootId };
        description = '已读取文件元数据。';
        await logEvent('文件访问', `读取文件元数据 ${entry.path}`);
        break;
      }
      case 'search_files': {
        const rootId = requiredString(args, 'root_id'); const root = requireRoot(rootId, true);
        const query = requiredString(args, 'query'); if (!query.trim()) throw coded('invalid_argument', 'query 不能为空');
        const basePath = normalizeRelative(optionalString(args, 'path') ?? '');
        const files = await collectFiles(root, basePath, MAX_TRAVERSED);
        const caseSensitive = optionalBoolean(args, 'case_sensitive') ?? false;
        const needle = caseSensitive ? query : query.toLocaleLowerCase();
        const matches = files.filter((entry) => (caseSensitive ? entry.name : entry.name.toLocaleLowerCase()).includes(needle)).slice(0, clamp(optionalInt(args, 'max_results') ?? 100, 1, 500));
        result = { root_id: rootId, query, matches, returned: matches.length, traversed: files.length, truncated: files.length >= MAX_TRAVERSED || matches.length >= clamp(optionalInt(args, 'max_results') ?? 100, 1, 500) };
        description = `文件名搜索返回 ${matches.length} 项。`;
        await logEvent('文件访问', `文件名搜索遍历 ${files.length} 项，命中 ${matches.length} 项`);
        break;
      }
      case 'search_file_contents': {
        const rootId = requiredString(args, 'root_id'); const root = requireRoot(rootId, true);
        const keyword = requiredString(args, 'keyword'); if (!keyword) throw coded('invalid_argument', 'keyword 不能为空');
        const basePath = normalizeRelative(optionalString(args, 'path') ?? '');
        const all = await collectFiles(root, basePath, MAX_SEARCH_FILES);
        const files = all.filter((entry) => entry.type === 'file' && isText(entry.name));
        const caseSensitive = optionalBoolean(args, 'case_sensitive') ?? false;
        const maxResults = clamp(optionalInt(args, 'max_results') ?? 50, 1, 200);
        const matches: Array<{ path: string; line: number; text: string }> = [];
        let scanned = 0; let skipped = 0; let budget = MAX_CONTENT_BYTES;
        for (const file of files) {
          if (matches.length >= maxResults || budget <= 0) break;
          const allowance = Math.min(MAX_CONTENT_FILE_BYTES, budget, getSettings().maxReadBytes);
          if (file.size_bytes > allowance) { skipped++; continue; }
          try {
            const hits = await searchTextStream(openReadStream(root.path, absolute(root, file.path), allowance), keyword, caseSensitive, maxResults - matches.length);
            matches.push(...hits.map((hit) => ({ path: file.path, ...hit })));
            scanned++; budget -= allowance;
          } catch { skipped++; }
        }
        result = { root_id: rootId, keyword, matches: matches.slice(0, maxResults), returned: matches.length, files_scanned: scanned, files_skipped: skipped, truncated: files.length > scanned || matches.length >= maxResults || budget <= 0 };
        description = `正文搜索命中 ${matches.length} 行；扫描 ${scanned} 个文本文件，跳过 ${skipped} 个。`;
        await logEvent('文件访问', `正文搜索扫描 ${scanned} 个文件，命中 ${matches.length} 行`);
        break;
      }
      case 'read_text': {
        const rootId = requiredString(args, 'root_id'); const entry = await readableTextEntry(requireRoot(rootId, true), requiredString(args, 'path'));
        result = await readText(requireRoot(rootId, true), entry, args);
        description = `已读取文本 ${entry.name}。`;
        break;
      }
      case 'read_document': {
        const rootId = requiredString(args, 'root_id'); const entry = await resolve(requireRoot(rootId, true), requiredString(args, 'path'));
        result = await readDocument(requireRoot(rootId, true), entry, args);
        description = `已提取 ${entry.extension.toUpperCase()} 文档文本。`;
        break;
      }
      case 'read_file_chunk': {
        const rootId = requiredString(args, 'root_id'); const root = requireRoot(rootId, true); const entry = await readableTextEntry(root, requiredString(args, 'path'));
        const offset = optionalInt(args, 'offset') ?? 0;
        if (offset < 0) throw coded('invalid_argument', 'offset 必须是非负整数');
        const length = clamp(optionalInt(args, 'length') ?? optionalInt(args, 'limit') ?? 32_768, 1, 131_072);
        const settings = getSettings(); const budget = Math.min(settings.maxReadBytes, settings.maxReadChars);
        if (offset + length > budget) throw coded('file_too_large', '读取范围超过单文件累计读取上限');
        const target = absolute(root, entry.path);
        const prefix = offset === 0 ? undefined : await collectStream(openReadStream(root.path, target, settings.maxReadBytes, 0, 4096));
        const encoding = prefix ? detectTextEncoding(prefix.subarray(0, 4096)) : undefined;
        const rawOffset = offset + (encoding?.bomBytes ?? 0);
        const windowOffset = offset === 0 ? 0 : Math.max(encoding!.bomBytes, rawOffset - 3);
        const leading = rawOffset - windowOffset;
        const extra = await collectStream(openReadStream(root.path, target, settings.maxReadBytes, windowOffset, Math.min(leading + length + 4, settings.maxReadBytes)));
        const detected = encoding ?? detectTextEncoding(extra.subarray(0, 4096));
        const decoded = decodeAlignedChunk(extra, offset, length, detected.encoding, detected.bomBytes, windowOffset, rawOffset);
        result = { root_id: rootId, path: entry.path, offset, next_offset: decoded.nextOffset, has_more: decoded.hasMore, truncated: decoded.hasMore, text: decoded.text };
        description = `已读取 ${decoded.nextOffset - offset} 字节${decoded.hasMore ? '，后面还有内容' : '，已到文件末尾'}。`;
        await recordFileRead();
        await logEvent('读取成功', `分块读取文本 ${entry.name}`, { bytes: decoded.nextOffset - offset });
        break;
      }
      default: throw coded('unknown_tool', `未知只读文件工具：${name}`);
    }
    return { structured: result!, text: description };
  } catch (error) {
    const code = errorCode(error);
    const message = messageOf(error);
    await logEvent('请求失败', `工具 ${name} 失败：${code} ${message}`, { error: true });
    return { structured: { error_code: code, error: message.slice(0, 240) }, text: `${message}（错误码：${code}）`, isError: true };
  }
}

async function readText(root: AuthorizedRoot, entry: FileEntry, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const settings = getSettings();
  const maxChars = Math.max(1, Math.min(optionalInt(args, 'max_chars') ?? settings.maxOutputChars, settings.maxOutputChars));
  const started = Date.now();
  if (Object.hasOwn(args, 'offset') || Object.hasOwn(args, 'limit') || (!Object.hasOwn(args, 'start_line') && !Object.hasOwn(args, 'line_count'))) {
    const offset = Math.max(0, optionalInt(args, 'offset') ?? 0);
    const limit = Math.max(1, Math.min(optionalInt(args, 'limit') ?? maxChars, settings.maxReadChars, 2_000_000));
    const page = await readTextPage(openReadStream(root.path, absolute(root, entry.path), settings.maxReadBytes), { offset, limit, maxOutputChars: maxChars, maxFileChars: settings.maxReadChars });
    await recordFileRead();
    await logEvent('读取成功', `按字符偏移读取文本 ${entry.name}，偏移 ${offset}`, { durationMs: Date.now() - started, bytes: Buffer.byteLength(page.text, 'utf8') });
    return { root_id: root.id, path: entry.path, ...page };
  }
  const startLine = Math.max(1, optionalInt(args, 'start_line') ?? 1);
  const lineCount = clamp(optionalInt(args, 'line_count') ?? 200, 1, 2_000);
  const page = await readLinePage(openReadStream(root.path, absolute(root, entry.path), settings.maxReadBytes), { startLine, lineCount, maxChars, maxFileChars: settings.maxReadChars });
  await recordFileRead();
  await logEvent('读取成功', `按行读取文本 ${entry.name}，${page.lines_returned} 行`, { durationMs: Date.now() - started, bytes: Buffer.byteLength(page.text, 'utf8') });
  return { root_id: root.id, path: entry.path, ...page };
}

async function readDocument(root: AuthorizedRoot, entry: FileEntry, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (entry.type !== 'file') throw coded('not_file', '路径指向文件夹，不是文档');
  if (entry.image_metadata_only) throw coded('image_metadata_only', '图片正文不会通过 MCP 返回');
  if (!DOCUMENT_EXTENSIONS.has(entry.extension)) throw coded('unsupported_format', 'read_document 仅支持 PDF、DOCX、XLSX、PPTX');
  if (entry.size_bytes > getSettings().maxReadBytes) throw coded('file_too_large', '文件超过当前单文件读取上限');
  const settings = getSettings(); const started = Date.now();
  const data = await collectStream(openReadStream(root.path, absolute(root, entry.path), settings.maxReadBytes));
  const page = await parseDocument(entry.name, data, Math.max(0, optionalInt(args, 'start_offset') ?? 0), Math.min(optionalInt(args, 'max_chars') ?? settings.maxOutputChars, settings.maxOutputChars));
  await recordFileRead();
  await logEvent('读取成功', `解析 ${entry.extension.toUpperCase()} 文档 ${entry.name}`, { durationMs: Date.now() - started, bytes: entry.size_bytes });
  return { root_id: root.id, path: entry.path, ...page };
}

async function readableTextEntry(root: AuthorizedRoot, rawPath: string): Promise<FileEntry> {
  const entry = await resolve(root, rawPath);
  if (entry.type !== 'file') throw coded(entry.type === 'directory' ? 'not_file' : 'unsupported_path', '路径不是普通文件');
  if (entry.image_metadata_only) throw coded('image_metadata_only', '图片内容不通过 MCP 返回；可查看目录元数据');
  if (entry.size_bytes > getSettings().maxReadBytes) throw coded('file_too_large', `文件大小 ${entry.size_bytes} 字节超过当前读取上限 ${getSettings().maxReadBytes} 字节`);
  if (!isText(entry.name)) throw coded('unsupported_format', '此格式不是可直接读取的文本文件，请使用 read_document');
  return entry;
}

async function resolve(root: AuthorizedRoot, rawPath: string): Promise<FileEntry> {
  const relative = normalizeRelative(rawPath);
  const target = absolute(root, relative);
  const info = await inspect(root.path, target);
  const name = relative ? basename(target) : root.name;
  const extension = extname(name).slice(1).toLowerCase();
  const directory = info.isDirectory;
  return { name, path: relative, type: directory ? 'directory' : 'file', size_bytes: info.size, modified_iso: info.modified, extension, image_metadata_only: !directory && IMAGE_EXTENSIONS.has(extension) };
}

async function collectFiles(root: AuthorizedRoot, basePath: string, cap: number): Promise<FileEntry[]> {
  const start = normalizeRelative(basePath);
  const first = await inspect(root.path, absolute(root, start));
  if (!first.isDirectory) throw coded('not_directory', '搜索起点不是文件夹');
  const queue = [start]; const files: FileEntry[] = []; let visited = 0;
  while (queue.length && visited < cap) {
    const directory = queue.shift()!;
    let children: SafeChild[] = [];
    try {
      const directoryPath = absolute(root, directory);
      let offset = 0;
      while (visited + children.length < cap) {
        const page = await nativeList(root.path, directoryPath, offset, Math.min(250, cap - visited - children.length));
        children.push(...page.entries);
        if (offset + page.entries.length >= page.total || page.entries.length === 0) break;
        offset += page.entries.length;
      }
    }
    catch { continue; }
    for (const child of children) {
      visited++;
      const relative = [directory, child.name].filter(Boolean).join('/');
      const entry = childEntry(root, directory, child);
      if (child.type === 'directory') queue.push(relative);
      else if (child.type === 'file') files.push(entry);
      if (visited >= cap) break;
    }
  }
  return files;
}

async function checkRoot(root: AuthorizedRoot): Promise<void> {
  if (!root.enabled) throw coded('permission_denied', '此授权目录已由用户暂停');
  const info = await inspect(root.path, root.path);
  if (!info.isDirectory) throw coded('permission_revoked', '授权目录当前不可访问');
}

function requireRoot(id: string, enabled: boolean): AuthorizedRoot {
  const root = getRoots().find((item) => item.id === id);
  if (!root) throw coded('root_not_found', '授权目录不存在');
  if (enabled && !root.enabled) throw coded('permission_denied', '此授权目录已由用户暂停');
  return root;
}

function absolute(root: AuthorizedRoot, relative: string): string {
  const clean = normalizeRelative(relative);
  const target = clean ? join(root.path, ...clean.split('/')) : root.path;
  if (!pathInside(root.path, target)) throw coded('invalid_path_or_argument', '目标路径不在授权目录内');
  return target;
}

function childEntry(root: AuthorizedRoot, parent: string, child: SafeChild): FileEntry {
  const relative = [parent, child.name].filter(Boolean).join('/');
  const extension = extname(child.name).slice(1).toLowerCase();
  return { name: child.name, path: relative, type: child.type, size_bytes: child.size, modified_iso: child.modified, extension, image_metadata_only: child.type === 'file' && IMAGE_EXTENSIONS.has(extension) };
}

function isText(name: string): boolean {
  const value = name.toLowerCase();
  const extension = value.endsWith('.gradle.kts') ? 'gradle.kts' : extname(value).slice(1);
  return TEXT_EXTENSIONS.has(extension);
}

function decodeAlignedChunk(buffer: Buffer, requestedOffset: number, maximum: number, encoding: ReturnType<typeof detectTextEncoding>['encoding'], bomBytes: number, windowOffset: number, rawOffset: number): { text: string; nextOffset: number; hasMore: boolean } {
  let start = rawOffset - windowOffset;
  let actualOffset = requestedOffset;
  if (rawOffset < bomBytes) {
    start += bomBytes - rawOffset;
  } else if (encoding === 'utf8') {
    while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) { start++; actualOffset++; }
  } else if (encoding === 'utf16-le' || encoding === 'utf16-be') {
    if (actualOffset % 2 !== 0 && start < buffer.length) { start++; actualOffset++; }
    const unit = (index: number) => encoding === 'utf16-le' ? buffer[index]! | (buffer[index + 1]! << 8) : (buffer[index]! << 8) | buffer[index + 1]!;
    if (buffer.length - start >= 2 && unit(start) >= 0xdc00 && unit(start) <= 0xdfff) { start += 2; actualOffset += 2; }
  } else {
    while (start < Math.min(buffer.length, 3) && isGb18030Continuation(buffer, start)) { start++; actualOffset++; }
  }
  let safeSize = Math.min(maximum, buffer.length - start);
  if (encoding === 'utf8') {
    while (safeSize > 0 && start + safeSize < buffer.length && (buffer[start + safeSize]! & 0xc0) === 0x80) safeSize--;
    if (safeSize === 0 && buffer.length - start >= 2) safeSize = utf8LeadWidth(buffer[start]!);
  } else if (encoding === 'utf16-le' || encoding === 'utf16-be') {
    safeSize -= safeSize % 2;
    const unit = (index: number) => encoding === 'utf16-le' ? buffer[index]! | (buffer[index + 1]! << 8) : (buffer[index]! << 8) | buffer[index + 1]!;
    if (safeSize >= 2 && start + safeSize + 1 < buffer.length && unit(start + safeSize - 2) >= 0xd800 && unit(start + safeSize - 2) <= 0xdbff && unit(start + safeSize) >= 0xdc00 && unit(start + safeSize) <= 0xdfff) safeSize -= 2;
    if (safeSize === 0 && buffer.length - start >= 2) safeSize = unit(start) >= 0xd800 && unit(start) <= 0xdbff && buffer.length - start >= 4 ? 4 : 2;
  }
  safeSize = Math.min(safeSize, buffer.length - start);
  const text = decodeBuffer(buffer.subarray(start, start + safeSize), encoding);
  return { text, nextOffset: actualOffset + safeSize, hasMore: buffer.length - start > safeSize };
}

function utf8LeadWidth(first: number): number {
  if ((first & 0xe0) === 0xc0) return 2;
  if ((first & 0xf0) === 0xe0) return 3;
  if ((first & 0xf8) === 0xf0) return 4;
  return 1;
}

function isGb18030Continuation(buffer: Buffer, index: number): boolean {
  const absolute = index;
  const current = buffer[index]!;
  const previous1 = buffer[absolute - 1];
  const previous2 = buffer[absolute - 2];
  const previous3 = buffer[absolute - 3];
  if (previous1 !== undefined && previous1 >= 0x81 && previous1 <= 0xfe && current >= 0x40 && current <= 0xfe && current !== 0x7f) return true;
  if (previous2 !== undefined && previous2 >= 0x81 && previous2 <= 0xfe && previous1! >= 0x30 && previous1! <= 0x39 && current >= 0x81 && current <= 0xfe) return true;
  return previous3 !== undefined && previous3 >= 0x81 && previous3 <= 0xfe && previous2! >= 0x30 && previous2! <= 0x39 && previous1! >= 0x81 && previous1! <= 0xfe && current >= 0x30 && current <= 0x39;
}

async function collectStream(stream: NodeJS.ReadableStream): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  for await (const value of stream as AsyncIterable<Buffer>) { const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value); size += chunk.length; if (size > 64 * 1024 * 1024) throw coded('file_too_large', '读取内容超过 64 MiB 安全上限'); chunks.push(chunk); }
  return Buffer.concat(chunks, size);
}

function requiredString(args: Record<string, unknown>, key: string): string { const value = optionalString(args, key); if (!value) throw coded('invalid_argument', `缺少必需参数：${key}`); return value; }
function optionalString(args: Record<string, unknown>, key: string): string | undefined { return typeof args[key] === 'string' ? args[key] as string : undefined; }
function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined { return typeof args[key] === 'boolean' ? args[key] as boolean : undefined; }
function optionalInt(args: Record<string, unknown>, key: string): number | undefined { const value = args[key]; return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined; }
function clamp(value: number, min: number, max: number): number { return Math.max(min, Math.min(max, Math.trunc(value))); }
function typeSort(type: FileEntry['type']): number { return type === 'directory' ? 0 : type === 'file' ? 1 : 2; }
function coded(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
function errorCode(error: unknown): string { return error instanceof Error && 'code' in error && typeof error.code === 'string' ? error.code : 'file_access_failed'; }
function messageOf(error: unknown): string {
  const code = errorCode(error);
  if (['ENOENT', 'file_not_found'].includes(code)) return '文件或目录不存在';
  if (['EACCES', 'EPERM', 'permission_denied'].includes(code)) return '文件系统权限不足';
  if (code === 'unsupported_path') return '不支持访问符号链接、Junction 或其他特殊路径';
  if (code === 'permission_revoked') return '授权目录已移动、删除或当前权限已失效';
  if (code === 'file_too_large') return '文件超过当前单文件读取上限';
  if (error instanceof Error) return error.message.slice(0, 240);
  return '文件访问失败';
}

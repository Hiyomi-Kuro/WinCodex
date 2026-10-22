import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { deflateRawSync } from 'node:zlib';
import iconv from 'iconv-lite';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const runId = randomUUID();
const fixtureRoot = path.join(projectRoot, '.tmp', `test-fixtures-${runId}`);
const outsideRoot = path.join(projectRoot, '.tmp', `test-outside-${runId}`);
const dataDir = path.join(projectRoot, '.tmp', `test-data-${runId}`);
const tempDir = path.join(projectRoot, '.tmp', `test-runtime-${runId}`);
const previousDataDir = process.env.WINCODEX_DATA_DIR;
const previousTempDir = process.env.WINCODEX_TEMP_DIR;
process.env.WINCODEX_DATA_DIR = dataDir;
process.env.WINCODEX_TEMP_DIR = tempDir;

const store = await import('../apps/server/src/store.js');
const files = await import('../apps/server/src/file-service.js');
const reader = await import('../apps/server/src/text-reader.js');
const registry = await import('../apps/server/src/mcp-registry.js');
const mcp = await import('../apps/server/src/mcp-handler.js');
const docs = await import('../apps/server/src/document-parser.js');
const { TunnelManager } = await import('../apps/server/src/tunnel-manager.js');
const { defaultSettings } = await import('../apps/server/src/types.js');

let rootId = '';
const connection = () => ({ serviceActive: true, tunnelState: 'CONNECTED' as const, tunnelId: 'tunnel_0123456789abcdefghijklmnopqrstuv', filesRead: store.getState().filesRead, toolCalls: store.getState().toolCalls });

before(async () => {
  await mkdir(fixtureRoot, { recursive: true });
  await mkdir(outsideRoot, { recursive: true });
  await store.initializeStore();
  await store.saveSettings({ ...defaultSettings, tunnelId: 'tunnel_0123456789abcdefghijklmnopqrstuv' });
  await writeFile(path.join(fixtureRoot, '中文 😀.txt'), Buffer.from('\uFEFF第一行 😀\nneedle 第二行\n尾行', 'utf8'));
  await writeFile(path.join(fixtureRoot, 'utf16.txt'), Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode('甲😀乙丙', 'utf16-le')]));
  await writeFile(path.join(fixtureRoot, 'gb18030.txt'), iconv.encode('中文内容', 'gb18030'));
  await writeFile(path.join(fixtureRoot, 'large.txt'), Buffer.alloc(300 * 1024, 0x61));
  await writeFile(path.join(fixtureRoot, 'image.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  await mkdir(path.join(fixtureRoot, '子目录'), { recursive: true });
  await writeFile(path.join(fixtureRoot, '子目录', 'nested.md'), '# nested\n');
  await writeFile(path.join(fixtureRoot, 'office.docx'), zip({ 'word/document.xml': '<w:document xmlns:w="urn:w"><w:body><w:p><w:r><w:t>Office Fixture</w:t></w:r></w:p></w:body></w:document>' }));
  await writeFile(path.join(fixtureRoot, 'book.xlsx'), zip({
    'xl/workbook.xml': '<workbook xmlns:r="urn:r"><sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets></workbook>',
    'xl/sharedStrings.xml': '<sst><si><t>Spreadsheet Fixture</t></si></sst>',
    'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row></sheetData></worksheet>',
  }));
  await writeFile(path.join(fixtureRoot, 'deck.pptx'), zip({ 'ppt/slides/slide1.xml': '<p:sld xmlns:p="urn:p" xmlns:a="urn:a"><p:cSld><a:t>Slide Fixture</a:t></p:cSld></p:sld>' }));
  await writeFile(path.join(fixtureRoot, 'sample.pdf'), minimalPdf('PDF Fixture'));
  const root = await files.addAuthorizedRoot(fixtureRoot);
  rootId = root.id;
  mcp.setMcpCredentialAdaptersForTests({
    read: async () => undefined,
    status: async () => ({ hasRuntimeApiKey: false, hasMcpBearer: false }),
  });
});

after(async () => {
  mcp.setMcpCredentialAdaptersForTests();
  if (rootId) await files.removeRoot(rootId).catch(() => false);
  await rm(fixtureRoot, { recursive: true, force: true });
  await rm(outsideRoot, { recursive: true, force: true });
  await rm(dataDir, { recursive: true, force: true });
  await rm(tempDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.WINCODEX_DATA_DIR; else process.env.WINCODEX_DATA_DIR = previousDataDir;
  if (previousTempDir === undefined) delete process.env.WINCODEX_TEMP_DIR; else process.env.WINCODEX_TEMP_DIR = previousTempDir;
});

test('WinCodex offline implementation acceptance', async (t) => {
  await t.test('registers the ten read-only Androdex tools and validates their schemas', async () => {
    assert.equal(registry.tools.length, 10);
    for (const item of registry.listToolsJson()) assert.equal((item.annotations as Record<string, unknown>).readOnlyHint, true);
    assert.equal(files.normalizeRelative('a//./b'), 'a/b');
    for (const value of ['../secret', 'C:/secret', '//server/share', 'a/../b', 'a%2f..%2fsecret', 'file:stream', 'CON.txt']) {
      assert.throws(() => files.normalizeRelative(value));
    }
    assert.equal(files.isValidTunnelId('tunnel_0123456789abcdefghijklmnopqrstuv'), true);
    assert.equal(files.isValidTunnelId('tunnel_ab12_0123456789abcdefghijklmnopqrstuv'), true);
    assert.equal(files.isValidTunnelId('tunnel_bad'), false);
    assert.equal(registry.validateArguments(registry.getTool('stat_file')!, { root_id: rootId, path: '../x' }), undefined);
    assert.match(registry.validateArguments(registry.getTool('stat_file')!, { root_id: rootId, path: 'x', extra: true })!, /不支持的参数/);
  });

  await t.test('serves five-page local roots and paginated file browsing with real Win32 handles', async () => {
    const roots = await files.getRootViews();
    assert.equal(roots.find((item) => item.id === rootId)?.accessible, true);
    const first = await files.browse(rootId, '', 0, 3);
    const second = await files.browse(rootId, '', 3, 3);
    assert.equal(first.total_entries, 10);
    assert.equal(first.entries.length, 3);
    assert.equal(second.offset, 3);
    assert.equal(new Set([...first.entries, ...second.entries].map((item) => item.name)).size, 6);
    assert.ok(first.next_offset !== null);
    await files.toggleRoot(rootId, false);
    const denied = await files.executeFileTool('list_directory', { root_id: rootId });
    assert.equal(denied.isError, true);
    await files.toggleRoot(rootId, true);
    await assert.rejects(files.addAuthorizedRoot(fixtureRoot), /already|已经/);
    await assert.rejects(files.addAuthorizedRoot('\\\\server\\share'), /本地磁盘|UNC/);
    const missingRootPath = path.join(projectRoot, '.tmp', `missing-root-${runId}`);
    await mkdir(missingRootPath, { recursive: true });
    const missingRoot = await files.addAuthorizedRoot(missingRootPath);
    await rm(missingRootPath, { recursive: true, force: true });
    assert.equal((await files.getRootViews()).find((item) => item.id === missingRoot.id)?.accessible, false);
    await files.removeRoot(missingRoot.id);
  });

  await t.test('rejects symbolic links and junctions that leave an authorized root', async (context) => {
    const junctionPath = path.join(fixtureRoot, 'outside-junction');
    try {
      execFileSync('cmd.exe', ['/d', '/c', 'mklink', '/J', junctionPath, outsideRoot], { stdio: 'ignore' });
    } catch {
      context.skip('Windows did not allow creation of a temporary junction in this environment');
      return;
    }
    const page = await files.browse(rootId, '', 0, 100);
    assert.equal(page.entries.find((entry) => entry.name === 'outside-junction')?.type, 'blocked_reparse');
    const rejected = await files.executeFileTool('stat_file', { root_id: rootId, path: 'outside-junction' });
    assert.equal(rejected.isError, true);
    assert.equal(rejected.structured.error_code, 'unsupported_path');
  });

  await t.test('streams UTF-8 BOM, UTF-16 and GB18030 text and keeps Unicode page offsets', async () => {
    const utf8 = await collect(reader.decodedChunks(Readable.from([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('A😀中\nZ')])));
    assert.equal(utf8, 'A😀中\nZ');
    const utf16 = await collect(reader.decodedChunks(Readable.from([await readFile(path.join(fixtureRoot, 'utf16.txt'))])));
    assert.equal(utf16, '甲😀乙丙');
    const gb = await collect(reader.decodedChunks(Readable.from([await readFile(path.join(fixtureRoot, 'gb18030.txt'))])));
    assert.equal(gb, '中文内容');
    const one = await reader.readTextPage(Readable.from([Buffer.from('A😀中\nZ')]), { offset: 0, limit: 2, maxOutputChars: 20, maxFileChars: 100 });
    assert.equal(one.text, 'A😀');
    assert.equal(one.next_offset, 2);
    assert.equal(one.has_more, true);
    const two = await reader.readTextPage(Readable.from([Buffer.from('A😀中\nZ')]), { offset: one.next_offset, limit: 3, maxOutputChars: 20, maxFileChars: 100 });
    assert.equal(two.text, '中\nZ');
    const linePage = await reader.readLinePage(Readable.from([Buffer.from('one\ntwo\n')]), { startLine: 1, lineCount: 2, maxChars: 50, maxFileChars: 100 });
    assert.equal(linePage.text, 'one\ntwo');
    assert.equal(linePage.has_more, false);
  });

  await t.test('reads byte chunks consistently across UTF-8 and UTF-16 boundaries', async () => {
    const utf8Path = '中文 😀.txt';
    const first = await files.executeFileTool('read_file_chunk', { root_id: rootId, path: utf8Path, offset: 0, length: 9 });
    assert.equal(first.isError, undefined);
    assert.ok(String(first.structured.text).startsWith('第一行'));
    const next = Number(first.structured.next_offset);
    const second = await files.executeFileTool('read_file_chunk', { root_id: rootId, path: utf8Path, offset: next, length: 30 });
    assert.ok(String(second.structured.text).includes('needle'));
    const utf16 = await files.executeFileTool('read_file_chunk', { root_id: rootId, path: 'utf16.txt', offset: 0, length: 6 });
    assert.equal(utf16.structured.text, '甲😀');
    const utf16Next = await files.executeFileTool('read_file_chunk', { root_id: rootId, path: 'utf16.txt', offset: Number(utf16.structured.next_offset), length: 8 });
    assert.equal(utf16Next.structured.text, '乙丙');
  });

  await t.test('returns stable errors for missing files, oversized reads and traversal attempts', async () => {
    const missing = await files.executeFileTool('stat_file', { root_id: rootId, path: 'does-not-exist.txt' });
    assert.equal(missing.structured.error_code, 'file_not_found');
    const traversal = await files.executeFileTool('stat_file', { root_id: rootId, path: '../outside.txt' });
    assert.equal(traversal.structured.error_code, 'invalid_path_or_argument');
    const image = await files.executeFileTool('stat_file', { root_id: rootId, path: 'image.png' });
    assert.equal(image.structured.image_metadata_only, true);
    const imageBody = await files.executeFileTool('read_text', { root_id: rootId, path: 'image.png' });
    assert.equal(imageBody.structured.error_code, 'image_metadata_only');
    const wrongDocument = await files.executeFileTool('read_document', { root_id: rootId, path: '中文 😀.txt' });
    assert.equal(wrongDocument.structured.error_code, 'unsupported_format');
    await store.saveSettings({ maxReadBytes: 256 * 1024 });
    const oversized = await files.executeFileTool('read_text', { root_id: rootId, path: 'large.txt' });
    assert.equal(oversized.structured.error_code, 'file_too_large');
    await store.saveSettings({ maxReadBytes: defaultSettings.maxReadBytes });
  });

  await t.test('extracts PDF, DOCX, XLSX and PPTX text within parser limits', async () => {
    const expectations = [['sample.pdf', 'PDF Fixture'], ['office.docx', 'Office Fixture'], ['book.xlsx', 'Spreadsheet Fixture'], ['deck.pptx', 'Slide Fixture']] as const;
    for (const [name, expected] of expectations) {
      const parsed = await docs.parseDocument(name, await readFile(path.join(fixtureRoot, name)), 0, 1000);
      assert.ok(parsed.text.includes(expected), `${name} text extraction`);
    }
    await assert.rejects(docs.parseDocument('corrupt.docx', Buffer.from('not a zip'), 0, 100), /解析|Office/);
  });

  await t.test('executes all ten MCP tools over real files and negotiates legacy and modern MCP', async () => {
    const argsByTool: Record<string, Record<string, unknown>> = {
      list_roots: {}, list_directory: { root_id: rootId, limit: 10 }, stat_file: { root_id: rootId, path: '中文 😀.txt' },
      search_files: { root_id: rootId, query: '中文' }, search_file_contents: { root_id: rootId, keyword: 'needle' },
      read_text: { root_id: rootId, path: '中文 😀.txt', offset: 0, limit: 12 },
      read_document: { root_id: rootId, path: 'office.docx', max_chars: 500 },
      read_file_chunk: { root_id: rootId, path: '中文 😀.txt', offset: 0, length: 16 }, get_connection_status: {}, get_capabilities: {},
    };
    for (const [index, tool] of registry.tools.entries()) {
      const response = await mcp.handleMcpRequest({ jsonrpc: '2.0', id: index + 1, method: 'tools/call', params: { name: tool.name, arguments: argsByTool[tool.name] } }, {}, connection);
      assert.equal(response.statusCode, 200, tool.name);
      assert.equal((response.body?.result as Record<string, unknown>).isError, false, tool.name);
    }
    const legacy = await mcp.handleMcpRequest({ jsonrpc: '2.0', id: 99, method: 'initialize', params: { protocolVersion: '2025-11-25' } }, {}, connection);
    assert.equal((legacy.body?.result as Record<string, unknown>).protocolVersion, '2025-11-25');
    const modernMeta = { 'io.modelcontextprotocol/protocolVersion': mcp.MODERN_PROTOCOL };
    const modern = await mcp.handleMcpRequest({ jsonrpc: '2.0', id: 100, method: 'server/discover', params: { _meta: modernMeta } }, { 'Mcp-Protocol-Version': mcp.MODERN_PROTOCOL, 'Mcp-Method': 'server/discover' }, connection);
    assert.equal(modern.statusCode, 200);
    assert.ok((modern.body?.result as Record<string, unknown>).supportedVersions);
    const unknown = await mcp.handleMcpRequest({ jsonrpc: '2.0', id: 101, method: 'tools/call', params: { name: 'exec_shell', arguments: {} } }, {}, connection);
    assert.equal((unknown.body?.error as Record<string, unknown>).code, -32602);
  });

  await t.test('enforces optional MCP Bearer auth, limits and redacts logged secrets', async () => {
    mcp.setMcpCredentialAdaptersForTests({ read: async () => 'test-bearer-secret', status: async () => ({ hasRuntimeApiKey: false, hasMcpBearer: true }) });
    const request = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };
    assert.equal((await mcp.handleMcpRequest(request, {}, connection)).statusCode, 401);
    assert.equal((await mcp.handleMcpRequest(request, { Authorization: 'Bearer wrong' }, connection)).statusCode, 401);
    assert.equal((await mcp.handleMcpRequest(request, { Authorization: 'Bearer test-bearer-secret' }, connection)).statusCode, 200);
    mcp.setMcpCredentialAdaptersForTests({ read: async () => undefined, status: async () => ({ hasRuntimeApiKey: false, hasMcpBearer: false }) });
    assert.throws(() => mcp.parseMcpBody(' '.repeat(1024 * 1024 + 1) + '{}'), (error: unknown) => Boolean(error && typeof error === 'object' && 'statusCode' in error && error.statusCode === 413));
    store.registerSecret('transient-log-secret');
    await store.logEvent('测试', 'secret=transient-log-secret');
    assert.ok(!store.getLogs().at(-1)?.message.includes('transient-log-secret'));
  });

  await t.test('round trips and deletes an isolated temporary Windows Credential Manager entry', async () => {
    const target = `WinCodex/TaskTest/${runId}`;
    const secret = `temporary-credential-${runId}`;
    try {
      await invokeCredentialStore({ operation: 'write', target, value: secret });
      assert.equal(await invokeCredentialStore({ operation: 'read', target }), secret);
    } finally {
      await invokeCredentialStore({ operation: 'delete', target });
    }
    assert.equal(await invokeCredentialStore({ operation: 'read', target }), null);
  });

  await t.test('uses the official Tunnel metadata, long-poll, response correlation and shard token with a mock server', async () => {
    await store.saveSettings({ tunnelId: 'tunnel_0123456789abcdefghijklmnopqrstuv', networkTimeoutSeconds: 10 });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    let pollCount = 0;
    const mockFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      if (url.endsWith('/v1/tunnels/tunnel_0123456789abcdefghijklmnopqrstuv')) return new Response('{}', { status: 200 });
      if (url.includes('/poll?')) {
        pollCount++;
        if (pollCount === 1) return new Response(JSON.stringify({ commands: [
          { request_id: 'request-ok', shard_token: 'shard-secret', command_type: 'jsonrpc', jsonrpc: { jsonrpc: '2.0', id: 'remote', method: 'tools/list', params: {} }, response_timeout: '5s' },
          { request_id: 'request-expired', shard_token: 'expired-shard', command_type: 'jsonrpc', jsonrpc: { jsonrpc: '2.0', id: 'expired', method: 'tools/list', params: {} }, response_timeout: '0ms' },
        ] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        return new Promise<Response>((resolve, reject) => {
          const signal = init?.signal;
          if (!signal) return reject(new Error('poll did not carry an abort signal'));
          const timer = setTimeout(() => resolve(new Response(null, { status: 204 })), 60_000);
          signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException('aborted', 'AbortError')); }, { once: true });
        });
      }
      if (url.endsWith('/response')) return new Response(null, { status: 204 });
      throw new Error(`Unexpected mock URL: ${url}`);
    };
    const manager = new TunnelManager(mcp.handleMcpRequest, mockFetch, async () => 'runtime-test-key');
    try {
      await manager.start();
      const deadline = Date.now() + 3000;
      while (!calls.some((call) => call.url.endsWith('/response')) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
      const responseCall = calls.find((call) => call.url.endsWith('/response'));
      assert.ok(responseCall, `no response submitted; state=${manager.snapshot().tunnelState}; calls=${calls.map((call) => call.url).join(',')}; error=${manager.snapshot().lastError ?? ''}`);
      assert.equal(responseCall.init?.headers && (responseCall.init.headers as Record<string, string>)['X-Tunnel-Shard-Token'], 'shard-secret');
      const responseBody = JSON.parse(String(responseCall.init?.body)) as Record<string, unknown>;
      assert.equal(responseBody.request_id, 'request-ok');
      assert.equal((responseBody.resp_json as Record<string, unknown>).id, 'remote');
      assert.equal(calls.filter((call) => call.url.endsWith('/response')).length, 1);
      assert.ok(calls[0]?.url.endsWith('/v1/tunnels/tunnel_0123456789abcdefghijklmnopqrstuv'));
      assert.ok((calls[0]?.init?.headers as Record<string, string>)['X-Tunnel-Client-Wire-Protocol-Version']);
    } finally {
      await manager.stop();
    }
    assert.equal(manager.snapshot().tunnelState, 'STOPPED');
  });

  await t.test('stops retrying after an authentication error without claiming ChatGPT registration', async () => {
    const failedFetch: typeof fetch = async () => new Response('{}', { status: 401 });
    const manager = new TunnelManager(mcp.handleMcpRequest, failedFetch, async () => 'invalid-key');
    await manager.start();
    const deadline = Date.now() + 1500;
    while (manager.snapshot().tunnelState !== 'AUTH_ERROR' && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(manager.snapshot().tunnelState, 'AUTH_ERROR');
    assert.equal(manager.snapshot().serviceActive, false);
    await manager.stop();
  });

  await t.test('backs off after transient network failures and remains stoppable', async () => {
    const callTimes: number[] = [];
    const failedNetwork: typeof fetch = async () => { callTimes.push(Date.now()); throw new TypeError('fetch failed'); };
    const manager = new TunnelManager(mcp.handleMcpRequest, failedNetwork, async () => 'runtime-test-key');
    await manager.start();
    const deadline = Date.now() + 4500;
    while (callTimes.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.ok(callTimes.length >= 2, 'retry should occur after initial exponential backoff');
    assert.ok(callTimes[1]! - callTimes[0]! >= 1800, 'retry should not be immediate');
    assert.equal(manager.snapshot().tunnelState, 'DISCONNECTED');
    assert.equal(manager.snapshot().serviceActive, true);
    await manager.stop();
    assert.equal(manager.snapshot().tunnelState, 'STOPPED');
  });
});

async function collect(chunks: AsyncGenerator<string>): Promise<string> {
  let result = '';
  for await (const value of chunks) result += value;
  return result;
}

async function invokeCredentialStore(value: Record<string, string>): Promise<unknown> {
  const script = path.join(projectRoot, 'scripts', 'credential-store.ps1');
  const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const stdout: Buffer[] = []; const stderr: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
  child.stdin.end(JSON.stringify(value), 'utf8');
  const code = await new Promise<number>((resolve, reject) => { child.once('error', reject); child.once('close', (status) => resolve(status ?? 1)); });
  assert.equal(code, 0, Buffer.concat(stderr).toString('utf8').trim());
  const output = Buffer.concat(stdout).toString('utf8').trim();
  return output ? JSON.parse(output) as unknown : null;
}

function zip(entries: Record<string, string>): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  const crcTable = makeCrcTable();
  for (const [name, value] of Object.entries(entries)) {
    const fileName = Buffer.from(name, 'utf8');
    const source = Buffer.from(value, 'utf8');
    const compressed = deflateRawSync(source);
    const crc = crc32(source, crcTable);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4); header.writeUInt16LE(0, 6);
    header.writeUInt16LE(8, 8); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(source.length, 22); header.writeUInt16LE(fileName.length, 26);
    local.push(header, fileName, compressed);
    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0); centralHeader.writeUInt16LE(20, 4); centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8); centralHeader.writeUInt16LE(8, 10); centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(compressed.length, 20); centralHeader.writeUInt32LE(source.length, 24);
    centralHeader.writeUInt16LE(fileName.length, 28); centralHeader.writeUInt32LE(0, 42);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, fileName);
    offset += header.length + fileName.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

function makeCrcTable(): number[] {
  const table: number[] = [];
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  return table;
}
function crc32(value: Buffer, table: number[]): number {
  let crc = 0xffffffff;
  for (const byte of value) crc = (crc >>> 8) ^ table[(crc ^ byte) & 0xff]!;
  return (crc ^ 0xffffffff) >>> 0;
}

function minimalPdf(text: string): Buffer {
  const safe = text.replace(/[()\\]/g, '\\$&');
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(`BT /F1 18 Tf 20 100 Td (${safe}) Tj ET`, 'ascii')} >>\nstream\nBT /F1 18 Tf 20 100 Td (${safe}) Tj ET\nendstream`,
  ];
  let output = '%PDF-1.4\n';
  const offsets = [0];
  for (let index = 0; index < objects.length; index++) { offsets.push(Buffer.byteLength(output, 'ascii')); output += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`; }
  const xrefOffset = Buffer.byteLength(output, 'ascii');
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets.slice(1)) output += `${String(offset).padStart(10, '0')} 00000 n \n`;
  output += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`;
  return Buffer.from(output, 'ascii');
}

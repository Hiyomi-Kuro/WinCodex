import { XMLParser } from 'fast-xml-parser';
import type * as Yauzl from 'yauzl';

const MAX_COMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 32 * 1024 * 1024;
const MAX_ENTRY_BYTES = 12 * 1024 * 1024;
const MAX_EXTRACTED_CHARS = 2_000_000;
const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', removeNSPrefix: true, trimValues: false, processEntities: true, parseTagValue: false, parseAttributeValue: false });

export interface DocumentPage {
  format: string; text: string; start_offset: number; next_offset: number | null;
  extracted_chars: number; has_more: boolean; parser_truncated: boolean;
}

export async function parseDocument(name: string, data: Buffer, startOffset: number, maxChars: number): Promise<DocumentPage> {
  if (data.length > MAX_COMPRESSED_BYTES) throw coded('file_too_large', '文档超过解析器的压缩文件大小上限');
  const extension = name.toLowerCase().split('.').at(-1) ?? '';
  let extracted: { text: string; truncated: boolean };
  if (extension === 'pdf') extracted = await parsePdf(data);
  else if (extension === 'docx') extracted = await parseDocx(data);
  else if (extension === 'xlsx') extracted = await parseXlsx(data);
  else if (extension === 'pptx') extracted = await parsePptx(data);
  else throw coded('unsupported_format', 'read_document 仅支持 PDF、DOCX、XLSX、PPTX');
  const text = extracted.text;
  let start = Math.min(Math.max(0, startOffset), text.length);
  if (start < text.length && isLowSurrogate(text.charCodeAt(start))) start++;
  let end = Math.min(text.length, start + Math.max(1, Math.min(maxChars, 262_144)));
  if (end < text.length && end > start && isHighSurrogate(text.charCodeAt(end - 1)) && isLowSurrogate(text.charCodeAt(end))) end--;
  return {
    format: extension.toUpperCase(), text: text.slice(start, end), start_offset: startOffset,
    next_offset: end < text.length ? end : null, extracted_chars: text.length,
    has_more: end < text.length || extracted.truncated, parser_truncated: extracted.truncated,
  };
}

async function parsePdf(data: Buffer): Promise<{ text: string; truncated: boolean }> {
  if (data.length > MAX_COMPRESSED_BYTES) throw coded('file_too_large', 'PDF 超过 32 MiB 解析内存上限');
  let destroyTask: (() => Promise<void>) | undefined;
  try {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    // This server uses the Node text-extraction API, not PDF.js's browser scripting manager or viewer.
    const loadingTask = pdfjs.getDocument({ data: new Uint8Array(data), useSystemFonts: true, disableFontFace: true, stopAtErrors: true, enableXfa: false });
    destroyTask = () => loadingTask.destroy();
    const doc = await loadingTask.promise;
    const out: string[] = []; let count = 0; let truncated = false;
    const pages = Math.min(doc.numPages, 500);
    for (let pageNo = 1; pageNo <= pages; pageNo++) {
      const page = await doc.getPage(pageNo);
      const content = await page.getTextContent();
      let rendered = '';
      for (const item of content.items) {
        if ('str' in item) rendered += `${item.str}${item.hasEOL ? '\n' : ' '}`;
      }
      const section = `[PDF 第 ${pageNo} 页]\n${rendered}\n`;
      if (count + section.length > MAX_EXTRACTED_CHARS) {
        out.push(safeTake(section, MAX_EXTRACTED_CHARS - count)); truncated = true; break;
      }
      out.push(section); count += section.length;
    }
    if (doc.numPages > pages) truncated = true;
    return { text: out.join(''), truncated };
  } catch (error) {
    if (hasCode(error)) throw error;
    throw coded('document_parse_failed', 'PDF 解析失败：文件可能已损坏、加密或不受支持');
  } finally {
    await destroyTask?.().catch(() => undefined);
  }
}

async function parseDocx(data: Buffer): Promise<{ text: string; truncated: boolean }> {
  const parts = await readXmlParts(data, new Set(['word/document.xml']));
  const document = parts.get('word/document.xml');
  if (!document) throw coded('document_parse_failed', 'DOCX 缺少 word/document.xml');
  const parsed = parseXml(document);
  let out = '';
  const truncated = { value: false };
  walkDocx(parsed, (chunk) => { out = appendBounded(out, chunk, truncated); });
  return { text: out, truncated: truncated.value };
}

async function parseXlsx(data: Buffer): Promise<{ text: string; truncated: boolean }> {
  const wanted = new Set(['xl/workbook.xml', 'xl/sharedStrings.xml']);
  for (let i = 1; i <= 10_000; i++) wanted.add(`xl/worksheets/sheet${i}.xml`);
  const parts = await readXmlParts(data, wanted);
  const workbook = parts.get('xl/workbook.xml');
  if (!workbook) throw coded('document_parse_failed', 'XLSX 缺少 xl/workbook.xml');
  const workbookDoc = parseXml(workbook) as Record<string, unknown>;
  const sheetNodes = asArray(asRecord(asRecord(workbookDoc.workbook).sheets).sheet);
  const sheetNames = sheetNodes.map((sheet, index) => str(asRecord(sheet)['@_name']) || `工作表 ${index + 1}`);
  const sharedDoc = parts.get('xl/sharedStrings.xml') ? parseXml(parts.get('xl/sharedStrings.xml')!) as Record<string, unknown> : {};
  const sharedStrings = asArray(asRecord(sharedDoc.sst).si).map((node) => collectTexts(node));
  const output: string[] = []; let size = 0; let truncated = false;
  const worksheets = [...parts.entries()].filter(([entry]) => /^xl\/worksheets\/sheet\d+\.xml$/.test(entry))
    .sort(([a], [b]) => Number(a.match(/sheet(\d+)/)?.[1] ?? 0) - Number(b.match(/sheet(\d+)/)?.[1] ?? 0));
  for (const [file, content] of worksheets) {
    const index = Number(file.match(/sheet(\d+)/)?.[1] ?? 1) - 1;
    const sheet = parseXml(content) as Record<string, unknown>;
    const rows = asArray(asRecord(asRecord(asRecord(sheet.worksheet).sheetData).row));
    const header = `[工作表：${sheetNames[index] ?? `工作表 ${index + 1}`}]\n`;
    output.push(header); size += header.length;
    for (const rowNode of rows) {
      const row = asRecord(rowNode);
      const rowNo = str(row['@_r']) || '?';
      for (const cellNode of asArray(row.c)) {
        const cell = asRecord(cellNode);
        const ref = str(cell['@_r']) || '';
        const type = str(cell['@_t']) || '';
        let value = collectTexts(cell.v ?? cell.is ?? '');
        if (type === 's') value = sharedStrings[Number(value)] ?? value;
        if (!value) continue;
        const text = `第 ${rowNo} 行，${ref}：${value}\n`;
        if (size + text.length > MAX_EXTRACTED_CHARS) { output.push(safeTake(text, MAX_EXTRACTED_CHARS - size)); truncated = true; break; }
        output.push(text); size += text.length;
      }
      if (truncated) break;
    }
    if (truncated) break;
  }
  return { text: output.join(''), truncated };
}

async function parsePptx(data: Buffer): Promise<{ text: string; truncated: boolean }> {
  const wanted = new Set(Array.from({ length: 5000 }, (_, i) => `ppt/slides/slide${i + 1}.xml`));
  const parts = await readXmlParts(data, wanted);
  const slides = [...parts.entries()].filter(([entry]) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
    .sort(([a], [b]) => Number(a.match(/slide(\d+)/)?.[1] ?? 0) - Number(b.match(/slide(\d+)/)?.[1] ?? 0));
  const output: string[] = []; let size = 0; let truncated = false;
  for (const [name, content] of slides) {
    const index = Number(name.match(/slide(\d+)/)?.[1] ?? 1);
    const text = `[幻灯片 ${index}]\n${collectTagTexts(parseXml(content), 't').join('\n')}\n`;
    if (size + text.length > MAX_EXTRACTED_CHARS) { output.push(safeTake(text, MAX_EXTRACTED_CHARS - size)); truncated = true; break; }
    output.push(text); size += text.length;
  }
  return { text: output.join(''), truncated };
}

function parseXml(bytes: Buffer): unknown {
  try { return xmlParser.parse(bytes.toString('utf8')); }
  catch { throw coded('document_parse_failed', 'Office XML 部件解析失败'); }
}

async function readXmlParts(buffer: Buffer, wanted: Set<string>): Promise<Map<string, Buffer>> {
  const yauzl = await import('yauzl');
  let zip: Yauzl.ZipFile;
  try {
    zip = await new Promise<Yauzl.ZipFile>((resolve, reject) => {
      yauzl.fromBuffer(buffer, { lazyEntries: true, autoClose: true, decodeStrings: true, validateEntrySizes: true }, (error, file) => error || !file ? reject(error ?? new Error('invalid zip')) : resolve(file));
    });
  } catch { throw coded('document_parse_failed', 'Office 文档 ZIP 容器无法解析'); }
  const parts = new Map<string, Buffer>();
  let expanded = 0;
  return new Promise((resolve, reject) => {
    zip.on('error', () => reject(coded('document_parse_failed', 'Office 文档 ZIP 容器无法解析')));
    zip.on('end', () => parts.size ? resolve(parts) : reject(coded('document_parse_failed', '未找到可解析的 Office Open XML 部件')));
    zip.on('entry', (entry) => {
      if (!wanted.has(entry.fileName) || entry.fileName.includes('..')) { zip.readEntry(); return; }
      if (entry.uncompressedSize > MAX_ENTRY_BYTES || expanded + entry.uncompressedSize > MAX_EXPANDED_BYTES) {
        reject(coded('file_too_large', 'Office 文档展开后超过 32 MiB 安全上限')); zip.close(); return;
      }
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) { reject(coded('document_parse_failed', 'Office XML 部件读取失败')); zip.close(); return; }
        const chunks: Buffer[] = []; let actual = 0;
        stream.on('data', (chunk: Buffer) => {
          actual += chunk.length; expanded += chunk.length;
          if (actual > MAX_ENTRY_BYTES || expanded > MAX_EXPANDED_BYTES) { stream.destroy(new Error('zip expansion limit')); return; }
          chunks.push(chunk);
        });
        stream.on('error', () => { reject(coded('file_too_large', 'Office 文档展开后超过资源上限')); zip.close(); });
        stream.on('end', () => { parts.set(entry.fileName, Buffer.concat(chunks)); zip.readEntry(); });
      });
    });
    zip.readEntry();
  });
}

function walkDocx(node: unknown, emit: (text: string) => void): void {
  if (Array.isArray(node)) { for (const item of node) walkDocx(item, emit); return; }
  if (!node || typeof node !== 'object') return;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === 'p') { walkDocx(value, emit); emit('\n'); }
    else if (key === 'tab') emit('\t');
    else if (key === 'br') emit('\n');
    else if (key === 't') emit(collectTexts(value));
    else if (!key.startsWith('@_')) walkDocx(value, emit);
  }
}

function collectTexts(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(collectTexts).join('');
  if (node && typeof node === 'object') {
    const record = node as Record<string, unknown>;
    if (Object.hasOwn(record, '#text')) return collectTexts(record['#text']);
    return Object.entries(record).filter(([key]) => !key.startsWith('@_')).map(([, value]) => collectTexts(value)).join('');
  }
  return '';
}

function collectTagTexts(node: unknown, tag: string, found: string[] = []): string[] {
  if (Array.isArray(node)) { for (const item of node) collectTagTexts(item, tag, found); return found; }
  if (!node || typeof node !== 'object') return found;
  for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
    if (key === tag) found.push(collectTexts(value)); else if (!key.startsWith('@_')) collectTagTexts(value, tag, found);
  }
  return found;
}

function appendBounded(existing: string, value: string, truncated: { value: boolean }): string {
  if (existing.length >= MAX_EXTRACTED_CHARS) { truncated.value = true; return existing; }
  const safe = safeTake(value, MAX_EXTRACTED_CHARS - existing.length);
  if (safe.length < value.length) truncated.value = true;
  return existing + safe;
}
function safeTake(value: string, max: number): string {
  let end = Math.max(0, Math.min(value.length, max));
  if (end < value.length && end > 0 && isHighSurrogate(value.charCodeAt(end - 1)) && isLowSurrogate(value.charCodeAt(end))) end--;
  return value.slice(0, end);
}
function isHighSurrogate(value: number): boolean { return value >= 0xd800 && value <= 0xdbff; }
function isLowSurrogate(value: number): boolean { return value >= 0xdc00 && value <= 0xdfff; }
function asRecord(value: unknown): Record<string, unknown> { return value && typeof value === 'object' ? value as Record<string, unknown> : {}; }
function asArray(value: unknown): unknown[] { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }
function str(value: unknown): string { return typeof value === 'string' || typeof value === 'number' ? String(value) : ''; }
function coded(code: string, message: string): Error { return Object.assign(new Error(message), { code }); }
function hasCode(value: unknown): value is Error & { code: string } { return value instanceof Error && 'code' in value; }


import iconv from 'iconv-lite';
import type { Readable } from 'node:stream';

export type TextEncoding = 'utf8' | 'utf16-le' | 'utf16-be' | 'gb18030';

export function detectTextEncoding(prefix: Buffer): { encoding: TextEncoding; bomBytes: number } {
  if (prefix.length >= 3 && prefix[0] === 0xef && prefix[1] === 0xbb && prefix[2] === 0xbf) return { encoding: 'utf8', bomBytes: 3 };
  if (prefix.length >= 2 && prefix[0] === 0xff && prefix[1] === 0xfe) return { encoding: 'utf16-le', bomBytes: 2 };
  if (prefix.length >= 2 && prefix[0] === 0xfe && prefix[1] === 0xff) return { encoding: 'utf16-be', bomBytes: 2 };
  if (prefix.length >= 4) {
    let evenZeros = 0; let oddZeros = 0;
    for (let i = 0; i < prefix.length; i += 2) if (prefix[i] === 0) evenZeros++;
    for (let i = 1; i < prefix.length; i += 2) if (prefix[i] === 0) oddZeros++;
    if (oddZeros > 0 && evenZeros === 0) return { encoding: 'utf16-le', bomBytes: 0 };
    if (evenZeros > 0 && oddZeros === 0) return { encoding: 'utf16-be', bomBytes: 0 };
  }
  if (prefix.length >= 4) {
    try { new TextDecoder('utf-8', { fatal: true }).decode(prefix, { stream: true }); }
    catch { return { encoding: 'gb18030', bomBytes: 0 }; }
  }
  return { encoding: 'utf8', bomBytes: 0 };
}

export async function* decodedChunks(stream: Readable, maxChars = Number.MAX_SAFE_INTEGER): AsyncGenerator<string> {
  const iterator = stream[Symbol.asyncIterator]();
  const prefixParts: Buffer[] = [];
  let prefixBytes = 0;
  while (prefixBytes < 4096) {
    const next = await iterator.next();
    if (next.done) break;
    const part = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    prefixParts.push(part);
    prefixBytes += part.length;
  }
  const prefix = Buffer.concat(prefixParts, prefixBytes);
  const { encoding, bomBytes } = detectTextEncoding(prefix);
  const decoder = iconv.getDecoder(encoding);
  let emittedChars = 0;
  const first = prefix.subarray(bomBytes);
  if (first.length) {
    const text = decoder.write(first);
    if (text) {
      const bounded = takeCodePoints(text, maxChars - emittedChars);
      if (bounded) { emittedChars += [...bounded].length; yield bounded; }
      if (emittedChars >= maxChars) return;
    }
  }
  while (true) {
    const next = await iterator.next();
    if (next.done) break;
    const part = Buffer.isBuffer(next.value) ? next.value : Buffer.from(next.value);
    const text = decoder.write(part);
    if (!text) continue;
    const bounded = takeCodePoints(text, maxChars - emittedChars);
    if (bounded) { emittedChars += [...bounded].length; yield bounded; }
    if (emittedChars >= maxChars) return;
  }
  const tail = decoder.end();
  if (tail && emittedChars < maxChars) yield takeCodePoints(tail, maxChars - emittedChars);
}

export async function readTextPage(stream: Readable, options: { offset: number; limit: number; maxOutputChars: number; maxFileChars: number }) {
  const { offset, limit, maxOutputChars, maxFileChars } = options;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('offset 必须是非负整数');
  if (offset > maxFileChars) throw new Error('读取偏移超过单文件累计读取字符上限');
  let absolute = 0;
  let line = 1;
  const startLineAtOffset = { value: 1 };
  const out: string[] = [];
  let outChars = 0;
  let returned = 0;
  let exhausted = true;
  let parserLimit = false;
  for await (const chunk of decodedChunks(stream, maxFileChars + 1)) {
    for (const point of chunk) {
      if (absolute >= maxFileChars) { parserLimit = true; exhausted = false; break; }
      if (absolute < offset) {
        absolute++;
        if (point === '\n') line++;
        continue;
      }
      if (returned === 0) startLineAtOffset.value = line;
      if (returned >= limit || outChars + point.length > maxOutputChars) { exhausted = false; break; }
      out.push(point);
      outChars += point.length;
      absolute++;
      returned++;
      if (point === '\n') line++;
    }
    if (parserLimit || !exhausted || returned >= limit || outChars >= maxOutputChars) { exhausted = false; break; }
  }
  const text = out.join('');
  const hasMore = !exhausted && !parserLimit;
  const endLine = Math.max(startLineAtOffset.value, line - (text.endsWith('\n') ? 1 : 0));
  return {
    text, offset, next_offset: absolute, has_more: hasMore,
    start_line: startLineAtOffset.value, end_line: endLine,
    next_start_line: hasMore ? (text.endsWith('\n') ? endLine + 1 : endLine) : null,
    characters_returned: returned, file_limit_reached: parserLimit,
    truncated: hasMore || parserLimit,
  };
}

export async function readLinePage(stream: Readable, options: { startLine: number; lineCount: number; maxChars: number; maxFileChars: number }) {
  const { startLine, lineCount, maxChars, maxFileChars } = options;
  let line = 1;
  let absolute = 0;
  let text = '';
  let linesReturned = 0;
  let lineBuffer = '';
  let hasMore = false;
  let pageFull = false;
  let fileLimitReached = false;
  for await (const chunk of decodedChunks(stream, maxFileChars + 1)) {
    for (const point of chunk) {
      if (pageFull) { hasMore = true; break; }
      if (absolute >= maxFileChars) { fileLimitReached = true; hasMore = true; break; }
      absolute++;
      if (line < startLine) { if (point === '\n') line++; continue; }
      if (point === '\n') {
        const renderedLength = text.length + (linesReturned ? 1 : 0) + lineBuffer.length;
        if (linesReturned >= lineCount || renderedLength > maxChars) { hasMore = true; break; }
        text += `${linesReturned ? '\n' : ''}${lineBuffer}`;
        lineBuffer = '';
        linesReturned++;
        line++;
        if (linesReturned >= lineCount) pageFull = true;
      } else {
        const renderedLength = text.length + (linesReturned ? 1 : 0) + lineBuffer.length;
        if (renderedLength + point.length > maxChars) {
          text += `${linesReturned ? '\n' : ''}${lineBuffer}`;
          lineBuffer = '';
          hasMore = true;
          break;
        }
        lineBuffer += point;
      }
    }
    if (hasMore || fileLimitReached) break;
  }
  if (!hasMore && !fileLimitReached && line >= startLine && (lineBuffer.length > 0 || linesReturned === 0)) {
    if (text.length + (linesReturned ? 1 : 0) + lineBuffer.length <= maxChars) { text += `${linesReturned ? '\n' : ''}${lineBuffer}`; linesReturned++; }
    else hasMore = true;
  }
  return {
    text, start_line: startLine, lines_returned: linesReturned,
    next_start_line: hasMore && linesReturned > 0 ? startLine + linesReturned : null,
    next_offset: hasMore && linesReturned === 0 ? Math.max(0, absolute - 1) : null,
    has_more: hasMore, file_limit_reached: fileLimitReached,
    truncated: hasMore || fileLimitReached, characters_read: absolute,
  };
}

export async function searchTextStream(stream: Readable, keyword: string, caseSensitive: boolean, maxResults: number) {
  const matches: Array<{ line: number; text: string }> = [];
  let line = 1; let carry = '';
  const needle = caseSensitive ? keyword : keyword.toLocaleLowerCase();
  for await (const chunk of decodedChunks(stream, 2_000_000)) {
    const parts = (carry + chunk).split('\n');
    carry = parts.pop() ?? '';
    for (const content of parts) {
      const rendered = content.endsWith('\r') ? content.slice(0, -1) : content;
      if ((caseSensitive ? rendered : rendered.toLocaleLowerCase()).includes(needle)) matches.push({ line, text: rendered.slice(0, 2_000) });
      line++;
      if (matches.length >= maxResults) return matches;
    }
  }
  if (carry) {
    const rendered = carry.endsWith('\r') ? carry.slice(0, -1) : carry;
    if ((caseSensitive ? rendered : rendered.toLocaleLowerCase()).includes(needle)) matches.push({ line, text: rendered.slice(0, 2_000) });
  }
  return matches;
}

export function decodeBuffer(buffer: Buffer, selectedEncoding?: TextEncoding, selectedBomBytes?: number): string {
  const detected = selectedEncoding ? { encoding: selectedEncoding, bomBytes: selectedBomBytes ?? 0 } : detectTextEncoding(buffer.subarray(0, 4096));
  return iconv.decode(buffer.subarray(detected.bomBytes), detected.encoding);
}

function takeCodePoints(value: string, count: number): string {
  if (count <= 0) return '';
  let out = ''; let used = 0;
  for (const point of value) { if (used >= count) break; out += point; used++; }
  return out;
}


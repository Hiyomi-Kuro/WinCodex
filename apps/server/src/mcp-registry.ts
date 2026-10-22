export interface ToolDefinition { name: string; description: string; inputSchema: Record<string, unknown> }
const objectSchema = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, ...(required.length ? { required } : {}), additionalProperties: false });
const string = (minLength = 0) => ({ type: 'string', ...(minLength ? { minLength } : {}) });
const integer = (minimum?: number, maximum?: number) => ({ type: 'integer', ...(minimum !== undefined ? { minimum } : {}), ...(maximum !== undefined ? { maximum } : {}) });

export const tools: ToolDefinition[] = [
  { name: 'list_roots', description: '列出 WinCodex 中用户明确授权且当前仍有效的只读目录。', inputSchema: objectSchema({}) },
  { name: 'list_directory', description: '列出授权目录内的文件与子目录；可用 offset/limit 分页，recursive 仅搜索文件。', inputSchema: objectSchema({ root_id: string(1), path: string(), recursive: { type: 'boolean' }, limit: integer(1, 500), offset: integer(0) }, ['root_id']) },
  { name: 'stat_file', description: '获取授权目录中指定相对路径的元数据，不读取文件正文。', inputSchema: objectSchema({ root_id: string(1), path: string(1) }, ['root_id', 'path']) },
  { name: 'search_files', description: '在授权目录中按文件名搜索；默认递归遍历并返回元数据。', inputSchema: objectSchema({ root_id: string(1), query: string(1), path: string(), case_sensitive: { type: 'boolean' }, max_results: integer(1, 500) }, ['root_id', 'query']) },
  { name: 'search_file_contents', description: '在授权目录的受支持纯文本文件中搜索关键词，返回匹配内容与行号；受单次扫描资源上限约束。', inputSchema: objectSchema({ root_id: string(1), keyword: string(1), path: string(), case_sensitive: { type: 'boolean' }, max_results: integer(1, 200) }, ['root_id', 'keyword']) },
  { name: 'read_text', description: '读取授权目录中的纯文本文件。推荐使用 offset/limit 按 Unicode 字符分页（offset 为码点偏移）；也兼容 start_line/line_count 行分页。max_chars 控制单次输出。', inputSchema: objectSchema({ root_id: string(1), path: string(1), offset: integer(0), limit: integer(1, 2_000_000), start_line: integer(1), line_count: integer(1, 2_000), max_chars: integer(1) }, ['root_id', 'path']) },
  { name: 'read_document', description: '从 PDF、DOCX、XLSX、PPTX 提取可读文本；通过 start_offset/max_chars 分页。不返回图片或二进制内容。', inputSchema: objectSchema({ root_id: string(1), path: string(1), start_offset: integer(0), max_chars: integer(1) }, ['root_id', 'path']) },
  { name: 'read_file_chunk', description: '兼容按字节 offset/length 读取安全文本片段。新调用优先使用 read_text 的 Unicode 字符 offset/limit 分页。', inputSchema: objectSchema({ root_id: string(1), path: string(1), offset: integer(0), length: integer(1, 131_072), limit: integer(1, 131_072) }, ['root_id', 'path']) },
  { name: 'get_connection_status', description: '查看 WinCodex 服务与 Secure MCP Tunnel 的真实运行状态；不探测 ChatGPT 账号连接器。', inputSchema: objectSchema({}) },
  { name: 'get_capabilities', description: '查看 Windows 平台、文件访问方式、支持格式和当前授权目录范围。', inputSchema: objectSchema({}) },
];

export function getTool(name: string): ToolDefinition | undefined { return tools.find((tool) => tool.name === name); }

export function validateArguments(tool: ToolDefinition, value: Record<string, unknown>): string | undefined {
  const schema = tool.inputSchema;
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  const required = (schema.required as string[] | undefined) ?? [];
  for (const key of required) if (value[key] === undefined || value[key] === null) return `缺少必需参数：${key}`;
  for (const key of Object.keys(value)) {
    const rule = properties[key];
    if (!rule) return `不支持的参数：${key}`;
    const item = value[key];
    if (item === null) continue;
    const expected = rule.type;
    const matches = expected === 'integer' ? typeof item === 'number' && Number.isSafeInteger(item)
      : expected === 'number' ? typeof item === 'number' && Number.isFinite(item)
        : expected === 'array' ? Array.isArray(item)
          : expected === 'object' ? typeof item === 'object' && !Array.isArray(item)
            : typeof item === expected;
    if (!matches) return `参数 ${key} 类型错误，应为 ${String(expected)}`;
    if (typeof item === 'string') {
      const min = Number(rule.minLength ?? 0);
      const max = Number(rule.maxLength ?? Number.POSITIVE_INFINITY);
      if (item.length < min) return `参数 ${key} 长度不能少于 ${min}`;
      if (item.length > max) return `参数 ${key} 长度不能超过 ${max}`;
    }
    if (typeof item === 'number') {
      if (typeof rule.minimum === 'number' && item < rule.minimum) return `参数 ${key} 不能小于 ${rule.minimum}`;
      if (typeof rule.maximum === 'number' && item > rule.maximum) return `参数 ${key} 不能大于 ${rule.maximum}`;
    }
  }
  return undefined;
}

export function listToolsJson(): Array<Record<string, unknown>> {
  return tools.map(({ name, description, inputSchema }) => ({
    name, description, inputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }));
}


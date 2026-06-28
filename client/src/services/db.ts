import Dexie, { type EntityTable } from 'dexie';

const DB_INLINE_STRING_LIMIT = 1200;
const DB_RENDERED_TEXT_LIMIT = 200_000;
const DB_MAX_ARRAY_ITEMS = 80;
const DB_MAX_OBJECT_KEYS = 80;

const hiddenTextSummary = (chars: number, reason: string) => ({
  hidden: true,
  chars,
  reason,
  note: '内容已在前端隐藏，仅保留字符计数以避免页面内存溢出。',
});

const capRenderedText = (value: unknown, label: string): string => {
  if (typeof value !== 'string') return '';
  if (value.length <= DB_RENDERED_TEXT_LIMIT) return value;
  return `${value.slice(0, DB_RENDERED_TEXT_LIMIT)}\n\n[${label} 过长，前端已截断显示；原始字符数：${value.length}]`;
};

const sanitizePersistedValue = (value: any, depth = 0): any => {
  if (typeof value === 'string') {
    return value.length > DB_INLINE_STRING_LIMIT ? hiddenTextSummary(value.length, 'large_string') : value;
  }
  if (value === null || value === undefined || typeof value !== 'object') return value;
  if (depth >= 6) return { hidden: true, reason: 'max_depth' };
  if (Array.isArray(value)) {
    const visible = value.slice(0, DB_MAX_ARRAY_ITEMS).map(item => sanitizePersistedValue(item, depth + 1));
    if (value.length > DB_MAX_ARRAY_ITEMS) {
      visible.push({ hidden: true, omittedItems: value.length - DB_MAX_ARRAY_ITEMS, reason: 'array_too_large' });
    }
    return visible;
  }
  const entries = Object.entries(value);
  const next: Record<string, any> = {};
  for (const [key, entryValue] of entries.slice(0, DB_MAX_OBJECT_KEYS)) {
    next[key] = sanitizePersistedValue(entryValue, depth + 1);
  }
  if (entries.length > DB_MAX_OBJECT_KEYS) next.__omittedKeys = entries.length - DB_MAX_OBJECT_KEYS;
  return next;
};

const sanitizePersistedWriteArgs = (toolName: string, args: any) => {
  if (!args || typeof args !== 'object') return args;
  if (toolName === 'file_write') {
    const contentChars = typeof args.content === 'string' ? args.content.length : Number(args.content?.chars) || 0;
    return sanitizePersistedValue({ ...args, content: hiddenTextSummary(contentChars, 'file_content') });
  }
  return sanitizePersistedValue(args);
};

const sanitizePersistedAnnotationParams = (method?: string, params?: any): any => {
  if (!params || typeof params !== 'object') return params;
  if (method === 'tool/call') {
    const toolName = String(params.toolName || '');
    return {
      ...params,
      args: sanitizePersistedWriteArgs(toolName, params.args),
      argsMeta: params.argsMeta || { redacted: true },
    };
  }
  if (method === 'tool/result') {
    return { ...params, result: sanitizePersistedValue(params.result) };
  }
  return params;
};

const sanitizePersistedChatRow = (row: any) => {
  row.content = capRenderedText(row.content, '消息内容');
  row.reasoning_content = undefined;
  if (Array.isArray(row.parts)) {
    row.parts = row.parts.map((part: any) => ({
      ...part,
      content: capRenderedText(part?.content, part?.type === 'reasoning' ? '推理文本' : '消息内容'),
      params: part?.type === 'annotation' ? sanitizePersistedAnnotationParams(part.method, part.params) : part?.params,
    }));
  }
};

export interface ChatMessage {
  id: string;
  workspaceRoot: string;
  role: 'user' | 'assistant' | 'system' | 'data';
  content: string;
  reasoning_content?: string;
  parts: any[];
  timestamp: number;
}

/**
 * 聊天历史持久化 (IndexedDB)
 * 对齐技术规范 第 9.0 节
 */
export const db = new Dexie('DeepSeekIDEAgentDB') as Dexie & {
  chatHistory: EntityTable<ChatMessage, 'id'>;
};

db.version(4).stores({
  chatHistory: 'id, workspaceRoot, timestamp'
});

db.version(5).stores({
  chatHistory: 'id, workspaceRoot, timestamp, [workspaceRoot+timestamp]'
}).upgrade(tx => {
  return tx.table('chatHistory').toCollection().modify((row: any) => {
    sanitizePersistedChatRow(row);
  });
});

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
  // 仅供前端 IndexedDB 本地存储节流（避免超大推理文本占用存储）。
  // 客户端从不把历史消息回传给后端，后端 API 回传走的是服务端 AgentTurnEngine 的原始消息，此处不影响 API。
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

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface TokenUsageRecord extends TokenUsage {
  id: string;
  workspaceRoot: string;
  date: string;
  timestamp: number;
}

export interface WorkspaceTokenUsageSummary {
  daily: Array<{ date: string; totalTokens: number }>;
  todayTokens: number;
  totalTokens: number;
}

export const TOKEN_USAGE_UPDATED_EVENT = 'ui:token-usage:updated';

const beijingDateFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Asia/Shanghai',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export const getBeijingDateKey = (timestamp: number): string => {
  const parts = beijingDateFormatter.formatToParts(new Date(timestamp));
  const year = parts.find(part => part.type === 'year')?.value || '0000';
  const month = parts.find(part => part.type === 'month')?.value || '00';
  const day = parts.find(part => part.type === 'day')?.value || '00';
  return `${year}-${month}-${day}`;
};

/**
 * 聊天历史持久化 (IndexedDB)
 * 对齐技术规范 第 9.0 节
 */
export const db = new Dexie('DeepSeekIDEAgentDB') as Dexie & {
  chatHistory: EntityTable<ChatMessage, 'id'>;
  tokenUsage: EntityTable<TokenUsageRecord, 'id'>;
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

db.version(6).stores({
  chatHistory: 'id, workspaceRoot, timestamp, [workspaceRoot+timestamp]',
  tokenUsage: 'id, workspaceRoot, date, [workspaceRoot+date]',
});

const toTokenCount = (value: number): number =>
  Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0;

export const recordTokenUsage = async (
  record: Omit<TokenUsageRecord, 'date'>,
): Promise<void> => {
  if (!record.id || !record.workspaceRoot) return;

  const timestamp = Number.isFinite(record.timestamp) ? record.timestamp : Date.now();
  const normalized = {
    ...record,
    timestamp,
    date: getBeijingDateKey(timestamp),
    inputTokens: toTokenCount(record.inputTokens),
    outputTokens: toTokenCount(record.outputTokens),
    totalTokens: toTokenCount(record.totalTokens),
  };
  if (normalized.totalTokens === 0) return;

  // The assistant message ID makes repeated done events idempotent.
  await db.tokenUsage.put(normalized);
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(TOKEN_USAGE_UPDATED_EVENT, {
      detail: { workspaceRoot: record.workspaceRoot },
    }));
  }
};

export const getWorkspaceTokenUsageSummary = async (
  workspaceRoot: string,
): Promise<WorkspaceTokenUsageSummary> => {
  const records = await db.tokenUsage.where('workspaceRoot').equals(workspaceRoot).toArray();
  const dailyTotals = new Map<string, number>();
  let totalTokens = 0;

  for (const record of records) {
    const tokens = toTokenCount(record.totalTokens);
    const date = record.date || getBeijingDateKey(record.timestamp);
    dailyTotals.set(date, (dailyTotals.get(date) || 0) + tokens);
    totalTokens += tokens;
  }

  const today = getBeijingDateKey(Date.now());
  return {
    daily: Array.from(dailyTotals, ([date, tokens]) => ({ date, totalTokens: tokens }))
      .sort((left, right) => left.date.localeCompare(right.date)),
    todayTokens: dailyTotals.get(today) || 0,
    totalTokens,
  };
};

export const clearWorkspaceChatHistory = async (workspaceRoot: string): Promise<void> => {
  await db.chatHistory.where('workspaceRoot').equals(workspaceRoot).delete();
};

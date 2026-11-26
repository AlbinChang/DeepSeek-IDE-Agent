import Dexie, { type EntityTable } from 'dexie';
import { normalizeWorkspaceKey } from '@/utils/path';
import { getBeijingDateKey } from '@/utils/beijingDate';

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
  // 兼容历史（宾+动）命名 file_write
  if (toolName === 'write_file' || toolName === 'file_write') {
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
  /** 归一化后的工作区分区键（跨重启稳定；见 normalizeWorkspaceKey） */
  workspaceKey?: string;
  role: 'user' | 'assistant' | 'system' | 'data';
  content: string;
  reasoning_content?: string;
  parts: any[];
  timestamp: number;
  traceId?: string;
  isFinal?: boolean;
}

/**
 * 前端 UI 状态快照（与聊天消息分开存储）：
 * 任务流水线、阶段提示、未发送的输入草稿。
 * 仅用于重启恢复展示，不参与模型请求。
 */
export interface ChatUiState {
  workspaceKey: string;
  workspaceRoot: string;
  todos: any[];
  stages: any[];
  input: string;
  updatedAt: number;
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

export { getBeijingDateKey };

/**
 * 聊天历史持久化 (IndexedDB)
 * 对齐技术规范 第 9.0 节
 */
export const db = new Dexie('DeepSeekIDEAgentDB') as Dexie & {
  chatHistory: EntityTable<ChatMessage, 'id'>;
  tokenUsage: EntityTable<TokenUsageRecord, 'id'>;
  chatUiState: EntityTable<ChatUiState, 'workspaceKey'>;
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

// v7：引入稳定的分区键 workspaceKey 与 UI 状态表。
// - 同一工作区在重启后可能以 D:\mall / D:/mall / 末尾斜杠等不同字符串出现，
//   旧实现按 workspaceRoot 精确查询会“查不到历史 → UI 看起来被清空”。
// - 升级时把已有行补齐 workspaceKey，保证旧数据不丢。
db.version(7).stores({
  chatHistory: 'id, workspaceRoot, workspaceKey, timestamp, [workspaceRoot+timestamp], [workspaceKey+timestamp]',
  tokenUsage: 'id, workspaceRoot, date, [workspaceRoot+date]',
  chatUiState: 'workspaceKey',
}).upgrade(tx => {
  return tx.table('chatHistory').toCollection().modify((row: any) => {
    row.workspaceKey = normalizeWorkspaceKey(row.workspaceRoot);
  });
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

/**
 * 归一化并补齐一条聊天记录的持久化字段。
 * 返回新对象，避免修改 React 正在使用的消息快照。
 */
const toPersistedChatRow = (message: ChatMessage): ChatMessage => {
  const row: ChatMessage = {
    ...message,
    workspaceKey: message.workspaceKey || normalizeWorkspaceKey(message.workspaceRoot),
  };
  sanitizePersistedChatRow(row);
  return row;
};

/**
 * 批量写入/覆盖聊天消息。
 * 写入前按持久化预算裁剪（超大工具参数、超长正文），避免 IndexedDB 无限膨胀。
 */
export const putChatMessages = async (messages: ChatMessage[]): Promise<void> => {
  if (!Array.isArray(messages) || messages.length === 0) return;
  await db.chatHistory.bulkPut(messages.map(toPersistedChatRow));
};

/**
 * 读取某个工作区的最近聊天消息（按时间正序返回，供 UI 直接渲染）。
 * 使用归一化 workspaceKey 查询，兼容 D:\ws / D:/ws / 末尾斜杠等写法差异。
 */
export const loadWorkspaceChatHistory = async (
  workspaceRoot: string,
  limit: number,
): Promise<ChatMessage[]> => {
  const workspaceKey = normalizeWorkspaceKey(workspaceRoot);
  if (!workspaceKey) return [];
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : 80;
  const rows = await db.chatHistory
    .where('[workspaceKey+timestamp]')
    .between([workspaceKey, Dexie.minKey], [workspaceKey, Dexie.maxKey])
    .reverse()
    .limit(safeLimit)
    .toArray();
  return rows.sort((left, right) => left.timestamp - right.timestamp);
};

/** 保存前端 UI 状态快照（任务流水线 / 阶段 / 输入草稿）。 */
export const saveChatUiState = async (state: ChatUiState): Promise<void> => {
  const workspaceKey = state.workspaceKey || normalizeWorkspaceKey(state.workspaceRoot);
  if (!workspaceKey) return;
  await db.chatUiState.put({
    ...state,
    workspaceKey,
    todos: Array.isArray(state.todos) ? state.todos.slice(0, 100) : [],
    stages: Array.isArray(state.stages) ? state.stages.slice(-120) : [],
    input: typeof state.input === 'string' ? state.input.slice(0, 100_000) : '',
    updatedAt: Number.isFinite(state.updatedAt) ? state.updatedAt : Date.now(),
  });
};

/** 读取前端 UI 状态快照。 */
export const loadChatUiState = async (workspaceRoot: string): Promise<ChatUiState | undefined> => {
  const workspaceKey = normalizeWorkspaceKey(workspaceRoot);
  if (!workspaceKey) return undefined;
  return db.chatUiState.get(workspaceKey);
};

/**
 * 清空某个工作区的全部前端内容（消息 + UI 状态）。
 * 只应在用户显式点击「清空历史会话」时调用。
 */
export const clearWorkspaceChatHistory = async (workspaceRoot: string): Promise<void> => {
  const workspaceKey = normalizeWorkspaceKey(workspaceRoot);
  if (!workspaceKey) return;
  await db.transaction('rw', db.chatHistory, db.chatUiState, async () => {
    await db.chatHistory.where('workspaceKey').equals(workspaceKey).delete();
    await db.chatUiState.delete(workspaceKey);
  });
};

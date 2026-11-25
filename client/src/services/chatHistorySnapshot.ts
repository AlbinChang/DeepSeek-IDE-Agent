/**
 * 聊天消息落库决策（纯函数，无 React / IndexedDB 依赖）。
 *
 * 抽出来的原因：这里是「重启后内容能不能恢复」的唯一决策点，历史上很容易写错——
 * 曾经只落库「最后一条 assistant 消息」，一旦末尾追加了提示/错误气泡，
 * 正在产出的回复就再也写不进 IndexedDB。
 */

export interface PersistableChatMessage {
    id: string;
    role: string;
    content?: string;
    reasoning_content?: string;
    parts?: any[];
    timestamp: number;
    traceId?: string;
    isFinal?: boolean;
}

export interface PersistableChatRow {
    id: string;
    workspaceRoot: string;
    workspaceKey: string;
    role: 'assistant';
    content: string;
    reasoning_content?: string;
    parts: any[];
    timestamp: number;
    traceId?: string;
    isFinal?: boolean;
}

/**
 * 消息内容指纹：正文长度 + 尾部片段 + parts 数量 + 最后一部分的进度 + isFinal。
 * 只有指纹变化才需要落库，避免流式分片时对同一条消息反复写库。
 */
export const messagePersistSignature = (message: PersistableChatMessage): string => {
    const parts = Array.isArray(message.parts) ? message.parts : [];
    const lastPart = parts.length > 0 ? parts[parts.length - 1] : null;
    const content = typeof message.content === 'string' ? message.content : '';
    return [
        message.role,
        content.length,
        content.slice(-32),
        parts.length,
        lastPart ? `${lastPart?.id ?? ''}:${String(lastPart?.content ?? '').length}` : '',
        message.isFinal ? 1 : 0,
    ].join('|');
};

export interface SelectMessagesToPersistOptions {
    workspaceRoot: string;
    workspaceKey: string;
    /** 已落库指纹（原地更新） */
    signatures: Map<string, string>;
    /** 从 IndexedDB 恢复出来的消息，禁止回写（否则每次重启都会被二次清洗，内容逐次退化） */
    skipIds?: ReadonlySet<string>;
}

export interface SelectMessagesToPersistResult {
    rows: PersistableChatRow[];
    /** 本次是否有终态消息需要立即 flush */
    finalized: boolean;
}

/**
 * 选出本次需要落库的消息：所有「内容发生变化」的 assistant 消息（不限于最后一条）。
 * 用户消息由 append 的即时写入负责，这里跳过以免重复写。
 */
export const selectMessagesToPersist = (
    messages: readonly PersistableChatMessage[],
    options: SelectMessagesToPersistOptions,
): SelectMessagesToPersistResult => {
    const { workspaceRoot, workspaceKey, signatures, skipIds } = options;
    const rows: PersistableChatRow[] = [];
    let finalized = false;

    for (const message of messages) {
        if (!message || message.role !== 'assistant') continue;
        if (skipIds?.has(message.id)) continue;

        const signature = messagePersistSignature(message);
        if (signatures.get(message.id) === signature) continue;
        signatures.set(message.id, signature);
        if (message.isFinal) finalized = true;

        rows.push({
            id: message.id,
            workspaceRoot,
            workspaceKey,
            role: 'assistant',
            content: typeof message.content === 'string' ? message.content : '',
            reasoning_content: message.reasoning_content,
            parts: Array.isArray(message.parts) ? message.parts : [],
            timestamp: message.timestamp,
            traceId: message.traceId,
            isFinal: message.isFinal,
        });
    }

    // 已从界面移除的消息不再保留指纹，避免 Map 无界增长
    if (signatures.size > messages.length) {
        const liveIds = new Set(messages.map((message) => message?.id));
        for (const id of Array.from(signatures.keys())) {
            if (!liveIds.has(id)) signatures.delete(id);
        }
    }

    return { rows, finalized };
};

/**
 * 流结束时的终态快照：无论 SSE 正常结束、报错还是被中止，
 * 本轮 assistant 消息都要以 isFinal 立即落库，避免重启后本轮内容缺失。
 */
export const buildFinalizedRow = (
    message: PersistableChatMessage,
    workspaceRoot: string,
    workspaceKey: string,
): PersistableChatRow => ({
    id: message.id,
    workspaceRoot,
    workspaceKey,
    role: 'assistant',
    content: typeof message.content === 'string' ? message.content : '',
    reasoning_content: message.reasoning_content,
    parts: Array.isArray(message.parts) ? message.parts : [],
    timestamp: message.timestamp,
    traceId: message.traceId,
    isFinal: true,
});

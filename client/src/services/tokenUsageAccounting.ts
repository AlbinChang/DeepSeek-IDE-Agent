/**
 * 模型 token 用量的分日落库计算（纯逻辑，不依赖 IndexedDB / React）。
 *
 * 为什么需要它：
 * 服务端每个 `usage` 事件是「本次模型调用」的用量，一轮任务里会不断累加。
 * 旧实现把「本轮累计值」直接 put 进 IndexedDB，并且时间戳固定取**本轮开始时刻**，
 * 于是 23:45 开始、跨过零点的长任务会把 00:00 之后的全部用量都算进前一天，
 * 状态栏「今日」在第二天长时间显示 0。这里改为：
 * - 落库的是**增量**（累计值 − 已落库值），重复/乱序事件不会重复计数；
 * - 时间取**真实发生时刻**，按北京自然日分桶；
 * - 主键带上日期（`<messageId>:<date>`），跨零点自然拆成两条记录。
 */

import { getBeijingDateKey } from '../utils/beijingDate.js';

export interface UsageTotals {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
}

/** 一条待写入 IndexedDB 的用量记录 */
export interface TokenUsageWrite extends UsageTotals {
    /** 主键：`<messageId>:<北京日期>` */
    id: string;
    workspaceRoot: string;
    /** 真实发生时刻 */
    timestamp: number;
    /** 北京日期 key，与 timestamp 对应 */
    date: string;
    /** 本次新增的 token 数（含 prompt），用于分日统计 */
    deltaTotalTokens: number;
    /** 本次新增的**生成** token 数（不含 prompt），用于状态栏 T/s 速率 */
    deltaOutputTokens: number;
}

export interface UsageRecorderOptions {
    /** 本轮 assistant 消息 id（用作主键前缀，保证同一轮内幂等） */
    messageId: string;
    workspaceRoot: string;
    /** 可注入的时钟，便于测试 */
    now?: () => number;
    /** 可注入的日期换算，默认北京时间 */
    toDateKey?: (timestamp: number) => string;
}

export interface UsageRecorder {
    /**
     * 传入「本轮累计 usage」，返回本该写入的记录。
     * 没有新增用量（或累计值回退）时返回 null。
     */
    record(cumulative: UsageTotals): TokenUsageWrite | null;
    /** 已落库的累计值，未写过时为 null */
    getPersisted(): UsageTotals | null;
}

const toFiniteCount = (value: number): number => (
    Number.isFinite(value) && value > 0 ? Math.trunc(value) : 0
);

const normalizeTotals = (totals: UsageTotals): UsageTotals => ({
    inputTokens: toFiniteCount(totals.inputTokens),
    outputTokens: toFiniteCount(totals.outputTokens),
    totalTokens: toFiniteCount(totals.totalTokens),
});

export const createUsageRecorder = (options: UsageRecorderOptions): UsageRecorder => {
    const now = options.now ?? Date.now;
    const toDateKey = options.toDateKey ?? getBeijingDateKey;

    let persisted: UsageTotals | null = null;
    /** 每个自然日已写入的量 */
    const writtenByDate = new Map<string, UsageTotals>();

    return {
        record(cumulative: UsageTotals): TokenUsageWrite | null {
            const current = normalizeTotals(cumulative);
            if (current.totalTokens <= 0) return null;

            const deltaTotal = current.totalTokens - (persisted?.totalTokens ?? 0);
            if (deltaTotal <= 0) return null;

            const deltaInput = Math.max(0, current.inputTokens - (persisted?.inputTokens ?? 0));
            const deltaOutput = Math.max(0, current.outputTokens - (persisted?.outputTokens ?? 0));
            persisted = current;

            const timestamp = now();
            const date = toDateKey(timestamp);
            const previous = writtenByDate.get(date) ?? { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
            const next: UsageTotals = {
                inputTokens: previous.inputTokens + deltaInput,
                outputTokens: previous.outputTokens + deltaOutput,
                totalTokens: previous.totalTokens + deltaTotal,
            };
            writtenByDate.set(date, next);

            return {
                id: `${options.messageId}:${date}`,
                workspaceRoot: options.workspaceRoot,
                timestamp,
                date,
                ...next,
                deltaTotalTokens: deltaTotal,
                deltaOutputTokens: deltaOutput,
            };
        },

        getPersisted(): UsageTotals | null {
            return persisted ? { ...persisted } : null;
        },
    };
};

/**
 * 模型 token 吞吐速率采样器（供状态栏「T/s」实时显示）。
 *
 * 设计约束（避免拖慢主渲染）：
 * - 只保存最近一个窗口内的采样点，`recordTokenDelta` 是 O(1) 摊还操作；
 * - 采样与通知由单个 1s 定时器驱动，且只在显示值真正变化时才通知订阅者；
 * - 通过 `useSyncExternalStore` 订阅，订阅者只有速率组件本身，父级不会因此重渲染；
 * - 没有订阅者时定时器自动停止，空闲时零开销。
 */

/**
 * 速率统计窗口。
 *
 * 用量的最小粒度是「一次模型调用」，而一次调用往往间隔十几秒；
 * 窗口太短会让两次调用之间的显示长期为 0（看起来像坏了），
 * 窗口太长又失去实时感。15s 滑动平均既能覆盖常规调用间隔，也能及时回落。
 */
export const TOKEN_RATE_WINDOW_MS = 15_000;

/** 采样/发布频率 */
export const TOKEN_RATE_PUBLISH_INTERVAL_MS = 1000;

export interface TokenRateSample {
    /** 采样时刻（ms） */
    at: number;
    /** 该时刻新增的 token 数 */
    tokens: number;
}

/**
 * 纯函数：按滑动窗口计算平均 token 速率（tokens/s）。
 * 窗口外的采样点不参与计算。
 */
export const computeTokenRate = (
    samples: readonly TokenRateSample[],
    now: number,
    windowMs: number = TOKEN_RATE_WINDOW_MS,
): number => {
    if (windowMs <= 0) return 0;
    let total = 0;
    for (const sample of samples) {
        const age = now - sample.at;
        if (age < 0 || age > windowMs) continue;
        total += sample.tokens;
    }
    if (total <= 0) return 0;
    return Math.round(total / (windowMs / 1000));
};

const samples: TokenRateSample[] = [];
const listeners = new Set<() => void>();
let publishTimer: ReturnType<typeof setInterval> | null = null;
let publishedRate = 0;

const pruneSamples = (now: number): void => {
    while (samples.length > 0 && now - samples[0].at > TOKEN_RATE_WINDOW_MS) {
        samples.shift();
    }
};

const publish = (): void => {
    const now = Date.now();
    pruneSamples(now);
    const next = computeTokenRate(samples, now);
    if (next === publishedRate) return;
    publishedRate = next;
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch (error) {
            console.warn('[tokenRate] listener failed:', error);
        }
    }
};

const ensureTimer = (): void => {
    if (publishTimer !== null || listeners.size === 0) return;
    publishTimer = setInterval(publish, TOKEN_RATE_PUBLISH_INTERVAL_MS);
};

const stopTimerIfIdle = (): void => {
    if (listeners.size > 0 || publishTimer === null) return;
    clearInterval(publishTimer);
    publishTimer = null;
};

/**
 * 记录一次 token 增量（每次模型调用返回的 usage 就是一段增量）。
 * 非正数与非有限值会被忽略，避免污染速率。
 */
export const recordTokenDelta = (tokens: number, at: number = Date.now()): void => {
    const value = Number.isFinite(tokens) ? Math.trunc(tokens) : 0;
    if (value <= 0) return;
    samples.push({ at, tokens: value });
    pruneSamples(at);
    // 时钟回拨等异常情况下保证采样点按时间有序
    if (samples.length > 1 && samples[samples.length - 2].at > at) {
        samples.sort((left, right) => left.at - right.at);
    }
};

/** 当前发布的速率（tokens/s）；供 useSyncExternalStore 读取 */
export const getTokenRateSnapshot = (): number => publishedRate;

export const subscribeTokenRate = (listener: () => void): (() => void) => {
    listeners.add(listener);
    ensureTimer();
    // 首个订阅者立刻拿到当前值，避免最长 1s 的空白
    publish();
    return () => {
        listeners.delete(listener);
        stopTimerIfIdle();
    };
};

/** 仅供测试与工作区切换时重置 */
export const resetTokenRate = (): void => {
    samples.length = 0;
    publishedRate = 0;
    for (const listener of [...listeners]) listener();
};

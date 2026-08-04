/**
 * LLM API 调用重试工具
 *
 * 统一管理「服务过载 / 网络层故障」两类可重试错误的识别、退避与重试：
 * - 服务过载：HTTP 408/409/425/429/500/502/503/504（含 DeepSeek 的
 *   「503 Service is too busy」），按 AGENT_API_SERVICE_BUSY_RETRY_LIMIT（默认 10）重试
 * - 网络层：未收到 HTTP 响应（DNS / 连接 / TLS / 流中断等），按 AGENT_API_RETRY_LIMIT（默认 3）重试
 *
 * 供 AgentTurnEngine（流式对话）/ CompletionService（补全）/ HistoryOptimizerService（历史修复）共用，
 * 避免各调用点重复实现分类与退避逻辑。
 */

/** 服务过载/临时故障类 HTTP 状态码（值得自动重试） */
export const SERVICE_BUSY_HTTP_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/** 常见 Node.js/undici 网络层错误码（未收到 HTTP 响应） */
const NETWORK_ERROR_CODES = new Set([
    'ETIMEDOUT',
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ENOTFOUND',
    'EAI_AGAIN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'EADDRINFO',
    'EPIPE',
]);

export type RetryCategory = 'service_busy' | 'network' | 'non_retryable';

export interface RetryVerdict {
    /** 是否可重试 */
    retryable: boolean;
    /** 错误类别 */
    category: RetryCategory;
    /** 人类可读原因（如 `HTTP 503` / `network:ENOTFOUND`） */
    reason: string;
    /** 归一化后的 HTTP 状态码；非 HTTP 错误为 -1 */
    status: number;
}

/**
 * 对错误对象做可重试性分类。
 * 兼容 OpenAI SDK（error.status / error.code）、undici（error.cause.code）、
 * 原生 fetch（error.response?.status）等常见错误形态。
 */
export function classifyRetryableError(error: any): RetryVerdict {
    const statusRaw = error?.status ?? error?.response?.status;
    let status: number;
    if (typeof statusRaw === 'number') {
        status = statusRaw;
    } else if (statusRaw === undefined || statusRaw === null || statusRaw === '') {
        status = Number.NaN;
    } else {
        status = Number.parseInt(String(statusRaw), 10);
    }

    const code: string = String(error?.code || error?.cause?.code || '');
    const message: string = String(error?.message || error?.cause?.message || '');

    // 1) 明确收到 HTTP 响应（状态码可解析且 > 0）
    if (Number.isFinite(status) && status > 0) {
        if (SERVICE_BUSY_HTTP_STATUS.has(status)) {
            return { retryable: true, category: 'service_busy', reason: `HTTP ${status}`, status };
        }
        return { retryable: false, category: 'non_retryable', reason: `HTTP ${status}`, status };
    }

    // 2) 无 HTTP 状态码 → 请求未到达服务端或连接中断（网络层）
    const isNetworkCode =
        NETWORK_ERROR_CODES.has(code) ||
        /^UND_ERR_/i.test(code) ||
        /fetch failed|terminated|socket hang up|network|timeout/i.test(message);

    if (isNetworkCode) {
        return { retryable: true, category: 'network', reason: `network:${code || 'no-http-status'}`, status: -1 };
    }

    // 3) 无 HTTP 状态且无法归类 → 保守视为网络层错误，沿用旧逻辑（可重试）
    return { retryable: true, category: 'network', reason: 'no-http-status', status: -1 };
}

/**
 * 计算第 attempt 次（从 0 开始）重试前的等待毫秒数。
 * 指数退避 + ±20% 抖动，避免多请求同时重试形成惊群。
 * 服务过载类错误退避更激进（base 2s），网络层 base 1s。
 */
export function computeRetryDelayMs(
    attempt: number,
    category: RetryCategory,
    maxDelayMs: number = 30_000,
): number {
    const base = category === 'service_busy' ? 2_000 : 1_000;
    const exponential = Math.min(base * Math.pow(2, Math.max(0, attempt)), maxDelayMs);
    const jitter = 1 + (Math.random() * 0.4 - 0.2); // 0.8 ~ 1.2
    return Math.round(exponential * jitter);
}

export interface WithApiRetryOptions {
    /** 网络层错误重试次数（默认取 3） */
    retries?: number;
    /** 服务过载（429/5xx）错误重试次数（默认取 10） */
    serviceBusyRetries?: number;
    /** 每次重试前的回调（用于日志 / 推送前端状态） */
    onRetry?: (info: {
        attempt: number;
        maxAttempts: number;
        verdict: RetryVerdict;
        delayMs: number;
    }) => void;
}

/**
 * 通用重试包装器：对可重试错误按分类执行指数退避重试。
 * 每次重试都会重新调用 fn()（务必让 fn 重新发起完整请求，而非复用失败请求）。
 * 不可重试错误或超过对应分类上限时，原样抛出。
 */
export async function withApiRetry<T>(
    fn: () => Promise<T>,
    options: WithApiRetryOptions = {},
): Promise<T> {
    const retries = options.retries ?? 3;
    const serviceBusyRetries = options.serviceBusyRetries ?? 10;
    let attempt = 0;

    for (;;) {
        try {
            return await fn();
        } catch (error: any) {
            const verdict = classifyRetryableError(error);
            const maxAttempts = verdict.category === 'service_busy' ? serviceBusyRetries : retries;

            if (!verdict.retryable || attempt >= maxAttempts) {
                throw error;
            }

            attempt++;
            const delayMs = computeRetryDelayMs(attempt - 1, verdict.category);
            if (options.onRetry) {
                options.onRetry({ attempt, maxAttempts, verdict, delayMs });
            }
            await new Promise((resolve) => setTimeout(resolve, delayMs));
        }
    }
}

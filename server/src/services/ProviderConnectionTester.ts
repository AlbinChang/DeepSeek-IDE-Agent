import OpenAI from 'openai';
import { AIProviderFactory, type ReasoningEffortLevel } from '@/services/AIProviderFactory.js';
import type { ModelProviderConfig } from '@/services/SettingsService.js';

export type ConnectionTestStatus =
    | 'ok'
    | 'invalid_request'
    | 'auth'
    | 'not_found'
    | 'rate_limited'
    | 'server'
    | 'network'
    | 'timeout'
    | 'error';

export interface ConnectionTestResult {
    success: boolean;
    status: ConnectionTestStatus;
    /** 首包延迟（从发起请求到收到第一个流式分片），不是完整生成的耗时 */
    latencyMs?: number;
    model?: string;
    httpStatus?: number;
    error?: string;
}

/** 仅暴露测试连接需要的最小客户端接口，便于单测注入假实现 */
export interface ConnectionTestClient {
    chat: {
        completions: {
            create: (body: Record<string, any>, options?: { signal?: AbortSignal }) => Promise<AsyncIterable<any>>;
        };
    };
}

export interface ConnectionTestOptions {
    /** 首包超时（毫秒），默认 60s。思考型模型首包可能很慢，不能用秒级超时。 */
    timeoutMs?: number;
    /** 思考强度档位，默认取 provider.defaultReasoningEffort */
    reasoningEffort?: ReasoningEffortLevel | null;
    /** 用于 extra_body.user_id 的工作区标识（仅影响 KV Cache 复用） */
    workspace?: string;
    clientFactory?: (config: { apiKey: string; baseURL: string; timeoutMs: number }) => ConnectionTestClient;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const HEALTH_CHECK_MAX_TOKENS = 16;

function defaultClientFactory(config: { apiKey: string; baseURL: string; timeoutMs: number }): ConnectionTestClient {
    const client = new OpenAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        timeout: config.timeoutMs,
        maxRetries: 0,
    });
    return client as unknown as ConnectionTestClient;
}

function describeError(error: any): { status: ConnectionTestStatus; message: string; httpStatus?: number } {
    const httpStatus: number | undefined =
        typeof error?.status === 'number'
            ? error.status
            : typeof error?.response?.status === 'number'
                ? error.response.status
                : undefined;
    const name = String(error?.name || '');
    const code = String(error?.code || error?.cause?.code || '');
    const rawMessage = String(error?.message || error || '未知错误');

    if (name === 'APIConnectionTimeoutError' || /timed?\s*out/i.test(rawMessage) || code === 'ETIMEDOUT') {
        return {
            status: 'timeout',
            httpStatus,
            message: `连接超时：模型在限定时间内没有返回任何数据（${rawMessage}）`,
        };
    }
    if (httpStatus === 401 || httpStatus === 403) {
        return { status: 'auth', httpStatus, message: `鉴权失败（HTTP ${httpStatus}）：请检查 API Key 与网关权限。${rawMessage}` };
    }
    if (httpStatus === 404) {
        return {
            status: 'not_found',
            httpStatus,
            message: `接口不存在（HTTP 404）：请检查 Base URL 是否包含正确的路径前缀（如 /v1）与模型 ID。${rawMessage}`,
        };
    }
    if (httpStatus === 429) {
        return { status: 'rate_limited', httpStatus, message: `请求被限流（HTTP 429）：请稍后重试或检查网关配额。${rawMessage}` };
    }
    if (typeof httpStatus === 'number' && httpStatus >= 500) {
        return { status: 'server', httpStatus, message: `网关/服务端错误（HTTP ${httpStatus}）：${rawMessage}` };
    }
    if (/^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|CERT_|ERR_TLS|UNABLE_TO_VERIFY)/.test(code)) {
        return { status: 'network', message: `网络不可达（${code}）：请检查 Base URL、代理与证书配置。${rawMessage}` };
    }
    if (name === 'AbortError') {
        return { status: 'timeout', httpStatus, message: `连接超时：请求已被中止（${rawMessage}）` };
    }
    return { status: 'error', httpStatus, message: rawMessage };
}

/**
 * Provider「测试连接」的共享实现。
 *
 * 必须与 Agent 实际请求保持一致：**流式**请求 + 首包超时判定。
 * 历史上这里用的是非流式 `max_tokens: 1` + 15s 超时，思考型模型（reasoning / thinking）
 * 在非流式模式下要等整段推理结束才返回响应头，网关侧很容易超过 15s，于是 Agent 能正常多轮对话、
 * 但「测试连接」必然报 timeout。改为流式后只要拿到首个分片即可判定连通性，并按需立即中止请求。
 */
export class ProviderConnectionTester {
    static async test(
        providerInput: Partial<ModelProviderConfig>,
        options: ConnectionTestOptions = {},
    ): Promise<ConnectionTestResult> {
        // 校验用户实际填写的值（normalizeProvider 会用环境变量兜底，不能用于必填校验）
        const apiKey = (providerInput.apiKey || '').trim();
        const baseURL = (providerInput.baseURL || '').trim();
        const modelId = (providerInput.modelId || '').trim();

        if (!apiKey) {
            return { success: false, status: 'invalid_request', error: '缺少 API Key' };
        }
        if (!baseURL) {
            return { success: false, status: 'invalid_request', error: '缺少 Base URL' };
        }
        if (!modelId) {
            return { success: false, status: 'invalid_request', error: '缺少模型 ID' };
        }

        const provider = AIProviderFactory.normalizeProvider({ ...providerInput, apiKey, baseURL, modelId });

        const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
            ? options.timeoutMs
            : DEFAULT_TIMEOUT_MS;
        const clientFactory = options.clientFactory ?? defaultClientFactory;
        const client = clientFactory({ apiKey, baseURL, timeoutMs });

        const thinkingOptions = AIProviderFactory.buildThinkingOptions(
            provider,
            options.reasoningEffort ?? provider.defaultReasoningEffort,
            'connection-test',
            options.workspace || provider.id,
        );
        const body: Record<string, any> = {
            model: modelId,
            messages: [{ role: 'user', content: 'ping' }],
            max_tokens: HEALTH_CHECK_MAX_TOKENS,
            stream: true,
            ...thinkingOptions,
        };

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const startedAt = Date.now();
        let settled = false;

        try {
            const response = await client.chat.completions.create(body, { signal: controller.signal }) as any;
            if (!response || typeof response[Symbol.asyncIterator] !== 'function') {
                // 少数网关会忽略 stream=true 直接返回完整响应：同样视为连通
                settled = true;
                return {
                    success: true,
                    status: 'ok',
                    latencyMs: Date.now() - startedAt,
                    model: typeof response?.model === 'string' && response.model.trim() ? response.model.trim() : modelId,
                };
            }
            for await (const chunk of response) {
                settled = true;
                const servedModel = typeof chunk?.model === 'string' && chunk.model.trim()
                    ? chunk.model.trim()
                    : modelId;
                return {
                    success: true,
                    status: 'ok',
                    latencyMs: Date.now() - startedAt,
                    model: servedModel,
                };
            }
            // 网关接受了请求但流里没有任何分片：仍视为连通（模型/配额问题会在真实对话中暴露）
            settled = true;
            return { success: true, status: 'ok', latencyMs: Date.now() - startedAt, model: modelId };
        } catch (error: any) {
            const described = describeError(error);
            return {
                success: false,
                status: described.status,
                httpStatus: described.httpStatus,
                error: described.message,
            };
        } finally {
            clearTimeout(timer);
            // 未拿到首包时中止底层请求，避免网关连接悬挂；成功路径已由迭代器关闭流
            if (!settled) {
                controller.abort();
            }
        }
    }
}

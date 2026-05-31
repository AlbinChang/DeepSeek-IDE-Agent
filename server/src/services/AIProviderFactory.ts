import OpenAI from 'openai';
import type { ModelProviderConfig } from '@/services/SettingsService.js';

/**
 * 对应重构需求：原生 DeepSeek 客户端工厂
 * 移除对 Vercel AI SDK 的依赖，直接使用 OpenAI SDK 调用 DeepSeek
 */
export class AIProviderFactory {
    private static clients: Map<string, OpenAI> = new Map();
    static readonly SYSTEM_PROVIDER = 'deepseek';
    static readonly SYSTEM_MODEL = 'deepseek-reasoner';

    static getFallbackProvider(): ModelProviderConfig {
        const modelId = process.env.DEEPSEEK_MODEL || this.SYSTEM_MODEL;
        return {
            id: this.SYSTEM_PROVIDER,
            name: 'DeepSeek',
            type: 'openai-compatible',
            modelId,
            apiKey: process.env.DEEPSEEK_API_KEY || '',
            baseURL: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com',
            enableThinking: true,
            defaultReasoningEffort: 'high',
        };
    }

    static normalizeProvider(input?: Partial<ModelProviderConfig>): ModelProviderConfig {
        const fallback = this.getFallbackProvider();
        const id = (input?.id || fallback.id).trim().toLowerCase() || fallback.id;
        const modelId = (input?.modelId || fallback.modelId).trim() || fallback.modelId;
        const baseURL = (input?.baseURL || fallback.baseURL || '').trim() || fallback.baseURL;
        return {
            id,
            name: (input?.name || id).trim() || id,
            type: 'openai-compatible',
            modelId,
            apiKey: (input?.apiKey || fallback.apiKey || '').trim(),
            baseURL,
            enableThinking: input?.enableThinking !== false,
            defaultReasoningEffort: input?.defaultReasoningEffort === 'max' ? 'max' : 'high',
        };
    }

    static resolveSelection(
        providers: ModelProviderConfig[] | undefined,
        activeProvider?: string,
        activeModel?: string,
        requestedProvider?: string,
        requestedModel?: string,
    ): { providerConfig: ModelProviderConfig; provider: string; modelId: string } {
        const list = (providers && providers.length > 0 ? providers : [this.getFallbackProvider()])
            .map((p) => this.normalizeProvider(p));

        const requestedProviderId = (requestedProvider || '').trim().toLowerCase();
        const currentActiveId = (activeProvider || '').trim().toLowerCase();

        const pickedProvider = list.find((p) => p.id === requestedProviderId)
            || list.find((p) => p.id === currentActiveId)
            || list[0];

        const modelId = (requestedModel || activeModel || pickedProvider.modelId || '').trim() || pickedProvider.modelId;
        return {
            providerConfig: { ...pickedProvider, modelId },
            provider: pickedProvider.id,
            modelId,
        };
    }

    /**
     * 获取 OpenAI-Compatible 客户端（按 baseURL + apiKey 复用连接）
     */
    static getClient(providerInput?: Partial<ModelProviderConfig>): OpenAI {
        const provider = this.normalizeProvider(providerInput);
        const apiKey = provider.apiKey;
        const baseURL = provider.baseURL || this.getFallbackProvider().baseURL || 'https://api.deepseek.com';

        if (!apiKey) {
            console.warn(`[AIProviderFactory] API key is empty for provider "${provider.id}".`);
        }

        const cacheKey = `${baseURL}::${apiKey}`;
        const cached = this.clients.get(cacheKey);
        if (cached) return cached;

        // 【性能优化】禁用 OpenAI SDK 内置重试（AgentTurnEngine 有独立的指数退避重试逻辑）
        // 双重重试叠加会导致最坏 3×3=9 次 API 调用，严重拖慢恢复速度。
        // 设置合理的超时：首次连接 30s、总请求 600s（流式长连接需要足够长）。
        const client = new OpenAI({
            apiKey: apiKey || 'missing-key',
            baseURL,
            maxRetries: 0,
            timeout: 600_000,            // 10 分钟总超时（流式长连接）
        });
        this.clients.set(cacheKey, client);
        return client;
    }

    static buildThinkingOptions(providerInput?: Partial<ModelProviderConfig>, reasoningEffort?: 'high' | 'max'): Record<string, any> {
        const provider = this.normalizeProvider(providerInput);
        if (provider.enableThinking === false) {
            return {};
        }

        const effort = reasoningEffort === 'max'
            ? 'max'
            : (provider.defaultReasoningEffort === 'max' ? 'max' : 'high');

        return {
            reasoning_effort: effort,
            extra_body: { thinking: { type: 'enabled' } }
        };
    }

    /**
     * 获取支持思考模式的模型 ID
     * 生产环境可能需要覆盖此值 (DEEPSEEK_MODEL)
     */
    static getReasonerModel(): string {
        return process.env.DEEPSEEK_MODEL || this.SYSTEM_MODEL;
    }

    /**
     * 获取当前系统默认模型
     */
    static getSystemDefaultModel(): string {
        return process.env.DEEPSEEK_MODEL || this.SYSTEM_MODEL;
    }

    /**
     * 获取历史压缩模型（强制使用 Reasoner 以保证语义完整性）
     */
    static getCompressorModel(): string {
        return process.env.DEEPSEEK_MODEL || this.SYSTEM_MODEL;
    }

    /**
     * 获取对话补全模型 (优先使用环境变量，默认为 deepseek-reasoner)
     */
    static getChatModel(): string {
        return process.env.DEEPSEEK_MODEL || this.SYSTEM_MODEL;
    }

    /**
     * 代码补全模型 (优先使用环境变量，维持技术栈一致性)
     */
    static getCompletionModel(): string {
        return process.env.DEEPSEEK_MODEL || this.SYSTEM_MODEL;
    }

    /**
     * 全局单点归一化：系统只接受 DeepSeek。模型 ID 优先从环境变量读取。
     * 任意外部传入值都将被忽略，防止前端/缓存绕过锁定策略。
     */
    static normalizeSelection(provider?: string, modelId?: string): { provider: string; modelId: string } {
        const normalizedProvider = this.normalizeProvider({
            id: provider || this.SYSTEM_PROVIDER,
            modelId: modelId || process.env.DEEPSEEK_MODEL || this.SYSTEM_MODEL,
        });
        return {
            provider: normalizedProvider.id,
            modelId: normalizedProvider.modelId,
        };
    }

    /**
     * 统一的模型获取接口，强制锁定 DeepSeek
     */
    static getModel(_provider?: string, _modelId?: string): { provider: string; modelId: string; client: OpenAI } {
        const normalized = this.normalizeSelection(_provider, _modelId);
        const providerConfig = this.normalizeProvider({ id: normalized.provider, modelId: normalized.modelId });
        return { 
            provider: normalized.provider,
            modelId: normalized.modelId,
            client: this.getClient(providerConfig)
        };
    }
}
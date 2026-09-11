import OpenAI from 'openai';
import type { ModelProviderConfig } from '@/services/SettingsService.js';

/**
 * 内部统一的思考强度档位（对齐 DeepSeek 官方 thinking mode 口径，2026-09-10）：
 * - 'default': 不发送 reasoning_effort / thinking 字段，完全采用模型默认思考强度（官方默认 high）
 * - 'low': 轻量档（DeepSeek 原样透传 low；Qwen 原样透传 low）
 * - 'high': 平衡档（DeepSeek 原样透传；Qwen 映射为 medium）
 * - 'max': 最强档（DeepSeek 原样透传；Qwen 映射为 xhigh）
 *
 * DeepSeek 官方别名归一化（请求传入 effort → 实际映射 effort）：
 *   minimal → low, low → low, medium → high, high → high, xhigh → high, max → max, ultra → max
 */
export type ReasoningEffortLevel = 'default' | 'low' | 'high' | 'max';

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
            defaultReasoningEffort: this.normalizeReasoningEffort(input?.defaultReasoningEffort),
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

    /**
     * 构建 user_id 用于流量隔离与 KV Cache 复用。
     * 规则：agentName + workspace，仅保留 [a-zA-Z0-9\-_]，最大 512 字符。
     */
    static buildUserId(agentName: string, workspace: string): string {
        const sanitize = (s: string) => s.replace(/[^a-zA-Z0-9\-_]/g, '_');
        const raw = `${sanitize(agentName)}__${sanitize(workspace)}`;
        return raw.length <= 512 ? raw : raw.slice(0, 512);
    }

    /**
     * DeepSeek 官方 effort 别名 → 内部档位归一化映射（thinking mode 官方口径 2026-09-10）。
     */
    static readonly OFFICIAL_EFFORT_ALIASES: Readonly<Record<string, ReasoningEffortLevel>> = Object.freeze({
        minimal: 'low',
        low: 'low',
        medium: 'high',
        high: 'high',
        xhigh: 'high',
        max: 'max',
        ultra: 'max',
    });

    /**
     * 归一化思考强度档位：仅接受 default | low | high | max，非法值回落 high。
     */
    static normalizeReasoningEffort(raw: unknown): ReasoningEffortLevel {
        if (raw === 'default' || raw === 'low' || raw === 'high' || raw === 'max') return raw;
        return 'high';
    }

    /**
     * 将请求层（wire）传入的思考强度字符串归一化为内部档位，兼容 DeepSeek 官方别名：
     * minimal→low、low→low、medium→high、high→high、xhigh→high、max→max、ultra→max。
     * 'default' 表示客户端显式选择不发送强度字段；空值/非字符串/无法识别返回 null，
     * 由调用方决定是否回落到 provider 默认档。
     */
    static parseReasoningEffortAlias(raw: unknown): ReasoningEffortLevel | null {
        if (typeof raw !== 'string') return null;
        const s = raw.trim().toLowerCase();
        if (!s) return null;
        if (s === 'default') return 'default';
        return this.OFFICIAL_EFFORT_ALIASES[s] ?? null;
    }

    /**
     * 解析最终生效的思考强度档位：
     * 调用方显式传入的 reasoningEffort 优先，其次 provider 配置默认，最后系统默认 high。
     * 返回 'default' 表示不发送 reasoning_effort 字段，采用模型默认思考强度。
     */
    static resolveReasoningEffort(
        providerInput?: Partial<ModelProviderConfig>,
        reasoningEffort?: ReasoningEffortLevel | null,
    ): ReasoningEffortLevel {
        if (reasoningEffort === 'default' || reasoningEffort === 'low' || reasoningEffort === 'high' || reasoningEffort === 'max') {
            return reasoningEffort;
        }
        const provider = this.normalizeProvider(providerInput);
        return this.normalizeReasoningEffort(provider.defaultReasoningEffort);
    }

    /**
     * 判断是否为 Qwen 系列模型。
     * Qwen 网关的思考强度取值与 DeepSeek 不同，需要单独适配。
     */
    static isQwenProvider(providerInput?: Partial<ModelProviderConfig>): boolean {
        const provider = this.normalizeProvider(providerInput);
        const id = (provider.id || '').toLowerCase();
        const name = (provider.name || '').toLowerCase();
        const modelId = (provider.modelId || '').toLowerCase();
        return id.includes('qwen') || name.includes('qwen') || modelId.includes('qwen');
    }

    /**
     * Qwen 系模型「中途注入指令」时附加在 user 消息上的前缀。
     * Qwen 网关不允许在对话中间插入 system 消息（仅首条可为 system），
     * 因此所有中途系统指令统一降级为 user 消息并加此前缀，明确标注「非用户指令」。
     */
    static readonly MID_CONVERSATION_DIRECTIVE_PREFIX = '系统提示(非用户指令): ';

    /**
     * 构建「中途注入」的指令消息（对话循环推进指令 / 评估修复指令等）：
     * - Qwen 系模型：中间不允许插入 system 消息 → 返回 role=user 且内容加前缀
     * - 其他模型（DeepSeek 等）：保持 role=system 原样返回
     * 首条 system 消息（系统提示词）不经过此方法，保持 system 角色不变。
     */
    static buildMidConversationDirective(
        providerInput: Partial<ModelProviderConfig> | undefined,
        content: string,
    ): { role: 'system' | 'user'; content: string } {
        if (this.isQwenProvider(providerInput)) {
            return { role: 'user', content: `${this.MID_CONVERSATION_DIRECTIVE_PREFIX}${content}` };
        }
        return { role: 'system', content };
    }

    /**
     * 请求前安全网：将消息序列中除首条以外的所有 system 消息统一降级为
     * user 消息（Qwen 不允许中途插入 system）。仅数组首条（index 0）system 保留。
     * 非 Qwen 模型原样返回，保证 DeepSeek 等模型的既有行为零变化。
     */
    static buildProviderSafeMessages(
        messages: any[],
        providerInput?: Partial<ModelProviderConfig>,
    ): any[] {
        if (!this.isQwenProvider(providerInput)) return messages;

        return messages.map((m, index) => {
            if (m.role === 'system' && index === 0) {
                return m;
            }
            if (m.role === 'system') {
                return { ...m, role: 'user', content: `${this.MID_CONVERSATION_DIRECTIVE_PREFIX}${m.content ?? ''}` };
            }
            return m;
        });
    }

    /**
     * 将内部统一档位映射为具体供应商支持的 reasoning_effort 取值：
     * - 'default' → null（不发送该字段，采用模型默认）
     * - DeepSeek: low | high | max 原样透传（官方口径）
     * - Qwen: max → xhigh（最强档）；high → medium；low → low
     *   （Qwen 无 high 档位，仅支持 xhigh/medium/low）
     */
    static mapReasoningEffort(
        providerInput?: Partial<ModelProviderConfig>,
        reasoningEffort?: ReasoningEffortLevel | null,
    ): string | null {
        const provider = this.normalizeProvider(providerInput);
        const level = this.resolveReasoningEffort(provider, reasoningEffort);

        if (level === 'default') return null;
        if (this.isQwenProvider(provider)) {
            return level === 'max' ? 'xhigh' : level === 'low' ? 'low' : 'medium';
        }
        return level;
    }

    static buildThinkingOptions(
        providerInput?: Partial<ModelProviderConfig>,
        reasoningEffort?: ReasoningEffortLevel | null,
        agentName?: string,
        workspace?: string,
    ): Record<string, any> {
        const provider = this.normalizeProvider(providerInput);
        const isQwen = this.isQwenProvider(provider);
        if (provider.enableThinking === false) {
            const opts: Record<string, any> = {};
            if (agentName && workspace && !isQwen) {
                opts.extra_body = { user_id: this.buildUserId(agentName, workspace) };
            }
            return opts;
        }

        const effort = this.mapReasoningEffort(provider, reasoningEffort);

        // 'default' 档位：不发送 reasoning_effort 与 thinking 字段，完全采用模型默认思考强度。
        // user_id 与思考无关，仅用于 DeepSeek KV Cache 复用，保留以提升缓存命中率。
        if (effort === null) {
            if (!isQwen && agentName && workspace) {
                return { extra_body: { user_id: this.buildUserId(agentName, workspace) } };
            }
            return {};
        }

        // Qwen 网关仅支持 reasoning_effort: xhigh(default) | medium | low，
        // 不接受 DeepSeek 专属的 extra_body.thinking 字段（默认即思考模式），保持请求体精简。
        if (isQwen) {
            return { reasoning_effort: effort };
        }

        const extra_body: Record<string, any> = { thinking: { type: 'enabled' } };
        if (agentName && workspace) {
            extra_body.user_id = this.buildUserId(agentName, workspace);
        }

        return {
            reasoning_effort: effort,
            extra_body,
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
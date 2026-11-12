import { AIProviderFactory } from "@/services/AIProviderFactory.js";
import { SettingsService } from "@/services/SettingsService.js";
import { extractReasoningText } from "../utils/ReasoningUtils.js";
import { withApiRetry } from "@/utils/ApiRetryUtils.js";
import { config as globalConfig } from "@/config/index.js";
import { findControlToken, probeLeadingContent } from "@/services/ModelOutputGuard.js";

/** 补全流同样先缓冲前缀，避免把拆包的控制标记直接插入编辑器。 */
const COMPLETION_PREFIX_PROBE_CHARS = 32;

export class CompletionService {
    private static userRateLimits: Map<string, { count: number, resetTime: number }> = new Map();
    private static readonly MAX_COMPLETIONS_PER_MINUTE = 60;

    private static checkRateLimit(userId: string) {
        const now = Date.now();
        const limit = this.userRateLimits.get(userId) || { count: 0, resetTime: now + 60000 };
        if (now > limit.resetTime) {
            limit.count = 0;
            limit.resetTime = now + 60000;
        }
        if (limit.count >= this.MAX_COMPLETIONS_PER_MINUTE) {
            throw new Error(`[Quota] Completion rate limited for ${userId}. Please slow down.`);
        }
        limit.count++;
        this.userRateLimits.set(userId, limit);
    }

    static async streamCompletion(params: {
        workspaceRoot: string,
        userId: string,
        prefix: string,
        suffix: string,
        filePath?: string
    }) {
        this.checkRateLimit(params.userId);
        const settings = await SettingsService.getSettings(params.workspaceRoot, params.userId);
        const selected = AIProviderFactory.resolveSelection(
            settings.providers,
            settings.activeProvider,
            settings.activeModel,
        );
        const client = AIProviderFactory.getClient(selected.providerConfig);
        const modelId = selected.modelId;
        const thinkingOptions = AIProviderFactory.buildThinkingOptions(
            selected.providerConfig,
            selected.providerConfig.defaultReasoningEffort,
            'completion',
            params.workspaceRoot,
        );
        
        // 统一使用简化补全提示，兼容不同 OpenAI-Compatible 模型
        const prompt = `Complete the following code:\n\n${params.prefix}[CURSOR]${params.suffix}`;
        let systemPrompt = `You are an AI code completion engine. Output ONLY the completion text after [CURSOR]. Do not include any explanations or the original code.`;

        const stream = await withApiRetry(
            () => client.chat.completions.create({
                model: modelId,
                messages: [
                    { role: "system", content: systemPrompt },
                    { role: "user", content: prompt }
                ],
                max_tokens: 300,
                stream: true,
                ...thinkingOptions
                // 避免注入不稳定采样参数，提升跨模型兼容性
            } as any) as any,
            {
                retries: globalConfig.agent.apiRetryLimit,
                serviceBusyRetries: globalConfig.agent.apiServiceBusyRetryLimit,
                onRetry: ({ attempt, maxAttempts, verdict, delayMs }) => {
                    console.warn(`[CompletionService] 补全请求遇 ${verdict.reason}，第 ${attempt}/${maxAttempts} 次重试（${delayMs}ms 后）...`);
                },
            }
        );

        return CompletionService.guardCompletionStream(stream);
    }

    /**
     * 补全结果守卫：模型把 BOS/EOS 等控制标记当正文输出时，整条补全直接丢弃，
     * 不把垃圾文本送进编辑器（与对话侧的 ModelOutputGuard 同一判定规则）。
     */
    private static async *guardCompletionStream(stream: any) {
        if (!globalConfig.agent.modelOutputGuard) {
            yield* stream;
            return;
        }
        let pendingPrefix = "";
        let prefixConfirmed = false;
        for await (const chunk of stream) {
            const delta = chunk?.choices?.[0]?.delta;
            const text = typeof delta?.content === "string" ? delta.content : "";
            if (!text) {
                yield chunk;
                continue;
            }
            if (prefixConfirmed) {
                yield chunk;
                continue;
            }
            pendingPrefix += text;
            const probe = probeLeadingContent(pendingPrefix);
            if (probe.state === "suspect") {
                console.warn(`[CompletionService] 补全返回了 ${probe.hit.token} 控制标记，已丢弃本次补全`);
                return;
            }
            if (probe.state === "clean" || pendingPrefix.length >= COMPLETION_PREFIX_PROBE_CHARS) {
                prefixConfirmed = true;
                yield {
                    ...chunk,
                    choices: [{ ...chunk.choices[0], delta: { ...delta, content: pendingPrefix } }],
                };
                pendingPrefix = "";
            }
        }
        if (!prefixConfirmed && pendingPrefix) {
            const probe = probeLeadingContent(pendingPrefix);
            if (probe.state === "suspect") {
                console.warn(`[CompletionService] 补全返回了 ${probe.hit.token} 控制标记，已丢弃本次补全`);
                return;
            }
            yield { choices: [{ index: 0, delta: { content: pendingPrefix } }] } as any;
        }
    }

    static async getCompletion(params: any) {
        this.checkRateLimit(params.userId);
        const settings = await SettingsService.getSettings(params.workspaceRoot, params.userId);
        const selected = AIProviderFactory.resolveSelection(
            settings.providers,
            settings.activeProvider,
            settings.activeModel,
        );
        const client = AIProviderFactory.getClient(selected.providerConfig);
        const modelId = selected.modelId;
        const thinkingOptions = AIProviderFactory.buildThinkingOptions(
            selected.providerConfig,
            selected.providerConfig.defaultReasoningEffort,
            'completion',
            params.workspaceRoot,
        );
        // 统一使用简化补全提示，兼容不同 OpenAI-Compatible 模型
        const prompt = `Complete the following code:\n\n${params.prefix}[CURSOR]${params.suffix}`;
        const response = await withApiRetry(
            () => client.chat.completions.create({
                model: modelId,
                messages: [{ role: "user", content: prompt }],
                max_tokens: 300,
                ...thinkingOptions
                // 避免注入不稳定采样参数，提升跨模型兼容性
            } as any),
            {
                retries: globalConfig.agent.apiRetryLimit,
                serviceBusyRetries: globalConfig.agent.apiServiceBusyRetryLimit,
                onRetry: ({ attempt, maxAttempts, verdict, delayMs }) => {
                    console.warn(`[CompletionService] 补全请求遇 ${verdict.reason}，第 ${attempt}/${maxAttempts} 次重试（${delayMs}ms 后）...`);
                },
            }
        );
        const message = response.choices[0]?.message;
        const text = message?.content || extractReasoningText(message) || "";
        if (globalConfig.agent.modelOutputGuard) {
            const hit = findControlToken(text);
            if (hit) {
                console.warn(`[CompletionService] 补全返回了 ${hit.token} 控制标记，已丢弃本次补全`);
                return "";
            }
        }
        return text;
    }
}

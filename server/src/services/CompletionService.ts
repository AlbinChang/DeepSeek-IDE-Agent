import { AIProviderFactory } from "@/services/AIProviderFactory.js";
import { SettingsService } from "@/services/SettingsService.js";
import { extractReasoningText } from "../utils/ReasoningUtils.js";

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

        const stream = await client.chat.completions.create({
            model: modelId,
            messages: [
                { role: "system", content: systemPrompt },
                { role: "user", content: prompt }
            ],
            max_tokens: 300,
            stream: true,
            ...thinkingOptions
            // 避免注入不稳定采样参数，提升跨模型兼容性
        } as any) as any;

        return stream;
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
        const response = await client.chat.completions.create({
            model: modelId,
            messages: [{ role: "user", content: prompt }],
            max_tokens: 300,
            ...thinkingOptions
            // 避免注入不稳定采样参数，提升跨模型兼容性
        } as any);
        const message = response.choices[0]?.message;
        return message?.content || extractReasoningText(message) || "";
    }
}

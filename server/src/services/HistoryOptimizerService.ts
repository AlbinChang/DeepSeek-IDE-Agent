import { AIProviderFactory } from "@/services/AIProviderFactory.js";
import { LiveContextStore } from "@/services/LiveContextStore.js";
import { SettingsService } from "@/services/SettingsService.js";
import { FileIO } from "@/utils/FileIO.js";
import { HistoryCompressor } from "@/services/HistoryCompressor.js";
import { withApiRetry } from "@/utils/ApiRetryUtils.js";
import { config as globalConfig } from "@/config/index.js";
import { extractReasoningText } from "../utils/ReasoningUtils.js";

/**
 * 历史会话优化服务（原 SubAgentService）
 *
 * 实际职责：历史消息裁剪、reasoning_content 清洗、超长上下文压缩。
 * 当前架构为主 Agent + 评估 Agent 双核引擎循环，此服务为二者的共享历史管理层，
 * 并非独立的智能子代理。
 */
export class HistoryOptimizerService {
    private static instance: HistoryOptimizerService;
    private contextStore = LiveContextStore.getInstance();

    private constructor() {}

    public static getInstance(): HistoryOptimizerService {
        if (!HistoryOptimizerService.instance) {
            HistoryOptimizerService.instance = new HistoryOptimizerService();
        }
        return HistoryOptimizerService.instance;
    }

    private async resolveSelectionForUser(userId: string, workspaceRoot?: string) {
        const liveCtx = this.contextStore.getContext(userId, workspaceRoot);
        const resolvedWorkspaceRoot = workspaceRoot || liveCtx?.workspaceRoot || "";
        const preferredModelId = liveCtx?.modelId || undefined;

        if (!resolvedWorkspaceRoot) {
            return AIProviderFactory.resolveSelection(undefined, undefined, undefined, undefined, preferredModelId);
        }

        const settings = await SettingsService.getSettings(resolvedWorkspaceRoot, userId);
        return AIProviderFactory.resolveSelection(
            settings.providers,
            settings.activeProvider,
            settings.activeModel,
            undefined,
            preferredModelId,
        );
    }

    public async optimizeHistory(messages: any[], userId: string, workspaceRoot?: string): Promise<{ messages: any[] }> {
        
        
        const processed = messages; // 先不清理 reasoning_content，直接进入压缩逻辑，确保不丢失重要上下文
        
        console.log(`[HistoryOptimizer] Optimizing history for user ${userId}. Initial messages: ${messages.length}, Cleaned messages: ${processed.length}`);
        
        if ( processed.length > 4) {
            
            //先进简单过滤：删除所有工具调用消息，只保留用户消息和助手的最终回答消息
            let filtered = processed.filter(m => m.role === "user" || (m.role === "assistant" && !m.tool_calls));
            
            //二次检查过滤后的消息是否仍然过长，如果是则进行压缩
            const filteredTokens = HistoryCompressor.estimateTokens(filtered);
            if( filteredTokens > 96000 || filtered.length > 4 ) {
                
                //返回最近的4条件用户消息和助手消息，确保不丢失重要的上下文，同时压缩历史以适应模型输入限制
                const recentMessages = filtered.slice(-4);
                
                // 压缩后的历史也需要清理 reasoning_content
                return {
                    messages: recentMessages
                };
            }
            else{
                return { messages: filtered };
            }
            
        }
        return { messages: processed};
    }

    /**
     * 清理历史记录中的 reasoning_content。
     * 遵循 DeepSeek 指南：在新一轮对话开始时，不要将旧的 reasoning_content 发送给模型。
     */
    public cleanHistory(messages: any[]): any[] {
        return messages.map((msg, index) => {
            const newMsg = { ...msg };
            if (newMsg.role === "assistant") {
                // 确保 reasoning_content 字段存在但清空，以符合 DeepSeek 的规范要求                
                newMsg.reasoning_content = ""; 
                
                // 确保内容字段合规
                if (newMsg.content === undefined || newMsg.content === null) {
                    newMsg.content = "";
                }
            }
            return newMsg;
        });
    }

    public async analyzeAndFix(filePath: string, context: any, sessionUsage: Map<string, number>) {
        const userId = context?.userId || "system";
        const liveCtx = this.contextStore.getContext(userId, context?.workspaceRoot);
        const root = context?.workspaceRoot || liveCtx?.workspaceRoot || "";
        const selected = await this.resolveSelectionForUser(userId, root);
        const modelId = selected.modelId;
        
        // 此逻辑旨在简化 AI 系统复杂性，直接通过文件读取获取内容后进行深度语义分析，降低资源占用
        const content = await FileIO.readFile(filePath, root);
        const prompt = `[Analyze and Fix]: ${filePath}\nContent: \n${content}\n\nPlease identify potential issues and output ONLY complete fixed file content. No blocks.`;
        
        const client = AIProviderFactory.getClient(selected.providerConfig);
        const thinkingOptions = AIProviderFactory.buildThinkingOptions(
            selected.providerConfig,
            selected.providerConfig.defaultReasoningEffort,
            'history-optimizer',
            root,
        );
        const response = await withApiRetry(
            () => client.chat.completions.create({
                model: modelId,
                messages: [{ role: "user", content: prompt }],
                ...thinkingOptions
            } as any),
            {
                retries: globalConfig.agent.apiRetryLimit,
                serviceBusyRetries: globalConfig.agent.apiServiceBusyRetryLimit,
                onRetry: ({ attempt, maxAttempts, verdict, delayMs }) => {
                    console.warn(`[HistoryOptimizer] 历史修复请求遇 ${verdict.reason}，第 ${attempt}/${maxAttempts} 次重试（${delayMs}ms 后）...`);
                },
            }
        );
        const message = response.choices[0]?.message;
        const text = message?.content || extractReasoningText(message) || "";
        sessionUsage.set(userId, (sessionUsage.get(userId) || 0) + response.usage!.total_tokens);
        return { status: "success", fixedContent: text, tokensUsed: response.usage!.total_tokens };
    }
}

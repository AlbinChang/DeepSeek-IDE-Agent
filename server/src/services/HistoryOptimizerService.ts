/**
 * 历史会话优化服务（原 SubAgentService）
 *
 * 实际职责：历史消息裁剪、超长上下文压缩。
 * 【原封不动原则】reasoning_content 不做任何加工（不增、不删、不改）：
 * DeepSeek thinking mode（2026-09-10 口径）要求携带 tools 参数的请求，历史中
 * 每一轮 assistant 消息都必须完整回传推理内容（与是否实际工具调用无关）。
 * 当前架构为主 Agent + 评估 Agent 双核引擎循环，此服务为二者的共享历史管理层，
 * 并非独立的智能子代理。
 */
export class HistoryOptimizerService {
    private static instance: HistoryOptimizerService;

    private constructor() {}

    public static getInstance(): HistoryOptimizerService {
        if (!HistoryOptimizerService.instance) {
            HistoryOptimizerService.instance = new HistoryOptimizerService();
        }
        return HistoryOptimizerService.instance;
    }

    public async optimizeHistory(messages: any[], userId: string, workspaceRoot?: string): Promise<{ messages: any[] }> {
        
        
        const processed = messages; // 先不清理 reasoning_content，直接进入压缩逻辑，确保不丢失重要上下文
        
        console.log(`[HistoryOptimizer] Optimizing history for user ${userId}. Initial messages: ${messages.length}, Cleaned messages: ${processed.length}`);
        
        if ( processed.length > 4) {
            
            //先进简单过滤：删除所有工具调用消息，只保留用户消息和助手的最终回答消息
            let filtered = processed.filter(m => m.role === "user" || (m.role === "assistant" && !m.tool_calls));
            
            
            if(  filtered.length > 10 ) {
                
                //返回最近的10条用户消息和助手消息，确保不丢失重要的上下文，同时压缩历史以适应模型输入限制
                const recentMessages = filtered.slice(-10);
                
                // 注意：reasoning_content 原样保留（不增、不删、不改），由 MessagePreparationService 逐字透传
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
}

import * as crypto from "node:crypto";
import { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import { AgentService } from "@/services/AgentService.js";
import { AgentChatComponent } from "@/services/AgentChatComponent.js";
import { AIProviderFactory } from "@/services/AIProviderFactory.js";
import { EventDistributor } from "@/services/EventDistributor.js";
import { SettingsService } from "@/services/SettingsService.js";

/**
 * Agent SSE 事件类型定义
 * init: 初始化连接，携带模型信息和 traceId
 * stage: 阶段性状态更新（如：正在运行终端命令、正在搜索文件等）
 * reasoning: 推理内容流（针对 DeepSeek Reasoner 等支持思考过程的模型）
 * text: 最终回答文本内容流
 * annotation: 结构化标注（如：文件修改预览、代码块元数据等）
 * progress: 后端已接收的大模型输出字符计数（不包含具体文本内容）
 * error: 错误信息
 * done: 传输完成标志
 * heartbeat: 保持连接活跃的心跳包
 */
export type AgentSSEEvent = "init" | "stage" | "reasoning" | "text" | "annotation" | "progress" | "error" | "done" | "heartbeat";

export interface AgentSSEPayload {
    type: AgentSSEEvent;
    content?: string;
    traceId?: string;
    model?: string;
    method?: string;
    params?: any;
    channel?: "content" | "reasoning" | "tool_arguments" | "complete";
    receivedChars?: number;
    contentChars?: number;
    reasoningChars?: number;
    toolArgumentChars?: number;
    deltaChars?: number;
    toolName?: string;
    turn?: number;
    timestamp: number;
    isFinal?: boolean;
}

/**
 * 设置 Agent Chat SSE 路由
 * 实现了基于 SSE (Server-Sent Events) 的流式协议，取代传统的 WebSocket 以获得更好的 HTTP 集成和更简单的错误处理。
 */
export async function setupChatSSE(fastify: FastifyInstance, agentService: AgentService) {
    // 追踪每个用户的活跃请求，用于支持客户端中断 (Cancellation Support)
    const activeRequests = new Map<string, AbortController>();

    fastify.post("/api/chat/sse", async (req: FastifyRequest, reply: FastifyReply) => {
        const { userId, userInstruct, traceId, locale, root, reasoningEffort, provider, model } = req.body as any;
        
        // 1. 参数校验：强制要求 TraceID 由前端生成并传递
        if (!userId || !userInstruct || !traceId) {
            console.error(`[SSE][Error] Missing required params for request (userId: ${userId}, traceId: ${traceId})`);
            return reply.status(400).send({ 
                error: "userId, userInstruct and traceId are required",
                code: "MISSING_PARAMS",
                timestamp: Date.now()
            });
        }

        // 2026.04: 思考强度归一化 —— 仅接受 high | max，其他一律回落到 high
        // 对齐 DeepSeek 官方兼容性：low/medium → high；xhigh → max
        const normalizeEffort = (v: any): 'high' | 'max' => {
            if (typeof v !== 'string') return 'high';
            const s = v.toLowerCase();
            if (s === 'max' || s === 'xhigh') return 'max';
            return 'high';
        };
        const effectiveReasoningEffort = normalizeEffort(reasoningEffort);

        // 【缓存策略】后端生成 request_id 作为系统提示词缓存的 key
        // request_id ≠ traceId：traceId 由前端生成用于全链路追踪，requestId 由后端生成用于对话级缓存
        const requestId = crypto.randomUUID();
        console.log(`[SSE][Info] Generated requestId: ${requestId} for user ${userId}, traceId: ${traceId}`);

        const effectiveTraceId = traceId;
        const requestedWorkspaceRoot = typeof root === 'string' && root.trim() ? root.trim() : undefined;
        const workspaceRootForRequest = requestedWorkspaceRoot || agentService.getWorkspaceRoot(userId);
        const requestKey = workspaceRootForRequest ? agentService.getIsolationKey(userId, workspaceRootForRequest) : userId;
        
        // 2. 自动初始化工作空间（如果未加载）
        if (requestedWorkspaceRoot && !agentService.getWorkspaceRoot(userId)) {
            try {
                await agentService.initializeWorkspace(userId, requestedWorkspaceRoot);
            } catch (initErr: any) {
                console.error(`[SSE][Error] Workspace init failed for ${userId}:`, initErr);
                return reply.status(500).send({ 
                    error: `Failed to initialize workspace: ${initErr.message}`,
                    code: "WORKSPACE_INIT_FAILED"
                });
            }
        }

        // 3. 配置 SSE 响应头 (Industrial Grade - RFC 8895)
        reply.raw.setHeader("Content-Type", "text/event-stream; charset=utf-8");
        reply.raw.setHeader("Cache-Control", "no-cache, no-transform, no-store, must-revalidate");
        reply.raw.setHeader("Pragma", "no-cache");
        reply.raw.setHeader("Expires", "0");
        reply.raw.setHeader("Connection", "keep-alive");
        reply.raw.setHeader("X-Accel-Buffering", "no"); // 禁用 Nginx 缓冲以实现真正的流式
        reply.raw.setHeader("Access-Control-Allow-Origin", "*");
        reply.raw.setHeader("Transfer-Encoding", "chunked");

        let isClosed = false;
        let messageIdCounter = 0;
        
        // 标准化的消息发送函数 (符合 43.1 节规范与 DeepSeek V3.2 响应要求)
        const sendEvent = (data: AgentSSEPayload) => {
            if (isClosed) return;
            try {
                messageIdCounter++;
                const sseId = `${effectiveTraceId}-${Date.now()}-${messageIdCounter}`;
                // 增加 retry 字段引导客户端在网络抖动时自动重新连接
                // 标准 SSE 格式: retry: 3000\nid: <ts>\nevent: message\ndata: json\n\n
                const payload = `retry: 3000\nid: ${sseId}\nevent: message\ndata: ${JSON.stringify({ ...data, sseId })}\n\n`;
                reply.raw.write(payload);
            } catch (e) {
                console.error(`[SSE][Error] Write failed for user ${userId}, traceId ${effectiveTraceId}:`, e);
                isClosed = true;
            }
        };

        // 核心定时心跳 (Keep-alive) 优化
        // 频率调整为 15秒一次，既能保活又不过度消耗带宽
        const heartbeatInterval = 15000; 
        const heartbeat = setInterval(() => {
            if (!isClosed) {
                try {
                    // [2026.04] 发送真实的 heartbeat 事件，防止中间反向代理（如 Nginx）因为长时间无真正的 data 数据流而强制断开连接
                    sendEvent({
                        type: "heartbeat",
                        timestamp: Date.now()
                    });
                } catch (e) {
                    clearInterval(heartbeat);
                    isClosed = true;
                }
            } else {
                clearInterval(heartbeat);
            }
        }, heartbeatInterval);

        // 4. 并发与中断控制 (Single Session Integrity)
        const abortController = new AbortController();

        // [2026.04.05] 桥接 EventDistributor 的系统级进度事件 (如 run_powershell_command / run_cmd_command 的进度)
        // 使通过 WebSocket 广播的后端状态能正确地分发到 SSE 通道中，防止前端死等导致卡住错觉。
        const onSysMessage = (payload: any) => {
            if (isClosed) return;
            if (payload?.workspaceRoot && workspaceRootForRequest && payload.workspaceRoot !== workspaceRootForRequest) return;
            if (payload && payload.type === 'stage') {
                sendEvent({
                    type: "stage",
                    content: payload.content,
                    traceId: effectiveTraceId,
                    timestamp: Date.now()
                });
            }
        };
            EventDistributor.subscribeSysMessage(userId, onSysMessage, workspaceRootForRequest);
        
        // 检查并终止同一用户同一工作区的前序活跃请求，避免跨工作区互相中断
        const existingController = activeRequests.get(requestKey);
        if (existingController) {
            console.warn(`[SSE][Concurrency] Aborting previous request for ${requestKey} to start new one.`);
            existingController.abort();
        }
        activeRequests.set(requestKey, abortController);

        // 5. 连接生命周期管理
        const cleanup = () => {
            clearInterval(heartbeat);
                EventDistributor.unsubscribeSysMessage(userId, onSysMessage, workspaceRootForRequest);
            if (activeRequests.get(requestKey) === abortController) {
                activeRequests.delete(requestKey);
            }
            // 【缓存清理】连接断开时清除该对话的系统提示词缓存
            agentService.clearSystemPromptCache(requestId);
            if (!isClosed) {
                isClosed = true;
                reply.raw.end();
            }
        };

        req.raw.on("close", () => { 
            if (!isClosed) {
                console.log(`[SSE][Info] Client connection closed for user ${userId}, traceId ${effectiveTraceId}`);
                abortController.abort(); 
                cleanup();
            }
        });

        req.raw.on("error", (err: Error) => {
            console.error(`[SSE][Error] Request error for user ${userId}, traceId ${effectiveTraceId}:`, err);
            abortController.abort();
            cleanup();
        });

        // 6. 核心业务执行
        try {
            const workspaceRoot = workspaceRootForRequest;
            const settings = workspaceRoot
                ? await SettingsService.getSettings(workspaceRoot, userId)
                : SettingsService.getDefaultSettings();
            const resolved = AIProviderFactory.resolveSelection(
                settings.providers,
                settings.activeProvider,
                settings.activeModel,
                provider,
                model,
            );
            
            // 发送初始化消息
            sendEvent({ 
                type: "init", 
                traceId: effectiveTraceId, 
                model: resolved.modelId,
                timestamp: Date.now()
            });
            
            // 启动定时心跳由 cleanup 管理，移除旧的 setInterval 逻辑
            
            try {
                const modelId = resolved.modelId;
                const chatComponent = AgentChatComponent.getInstance();

                await chatComponent.handleChat(
                    agentService, 
                    userId, 
                    resolved.provider,
                    modelId,
                    Array.isArray(userInstruct) ? userInstruct : [{ role: "user", content: userInstruct }],
                    effectiveTraceId, 
                    locale || "zh-CN", 
                    abortController.signal,
                    (chunk: any) => { 
                        if (!isClosed) {
                            sendEvent({
                                ...chunk,
                                traceId: effectiveTraceId // 确保 traceId 始终存在
                            }); 
                        }
                    },
                    effectiveReasoningEffort,
                    resolved.providerConfig,
                    workspaceRoot,
                    requestId,
                );
            } finally {
                // Heartbeat 已由统一的 cleanup 和 setInterval 定义，此处无需清理
            }

            // 发送完成标志
            if (!isClosed) {
                sendEvent({ 
                    type: "done", 
                    content: "Processing complete", 
                    traceId: effectiveTraceId, 
                    timestamp: Date.now(), 
                    isFinal: true 
                });
            }
        } catch (error: any) {
            // 统一错误捕获：区分用户主动取消和系统异常
            if (error.name === "AbortError" || abortController.signal.aborted) {
                console.log(`[SSE][Info] Chat aborted for user ${userId}, traceId ${effectiveTraceId}`);
            } else {
                console.error(`[SSE][Fatal] Chat stream execution failed for user ${userId}:`, error);
                if (!isClosed) {
                    sendEvent({ 
                        type: "error", 
                        content: error.message || "An unexpected error occurred during message generation.",
                        timestamp: Date.now(),
                        isFinal: true
                    });
                }
            }
        } finally {
            cleanup();
        }
    });

    /**
     * 强行停止指定用户的活跃对话
     */
    fastify.post("/api/chat/stop", async (req: FastifyRequest, reply: FastifyReply) => {
        const { userId, workspaceRoot, root } = req.body as any;
        const requestedRoot = typeof workspaceRoot === 'string' && workspaceRoot.trim()
            ? workspaceRoot.trim()
            : (typeof root === 'string' && root.trim() ? root.trim() : undefined);
        const requestKey = requestedRoot ? agentService.getIsolationKey(userId, requestedRoot) : userId;
        const controller = activeRequests.get(requestKey);
        if (controller) {
            console.log(`[SSE][Action] Manually stopping chat for ${requestKey}`);
            controller.abort();
            activeRequests.delete(requestKey);
            return reply.send({ success: true, message: "Active stream terminated." });
        }
        return reply.status(404).send({ error: "No active stream found for this user." });
    });

    /**
     * 清理会话历史
     */
    fastify.post("/api/chat/clear", async (req: FastifyRequest, reply: FastifyReply) => {
        const { userId, workspaceRoot } = req.body as any;
        if (!userId) return reply.status(400).send({ error: "userId is required" });
        
        console.log(`[SSE][Action] Clearing history for user ${userId} in ${workspaceRoot}`);
        agentService.clearSessionHistory(userId, workspaceRoot);
        AgentChatComponent.getInstance().clearSession(userId, workspaceRoot);
        return reply.send({ success: true, message: "History cleared." });
    });
}

import { AgentService } from "@/services/AgentService.js";
import { AIProviderFactory } from "@/services/AIProviderFactory.js";
import type { ModelProviderConfig } from "@/services/SettingsService.js";
import { HistoryOptimizerService } from "@/services/HistoryOptimizerService.js";
import { TodoService } from "@/services/TodoService.js";
import { TelemetryService } from "@/services/TelemetryService.js";
import { AgentTurnEngine } from "@/services/AgentTurnEngine.js";
import { EvaluationAgentService } from "@/services/EvaluationAgentService.js";
import { MessagePreparationService } from "@/services/MessagePreparationService.js";
import { config as globalConfig } from "@/config/index.js";
import { getBeijingLogTimePrefix } from "@/utils/TimeUtils.js";

const getTS = () => getBeijingLogTimePrefix();

export class AgentChatComponent {
    private static instance: AgentChatComponent;

    public static getInstance(): AgentChatComponent {
        if (!this.instance) {
            this.instance = new AgentChatComponent();
        }
        return this.instance;
    }

    public clearSession(userId: string, workspaceRoot?: string) {
        const agentService = AgentService.getInstance();
        const root = workspaceRoot || agentService.getWorkspaceRoot(userId);
        agentService.clearSessionHistory(userId, root);
        if (root) {
            console.log(`${getTS()} [AgentChat] Clearing session history for user: ${userId} in workspace: ${root}`);
            TodoService.clearAllTodos(root, userId).catch(() => {});
            agentService.contextStore.updateContext(userId, { currentFile: null, selection: null, workspaceRoot: root }, root);
        }
        console.log(`${getTS()} [AgentChat] Session cleared for user: ${userId}`);
    }

    async handleChat(
        agentService: AgentService,
        userId: string, 
        providerId: string,
        modelId: string,
        userInstruct: any[], 
        traceId: string, 
        locale?: string, 
        abortSignal?: AbortSignal,
        onChunk?: (chunk: any) => void,
        reasoningEffort?: 'high' | 'max',
        providerConfig?: ModelProviderConfig,
        workspaceRoot?: string,
        requestId?: string,
    ) {
        // [DAU STATS] 记录日活：每次用户发起对话均计入活跃用户统计
        TelemetryService.recordActiveUser(userId);

        const root = agentService.checkWorkspace(userId, workspaceRoot);
        const resolvedProvider = AIProviderFactory.normalizeProvider({
            ...(providerConfig || {}),
            id: providerId || providerConfig?.id,
            modelId: modelId || providerConfig?.modelId,
        });
        const finalModelId = resolvedProvider.modelId;
        const currentTraceId = traceId;

        const isoKey = agentService.getIsolationKey(userId, root);
        agentService.sessionLastAccess.set(isoKey, Date.now());

        const startTimeStamp = Date.now();
        console.log(`${getTS()} [AgentChat] Chat started for user: ${userId}, traceId: ${traceId}, requestId: ${requestId || 'N/A'}, model: ${finalModelId}`);

        // 【缓存策略】追踪本轮对话的系统提示词缓存是否已清理，避免重复操作
        let systemPromptCacheCleared = false;
        const clearPromptCache = () => {
            if (requestId && !systemPromptCacheCleared) {
                systemPromptCacheCleared = true;
                agentService.clearSystemPromptCache(requestId);
            }
        };

        // 初始化 MCP 工具（扫描 workspace .mcp/ 目录，连接 MCP 服务器，注册桥接工具）
        try {
            await agentService.registerMcpTools(userId, root);
        } catch (mcpErr) {
            console.warn(`${getTS()} [AgentChat] Failed to register MCP tools:`, mcpErr);
            // MCP 工具初始化失败不影响主流程
        }

        // 初始化 Playwright MCP 浏览器自动化适配器
        try {
            await agentService.registerBrowserMcpAdapter(userId, root);
        } catch (browserErr) {
            console.warn(`${getTS()} [AgentChat] Failed to register Playwright MCP adapter:`, browserErr);
            // Playwright MCP 初始化失败不影响主流程
        }

        // 打印完整工具清单，方便用户确认当前可用的工具集
        agentService.logRegisteredTools();

        // 2026.04: 思考强度 (reasoning_effort)
        // 官方兼容映射：low/medium → high；xhigh → max；默认 high。复杂 Agent 场景建议 max。
        const effectiveReasoningEffort: 'high' | 'max' = reasoningEffort === 'max'
            ? 'max'
            : (resolvedProvider.defaultReasoningEffort === 'max' ? 'max' : 'high');
        console.log(`${getTS()} [AgentChat] Reasoning effort: ${effectiveReasoningEffort} for user: ${userId}`);

        const emit = (chunk: any) => {
            if (onChunk) {
                // 如果是 error，确保设置 isFinal 为 true
                const isFinal = chunk.type === "error";
                onChunk({ 
                    ...chunk, 
                    traceId: currentTraceId, 
                    timestamp: Date.now(),
                    isFinal: isFinal 
                });
            }
        };

            const TERMINAL_TODO_STATUSES = new Set(["completed", "failed"]);
            const isTerminalTodo = (todo: any) => TERMINAL_TODO_STATUSES.has(String(todo?.status || "").toLowerCase());
            const isNonTerminalTodo = (todo: any) => !isTerminalTodo(todo);
            const formatNonTerminalTodos = (list: any[]) => {
                return list
                    .map(
                        (t: any, idx: number) =>
                            `${idx + 1}. [${String(t?.status || "unknown")}] ${String(t?.title || "(未命名任务)")} (id: ${String(t?.id || "N/A")})`
                    )
                    .join("\n");
            };
            const requiresUserInputOrDecision = (reply: string) => {
                const text = String(reply || "").replace(/\s+/g, " ").trim();
                if (!text) return false;

                const negation = /(无需|不用|不需要|暂不需要|已无需|no need|not required)/i;
                if (negation.test(text)) return false;

                const patterns = [
                    /请(?:你)?(?:先|再)?(?:提供|补充|确认|选择|决定|上传|填写|输入|告知)/,
                    /需要(?:你|用户)(?:提供|补充|确认|选择|决定|授权|上传|输入)/,
                    /(是否|能否|可否).*(?:提供|确认|选择|决定|授权|上传|输入)/,
                    /请问.*(?:提供|确认|选择|决定|授权|上传|输入)/,
                    /等待(?:你|用户).*(?:提供|确认|选择|决定|授权|上传|输入)/,
                    /\b(?:please|kindly)\s+(?:provide|confirm|choose|decide|select|upload|input|share)\b/i,
                    /\bneed your (?:input|decision|confirmation|approval|selection)\b/i,
                ];

                return patterns.some((re) => re.test(text));
            };
            const isEvaluatorRepairConfirmationOnly = (reply: string) => {
                const text = String(reply || "").replace(/\s+/g, " ").trim();
                if (!text) return false;

                const mentionsEvaluatorRepair = /(评估Agent|评估报告|评估结论|P[0-3]|问题清单|修复建议|继续迭代|原文件|原路径)/i.test(text)
                    && /(修复|修改|调整|优化|改动|处理|解决)/.test(text);
                const asksForRepairConsent = /(是否|要不要|需不需要|是否需要|是否继续|确认|同意|批准|采用|选择|决定)/.test(text)
                    || /\b(?:confirm|approval|approve|proceed|continue|choose|decide)\b/i.test(text);
                const needsRealUserInput = /(上传|登录|付款|购买|提供.*(?:文件|素材|账号|密码|token|密钥|授权|凭证)|缺少.*(?:路径|文件|素材|信息)|无法定位|主观取舍|二选一)/.test(text);

                return mentionsEvaluatorRepair && asksForRepairConsent && !needsRealUserInput;
            };

        try {
            emit({ type: "stage", content: "Agent 思考中..." });
            
            let storedHistory = agentService.getSessionHistory(userId, root);
            const userInstructList = Array.isArray(userInstruct) ? userInstruct : [{ role: 'user', content: userInstruct }];
            const lastUserMsgRecord = [...userInstructList].reverse().find(m => m.role === "user");
            
            if (!lastUserMsgRecord) {
                emit({ type: "error", content: "未检测到有效的用户指令" });
                return;
            }

            // 写入长期记忆机制
            const { MemoryService } = await import('./MemoryService.js');
            await MemoryService.recordUserInstruction(root, lastUserMsgRecord.content);

            // 如果存在非终态任务，不清理历史，继续推进；仅在全部任务都为终态时才清理。
            const todosAtStart = await TodoService.getTodos(root, userId).catch(() => [] as any[]);
            const hasNonTerminalAtStart = todosAtStart.some(isNonTerminalTodo);

            if (!hasNonTerminalAtStart) {
                try { await TodoService.clearAllTodos(root, userId); } catch (err) {}
                console.log(`${getTS()} [AgentChat] No pending TODOs, clearing session history for user: ${userId}`);
                emit({ type: "annotation", method: "todo/update", params: { todos: [] } });
            }
            else {
                // 推送现存 TODO 状态给前端
                console.log(`${getTS()} [AgentChat] Pending TODOs detected at the start of the chat loop, pushing current TODO state to frontend for user: ${userId}`);
                emit({ type: "annotation", method: "todo/update", params: { todos: todosAtStart } });
            }

            const historyToOptimize = [...storedHistory];
            const { messages: optimizedMessages } = await HistoryOptimizerService.getInstance().optimizeHistory(historyToOptimize, userId, root);
            
            const finalLocale = locale || "zh-CN";
            const firstUserIntent = lastUserMsgRecord.content;
            
            
            const prepareMessages = async (msgs: any[]) => {
                const systemPrompt = await agentService.buildSystemPrompt(userId, finalLocale, 'main-agent.json', root, requestId);
                return MessagePreparationService.buildMessages({
                    systemPrompt,
                    pinnedUserMessage: firstUserIntent,
                    incomingMessages: msgs,
                });
            };

            let activeHistory = await prepareMessages(optimizedMessages);
            const toolsMetadata = agentService.getSharedToolsMetadata();

            const client = AIProviderFactory.getClient(resolvedProvider);
            const thinkingOptions = AIProviderFactory.buildThinkingOptions(resolvedProvider, effectiveReasoningEffort);
           
            const MAX_TURNS = globalConfig.agent.maxTurns;

            let totalSteps = 0;
            let pendingEvaluatorRepairDirective: { reportPath: string; finalReply: string } | null = null;
            let evaluatorRepairConfirmationRetries = 0;

            while(true)
            {
                let usage: any = null;

                // 执行 Agent 轮次引擎（AI 流式调用 → 工具执行 → 循环，直到无工具调用为止）
                const turnResult = await AgentTurnEngine.runTurns({
                    client,
                    finalModelId,
                    activeHistory,
                    toolsMetadata,
                    thinkingOptions,
                    agentService,
                    root,
                    userId,
                    currentTraceId,
                    optimizedMessages,
                    lastUserMsgRecord,
                    prepareMessages,
                    abortSignal,
                    emit,
                    startTimeStamp,
                    totalSteps,
                    maxTurns: MAX_TURNS,
                });

                activeHistory = turnResult.activeHistory;
                usage = turnResult.usage;
                totalSteps = turnResult.totalSteps;
                const mainAgentFinalReply = turnResult.finalAssistantContent || "";

                // 若主Agent明确要求用户补充信息或做决策，应立即退出循环等待新指令。
                // 该规则优先级高于“非终态任务继续执行”，避免代理在等待用户输入时空转。
                if (requiresUserInputOrDecision(mainAgentFinalReply)) {
                    if (pendingEvaluatorRepairDirective && evaluatorRepairConfirmationRetries < 1 && isEvaluatorRepairConfirmationOnly(mainAgentFinalReply)) {
                        evaluatorRepairConfirmationRetries += 1;
                        console.log(`${getTS()} [AgentChat] Main agent asked for confirmation on actionable evaluator repair; forcing direct repair iteration for user: ${userId}`);
                        activeHistory = await prepareMessages(activeHistory);
                        activeHistory.push({
                            role: "system",
                            content: [
                                "你刚才试图询问用户是否确认评估报告修复。当前处于评估驱动修复轮：评估报告已给出明确文件路径、问题定位和修复动作时，视为本轮已有修复授权。",
                                "不要再询问用户是否确认、是否继续或是否采用建议；请立即基于评估报告创建修复 TODO，读取对应文件并在原文件原路径上执行最小必要修改。",
                                "只有评估报告缺少可定位目标、缺少修复动作，或确实需要用户提供外部素材、账号授权、主观取舍时，才可以等待用户输入。",
                                `评估报告路径: ${pendingEvaluatorRepairDirective.reportPath}`,
                                "评估结论正文如下：",
                                pendingEvaluatorRepairDirective.finalReply || "(评估结论为空，请读取评估报告文件)",
                            ].join("\n"),
                        });
                        emit({ type: "stage", content: "评估报告已有明确修复建议，主Agent将直接修复，不再等待二次确认。" });
                        continue;
                    }
                    console.log(`${getTS()} [AgentChat] Main agent is waiting for user input/decision, exiting loop for user: ${userId}`);
                    clearPromptCache();
                    emit({
                        type: "done",
                        content: mainAgentFinalReply || "需要你提供进一步信息或做出决策后才能继续，请回复后我再执行下一步。",
                        usage,
                    });
                    return;
                }

                // 一次性读取 TODO，避免重复 I/O 与状态不一致
                const todos = await TodoService.getTodos(root, userId);
                const nonTerminalTodos = todos.filter(isNonTerminalTodo);

                // 只要存在非终态任务，严禁退出循环；必须继续推进任务
                if (nonTerminalTodos.length > 0) {
                    activeHistory = await prepareMessages(activeHistory);
                    activeHistory.push({
                        role: "system",
                        content: [
                            "检测到仍有 TODO 任务未到终态，先利用TODO工具检查并推进或更新这些任务，不要进入最终结论判断阶段。",
                            "请继续调用工具推进任务，优先处理以下未终态项：",
                            formatNonTerminalTodos(nonTerminalTodos),
                            "仅当所有任务都进入终态（completed 或 failed）后，才允许进入最终结论判断。"
                        ].join("\n")
                    });

                    console.log(`${getTS()} [AgentChat] Non-terminal TODOs detected (${nonTerminalTodos.length}), continuing chat loop for user: ${userId}`);
                    continue;
                }

                if (todos.length === 0) {
                    console.log(`${getTS()} [AgentChat] No TODOs remaining, ending chat loop for user: ${userId}`);
                    clearPromptCache();
                    emit({ type: "done", content: "目标已达成，结束对话。" });
                    return;
                }

                if (todos.length === 1 && todos[0].status === "completed") {
                    console.log(`${getTS()} [AgentChat] Single TODO completed, ending chat loop for user: ${userId}`);
                    clearPromptCache();
                    emit({ type: "done", content: "目标已达成，结束对话。" });
                    return;
                }

                if (todos.length > 1) {
                    console.log(`${getTS()} [AgentChat] All TODOs are terminal in main agent, switching to evaluator agent for user: ${userId}`);
                    emit({ type: "stage", content: "评估Agent正在核验工作区产出并生成评估报告..." });

                    const evaluationResult = await EvaluationAgentService.getInstance().runEvaluation({
                        agentService,
                        root,
                        userId,
                        traceId: currentTraceId,
                        requestId,
                        locale: finalLocale,
                        abortSignal,
                        emit,
                        providerConfig: resolvedProvider,
                        modelId: finalModelId,
                        thinkingOptions,
                        userInstruction: String(lastUserMsgRecord?.content || ""),
                        mainAgentFinalReply,
                    });

                    // 评估Agent结论：需要主Agent继续迭代
                    if (evaluationResult.decision === "continue_main_agent") {
                        pendingEvaluatorRepairDirective = {
                            reportPath: evaluationResult.reportPath,
                            finalReply: evaluationResult.finalReply || "",
                        };
                        evaluatorRepairConfirmationRetries = 0;
                        console.log(`${getTS()} [AgentChat] Evaluator requested main agent iteration for user: ${userId}, resetting previous iteration history to avoid context pollution.`);
                        try {
                            await TodoService.clearAllTodos(root, userId);
                            emit({ type: "annotation", method: "todo/update", params: { todos: [] } });
                        } catch (todoResetErr) {
                            console.warn(`${getTS()} [AgentChat] Failed to clear stale TODOs before re-iteration for user: ${userId}`, todoResetErr);
                        }
                        // 关键策略：继续迭代前清空上一轮主Agent历史，避免旧工具轨迹污染新一轮决策。
                        // 新一轮仅保留系统提示、固定用户意图，以及评估Agent输出的当前迭代指令。
                        const cleanHistoryForNewTurn = (msgs: any[]) => {
                            return msgs;
                        };
                        activeHistory = await prepareMessages(cleanHistoryForNewTurn([]));
                        activeHistory.push({
                            role: "system",
                            content: [
                                "评估Agent已完成本轮评估，结论：需要继续迭代优化，务必将评估报告的问题一一修复。",
                                "默认采用原文件原路径的迭代修复模式：先读取评估报告和现有目标文件，再在原文件上做最小必要修改。",
                                "若评估报告已经列出 P1/P0/P2 等问题、目标文件路径和修复动作，视为本轮已有修复授权；不要询问用户是否确认、是否继续、是否采用建议。",
                                "只有报告明确缺少用户输入、外部素材、授权或主观取舍时，才可以请求用户介入。",
                                "禁止为了绕开问题而新建 V2/V3/新版/修正版/最终版 等平行交付文件；除非用户明确要求多版本，否则只能收敛到原目标文件。",
                                "在开始修复前，基于评估报告的问题清单创建本轮修复 TODO；每个 TODO 必须绑定原目标文件路径和具体问题，不要重新发明与原产物脱节的方案。",
                                "请严格依据评估报告执行下一轮 TODO 规划、原文件修复与复查。",
                                `评估报告路径: ${evaluationResult.reportPath}`,
                                "评估结论正文如下：",
                                evaluationResult.finalReply || "(评估结论为空，请读取评估报告文件)",
                            ].join("\n"),
                        });
                        emit({ type: "stage", content: "评估完成：需要继续迭代，主Agent正在根据评估报告执行下一轮..." });
                        continue;
                    }

                    // 评估Agent结论：终局（达成 / 无法达成 / 需用户操作）
                    console.log(`${getTS()} [AgentChat] Evaluator returned terminal decision (${evaluationResult.decision}) for user: ${userId}`);
                    const decisionLabel =
                        evaluationResult.decision === "goal_achieved" ? "已经达成目标" :
                        evaluationResult.decision === "goal_unachievable" ? "条件不满足、目标无法达成" :
                        evaluationResult.decision === "need_user_input" ? "需要用户进一步操作或提供信息" :
                        "需要主Agent继续迭代";

                    clearPromptCache();
                    emit({
                        type: "done",
                        content: `评估已完成：${decisionLabel}。评估报告已写入 ${evaluationResult.reportPath}`,
                        usage: usage,
                    });
                    return;
                   
                }

                
                //如果用户终止了对话，则跳出循环并结束函数
                if (abortSignal?.aborted) {
                    console.log(`${getTS()} [AgentChat] Chat loop aborted for user: ${userId}`);
                    clearPromptCache();
                    break;
                }
            }
        } catch (err: any) {
            clearPromptCache();
            if (err.name === "AbortError") {
                console.log(`${getTS()} [AgentChat] Operation aborted for user: ${userId}`);
                return;
            }
            emit({ type: "error", message: err.message || "未知错误" });
            console.log(`${getTS()} [AgentChat] Error for user ${userId}:`, err);
        }
    }
}

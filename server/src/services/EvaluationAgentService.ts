import { randomUUID } from "node:crypto";
import { AgentService } from "@/services/AgentService.js";
import { AgentTurnEngine, type AgentTurnEngineResult } from "@/services/AgentTurnEngine.js";
import { AIProviderFactory } from "@/services/AIProviderFactory.js";
import { HistoryOptimizerService } from "@/services/HistoryOptimizerService.js";
import { MessagePreparationService } from "@/services/MessagePreparationService.js";
import { accumulateTokenUsage, type TokenUsage } from "@/utils/TokenUsage.js";
import type { ModelProviderConfig } from "@/services/SettingsService.js";
import { FileIO } from "@/utils/FileIO.js";
import { getBeijingLogTimePrefix } from "@/utils/TimeUtils.js";
import type { LLMRequestRecord } from "@/services/LLMRequestJournal.js";

/** 最近一次评估报告落盘路径（工作区相对路径，系统内部上下文补充文件） */
const EVALUATION_REPORT_RELATIVE_PATH = ".evaluate/evl_result.md";

/** 评估报告不完整时，最多自动续写几次（避免无限循环） */
const MAX_REPORT_CONTINUATIONS = 2;

const getTS = () => getBeijingLogTimePrefix();

export type EvaluationDecision =
    | "continue_main_agent"
    | "goal_achieved"
    | "goal_unachievable"
    | "need_user_input"
    /** 评估Agent未能产出完整报告（输出被截断/异常），不得据此驱动主Agent修复循环 */
    | "evaluation_failed";

/** 评估报告完整性检查结果 */
interface ReportIntegrity {
    complete: boolean;
    hasHeading: boolean;
    hasIssueCount: boolean;
    hasP0P1Count: boolean;
    hasDecision: boolean;
    hasRepairList: boolean;
    requiresRepairList: boolean;
    length: number;
}

interface ResolvedReport {
    report: string;
    source: string;
    integrity: ReportIntegrity;
}

export interface EvaluationAgentInput {
    agentService: AgentService;
    root: string;
    userId: string;
    traceId: string;
    /** 对话级缓存 key（后端生成），同一对话内复用系统提示词缓存 */
    requestId?: string;
    locale?: string;
    abortSignal?: AbortSignal;
    emit: (chunk: any) => void;
    providerConfig: ModelProviderConfig;
    modelId: string;
    thinkingOptions: any;
    userInstruction: string;
    mainAgentFinalReply: string;
    resumeRequest?: LLMRequestRecord;
    /**
     * 是否把评估报告落盘到 `.evaluate/evl_result.md`（默认 true）。
     * Workflow evaluator 应传 false，避免覆盖主 Agent 的评估报告。
     */
    persistReport?: boolean;
    /** 限制评估 Agent 可用的工具（默认不限制，保持现有行为） */
    allowedToolNames?: ReadonlySet<string>;
    /** 跳过 LLM 请求日志（workflow 步骤不参与 chat 崩溃恢复） */
    skipJournal?: boolean;
    /** 跳过 Telemetry 写盘（Worker/批量评估场景由调用方统一记录） */
    skipTelemetry?: boolean;
    /** 最大轮次上限（默认不限制；workflow 步骤建议传入） */
    maxTurns?: number;
    /** 可选模型请求门控，失败时向调用方传播。 */
    beforeApiRequest?: () => Promise<void>;
    afterApiRequest?: (usage: TokenUsage | null) => void;
    telemetrySink?: (usage: TokenUsage, modelId: string) => void;
}

export interface EvaluationAgentOutput {
    decision: EvaluationDecision;
    finalReply: string;
    reportContent: string;
    usage: TokenUsage | null;
}

/**
 * 评估Agent：
 * - 使用独立 evaluator-agent.json 系统提示词
 * - 仅注入「用户指令 + 主Agent最终回复」作为任务上下文
 * - 复用主Agent同款工具链，支持评估任务 TODO 化与工作区核验
 * - 评估结果通过内存传递；最近一次评估报告落盘 .evaluate/evl_result.md，
 *   供多轮对话中主Agent在上下文缺少评估报告时按需检索补充（一般情况下无需读取）
 */
export class EvaluationAgentService {
    private static instance: EvaluationAgentService;

    public static getInstance(): EvaluationAgentService {
        if (!this.instance) {
            this.instance = new EvaluationAgentService();
        }
        return this.instance;
    }

    public async runEvaluation(input: EvaluationAgentInput): Promise<EvaluationAgentOutput> {
        const {
            agentService,
            root,
            userId,
            traceId,
            requestId,
            locale,
            abortSignal,
            emit,
            providerConfig,
            modelId,
            thinkingOptions,
            userInstruction,
            mainAgentFinalReply,
            resumeRequest,
            persistReport,
            allowedToolNames,
            skipJournal,
            skipTelemetry,
            maxTurns,
            beforeApiRequest,
            afterApiRequest,
            telemetrySink,
        } = input;

        // workflow evaluator 等调用方可能不传 requestId；兜底生成本次评估的
        // 提示词缓存 key，避免每轮工具调用后重复扫描工作区/技能/规则。
        const effectiveRequestId = requestId || randomUUID();

        const evaluationTask = [
            "你现在是评估专家Agent，请执行完整评估闭环。",
            "",
            "【用户原始指令】",
            userInstruction || "(空)",
            "",
            "【主Agent最新最终回复】",
            mainAgentFinalReply || "(空)",
            "",
            "【你的评估任务】",
            "0. 严禁直接相信主Agent最终回复，必须逐项独立核查；未核查项必须明确标注为未验证。",
            "1. 先解析主Agent最终回复中的“文件变更清单”，据此确定核验范围：",
            "   - 若清单列出创建/修改/删除文件，优先核验这些工作区相对路径及其直接依赖证据；创建/修改类检查文件存在、内容与用户目标一致，删除类检查文件确已不存在或删除动作有证据。",
            "   - 若主Agent明确声明“没有创建、修改、删除任何文件”，且用户目标不要求落盘产物，则不要把文件系统扫描作为主要验收路径，应主要核验最终回复本身的事实、逻辑、完整性与风险说明。",
            "   - 若用户目标要求文件产出但主Agent声明无文件变更，或最终回复缺失/含糊文件变更清单，必须判定为问题并要求主Agent补充或修正最终回复。",
            "2. 结合工作区真实产出进行核验（可调用工具，必要时规划TODO任务并执行）",
            "   - 你与主Agent共享同一套工具能力（含 playwright__browser_* 浏览器工具与 read_skill 技能加载工具）",
            "   - 必须核验临时文件治理是否合规：临时产物是否统一位于工作目录 `.temp/` 下。",
            "   - 若存在临时文件落在 `.temp/` 之外且用户未明确要求该位置，必须判定为问题，并给出迁移建议。",
            "3. 形成结构化评估报告：目标、文件变更清单解析、证据、差距、风险、后续动作",
            "   - 你的最终输出必须是完整的 Markdown 报告正文，不得只给简短结论。",
            "   - 评估结果将通过内存传递给主Agent，请确保内容完整、可追溯。",
            "   - 若结论为需要继续迭代，后续动作必须指向原目标文件的原路径局部修复：列出文件路径、问题位置或可定位区域、最小修复动作和复查方式。",
            "   - 若结论为需要继续迭代，必须输出“可直接修复清单”：每个问题包含等级（P0/P1/P2/P3）、需修改文件路径、页码/行号/区域、问题描述、最小修复动作和复查方式。",
            "   - 如果评估报告已能定位问题并给出修复动作（例如 P1 问题已给出目标文件和修复建议），必须要求主Agent直接修复，不要要求用户确认是否修复。",
            "   - 只有确需外部素材、账号授权、用户主观取舍，或无法定位目标文件/修复动作时，才允许选择“需要用户进一步操作或提供信息”。",
            "   - 禁止建议主Agent通过新建 V2/V3/新版/修正版/最终版 等平行文件绕开问题；除非用户明确要求多版本，否则必须要求收敛到原交付文件。",
            "4. 最后一节必须给出“最终判定”，且只能是以下四类之一：",
            "   - 已经达成目标",
            "   - 需要主Agent继续迭代",
            "   - 条件不满足、目标无法达成",
            "   - 需要用户进一步操作或提供信息",
            "5. 结尾区域必须先输出固定字段「问题个数：N」和「P0+P1问题个数：M」（M 为 P0 和 P1 级别的问题总数，0 ≤ M ≤ N）。",
            "   - 若无法确认问题数，保守输出：问题个数：1、P0+P1问题个数：1，并在正文说明不确定原因。",
            "   - 问题个数和 P0+P1问题个数 都必须是单一确定值，禁止区间、中文数字、约数或省略。",
            "6. 结尾必须给出“执行结论”单行，格式：执行结论：<四类之一>",
            "7. 禁止在正文中声称\u201c已写入文件/已保存文件\u201d；你的报告内容将通过系统消息直接传递给主Agent，无需落盘。"
        ].join("\n");

        const finalLocale = locale || "zh-CN";
        const pinnedUserMessage = resumeRequest?.metadata.recoveryContext?.pinnedUserMessage || evaluationTask;
        const prepareMessages = async (msgs: any[]) => {
            const systemPrompt = await agentService.buildSystemPrompt(
                userId,
                finalLocale,
                "evaluator-agent.json",
                root,
                effectiveRequestId,
                userInstruction,
            );
            return MessagePreparationService.buildMessages({
                systemPrompt,
                pinnedUserMessage,
                pinnedUserPrefix: "",
                incomingMessages: msgs,
                provider: providerConfig,
            });
        };

        // 与主Agent一致：先走一遍历史压缩入口（评估Agent默认初始为空历史，后续可平滑扩展）
        const historyToOptimize: any[] = [];
        const optimizedMessages = resumeRequest
            ? historyToOptimize
            : (await HistoryOptimizerService.getInstance().optimizeHistory(historyToOptimize, userId, root)).messages;

        const activeHistory = resumeRequest
            ? resumeRequest.payload.messages
            : await prepareMessages(optimizedMessages);
        const toolsMetadata = agentService.getSharedToolsMetadata(allowedToolNames);

        const client = AIProviderFactory.getClient(providerConfig);

        let turnResultUsage: TokenUsage | null = null;
        let finalReply = "";
        let decision: EvaluationDecision = "continue_main_agent";
        let issueCount = 1;
        let p0p1IssueCount = 1;
        let finalReportComplete = true;

        let requestGateFailed = false;

        const executeTurns = async (
            history: any[],
            forceFinalAnswer: boolean,
            isFirstAttempt: boolean,
        ): Promise<AgentTurnEngineResult> => {
            const result = await AgentTurnEngine.runTurns({
                client,
                finalModelId: modelId,
                activeHistory: history,
                toolsMetadata,
                thinkingOptions,
                agentService,
                root,
                userId,
                currentTraceId: traceId,
                optimizedMessages,
                lastUserMsgRecord: { role: "user", content: evaluationTask },
                prepareMessages,
                abortSignal,
                emit,
                startTimeStamp: Date.now(),
                totalSteps: 0,
                /** 评估Agent对话旅程独立存放，不污染主Agent持久化历史 */
                skipPersist: true,
                provider: providerConfig,
                agentStage: "评估Agent",
                allowedToolNames,
                skipJournal,
                skipTelemetry,
                maxTurns,
                forceFinalAnswer,
                beforeApiRequest: beforeApiRequest && (async () => {
                    try {
                        await beforeApiRequest();
                    } catch (error) {
                        requestGateFailed = true;
                        throw error;
                    }
                }),
                afterApiRequest: afterApiRequest && ((usage) => {
                    try {
                        afterApiRequest(usage);
                    } catch (error) {
                        requestGateFailed = true;
                        throw error;
                    }
                }),
                telemetrySink,
                recoveryContext: {
                    userInstruction,
                    pinnedUserMessage,
                    mainAgentFinalReply,
                },
                // 只有第一次请求需要重放崩溃前的原始 payload；续写必须使用新构造的历史。
                resumeRequest: isFirstAttempt ? resumeRequest : undefined,
            });
            turnResultUsage = accumulateTokenUsage(turnResultUsage, result.usage);
            return result;
        };

        try {
            let turnResult = await executeTurns(activeHistory, false, true);
            let resolved = this.resolveReport(turnResult);

            // 评估报告必须是完整正文；只拿到标题/开头时不能直接交给主Agent，
            // 否则主Agent会按一个不存在的「可直接修复清单」反复扫描工作区。
            // 即使字段齐全，只要 finish_reason=length 也强制续写一次，避免尾部清单被截断。
            let continuationRounds = 0;
            let shouldContinue = !resolved.integrity.complete
                || (turnResult.finishReason === "length" && continuationRounds === 0);
            while (shouldContinue
                && continuationRounds < MAX_REPORT_CONTINUATIONS
                && !abortSignal?.aborted) {
                const partial = resolved.report;
                const missing = this.describeMissingReportParts(resolved.integrity);
                console.warn(
                    `${getTS()} [EvaluationAgent] 评估报告不完整（缺少：${missing}；`
                    + `finishReason=${turnResult.finishReason ?? "unknown"}；长度=${partial.length}），`
                    + `正在自动续写（第 ${continuationRounds + 1}/${MAX_REPORT_CONTINUATIONS} 次）...`,
                );
                emit({
                    type: "stage",
                    content: `评估报告不完整（缺少：${missing}），正在自动续写完整报告...`,
                });

                const continuationHistory = this.buildContinuationHistory(
                    turnResult,
                    partial,
                    this.buildContinuationDirective(resolved.integrity, turnResult.finishReason),
                    providerConfig,
                );
                const nextResult = await executeTurns(continuationHistory, true, false);
                const nextResolved = this.resolveReport(nextResult);

                if (nextResolved.integrity.complete) {
                    resolved = nextResolved;
                    turnResult = nextResult;
                    break;
                }

                // 强制续写时模型可能只回一句“报告已完整输出”。原报告已完整时保留原报告，
                // 不要把确认语拼进正文。
                if (resolved.integrity.complete
                    && nextResolved.report.length < 120
                    && !/(?:问题个数|执行结论|可直接修复清单)/.test(nextResolved.report)) {
                    turnResult = nextResult;
                    break;
                }

                if (nextResolved.report) {
                    const combined = this.combineReportSegments(partial, nextResolved.report);
                    resolved = {
                        report: combined,
                        source: "continuation",
                        integrity: this.inspectReport(combined),
                    };
                }
                turnResult = nextResult;
                continuationRounds++;
                shouldContinue = !resolved.integrity.complete
                    && continuationRounds < MAX_REPORT_CONTINUATIONS
                    && !abortSignal?.aborted;
            }

            if (abortSignal?.aborted) {
                const abortError = new Error("评估Agent请求已取消");
                abortError.name = "AbortError";
                throw abortError;
            }

            finalReply = resolved.report.trim();
            finalReportComplete = resolved.integrity.complete;

            if (finalReportComplete) {
                decision = this.parseDecision(finalReply);
                issueCount = this.parseIssueCount(finalReply);
                p0p1IssueCount = this.parseP0P1IssueCount(finalReply, issueCount);

                // 质量门禁：仅 P0+P1 级别问题阻塞交付，P2/P3 不阻塞。
                // 评估失败是终局信号，不能被 P0/P1 计数改写成“继续迭代”。
                if (decision !== "evaluation_failed" && p0p1IssueCount > 0) {
                    decision = "continue_main_agent";
                }
            } else {
                decision = "evaluation_failed";
                issueCount = 1;
                p0p1IssueCount = 1;
                finalReply = this.buildIncompleteReport(resolved, turnResult);
                console.error(
                    `${getTS()} [EvaluationAgent] 评估报告仍不完整，已终止修复循环：`
                    + `missing=${this.describeMissingReportParts(resolved.integrity)}，`
                    + `finishReason=${turnResult.finishReason ?? "unknown"}，`
                    + `length=${resolved.report.length}，user=${userId}`,
                );
            }
        } catch (err: any) {
            if (requestGateFailed || err?.name === "AbortError" || abortSignal?.aborted) throw err;
            const errMsg = String(err?.message || err || "未知异常").trim();
            // 评估异常不能伪装成“需要主Agent继续迭代”：否则主Agent会把异常文本
            // 当成修复清单，反复扫描工作区却找不到可执行项。
            decision = "evaluation_failed";
            issueCount = 1;
            p0p1IssueCount = 1;
            finalReportComplete = false;
            finalReply = [
                "## 评估执行异常",
                "",
                `评估Agent在运行过程中出现异常：${errMsg}`,
                "",
                "系统已停止本轮修复循环；请重试评估，不要依据本报告臆造「可直接修复清单」。",
                "",
                "问题个数：1",
                "P0+P1问题个数：1",
                "执行结论：评估失败",
            ].join("\n");
            console.error(`${getTS()} [EvaluationAgent] runTurns failed for user: ${userId}`, err);
        }

        const reportContent = finalReply;

        // 【持久化】最近一次评估报告落盘到工作区 .evaluate/evl_result.md（覆盖式）。
        // 供多轮对话中主Agent在上下文缺少评估报告时按需检索补充；一般情况下无需读取。
        // 失败不应影响评估主流程，这里仅告警。
        if (persistReport !== false) {
            try {
                await this.saveEvaluationReport(root, finalReply, finalReportComplete);
            } catch (persistErr) {
                console.warn(
                    `${getTS()} [EvaluationAgent] Failed to persist evaluation report to ${EVALUATION_REPORT_RELATIVE_PATH}:`,
                    persistErr
                );
            }
        }

        console.log(`${getTS()} [EvaluationAgent] Evaluation finished for user: ${userId}, decision: ${decision}, issueCount: ${issueCount}, p0p1IssueCount: ${p0p1IssueCount}`);

        // 本次评估自行生成的缓存 key：评估结束后清理，避免 workflow/内部调用长期占用
        // 全局提示词缓存（chat 路径由 AgentChatComponent 统一清理）。
        if (!requestId) {
            try {
                agentService.clearSystemPromptCache(effectiveRequestId);
            } catch (cacheErr) {
                console.warn(`${getTS()} [EvaluationAgent] Failed to clear system prompt cache:`, cacheErr);
            }
        }

        return {
            decision,
            finalReply,
            reportContent,
            usage: turnResultUsage,
        };
    }

    /**
     * 检查评估报告是否满足交付契约：
     * - 固定标题「# 评估Agent的评估报告」
     * - 「问题个数：N」
     * - 「执行结论：...」
     * - 结论为需要继续迭代时，必须包含「可直接修复清单」
     *
     * 只有完整报告才允许进入主Agent修复循环；仅拿到标题/开头时视为评估失败。
     */
    private inspectReport(report: string): ReportIntegrity {
        const text = String(report || "").trim();
        const hasHeading = /(?:^|\n)\s*#{1,3}\s*评估Agent的评估报告/.test(text);
        const hasIssueCount = /(?:^|\n)\s*(?:问题个数|问题数量|问题数)\s*[：:]\s*\d+/.test(text);
        const hasP0P1Count = /(?:^|\n)\s*(?:P0\+P1问题个数|P0P1问题个数|P0\+P1问题数|P0P1问题数)\s*[：:]\s*\d+/.test(text);
        const hasDecision = /(?:^|\n)\s*执行结论\s*[：:]/.test(text);
        const hasRepairList = /(?:可直接修复清单|修复清单)/.test(text);

        const decisionLine = text
            .split(/\r?\n/)
            .map((line) => this.normalizeDecisionLine(line))
            .find((line) => /^执行结论\s*[：:]/.test(line));
        const requiresRepairList = (!!decisionLine
            && decisionLine.replace(/\s+/g, "").includes("需要主Agent继续迭代"))
            // 兼容“执行结论：”与结论文字之间被换行/空格拆开的情况
            || /执行结论\s*[：:][\s\S]{0,40}需要主Agent继续迭代/.test(text);

        const complete = text.length >= 40
            && hasHeading
            && hasIssueCount
            && hasDecision
            && (!requiresRepairList || hasRepairList);

        return {
            complete,
            hasHeading,
            hasIssueCount,
            hasP0P1Count,
            hasDecision,
            hasRepairList,
            requiresRepairList,
            length: text.length,
        };
    }

    /**
     * 从「最终答复 / 推理内容 / 历史 assistant 消息」中挑选最完整的评估报告。
     * 某些模型会把完整报告写进 reasoning_content，或把报告写在带工具调用的
     * 中间轮次里，而最终 content 只剩一行开头；此时必须回退到更完整的候选。
     */
    private resolveReport(result: AgentTurnEngineResult): ResolvedReport {
        const finalContent = String(result.finalAssistantContent || "").trim();
        const finalIntegrity = this.inspectReport(finalContent);
        if (finalIntegrity.complete) {
            return { report: finalContent, source: "final", integrity: finalIntegrity };
        }

        const candidates: Array<{ source: string; text: string }> = [];
        const reasoning = String(result.finalAssistantReasoning || "").trim();
        if (reasoning) candidates.push({ source: "reasoning", text: reasoning });

        (result.activeHistory || []).forEach((message: any, index: number) => {
            if (message?.role !== "assistant" || typeof message.content !== "string") return;
            const text = message.content.trim();
            if (text) candidates.push({ source: `history#${index}`, text });
        });

        const completeCandidates = candidates
            .map((candidate) => ({ ...candidate, integrity: this.inspectReport(candidate.text) }))
            .filter((candidate) => candidate.integrity.complete)
            .sort((left, right) => right.text.length - left.text.length);

        if (completeCandidates.length > 0) {
            const best = completeCandidates[0];
            console.warn(
                `${getTS()} [EvaluationAgent] 最终答复不完整（长度=${finalContent.length}），`
                + `改用 ${best.source} 中的完整报告（长度=${best.text.length}）`,
            );
            return { report: best.text, source: best.source, integrity: best.integrity };
        }

        // 没有完整候选：优先保留最终答复，避免把更长的中间草稿误当成结论。
        const fallback = finalContent
            ? { source: "final", text: finalContent }
            : (candidates.sort((left, right) => right.text.length - left.text.length)[0]
                ?? { source: "none", text: "" });

        return {
            report: fallback.text,
            source: fallback.source,
            integrity: this.inspectReport(fallback.text),
        };
    }

    private describeMissingReportParts(integrity: ReportIntegrity): string {
        const missing: string[] = [];
        if (!integrity.hasHeading) missing.push("标题「# 评估Agent的评估报告」");
        if (!integrity.hasIssueCount) missing.push("「问题个数：N」");
        if (!integrity.hasDecision) missing.push("「执行结论：...」");
        if (integrity.requiresRepairList && !integrity.hasRepairList) missing.push("「可直接修复清单」");
        return missing.length > 0 ? missing.join("、") : "完整报告正文";
    }

    private buildContinuationDirective(integrity: ReportIntegrity, finishReason: string | null): string {
        const missing = this.describeMissingReportParts(integrity);
        return [
            "【评估报告续写】",
            "你上一次的最终答复不是完整的评估报告：可能被输出长度上限截断，或只输出了开头。",
            `缺失内容：${missing}。`,
            finishReason === "length" ? "上次请求的 finish_reason=length，确认输出已被截断。" : "",
            "请立即输出完整评估报告正文：",
            "- 必须以「# 评估Agent的评估报告」开头；",
            "- 必须包含「问题个数：N」「P0+P1问题个数：M」「执行结论：<四类之一>」；",
            "- 若结论为「需要主Agent继续迭代」，必须包含「可直接修复清单」，逐项给出 P0-P3、文件路径、位置、问题描述、最小修复动作和复查方式；",
            "- 不要调用任何工具；不要只输出标题或摘要；如果无法从中断处续写，请重新输出完整报告。",
        ].filter(Boolean).join("\n");
    }

    private buildContinuationHistory(
        result: AgentTurnEngineResult,
        partial: string,
        directive: string,
        provider: Partial<ModelProviderConfig>,
    ): any[] {
        const history = [...(result.activeHistory || [])];
        const partialText = String(partial || "").trim();
        const last = history[history.length - 1];
        const alreadyPresent = last?.role === "assistant"
            && typeof last.content === "string"
            && last.content.trim() === partialText;

        if (partialText && !alreadyPresent) {
            const assistantMessage: any = { role: "assistant", content: partialText };
            // 请求携带 tools 时，DeepSeek thinking mode 要求 assistant 消息逐字回传 reasoning_content。
            if (result.finalAssistantReasoning) {
                assistantMessage.reasoning_content = result.finalAssistantReasoning;
            }
            history.push(assistantMessage);
        }

        history.push(AIProviderFactory.buildMidConversationDirective(provider, directive));
        return history;
    }

    /** 合并两次续写片段；模型重新从头输出时取更完整的一份，避免重复拼接。 */
    private combineReportSegments(partial: string, continuation: string): string {
        const left = String(partial || "").trim();
        const right = String(continuation || "").trim();
        if (!left) return right;
        if (!right) return left;

        if (/(?:^|\n)\s*#{1,3}\s*评估Agent的评估报告/.test(right)) {
            return right.length >= left.length ? right : left;
        }
        if (left.endsWith(right)) return left;

        const maxOverlap = Math.min(200, left.length, right.length);
        for (let length = maxOverlap; length > 0; length--) {
            if (left.slice(-length) === right.slice(0, length)) {
                return left + right.slice(length);
            }
        }
        return `${left}${left.endsWith("\n") ? "" : "\n"}${right}`;
    }

    private buildIncompleteReport(resolved: ResolvedReport, result: AgentTurnEngineResult): string {
        const missing = this.describeMissingReportParts(resolved.integrity);
        const received = resolved.report.trim();
        const lines = [
            "## 评估执行异常",
            "",
            "评估Agent未能生成完整评估报告，系统已停止本轮修复循环，避免主Agent依据不完整报告臆造问题清单。",
            "",
            `- 报告完整性：不完整（缺少：${missing}）`,
            `- 已接收内容长度：${received.length} 字符`,
            `- finish_reason：${result.finishReason ?? "unknown"}`,
        ];
        if (received) {
            lines.push("", "### 已接收到的报告片段", "", received);
        }
        lines.push(
            "",
            "问题个数：1",
            "P0+P1问题个数：1",
            "执行结论：评估失败",
        );
        return lines.join("\n");
    }

    /**
     * 将最近一次评估报告写入工作区 `.evaluate/evl_result.md`（覆盖式）。
     * - 系统内部上下文补充文件：多轮对话中主Agent若发现上下文中缺少评估报告，
     *   可通过 read_file 读取本文件补充信息；一般情况下无需读取。
     * - 原样保留报告正文（含一级标题「# 评估Agent的评估报告」），仅在文件头追加
     *   HTML 注释形式的元信息，不影响 Markdown 渲染与标题识别。
     * - 写入失败由调用方 try/catch 兜底，不影响评估主流程。
     */
    private async saveEvaluationReport(
        root: string,
        finalReply: string,
        complete: boolean = true,
    ): Promise<void> {
        const content = String(finalReply || "").trim();
        const body = content || "(评估结论为空)";
        const stamped = [
            `<!-- 最近一次评估Agent评估报告 · 生成时间 ${getBeijingLogTimePrefix()} · 系统内部上下文补充文件 -->`,
            `<!-- 报告状态：${complete ? "完整" : "不完整/评估失败"} -->`,
            `<!-- 多轮对话中若上下文缺少评估报告且需要补充评估信息，可用 read_file 读取本文件；一般情况下无需读取。 -->`,
            "",
            body,
            "",
        ].join("\n");
        await FileIO.writeFile(EVALUATION_REPORT_RELATIVE_PATH, root, stamped);
    }

    private normalizeDecisionLine(line: string): string {
        let normalized = String(line || "").trim();
        // Remove common markdown prefixes: quote/list/ordered-list
        normalized = normalized.replace(/^\s*(?:>+\s*)?(?:(?:[-*+]\s+)|(?:\d+\.\s+))?/, "");
        // Remove surrounding markdown emphasis wrappers
        normalized = normalized.replace(/^[`*_~]+/, "").replace(/[`*_~]+$/, "");
        return normalized.trim();
    }

    private parseDecision(finalReply: string): EvaluationDecision {
        const source = String(finalReply || "");
        const text = source.replace(/\s+/g, "");

        // 优先解析“执行结论：xxx”这一显式字段，降低误判概率。
        const explicitLine = source
            .split(/\r?\n/)
            .map((line) => this.normalizeDecisionLine(line))
            .find((line) => /^执行结论\s*[：:]/.test(line));

        if (explicitLine) {
            const normalized = explicitLine.replace(/\s+/g, "");
            if (normalized.includes("评估失败")) return "evaluation_failed";
            if (normalized.includes("需要主Agent继续迭代")) return "continue_main_agent";
            if (normalized.includes("已经达成目标")) return "goal_achieved";
            if (normalized.includes("条件不满足、目标无法达成") || normalized.includes("无法达成")) return "goal_unachievable";
            if (normalized.includes("需要用户进一步操作或提供信息") || normalized.includes("需要用户操作") || normalized.includes("需要用户提供信息")) {
                return "need_user_input";
            }
        }

        if (!text) return "continue_main_agent";
        if (text.includes("执行结论：评估失败") || text.includes("评估报告不完整") || text.includes("评估执行异常")) {
            return "evaluation_failed";
        }
        if (text.includes("需要主Agent继续迭代") || text.includes("执行结论：需要主Agent继续迭代")) {
            return "continue_main_agent";
        }
        if (text.includes("已经达成目标") || text.includes("执行结论：已经达成目标")) {
            return "goal_achieved";
        }
        if (text.includes("条件不满足、目标无法达成") || text.includes("无法达成")) {
            return "goal_unachievable";
        }
        if (text.includes("需要用户进一步操作或提供信息") || text.includes("需要用户操作") || text.includes("需要用户提供信息")) {
            return "need_user_input";
        }

        // 歧义输出不再静默放行为“继续迭代”，直接要求补充信息。
        return "need_user_input";
    }

    /**
     * 解析评估报告中的 P0+P1 级别问题个数。
     * 质量门禁仅以此值为准：P0+P1=0 时放行，P2/P3 不阻塞交付。
     * 若报告未显式给出该字段，保守回退到总问题数（issueCount）。
     */
    private parseP0P1IssueCount(finalReply: string, fallbackTotalIssueCount: number): number {
        const source = String(finalReply || "");
        if (!source.trim()) return fallbackTotalIssueCount;

        // 优先解析显式字段：P0+P1问题个数/P0P1问题个数：M
        const explicitLine = source
            .split(/\r?\n/)
            .map((line) => this.normalizeDecisionLine(line))
            .find((line) => /^(P0\+P1问题个数|P0P1问题个数|P0\+P1问题数|P0P1问题数)\s*[：:]/.test(line));

        if (explicitLine) {
            const normalized = explicitLine.replace(/\s+/g, "");
            const m = normalized.match(/(?:P0\+P1问题个数|P0P1问题个数|P0\+P1问题数|P0P1问题数)[：:](\d+)/);
            if (m) {
                const count = Number(m[1] || 0);
                // P0+P1 不应超过总问题数，若超过则以上限为准
                return Math.min(count, fallbackTotalIssueCount);
            }
            if (/(?:P0\+P1问题个数|P0P1问题个数|P0\+P1问题数|P0P1问题数)[：:](?:0|0个?)/.test(normalized)) return 0;
        }

        // 回退：尝试从「可直接修复清单」中统计 P0/P1 标记
        const p0p1Matches = source.match(/[（(]P[01][）)]/g);
        if (p0p1Matches && p0p1Matches.length > 0) {
            return Math.min(p0p1Matches.length, fallbackTotalIssueCount);
        }

        // 无法解析 P0+P1 计数时，保守使用总问题数
        return fallbackTotalIssueCount;
    }

    private parseIssueCount(finalReply: string): number {
        const source = String(finalReply || "");
        if (!source.trim()) return 1;

        // 优先解析显式字段：问题个数/问题数量/问题数：N
        const explicitLine = source
            .split(/\r?\n/)
            .map((line) => this.normalizeDecisionLine(line))
            .find((line) => /^(问题个数|问题数量|问题数)\s*[：:]/.test(line));

        if (explicitLine) {
            const normalized = explicitLine.replace(/\s+/g, "");
            const m = normalized.match(/(?:问题个数|问题数量|问题数)[：:](\d+)/);
            if (m) return Number(m[1] || 0);
            if (/(?:问题个数|问题数量|问题数)[：:](?:0|0个?)/.test(normalized)) return 0;
        }

        // 回退：全文提取“问题X个/发现X个问题/问题共X项”等表述。
        const normalized = source.replace(/\s+/g, "");
        const patterns = [
            /(?:问题个数|问题数量|问题数)[：:]?(\d+)/,
            /发现(\d+)个问题/,
            /存在(\d+)个问题/,
            /问题(?:共计|共|合计)?(\d+)(?:个|项)/,
        ];

        for (const pattern of patterns) {
            const match = normalized.match(pattern);
            if (match) return Number(match[1] || 0);
        }

        if (/无问题|没有问题|问题为0|问题=0|问题:0|问题：0/.test(normalized)) {
            return 0;
        }

        // 无法解析时保持保守策略：视为存在问题，促使主Agent继续迭代。
        return 1;
    }
}

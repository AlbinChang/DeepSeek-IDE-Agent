import { AgentService } from "@/services/AgentService.js";
import { AgentTurnEngine } from "@/services/AgentTurnEngine.js";
import { AIProviderFactory } from "@/services/AIProviderFactory.js";
import { HistoryOptimizerService } from "@/services/HistoryOptimizerService.js";
import { MessagePreparationService } from "@/services/MessagePreparationService.js";
import type { ModelProviderConfig } from "@/services/SettingsService.js";
import { config as globalConfig } from "@/config/index.js";
import { getBeijingLogTimePrefix } from "@/utils/TimeUtils.js";

const getTS = () => getBeijingLogTimePrefix();

export type EvaluationDecision =
    | "continue_main_agent"
    | "goal_achieved"
    | "goal_unachievable"
    | "need_user_input";

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
}

export interface EvaluationAgentOutput {
    decision: EvaluationDecision;
    finalReply: string;
    reportContent: string;
    usage: any;
}

/**
 * 评估Agent：
 * - 使用独立 evaluator-agent.json 系统提示词
 * - 仅注入「用户指令 + 主Agent最终回复」作为任务上下文
 * - 复用主Agent同款工具链，支持评估任务 TODO 化与工作区核验
 * - 评估结果通过内存传递，不再写入 .evaluate 文件夹
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
        } = input;

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
            "   - 你与主Agent共享同一套工具能力（含 browser_open / browser_list_sessions / browser_close_all / browser_mcp_list_tools / browser_mcp_call 等浏览器工具）",
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
        const prepareMessages = async (msgs: any[]) => {
            const systemPrompt = await agentService.buildSystemPrompt(
                userId,
                finalLocale,
                "evaluator-agent.json",
                root,
                requestId,
            );
            return MessagePreparationService.buildMessages({
                systemPrompt,
                pinnedUserMessage: evaluationTask,
                pinnedUserPrefix: "",
                incomingMessages: msgs,
            });
        };

        // 与主Agent一致：先走一遍历史压缩入口（评估Agent默认初始为空历史，后续可平滑扩展）
        const historyToOptimize: any[] = [];
        const { messages: optimizedMessages } = await HistoryOptimizerService.getInstance().optimizeHistory(historyToOptimize, userId, root);

        const activeHistory = await prepareMessages(optimizedMessages);
        const toolsMetadata = agentService.getSharedToolsMetadata();

        const client = AIProviderFactory.getClient(providerConfig);

        let turnResultUsage: any = null;
        let finalReply = "";
        let decision: EvaluationDecision = "continue_main_agent";
        let issueCount = 1;
        let p0p1IssueCount = 1;

        try {
            const turnResult = await AgentTurnEngine.runTurns({
                client,
                finalModelId: modelId,
                activeHistory,
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
                maxTurns: globalConfig.agent.maxTurns,
                /** 评估Agent对话旅程独立存放，不污染主Agent持久化历史 */
                skipPersist: true,
            });

            turnResultUsage = turnResult.usage;
            const rawFinalReply = (turnResult.finalAssistantContent || "").trim();
            finalReply = rawFinalReply;
            decision = this.parseDecision(rawFinalReply);
            issueCount = this.parseIssueCount(rawFinalReply);
            p0p1IssueCount = this.parseP0P1IssueCount(rawFinalReply, issueCount);

            // 质量门禁：仅 P0+P1 级别问题阻塞交付，P2/P3 不阻塞。
            if (p0p1IssueCount > 0) {
                decision = "continue_main_agent";
            }
        } catch (err: any) {
            const errMsg = String(err?.message || err || "未知异常").trim();
            decision = "continue_main_agent";
            issueCount = 1;
            p0p1IssueCount = 1;
            finalReply = [
                "## 评估执行异常",
                "",
                `评估Agent在运行过程中出现异常：${errMsg}`,
                "",
                "问题个数：1",
                "执行结论：需要主Agent继续迭代",
            ].join("\n");
            console.error(`${getTS()} [EvaluationAgent] runTurns failed for user: ${userId}`, err);
        }

        const reportContent = finalReply;

        console.log(`${getTS()} [EvaluationAgent] Evaluation finished for user: ${userId}, decision: ${decision}, issueCount: ${issueCount}, p0p1IssueCount: ${p0p1IssueCount}`);

        return {
            decision,
            finalReply,
            reportContent,
            usage: turnResultUsage,
        };
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
            if (normalized.includes("需要主Agent继续迭代")) return "continue_main_agent";
            if (normalized.includes("已经达成目标")) return "goal_achieved";
            if (normalized.includes("条件不满足、目标无法达成") || normalized.includes("无法达成")) return "goal_unachievable";
            if (normalized.includes("需要用户进一步操作或提供信息") || normalized.includes("需要用户操作") || normalized.includes("需要用户提供信息")) {
                return "need_user_input";
            }
        }

        if (!text) return "continue_main_agent";
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

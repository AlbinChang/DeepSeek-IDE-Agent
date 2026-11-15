import { afterEach, describe, expect, it, vi } from "vitest";

import { EvaluationAgentService } from "./EvaluationAgentService.js";
import { AgentService } from "./AgentService.js";
import { AgentTurnEngine } from "./AgentTurnEngine.js";
import { AIProviderFactory } from "./AIProviderFactory.js";
import { HistoryOptimizerService } from "./HistoryOptimizerService.js";
import { SettingsService } from "./SettingsService.js";
import { TodoService } from "./TodoService.js";

afterEach(() => vi.restoreAllMocks());

describe("EvaluationAgentService request gate", () => {
    it("propagates a gate failure instead of returning a successful evaluation", async () => {
        const agentService = AgentService.getInstance();
        vi.spyOn(agentService, "buildSystemPrompt").mockResolvedValue("system");
        vi.spyOn(HistoryOptimizerService.getInstance(), "optimizeHistory").mockResolvedValue({ messages: [] });
        vi.spyOn(AIProviderFactory, "getClient").mockReturnValue({} as ReturnType<typeof AIProviderFactory.getClient>);
        vi.spyOn(AgentTurnEngine, "runTurns").mockImplementation(async (options) => {
            await options.beforeApiRequest?.();
            throw new Error("unreachable");
        });
        await expect(new EvaluationAgentService().runEvaluation({
            agentService,
            root: process.cwd(),
            userId: "workflow-evaluator-test",
            traceId: "trace",
            emit: vi.fn(),
            providerConfig: SettingsService.getDefaultSettings().providers[0],
            modelId: "model",
            thinkingOptions: {},
            userInstruction: "test",
            mainAgentFinalReply: "result",
            persistReport: false,
            beforeApiRequest: async () => { throw new Error("gate failed"); },
        })).rejects.toThrow("gate failed");
    });
});

describe("EvaluationAgentService.parseIssueCount", () => {
    const service = new EvaluationAgentService() as any;

    it("extracts the explicit issue count from the provided evaluation sample", () => {
        const sample = [
            "产出文件 Anthropic_Agent_培训材料.html 满足用户指令的核心要求：36 页幻灯片、31 个 SVG 图形（全部正确闭合）、MD 源文档 16 章全覆盖、内容无重复。SVG 排版布局整体良好，仅 Slide 14 存在 1 处轻微文本重叠。总体目标已达成，剩余问题不构成功能性阻塞。",
            "",
            "问题个数：1",
            "",
            "执行结论：已经达成目标",
        ].join("\n");

        expect(service.parseIssueCount(sample)).toBe(1);
    });

    it("stays conservative when the final reply is empty", () => {
        expect(service.parseIssueCount("")).toBe(1);
    });

    it("does not misread '无法确认' as zero issues", () => {
        const sample = [
            "## 最终判定",
            "",
            "问题个数：无法确认",
            "执行结论：已经达成目标",
        ].join("\n");

        expect(service.parseIssueCount(sample)).toBe(1);
    });

    it("recognizes an explicit zero issue count", () => {
        const sample = [
            "## 最终判定",
            "",
            "问题个数：0",
            "执行结论：已经达成目标",
        ].join("\n");

        expect(service.parseIssueCount(sample)).toBe(0);
    });
});

describe("EvaluationAgentService.parseP0P1IssueCount", () => {
    const service = new EvaluationAgentService() as any;

    it("extracts explicit P0+P1 count when P0+P1=0, total=3 (only P2/P3 issues)", () => {
        const sample = [
            "## 评估报告",
            "",
            "问题个数：3",
            "P0+P1问题个数：0",
            "",
            "执行结论：已经达成目标",
        ].join("\n");

        // P0+P1=0 → quality gate should pass despite 3 total issues
        expect(service.parseP0P1IssueCount(sample, 3)).toBe(0);
    });

    it("extracts explicit P0+P1 count when both exist", () => {
        const sample = [
            "## 评估报告",
            "",
            "问题个数：5",
            "P0+P1问题个数：2",
            "",
            "执行结论：需要主Agent继续迭代",
        ].join("\n");

        expect(service.parseP0P1IssueCount(sample, 5)).toBe(2);
    });

    it("extracts P0P1 count using alternate field name 'P0P1问题个数'", () => {
        const sample = [
            "问题个数：4",
            "P0P1问题个数：1",
            "执行结论：需要主Agent继续迭代",
        ].join("\n");

        expect(service.parseP0P1IssueCount(sample, 4)).toBe(1);
    });

    it("falls back to total issue count when P0+P1 field is missing", () => {
        const sample = [
            "## 评估报告",
            "",
            "问题个数：3",
            "执行结论：已经达成目标",
        ].join("\n");

        // No P0+P1 field → conservative fallback to total=3
        expect(service.parseP0P1IssueCount(sample, 3)).toBe(3);
    });

    it("caps P0+P1 count at total issue count when P0+P1 > total (safety)", () => {
        const sample = [
            "问题个数：2",
            "P0+P1问题个数：5",
            "执行结论：需要主Agent继续迭代",
        ].join("\n");

        // P0+P1=5 > total=2 → cap at 2
        expect(service.parseP0P1IssueCount(sample, 2)).toBe(2);
    });

    it("falls back to total count when reply is empty", () => {
        expect(service.parseP0P1IssueCount("", 3)).toBe(3);
    });

    it("detects P0/P1 from repair checklist as secondary fallback", () => {
        const sample = [
            "## 可直接修复清单",
            "",
            "- (P0) 严重问题：端口冲突",
            "- (P1) 设计问题：配色刺眼",
            "- (P2) 轻微问题：注释缺失",
            "",
            "问题个数：3",
            "执行结论：需要主Agent继续迭代",
        ].join("\n");

        // No explicit P0+P1 field, but checklist has 2 P0/P1 items
        expect(service.parseP0P1IssueCount(sample, 3)).toBe(2);
    });

    it("returns 0 for P0+P1 when explicit field shows 0", () => {
        const sample = [
            "问题个数：2",
            "P0+P1问题个数：0",
            "执行结论：已经达成目标",
        ].join("\n");

        expect(service.parseP0P1IssueCount(sample, 2)).toBe(0);
    });
});

const COMPLETE_GOAL_REPORT = [
    "# 评估Agent的评估报告",
    "",
    "## 核验结论",
    "主Agent产出与用户目标一致，关键文件均已核验。",
    "",
    "问题个数：0",
    "P0+P1问题个数：0",
    "执行结论：已经达成目标",
].join("\n");

function mockEvaluationDependencies() {
    const agentService = AgentService.getInstance();
    vi.spyOn(agentService, "buildSystemPrompt").mockResolvedValue("system");
    vi.spyOn(HistoryOptimizerService.getInstance(), "optimizeHistory").mockResolvedValue({ messages: [] });
    vi.spyOn(AIProviderFactory, "getClient").mockReturnValue({} as ReturnType<typeof AIProviderFactory.getClient>);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    return agentService;
}

function buildEvaluationInput(agentService: AgentService) {
    return {
        agentService,
        root: process.cwd(),
        userId: "evaluation-report-test",
        traceId: "trace",
        emit: vi.fn(),
        providerConfig: SettingsService.getDefaultSettings().providers[0],
        modelId: "model",
        thinkingOptions: {},
        userInstruction: "完成文档",
        mainAgentFinalReply: "已完成",
        persistReport: false,
        skipJournal: true,
        skipTelemetry: true,
    };
}

describe("EvaluationAgentService report integrity", () => {
    const service = new EvaluationAgentService() as any;

    it("treats a heading-only final reply as an incomplete report", () => {
        const integrity = service.inspectReport("# 评估Agent的评估报告\n\n只核验了开头。");
        expect(integrity.complete).toBe(false);
        expect(integrity.hasHeading).toBe(true);
        expect(integrity.hasIssueCount).toBe(false);
        expect(integrity.hasDecision).toBe(false);
    });

    it("requires a repair checklist when the decision asks for another iteration", () => {
        const withoutList = [
            "# 评估Agent的评估报告",
            "",
            "发现若干问题。",
            "",
            "问题个数：2",
            "P0+P1问题个数：1",
            "执行结论：需要主Agent继续迭代",
        ].join("\n");
        expect(service.inspectReport(withoutList).complete).toBe(false);

        const withList = `${withoutList}\n\n## 可直接修复清单\n- (P1) docs/a.md：替换第 3 节`;
        expect(service.inspectReport(withList).complete).toBe(true);
    });

    it("recovers a complete report written into reasoning_content", () => {
        const resolved = service.resolveReport({
            finalAssistantContent: "# 评估Agent的评估报告\n\n只输出了开头。",
            finalAssistantReasoning: COMPLETE_GOAL_REPORT,
            activeHistory: [],
            finishReason: "stop",
        });

        expect(resolved.source).toBe("reasoning");
        expect(resolved.report).toBe(COMPLETE_GOAL_REPORT);
        expect(resolved.integrity.complete).toBe(true);
    });

    it("continues an incomplete report and returns the complete continuation", async () => {
        const agentService = mockEvaluationDependencies();
        const runTurns = vi.spyOn(AgentTurnEngine, "runTurns")
            .mockResolvedValueOnce({
                activeHistory: [{ role: "system", content: "system" }],
                usage: null,
                totalSteps: 1,
                finalAssistantContent: "# 评估Agent的评估报告\n\n只核验了开头。",
                finalAssistantReasoning: "",
                finishReason: "length",
            })
            .mockResolvedValueOnce({
                activeHistory: [],
                usage: null,
                totalSteps: 1,
                finalAssistantContent: COMPLETE_GOAL_REPORT,
                finalAssistantReasoning: "",
                finishReason: "stop",
            });

        const result = await new EvaluationAgentService().runEvaluation(buildEvaluationInput(agentService));

        expect(runTurns).toHaveBeenCalledTimes(2);
        const continuationOptions = runTurns.mock.calls[1][0];
        expect(continuationOptions.forceFinalAnswer).toBe(true);
        expect(continuationOptions.activeHistory.some(
            (message: any) => String(message?.content || "").includes("评估报告续写"),
        )).toBe(true);
        expect(result.decision).toBe("goal_achieved");
        expect(result.finalReply).toBe(COMPLETE_GOAL_REPORT);
    });

    it("forces one continuation when finish_reason=length even if the required fields are present", async () => {
        const agentService = mockEvaluationDependencies();
        const runTurns = vi.spyOn(AgentTurnEngine, "runTurns")
            .mockResolvedValueOnce({
                activeHistory: [],
                usage: null,
                totalSteps: 1,
                finalAssistantContent: COMPLETE_GOAL_REPORT,
                finalAssistantReasoning: "",
                finishReason: "length",
            })
            .mockResolvedValueOnce({
                activeHistory: [],
                usage: null,
                totalSteps: 1,
                finalAssistantContent: COMPLETE_GOAL_REPORT,
                finalAssistantReasoning: "",
                finishReason: "stop",
            });

        const result = await new EvaluationAgentService().runEvaluation(buildEvaluationInput(agentService));

        expect(runTurns).toHaveBeenCalledTimes(2);
        expect(result.decision).toBe("goal_achieved");
        expect(result.finalReply).toBe(COMPLETE_GOAL_REPORT);
    });

    it("merges a continuation that only contains the missing report tail", async () => {
        const agentService = mockEvaluationDependencies();
        const head = "# 评估Agent的评估报告\n\n## 核验结论\n主Agent产出已完成关键核验，未发现阻塞问题。";
        const tail = "问题个数：0\nP0+P1问题个数：0\n执行结论：已经达成目标";
        vi.spyOn(AgentTurnEngine, "runTurns")
            .mockResolvedValueOnce({
                activeHistory: [],
                usage: null,
                totalSteps: 1,
                finalAssistantContent: head,
                finalAssistantReasoning: "",
                finishReason: "length",
            })
            .mockResolvedValueOnce({
                activeHistory: [],
                usage: null,
                totalSteps: 1,
                finalAssistantContent: tail,
                finalAssistantReasoning: "",
                finishReason: "stop",
            });

        const result = await new EvaluationAgentService().runEvaluation(buildEvaluationInput(agentService));

        expect(result.decision).toBe("goal_achieved");
        expect(result.finalReply).toContain("主Agent产出已完成关键核验");
        expect(result.finalReply).toContain("执行结论：已经达成目标");
    });

    it("recovers a truncated report through a real engine continuation", async () => {
        const agentService = mockEvaluationDependencies();
        vi.spyOn(TodoService, "getTodos").mockResolvedValue([]);
        const payloads: any[] = [];
        const create = vi.fn()
            .mockImplementationOnce(async (payload: Record<string, any>) => {
                payloads.push(payload);
                return (async function* () {
                    yield { choices: [{ delta: { content: "# 评估Agent的评估报告\n\n只核验了开头。" } }] };
                    yield { choices: [{ delta: {}, finish_reason: "length" }] };
                })();
            })
            .mockImplementationOnce(async (payload: Record<string, any>) => {
                payloads.push(payload);
                return (async function* () {
                    yield { choices: [{ delta: { content: COMPLETE_GOAL_REPORT }, finish_reason: "stop" }] };
                })();
            });
        vi.spyOn(AIProviderFactory, "getClient").mockReturnValue({
            chat: { completions: { create } },
        } as unknown as ReturnType<typeof AIProviderFactory.getClient>);

        const result = await new EvaluationAgentService().runEvaluation(buildEvaluationInput(agentService));

        expect(create).toHaveBeenCalledTimes(2);
        expect(payloads[1].tool_choice).toBe("none");
        expect(payloads[1].messages).toEqual(expect.arrayContaining([
            expect.objectContaining({ role: "assistant", content: expect.stringContaining("只核验了开头") }),
            expect.objectContaining({ content: expect.stringContaining("评估报告续写") }),
        ]));
        expect(result.decision).toBe("goal_achieved");
        expect(result.finalReply).toBe(COMPLETE_GOAL_REPORT);
    });

    it("returns evaluation_failed instead of driving another repair loop when the report stays incomplete", async () => {
        const agentService = mockEvaluationDependencies();
        const incomplete = {
            activeHistory: [],
            usage: null,
            totalSteps: 1,
            finalAssistantContent: "# 评估Agent的评估报告\n\n只核验了开头。",
            finalAssistantReasoning: "",
            finishReason: "length",
        };
        vi.spyOn(AgentTurnEngine, "runTurns").mockResolvedValue(incomplete);

        const result = await new EvaluationAgentService().runEvaluation(buildEvaluationInput(agentService));

        expect(result.decision).toBe("evaluation_failed");
        expect(result.finalReply).toContain("评估执行异常");
        expect(result.finalReply).toContain("执行结论：评估失败");
        expect(result.finalReply).toContain("臆造问题清单");
    });

    it("marks evaluator exceptions as evaluation_failed", async () => {
        const agentService = mockEvaluationDependencies();
        vi.spyOn(AgentTurnEngine, "runTurns").mockRejectedValueOnce(new Error("gateway closed"));

        const result = await new EvaluationAgentService().runEvaluation(buildEvaluationInput(agentService));

        expect(result.decision).toBe("evaluation_failed");
        expect(result.finalReply).toContain("gateway closed");
        expect(result.finalReply).toContain("执行结论：评估失败");
    });
});
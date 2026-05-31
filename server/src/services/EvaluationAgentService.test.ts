import { describe, expect, it } from "vitest";

import { EvaluationAgentService } from "./EvaluationAgentService.js";

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
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
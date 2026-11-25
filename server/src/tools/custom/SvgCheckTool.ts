import * as fs from 'fs/promises';
import { ToolDefinition } from '@/services/ToolManager.js';
import { PathUtils } from '@/utils/PathUtils.js';
import { FileIO } from '@/utils/FileIO.js';
import { SvgCheckService, SvgCheckReport } from '@/services/SvgCheckService.js';

/**
 * SVG 编译/边界检查工具
 *
 * 大模型生成 SVG 时最常犯的错是坐标算错导致元素画出 viewBox 之外（被裁切）。
 * 本工具不渲染、不依赖浏览器，直接对源码做几何校验，给出越界元素、行号与修正建议。
 */

const DEFAULT_MAX_ISSUES = 20;
const MAX_MAX_ISSUES = 100;
const MESSAGE_CLIP = 200;

function clip(text: string, max: number): string {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max)}…` : value;
}

function formatBox(box: [number, number, number, number] | null): string {
    if (!box) return 'none';
    const round = (value: number) => Math.round(value * 100) / 100;
    return `${round(box[0])},${round(box[1])}→${round(box[2])},${round(box[3])}`;
}

/** 把结构化报告压成模型易读的紧凑文本（比 JSON 省 40%+ token） */
export function formatSvgReport(report: SvgCheckReport, sourceLabel: string): string {
    const header = [
        `[check_svg] ${report.status.toUpperCase()}`,
        sourceLabel,
        `viewBox=${report.viewBox ? report.viewBox.join(' ') : 'missing'}`,
        `content=${formatBox(report.contentBBox)}`,
        `errors=${report.errorCount} warnings=${report.warningCount}`,
        `elements=${report.stats.elements} measured=${report.stats.measured}`,
    ].join(' | ');

    const lines = [header];
    if (report.totalIssues === 0) {
        lines.push('未发现结构问题与边界溢出。');
        return lines.join('\n');
    }

    report.issues.forEach((issue, index) => {
        const where = [
            issue.line ? `L${issue.line}${issue.column ? `:${issue.column}` : ''}` : '',
            issue.element || '',
        ].filter(Boolean).join(' ');
        const approx = issue.approximate ? ' [文本估算]' : '';
        const sides = issue.sides?.length ? ` sides=[${issue.sides.join(',')}]` : '';
        lines.push(`${index + 1}. [${issue.severity}] ${issue.code}${where ? ` ${where}` : ''}${sides}${approx}`);
        lines.push(`   ${clip(issue.message, MESSAGE_CLIP)}`);
        if (issue.bounds) lines.push(`   bounds=${formatBox(issue.bounds)}`);
        if (issue.fix) lines.push(`   fix: ${clip(issue.fix, MESSAGE_CLIP)}`);
    });

    const hidden = report.totalIssues - report.issues.length;
    if (hidden > 0) {
        lines.push(`…另有 ${hidden} 条未显示（先修上面的，或用 maxIssues 调大上限）`);
    }
    return lines.join('\n');
}

export const SvgCheckTool: ToolDefinition = {
    name: 'check_svg',
    description: '静态校验 SVG 是否越出 viewBox（解析 transform/path/图元/文本，不渲染）。新增或修改 .svg 后必调用。',

    parameters: {
        type: 'object',
        properties: {
            path: {
                type: 'string',
                description: '工作区相对路径的 .svg 文件；与 content 二选一，同时提供时以 path 为准',
            },
            content: {
                type: 'string',
                description: '直接传入 SVG 源码（写入文件前预检）',
            },
            tolerance: {
                type: 'number',
                description: '允许的溢出容差（用户单位），默认 0.5',
            },
            includeText: {
                type: 'boolean',
                description: '是否测量 <text> 边界（字宽启发式，近似），默认 true',
            },
            maxIssues: {
                type: 'integer',
                description: `最多返回的问题条数，默认 ${DEFAULT_MAX_ISSUES}、最大 ${MAX_MAX_ISSUES}`,
            },
        },
        required: [],
    },

    execute: async (params, context) => {
        const path = typeof params?.path === 'string' ? params.path.trim() : '';
        const content = typeof params?.content === 'string' ? params.content : '';
        const rawMax = Number(params?.maxIssues);
        const maxIssues = Number.isInteger(rawMax) && rawMax > 0
            ? Math.min(rawMax, MAX_MAX_ISSUES)
            : DEFAULT_MAX_ISSUES;

        const options = {
            tolerance: typeof params?.tolerance === 'number' ? params.tolerance : undefined,
            includeText: params?.includeText === undefined ? undefined : params.includeText !== false,
            maxIssues,
        };

        if (!path && !content.trim()) {
            throw new Error('check_svg 需要提供 path（工作区相对 .svg 路径）或 content（SVG 源码）之一。');
        }

        if (path) {
            const workspaceRoot = context?.workspaceRoot;
            if (!workspaceRoot) {
                throw new Error('Workspace not initialized：无法解析 path，请改用 content 传入 SVG 源码。');
            }
            let fullPath: string;
            try {
                fullPath = PathUtils.resolveReadPath(path, workspaceRoot);
            } catch (error: any) {
                return `[check_svg] ERROR | ${path} | 路径非法：${clip(error?.message || '解析失败', MESSAGE_CLIP)}`;
            }
            let source: string;
            try {
                const raw = await fs.readFile(fullPath);
                source = FileIO.decodeBuffer(raw).content;
            } catch (error: any) {
                return `[check_svg] ERROR | ${path} | 读取失败：${clip(error?.message || '文件不存在或无权限', MESSAGE_CLIP)}`;
            }
            const report = SvgCheckService.checkSource(source, options);
            const extra = content.trim() ? '\n（已忽略 content：path 优先）' : '';
            return formatSvgReport(report, path) + extra;
        }

        const report = SvgCheckService.checkSource(content, options);
        return formatSvgReport(report, 'inline');
    },
};

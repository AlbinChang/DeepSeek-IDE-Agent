import type { IPromptSection, PromptBuildContext } from '@/types/prompt.js';
import { WorkflowRegistry } from '@/workflow/WorkflowRegistry.js';
import type { WorkflowSummary } from '@/workflow/types.js';

const MAX_WORKFLOWS = 20;
const MAX_SUMMARY_CHARS = 120;
const CACHE_TTL_MS = 10_000;

const indexCache = new Map<string, { at: number; workflows: WorkflowSummary[] }>();

function truncate(value: string, maxChars: number): string {
    return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

/**
 * 只注入工作流索引（名称/标题/输入/路径），不注入完整 YAML。
 * 项目没有 .workflow 目录时返回空字符串，对现有提示词零影响。
 */
export class WorkflowIndexSection implements IPromptSection {
    public readonly id = 'workflow-index';
    public readonly priority = 'low-churn' as const;

    public async build(ctx: PromptBuildContext): Promise<string> {
        // 只对主 Agent 注入工作流索引；评估 Agent 等使用独立 prompt 的场景不注入
        if (!ctx.agentConfigFile.includes('main-agent')) return '';
        try {
            const cached = indexCache.get(ctx.workspaceRoot);
            let workflows = cached && Date.now() - cached.at < CACHE_TTL_MS
                ? cached.workflows
                : undefined;
            if (!workflows) {
                workflows = await new WorkflowRegistry(ctx.workspaceRoot).list();
                indexCache.set(ctx.workspaceRoot, { at: Date.now(), workflows });
            }
            if (workflows.length === 0) return '';

            const lines = workflows.slice(0, MAX_WORKFLOWS).map((workflow) => {
                const title = workflow.title && workflow.title !== workflow.name
                    ? `（${workflow.title}）`
                    : '';
                const inputs = workflow.inputs.length > 0
                    ? `；输入: ${workflow.inputs.map((input) => input.name).join(', ')}`
                    : '';
                const summary = workflow.summary
                    ? `：${truncate(workflow.summary, MAX_SUMMARY_CHARS)}`
                    : '';
                return `- ${workflow.name}${title}${summary}${inputs} [${workflow.path}]`;
            });

            return [
                '## 可用工作流（工作区 .workflow/）',
                '需要执行固定流程时，先调用 list_workflows 查看，再用 validate_workflow 校验，最后用 run_workflow 入队；不要凭记忆编造工作流名称。',
                ...lines,
            ].join('\n');
        } catch {
            return '';
        }
    }
}

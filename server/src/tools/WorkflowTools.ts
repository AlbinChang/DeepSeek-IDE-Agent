import type { ToolDefinition, ToolExecutionContext } from '@/services/ToolManager.js';
import { WorkflowService } from '@/workflow/WorkflowService.js';
import type { WorkflowRunRequest } from '@/workflow/types.js';

function resolveScope(context?: ToolExecutionContext): { userId: string; root: string } {
    const userId = typeof context?.userId === 'string' ? context.userId : '';
    const root = typeof context?.workspaceRoot === 'string' ? context.workspaceRoot : '';
    if (!userId) throw new Error('Workflow 工具需要 userId');
    if (!root) throw new Error('Workflow 工具需要 workspaceRoot；请先初始化工作区');
    return { userId, root };
}

function service(): WorkflowService {
    return WorkflowService.getInstance();
}

/**
 * 暴露给 Agent 的 workflow 工具面。
 * 只做参数整理与错误转换，执行逻辑在 WorkflowService/WorkflowEngine。
 */
export class WorkflowTools {
    public static getDefinitions(options: {
        /** 提供已注册工具名，validate_workflow 会做工具链接检查 */
        knownTools?: () => string[];
    } = {}): ToolDefinition[] {
        return [
            {
                name: 'list_workflows',
                description: '列出工作区 .workflow 下的声明式工作流。',
                parameters: {
                    type: 'object',
                    properties: {},
                    additionalProperties: false,
                },
                execute: async (_params, context) => {
                    const { root } = resolveScope(context);
                    const workflows = await service().list(root);
                    return { workflows: workflows.slice(0, 50), truncated: workflows.length > 50 };
                },
            },
            {
                name: 'get_workflow',
                description: '读取工作流完整 YAML、元数据与校验结果。',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: '工作流名称或 .workflow 下的相对路径' },
                    },
                    required: ['name'],
                    additionalProperties: false,
                },
                execute: async (params, context) => {
                    const { root } = resolveScope(context);
                    const name = String(params?.name || '').trim();
                    if (!name) throw new Error('name 不能为空');
                    const workflow = await service().get(root, name);
                    if (!workflow) throw new Error(`Workflow not found: ${name}`);
                    const yamlLimit = 200_000;
                    const yamlTruncated = workflow.yaml.length > yamlLimit;
                    return {
                        ...workflow,
                        yaml: yamlTruncated
                            ? `${workflow.yaml.slice(0, yamlLimit)}\n…[truncated ${workflow.yaml.length - yamlLimit} chars]`
                            : workflow.yaml,
                        yamlTruncated,
                    };
                },
            },
            {
                name: 'validate_workflow',
                description: '编译检查工作流：结构+表达式+引用+权限+schema；deep 校验资产/子工作流；不传 name 校验全部。',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: '可选：工作流名称或相对路径' },
                        strict: { type: 'boolean', description: 'true 时 warning 也算不通过' },
                        deep: { type: 'boolean', description: 'true 时检查资产文件与子工作流是否存在' },
                        maxIssues: { type: 'integer', minimum: 1, maximum: 500, description: '返回问题条数上限，默认 100' },
                        codes: {
                            type: 'array',
                            items: { type: 'string' },
                            description: '只返回指定诊断码（如 steps_ref_unknown）',
                        },
                    },
                    additionalProperties: false,
                },
                execute: async (params, context) => {
                    const { root } = resolveScope(context);
                    const name = typeof params?.name === 'string' && params.name.trim()
                        ? params.name.trim()
                        : undefined;
                    const knownTools = options.knownTools?.() || undefined;
                    const validation = await service().validate(root, name, {
                        knownTools,
                        deep: params?.deep === true,
                        maxIssues: Number.isFinite(Number(params?.maxIssues))
                            ? Number(params.maxIssues)
                            : undefined,
                        codes: Array.isArray(params?.codes)
                            ? params.codes.map(String).filter(Boolean)
                            : undefined,
                    });
                    const strict = params?.strict === true;
                    const issues = validation.issues || [];
                    const infos = validation.infos || [];
                    const errorCount = issues.filter((issue) => issue.severity === 'error').length;
                    const warningCount = issues.filter((issue) => issue.severity === 'warning').length;
                    const infoCount = infos.length;
                    return {
                        validation: {
                            ...validation,
                            ok: errorCount === 0 && (!strict || warningCount === 0),
                            strict,
                            errorCount,
                            warningCount,
                            infoCount,
                        },
                        summary: errorCount === 0 && (!strict || warningCount === 0)
                            ? `✅ 编译通过（warning ${warningCount} / info ${infoCount}）`
                            : `❌ ${errorCount} 个 error${strict ? ` / ${warningCount} 个 warning` : ''}`,
                    };
                },
            },
            {
                name: 'run_workflow',
                description: '入队执行工作流；默认返回 runId，wait=true 时等到终态或审批暂停。',
                parameters: {
                    type: 'object',
                    properties: {
                        name: { type: 'string', description: '工作流名称或相对路径' },
                        inputs: { type: 'object', description: '工作流输入', additionalProperties: true },
                        wait: { type: 'boolean', description: '是否等待运行结束（默认 false）' },
                        timeoutSeconds: { type: 'number', description: 'wait=true 时的最长等待秒数', minimum: 1 },
                        concurrencyGroup: { type: 'string', description: '可选并发组（同组串行）' },
                    },
                    required: ['name'],
                    additionalProperties: false,
                },
                execute: async (params, context) => {
                    const { userId, root } = resolveScope(context);
                    const name = String(params?.name || '').trim();
                    if (!name) throw new Error('name 不能为空');
                    const request: WorkflowRunRequest = {
                        userId,
                        root,
                        name,
                        inputs: params?.inputs && typeof params.inputs === 'object' ? params.inputs : {},
                        wait: params?.wait === true,
                        timeoutSeconds: Number.isFinite(Number(params?.timeoutSeconds))
                            ? Number(params.timeoutSeconds)
                            : undefined,
                        concurrencyGroup: typeof params?.concurrencyGroup === 'string'
                            ? params.concurrencyGroup
                            : undefined,
                    };
                    const result = await service().run(request);
                    if (!result.ok) {
                        throw new Error(result.error || 'workflow run failed to start');
                    }
                    return result;
                },
            },
            {
                name: 'get_workflow_run',
                description: '查询工作流运行状态、步骤、用量、审批与错误。',
                parameters: {
                    type: 'object',
                    properties: {
                        runId: { type: 'string', description: '运行 ID' },
                        includeEvents: { type: 'boolean', description: '是否附带最近事件（默认 false）' },
                    },
                    required: ['runId'],
                    additionalProperties: false,
                },
                execute: async (params, context) => {
                    const { userId, root } = resolveScope(context);
                    const runId = String(params?.runId || '').trim();
                    if (!runId) throw new Error('runId 不能为空');
                    const run = await service().getRun({
                        userId,
                        root,
                        runId,
                        includeEvents: params?.includeEvents === true,
                    });
                    if (!run) throw new Error(`Workflow run not found: ${runId}`);
                    return run;
                },
            },
            {
                name: 'list_workflow_runs',
                description: '列出工作区运行记录（默认最近 50 条）。',
                parameters: {
                    type: 'object',
                    properties: {
                        status: {
                            type: 'string',
                            enum: ['queued', 'running', 'waiting_approval', 'succeeded', 'failed', 'cancelled', 'interrupted'],
                            description: '可选：按状态过滤',
                        },
                    },
                    additionalProperties: false,
                },
                execute: async (params, context) => {
                    const { userId, root } = resolveScope(context);
                    const runs = await service().listRuns({
                        userId,
                        root,
                        status: typeof params?.status === 'string' ? params.status : undefined,
                    });
                    return {
                        runs: runs.slice(0, 50).map((run) => ({
                            runId: run.runId,
                            workflow: run.workflow,
                            status: run.status,
                            createdAt: run.createdAt,
                            startedAt: run.startedAt,
                            finishedAt: run.finishedAt,
                            currentTask: run.currentTask,
                            error: run.error,
                            stepCount: run.steps.length,
                            approval: run.approval,
                            usage: run.usage,
                        })),
                    };
                },
            },
            {
                name: 'cancel_workflow',
                description: '取消排队中、运行中或等待审批的运行。',
                parameters: {
                    type: 'object',
                    properties: {
                        runId: { type: 'string', description: '运行 ID' },
                    },
                    required: ['runId'],
                    additionalProperties: false,
                },
                execute: async (params, context) => {
                    const { userId, root } = resolveScope(context);
                    const runId = String(params?.runId || '').trim();
                    if (!runId) throw new Error('runId 不能为空');
                    const cancelled = await service().cancel({ userId, root, runId });
                    return { cancelled };
                },
            },
            {
                name: 'resume_workflow',
                description: '恢复 waiting_approval 或 interrupted 的运行；审批场景 decision 必填。',
                parameters: {
                    type: 'object',
                    properties: {
                        runId: { type: 'string', description: '运行 ID' },
                        decision: {
                            type: 'string',
                            enum: ['approve', 'reject'],
                            description: '批准继续或拒绝取消；interrupted 运行可省略',
                        },
                        inputs: {
                            type: 'object',
                            description: '恢复运行时重新提供的工作流输入',
                            additionalProperties: true,
                        },
                    },
                    required: ['runId'],
                    additionalProperties: false,
                },
                execute: async (params, context) => {
                    const { userId, root } = resolveScope(context);
                    const runId = String(params?.runId || '').trim();
                    if (!runId) throw new Error('runId 不能为空');
                    const rawDecision = params?.decision;
                    const decision = rawDecision === undefined || rawDecision === null
                        ? undefined
                        : String(rawDecision).trim();
                    if (decision !== undefined && decision !== 'approve' && decision !== 'reject') {
                        throw new Error('decision 必须是 approve 或 reject');
                    }
                    const inputs = params?.inputs;
                    if (inputs !== undefined && (!inputs || typeof inputs !== 'object' || Array.isArray(inputs))) {
                        throw new Error('inputs 必须是对象');
                    }
                    const resumed = await service().resume({ userId, root, runId, decision, ...(inputs ? { inputs } : {}) });
                    if (!resumed) {
                        const run = await service().getRun({ userId, root, runId });
                        throw new Error(run?.error || '工作流当前无法恢复，请检查状态和审批决策');
                    }
                    return { resumed };
                },
            },
        ];
    }
}

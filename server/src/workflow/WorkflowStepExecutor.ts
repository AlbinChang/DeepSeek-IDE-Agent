import { AgentService } from '@/services/AgentService.js';
import { AgentTurnEngine } from '@/services/AgentTurnEngine.js';
import { AIProviderFactory } from '@/services/AIProviderFactory.js';
import { EvaluationAgentService } from '@/services/EvaluationAgentService.js';
import { ProviderConfigResolver, type ResolvedProviderConfig } from '@/services/ProviderConfigResolver.js';
import { config as globalConfig } from '@/config/index.js';
import { WorkflowError } from '@/workflow/errors.js';
import { executeWorkflowHttp } from '@/workflow/httpStep.js';
import { parseDurationMs } from '@/workflow/expressions.js';
import { validateJsonSchema } from '@/workflow/schema.js';
import type {
    WorkflowApprovalState,
    WorkflowUsage,
} from '@/workflow/types.js';
import type { TokenUsage } from '@/utils/TokenUsage.js';

const READONLY_AGENT_TOOLS = [
    'read_skill',
    'read_file',
    'read_file_by_byte',
    'list_files',
    'calculate',
];

const READONLY_EVALUATOR_TOOLS = [
    'read_skill',
    'read_file',
    'read_file_by_byte',
    'list_files',
];

/** 禁止在 workflow 内部递归/管理的工具 */
const FORBIDDEN_WORKFLOW_TOOLS = new Set([
    'list_workflows',
    'get_workflow',
    'validate_workflow',
    'run_workflow',
    'get_workflow_run',
    'cancel_workflow',
    'resume_workflow',
]);

/** v1 禁止 workflow 内部写全局 TODO SSOT */
const FORBIDDEN_TODO_WRITE_TOOLS = new Set(['append_todo', 'update_todo', 'delete_todo']);

const WORKFLOW_STEP_CONTRACT = [
    '',
    '【Workflow 步骤契约】',
    '- 你正在执行一个声明式 workflow 步骤，只能使用当前提供的工具。',
    '- 不要请求未提供的工具，不要调用 run_workflow/resume_workflow/cancel_workflow。',
    '- 忽略系统提示中关于 TODO / 工作流管理的建议；当前步骤不参与这些全局状态。',
    '- 输出会作为后续步骤的输入；请直接给出结果，不要复述无关背景。',
].join('\n');

export interface WorkflowStepExecutionContext {
    runId: string;
    traceId: string;
    userId: string;
    root: string;
    workflowName: string;
    stepPath: string;
    stepName: string;
    abortSignal: AbortSignal;
    inputs: Record<string, unknown>;
    context: Record<string, unknown>;
    provider?: string;
    model?: string;
    reasoningEffort?: 'default' | 'low' | 'high' | 'max';
    locale?: string;
    log: (message: string, data?: Record<string, unknown>) => Promise<void>;
}

export interface WorkflowStepExecutionResult {
    output?: unknown;
    usage?: WorkflowUsage;
    approval?: WorkflowApprovalState;
}

export type WorkflowStepKind = 'agent' | 'tool' | 'shell' | 'http' | 'evaluator' | 'approval';

export interface WorkflowStepExecutor {
    execute(
        kind: WorkflowStepKind,
        definition: Record<string, any>,
        ctx: WorkflowStepExecutionContext,
    ): Promise<WorkflowStepExecutionResult>;
}

export interface DefaultWorkflowStepExecutorOptions {
    agentService?: AgentService;
    resolveProvider?: (
        userId: string,
        root: string,
        provider?: string,
        model?: string,
    ) => ResolvedProviderConfig;
    httpAllowPrivate?: boolean;
    httpMaxResponseBytes?: number;
    httpTimeoutMs?: number;
}

function mergeUsage(current: WorkflowUsage | undefined, next: TokenUsage | null | undefined): WorkflowUsage | undefined {
    if (!next) return current;
    const base = current || { inputTokens: 0, outputTokens: 0, totalTokens: 0 };
    return {
        inputTokens: base.inputTokens + (next.inputTokens || 0),
        outputTokens: base.outputTokens + (next.outputTokens || 0),
        totalTokens: base.totalTokens + (next.totalTokens || 0),
    };
}

function readStringArray(value: unknown): string[] | undefined {
    if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0);
    }
    if (typeof value === 'string' && value.trim()) {
        return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
    }
    return undefined;
}

function positiveInteger(value: unknown): number | undefined {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.floor(parsed);
}

function resolveAgentTools(requested?: string[]): ReadonlySet<string> {
    const tools = new Set(requested && requested.length > 0 ? requested : READONLY_AGENT_TOOLS);
    for (const name of FORBIDDEN_WORKFLOW_TOOLS) tools.delete(name);
    for (const name of FORBIDDEN_TODO_WRITE_TOOLS) tools.delete(name);
    return tools;
}

function resolveEvaluatorTools(requested?: string[]): ReadonlySet<string> {
    const tools = new Set(requested && requested.length > 0 ? requested : READONLY_EVALUATOR_TOOLS);
    for (const name of FORBIDDEN_WORKFLOW_TOOLS) tools.delete(name);
    for (const name of FORBIDDEN_TODO_WRITE_TOOLS) tools.delete(name);
    // evaluator 默认只读；即使显式传入写工具也拒绝
    for (const name of ['file_write', 'delete_path', 'file_replace', 'file_insert', 'file_replace_all', 'run_powershell_command', 'run_cmd_command']) {
        tools.delete(name);
    }
    return tools;
}

function extractOutputSchema(definition: Record<string, any>): any | undefined {
    const output = definition.output;
    if (!output || typeof output !== 'object') return undefined;
    if (output.schema && typeof output.schema === 'object') {
        return output.schema.document && typeof output.schema.document === 'object'
            ? output.schema.document
            : output.schema;
    }
    return undefined;
}

/**
 * 默认步骤执行器：复用现有 AgentTurnEngine / ToolManager / EvaluationAgentService。
 * 不依赖 Electron，可在主进程或 standalone server 中使用。
 */
export class DefaultWorkflowStepExecutor implements WorkflowStepExecutor {
    private agentService: AgentService | null;
    private readonly resolveProvider: NonNullable<DefaultWorkflowStepExecutorOptions['resolveProvider']>;
    private readonly httpAllowPrivate: boolean;
    private readonly httpMaxResponseBytes: number;
    private readonly httpTimeoutMs: number;

    constructor(options: DefaultWorkflowStepExecutorOptions = {}) {
        this.agentService = options.agentService || null;
        this.resolveProvider = options.resolveProvider || ((userId, root, provider, model) => (
            ProviderConfigResolver.resolveForUser(userId, root, provider, model)
        ));
        this.httpAllowPrivate = options.httpAllowPrivate ?? globalConfig.workflow.httpAllowPrivate;
        this.httpMaxResponseBytes = options.httpMaxResponseBytes ?? globalConfig.workflow.httpMaxResponseBytes;
        this.httpTimeoutMs = options.httpTimeoutMs ?? globalConfig.workflow.httpTimeoutMs;
    }

    private getAgentService(): AgentService {
        if (!this.agentService) {
            this.agentService = AgentService.getInstance();
        }
        return this.agentService;
    }

    public async execute(
        kind: WorkflowStepKind,
        definition: Record<string, any>,
        ctx: WorkflowStepExecutionContext,
    ): Promise<WorkflowStepExecutionResult> {
        switch (kind) {
            case 'agent': return this.executeAgent(definition, ctx);
            case 'tool': return this.executeTool(definition, ctx);
            case 'shell': return this.executeShell(definition, ctx);
            case 'http': return this.executeHttp(definition, ctx);
            case 'evaluator': return this.executeEvaluator(definition, ctx);
            case 'approval': return this.executeApproval(definition, ctx);
            default: throw new WorkflowError(`Unsupported workflow step kind: ${String(kind)}`, 'unsupported', ctx.stepPath);
        }
    }

    private async executeAgent(
        definition: Record<string, any>,
        ctx: WorkflowStepExecutionContext,
    ): Promise<WorkflowStepExecutionResult> {
        const withConfig = (definition.with && typeof definition.with === 'object') ? definition.with : {};
        const prompt = withConfig.prompt ?? withConfig.instruction;
        if (typeof prompt !== 'string' || !prompt.trim()) {
            throw new WorkflowError('agent 步骤缺少 with.prompt', 'validation', ctx.stepPath);
        }

        const allowedToolNames = resolveAgentTools(readStringArray(withConfig.tools));
        const agentService = this.getAgentService();
        const toolsMetadata = agentService.getSharedToolsMetadata(allowedToolNames);
        const resolved = this.resolveProvider(
            ctx.userId,
            ctx.root,
            typeof withConfig.provider === 'string' ? withConfig.provider : ctx.provider,
            typeof withConfig.model === 'string' ? withConfig.model : ctx.model,
        );
        const modelId = resolved.modelId;
        const client = AIProviderFactory.getClient(resolved.providerConfig);
        const effort = AIProviderFactory.resolveReasoningEffort(
            resolved.providerConfig,
            (withConfig.reasoningEffort as any) || ctx.reasoningEffort,
        );
        const thinkingOptions = AIProviderFactory.buildThinkingOptions(resolved.providerConfig, effort);

        const systemPrompt = await agentService.buildSystemPrompt(
            ctx.userId,
            ctx.locale || 'zh-CN',
            'workflow-step-agent.json',
            ctx.root,
            undefined,
            prompt,
        );
        const userMessage = { role: 'user', content: prompt };
        const messages = AIProviderFactory.buildProviderSafeMessages([
            { role: 'system', content: `${systemPrompt}${WORKFLOW_STEP_CONTRACT}` },
            userMessage,
        ], resolved.providerConfig);

        let usage: WorkflowUsage | undefined;
        const maxTurns = positiveInteger(withConfig.maxTurns) ?? globalConfig.workflow.agentStepMaxTurns;

        const turnResult = await AgentTurnEngine.runTurns({
            client,
            finalModelId: modelId,
            activeHistory: messages,
            toolsMetadata,
            thinkingOptions,
            agentService,
            root: ctx.root,
            userId: ctx.userId,
            currentTraceId: ctx.traceId,
            optimizedMessages: [],
            lastUserMsgRecord: userMessage,
            prepareMessages: async (history) => history,
            abortSignal: ctx.abortSignal,
            emit: (chunk) => {
                if (chunk?.type === 'stage' && typeof chunk.content === 'string' && chunk.content.trim()) {
                    void ctx.log(chunk.content);
                }
            },
            startTimeStamp: Date.now(),
            totalSteps: 0,
            provider: resolved.providerConfig,
            skipPersist: true,
            skipJournal: true,
            skipTelemetry: true,
            telemetrySink: (turnUsage) => {
                usage = mergeUsage(usage, turnUsage);
            },
            agentStage: '工作流步骤',
            allowedToolNames,
            maxTurns,
            runId: ctx.runId,
            stepPath: ctx.stepPath,
        });

        let output: unknown = turnResult.finalAssistantContent;
        const outputSchema = extractOutputSchema(definition);
        if (outputSchema) {
            let candidate = output;
            if (typeof candidate === 'string') {
                const trimmed = candidate.trim();
                const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
                const jsonText = fenced ? fenced[1] : trimmed;
                try {
                    candidate = JSON.parse(jsonText);
                } catch {
                    // 保留字符串，让 schema 报类型错误
                }
            }
            const issues = validateJsonSchema(candidate, outputSchema);
            if (issues.length > 0) {
                throw new WorkflowError(
                    `agent 步骤输出不满足 output.schema: ${issues.map((issue) => `${issue.path} ${issue.message}`).join('; ')}`,
                    'step',
                    ctx.stepPath,
                    issues,
                );
            }
            output = candidate;
        }

        if (output === undefined || output === null || (typeof output === 'string' && !output.trim())) {
            throw new WorkflowError('agent 步骤未返回有效输出', 'step', ctx.stepPath);
        }

        return { output, usage };
    }

    private async executeTool(
        definition: Record<string, any>,
        ctx: WorkflowStepExecutionContext,
    ): Promise<WorkflowStepExecutionResult> {
        const withConfig = (definition.with && typeof definition.with === 'object') ? definition.with : {};
        const toolName = withConfig.tool ?? withConfig.name;
        if (typeof toolName !== 'string' || !toolName.trim()) {
            throw new WorkflowError('tool 步骤缺少 with.tool', 'validation', ctx.stepPath);
        }
        if (FORBIDDEN_WORKFLOW_TOOLS.has(toolName)) {
            throw new WorkflowError(`workflow 步骤内禁止调用工具: ${toolName}`, 'validation', ctx.stepPath);
        }
        const args = withConfig.args && typeof withConfig.args === 'object' ? withConfig.args : {};

        const output = await this.getAgentService().toolManager.executeTool(
            ctx.userId,
            toolName,
            args,
            ctx.traceId,
            {
                workspaceRoot: ctx.root,
                abortSignal: ctx.abortSignal,
                runId: ctx.runId,
                stepPath: ctx.stepPath,
            },
        );
        return { output };
    }

    private async executeShell(
        definition: Record<string, any>,
        ctx: WorkflowStepExecutionContext,
    ): Promise<WorkflowStepExecutionResult> {
        const shellConfig = definition.run?.shell && typeof definition.run.shell === 'object'
            ? definition.run.shell
            : {};
        const command = shellConfig.command ?? definition.with?.command;
        if (typeof command !== 'string' || !command.trim()) {
            throw new WorkflowError('run.shell 步骤缺少 command', 'validation', ctx.stepPath);
        }
        const environment = (shellConfig.environment
            && typeof shellConfig.environment === 'object'
            && !Array.isArray(shellConfig.environment))
            ? Object.fromEntries(
                Object.entries(shellConfig.environment as Record<string, unknown>)
                    .filter(([, value]) => typeof value === 'string'),
            ) as Record<string, string>
            : undefined;

        const timeoutMs = parseDurationMs(definition.timeout?.after)
            ?? parseDurationMs(definition.with?.timeout)
            ?? negativeToUndefined(definition.with?.timeoutMs)
            ?? globalConfig.workflow.defaultStepTimeoutMs;

        const result: any = await this.getAgentService().toolManager.executeTool(
            ctx.userId,
            'run_powershell_command',
            {
                command,
                timeout: timeoutMs,
                ...(environment && Object.keys(environment).length > 0 ? { environment } : {}),
            },
            ctx.traceId,
            {
                workspaceRoot: ctx.root,
                abortSignal: ctx.abortSignal,
                runId: ctx.runId,
                stepPath: ctx.stepPath,
            },
        );

        const status = result?.status;
        const code = result?.code;
        if (status === 'error' || (code !== undefined && code !== null && code !== 0 && code !== '0')) {
            throw new WorkflowError(
                `shell 步骤失败 (code=${String(code ?? 'unknown')}): ${String(result?.stderr || result?.stdout || '').slice(0, 2000)}`,
                'step',
                ctx.stepPath,
            );
        }
        return { output: result };
    }

    private async executeHttp(
        definition: Record<string, any>,
        ctx: WorkflowStepExecutionContext,
    ): Promise<WorkflowStepExecutionResult> {
        const withConfig = (definition.with && typeof definition.with === 'object')
            ? definition.with
            : ((definition.run?.http && typeof definition.run.http === 'object') ? definition.run.http : {});
        const url = withConfig.url;
        if (typeof url !== 'string' || !url.trim()) {
            throw new WorkflowError('http 步骤缺少 with.url', 'validation', ctx.stepPath);
        }
        const headers = (withConfig.headers && typeof withConfig.headers === 'object' && !Array.isArray(withConfig.headers))
            ? withConfig.headers as Record<string, unknown>
            : undefined;
        const timeoutMs = parseDurationMs(withConfig.timeout)
            ?? parseDurationMs(definition.timeout?.after)
            ?? this.httpTimeoutMs;

        const output = await executeWorkflowHttp({
            url: url.trim(),
            method: typeof withConfig.method === 'string' ? withConfig.method : 'GET',
            headers,
            body: withConfig.body,
            failOnError: withConfig.failOnError === true,
            timeoutMs,
            allowPrivate: this.httpAllowPrivate,
            maxResponseBytes: this.httpMaxResponseBytes,
            abortSignal: ctx.abortSignal,
            stepPath: ctx.stepPath,
        });
        return { output };
    }

    private async executeEvaluator(
        definition: Record<string, any>,
        ctx: WorkflowStepExecutionContext,
    ): Promise<WorkflowStepExecutionResult> {
        const withConfig = (definition.with && typeof definition.with === 'object') ? definition.with : {};
        const target = withConfig.target ?? withConfig.input;
        const targetText = typeof target === 'string'
            ? target
            : (target === undefined ? '' : JSON.stringify(target));
        if (!targetText.trim()) {
            throw new WorkflowError('evaluator 步骤缺少 with.target', 'validation', ctx.stepPath);
        }

        const instruction = typeof withConfig.instruction === 'string' && withConfig.instruction.trim()
            ? withConfig.instruction
            : `请评估 workflow「${ctx.workflowName}」步骤「${ctx.stepName}」的产出是否满足要求。`;
        const allowedToolNames = resolveEvaluatorTools(readStringArray(withConfig.tools));

        const resolved = this.resolveProvider(
            ctx.userId,
            ctx.root,
            typeof withConfig.provider === 'string' ? withConfig.provider : ctx.provider,
            typeof withConfig.model === 'string' ? withConfig.model : ctx.model,
        );
        const client = AIProviderFactory.getClient(resolved.providerConfig);
        const effort = AIProviderFactory.resolveReasoningEffort(
            resolved.providerConfig,
            (withConfig.reasoningEffort as any) || ctx.reasoningEffort,
        );
        const thinkingOptions = AIProviderFactory.buildThinkingOptions(resolved.providerConfig, effort);

        const result = await EvaluationAgentService.getInstance().runEvaluation({
            agentService: this.getAgentService(),
            root: ctx.root,
            userId: ctx.userId,
            traceId: ctx.traceId,
            locale: ctx.locale,
            abortSignal: ctx.abortSignal,
            emit: (chunk) => {
                if (chunk?.type === 'stage' && typeof chunk.content === 'string' && chunk.content.trim()) {
                    void ctx.log(chunk.content);
                }
            },
            providerConfig: resolved.providerConfig,
            modelId: resolved.modelId,
            thinkingOptions,
            userInstruction: instruction,
            mainAgentFinalReply: targetText,
            persistReport: false,
            allowedToolNames,
            skipJournal: true,
            skipTelemetry: true,
            maxTurns: globalConfig.workflow.agentStepMaxTurns,
        });

        if (withConfig.requirePass === true && result.decision !== 'goal_achieved') {
            throw new WorkflowError(
                `evaluator 未通过: ${result.decision}`,
                'step',
                ctx.stepPath,
                { report: result.reportContent },
            );
        }

        return {
            output: {
                decision: result.decision,
                report: result.reportContent,
            },
            usage: result.usage || undefined,
        };
    }

    private async executeApproval(
        definition: Record<string, any>,
        ctx: WorkflowStepExecutionContext,
    ): Promise<WorkflowStepExecutionResult> {
        const withConfig = (definition.with && typeof definition.with === 'object') ? definition.with : {};
        return {
            approval: {
                stepPath: ctx.stepPath,
                message: typeof withConfig.message === 'string' ? withConfig.message : undefined,
                risk: typeof withConfig.risk === 'string' ? withConfig.risk : undefined,
                requestedAt: Date.now(),
            },
        };
    }
}

function negativeToUndefined(value: unknown): number | undefined {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
    return Math.floor(parsed);
}

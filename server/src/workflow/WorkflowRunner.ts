import { config as globalConfig } from '@/config/index.js';
import {
    WorkflowApprovalPause,
    WorkflowBudgetExceededError,
    WorkflowCancelledError,
    WorkflowError,
    WorkflowTimeoutError,
    WorkflowUnsupportedError,
} from '@/workflow/errors.js';
import {
    evaluateExpression,
    parseDurationMs,
    resolveDeep,
    resolveTemplate,
    isForbiddenPropertyKey,
    type WorkflowExpressionContext,
} from '@/workflow/expressions.js';
import { WorkflowRegistry } from '@/workflow/WorkflowRegistry.js';
import type { WorkflowRunChannel } from '@/workflow/WorkflowRunSession.js';
import type { WorkflowStepExecutor, WorkflowStepKind } from '@/workflow/WorkflowStepExecutor.js';
import type {
    WorkflowApprovalState,
    WorkflowExecutableDefinition,
    WorkflowStepInfo,
    WorkflowUsage,
} from '@/workflow/types.js';
import { prepareWorkflowInputs } from '@/workflow/engineUtils.js';

const CALLABLE_KINDS = new Set<WorkflowStepKind>(['agent', 'tool', 'shell', 'http', 'evaluator', 'approval']);

export interface WorkflowRunnerOptions {
    session: WorkflowRunChannel;
    definition: WorkflowExecutableDefinition;
    inputs: Record<string, unknown>;
    executor: WorkflowStepExecutor;
    abortSignal: AbortSignal;
    traceId: string;
    userId: string;
    root: string;
    provider?: string;
    model?: string;
    reasoningEffort?: 'default' | 'low' | 'high' | 'max';
    locale?: string;
    /** 恢复时从顶层 do 的第 N 个步骤继续（审批恢复/中断恢复） */
    startIndex?: number;
    initialContext?: Record<string, unknown>;
    /** 顶层步骤完成后回调，用于持久化 crash/审批恢复所需的 checkpoint */
    onCheckpoint?: (checkpoint: { nextStepIndex: number; context: Record<string, unknown> }) => void | Promise<void>;
    /** 顶层 do 的路径前缀；子工作流使用独立前缀避免步骤路径冲突 */
    basePath?: string;
    /** 子工作流内默认禁止审批（Phase 2 仅支持顶层审批） */
    allowApproval?: boolean;
    /** 子工作流名称栈，用于检测循环引用 */
    workflowStack?: string[];
    /** 当前子工作流嵌套深度 */
    subworkflowDepth?: number;
    maxSubworkflowDepth?: number;
    /** fork/子工作流共享的步骤预算 */
    sharedBudget?: { stepCount: number };
    /** 共享的启动时间；子工作流继承父 run 的 wall-clock 预算 */
    startedAt?: number;
}

interface SequenceOptions {
    depth: number;
    vars: Record<string, unknown>;
    /** 当前作用域上下文；fork 分支使用独立副本 */
    context: Record<string, unknown>;
    /** 当前作用域的取消信号（父步骤超时/取消会传播到嵌套步骤） */
    signal: AbortSignal;
    topLevelIndex?: number;
}

interface SequenceResult {
    lastOutput?: unknown;
    exited?: boolean;
}

export class WorkflowRunner {
    private readonly stepByPath = new Map<string, WorkflowStepInfo>();
    private readonly stepByName = new Map<string, WorkflowStepInfo>();
    private readonly contextValues: Record<string, unknown>;
    private readonly budgetState: { stepCount: number };
    private readonly startedAt: number;
    private readonly maxSteps = globalConfig.workflow.maxSteps;
    private readonly maxWallClockMs = globalConfig.workflow.maxRunDurationMs;
    private readonly defaultStepTimeoutMs = globalConfig.workflow.defaultStepTimeoutMs;
    private readonly maxOutputChars = globalConfig.workflow.maxStepOutputChars;

    constructor(private readonly options: WorkflowRunnerOptions) {
        this.contextValues = Object.assign(Object.create(null), options.initialContext || {});
        this.budgetState = options.sharedBudget || { stepCount: 0 };
        this.startedAt = options.startedAt ?? Date.now();
        for (const step of options.session.snapshot.steps) {
            this.rememberStep(step);
        }
    }

    public async run(): Promise<SequenceResult> {
        try {
            return await this.executeSequence(
                this.options.definition.steps,
                this.options.basePath || '/do',
                { depth: 0, vars: {}, context: this.contextValues, signal: this.options.abortSignal },
                this.options.startIndex ?? 0,
            );
        } catch (error) {
            if (error instanceof WorkflowApprovalPause) throw error;
            if (error instanceof WorkflowCancelledError) throw error;
            if (error instanceof WorkflowError) throw error;
            throw new WorkflowError(
                error instanceof Error ? error.message : String(error),
                'step',
                undefined,
                error,
            );
        }
    }

    /** 供审批暂停时写入 checkpoint */
    public getContextValues(): Record<string, unknown> {
        return { ...this.contextValues };
    }

    private async executeSequence(
        steps: Record<string, any>[],
        basePath: string,
        options: SequenceOptions,
        startIndex = 0,
    ): Promise<SequenceResult> {
        let lastOutput: unknown;
        for (let index = startIndex; index < steps.length; index++) {
            const entry = steps[index];
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                throw new WorkflowError(`步骤 ${basePath}/${index} 不是对象`, 'validation');
            }
            const names = Object.keys(entry);
            if (names.length === 0) {
                throw new WorkflowError(`步骤 ${basePath}/${index} 缺少名称`, 'validation');
            }
            const name = names[0];
            const definition = entry[name];
            if (!definition || typeof definition !== 'object' || Array.isArray(definition)) {
                throw new WorkflowError(`步骤 ${basePath}/${index}/${name} 定义无效`, 'validation');
            }

            const stepPath = `${basePath}/${index}/${name}`;
            const topLevelIndex = options.depth === 0 ? index : undefined;
            const result = await this.executeStep(definition, {
                stepPath,
                name,
                depth: options.depth,
                vars: options.vars,
                context: options.context,
                signal: options.signal,
                topLevelIndex,
            });
            lastOutput = result.output;
            if (result.exited) {
                return { lastOutput, exited: true };
            }
            if (options.depth === 0 && this.options.onCheckpoint) {
                await this.options.onCheckpoint({
                    nextStepIndex: index + 1,
                    context: { ...options.context },
                });
            }
        }
        return { lastOutput };
    }

    private async executeStep(
        definition: Record<string, any>,
        step: {
            stepPath: string;
            name: string;
            depth: number;
            vars: Record<string, unknown>;
            context: Record<string, unknown>;
            signal: AbortSignal;
            topLevelIndex?: number;
        },
    ): Promise<{ output?: unknown; exited?: boolean }> {
        this.assertBudget(step.stepPath);
        const expressionContext = this.buildExpressionContext(step.vars, step.context);
        const timeoutMs = parseDurationMs(definition.timeout?.after) ?? this.defaultStepTimeoutMs;
        const record = this.beginStep(step.stepPath, step.name);
        await this.options.session.patch({ currentTask: step.stepPath });
        await this.options.session.upsertStep(record);
        await this.options.session.emit('step.started', {
            path: step.stepPath,
            id: step.name,
            attempts: record.attempts,
        });

        try {
            const result = await this.withTimeout(
                (signal) => this.executeKind(definition, {
                    ...step,
                    signal,
                    expressionContext,
                }),
                timeoutMs,
                step.signal,
                step.stepPath,
            );

            if (result.approval) {
                if (this.options.allowApproval === false
                    || step.depth > 0
                    || step.topLevelIndex === undefined) {
                    throw new WorkflowUnsupportedError(
                        '审批步骤仅支持顶层 do；子工作流/嵌套审批暂不支持',
                        step.stepPath,
                    );
                }
                record.status = 'waiting_approval';
                record.finishedAt = Date.now();
                this.rememberStep(record);
                await this.options.session.upsertStep(record);
                await this.options.session.emit('run.waiting_approval', {
                    path: step.stepPath,
                    message: result.approval.message,
                    risk: result.approval.risk,
                });
                throw new WorkflowApprovalPause(result.approval, step.topLevelIndex!);
            }

            record.status = 'succeeded';
            record.finishedAt = Date.now();
            record.output = this.options.session.sanitizeOutput(result.output);
            record.outputPreview = this.options.session.previewOutput(result.output);
            if (result.usage) {
                record.usage = result.usage;
                await this.options.session.addUsage(result.usage);
            }
            this.rememberStep(record);
            await this.options.session.upsertStep(record);
            await this.options.session.emit('step.output', {
                path: step.stepPath,
                id: step.name,
                preview: truncate(record.outputPreview || '', 500),
            });

            return {
                output: result.output,
                exited: definition.then === 'exit',
            };
        } catch (error: any) {
            if (error instanceof WorkflowApprovalPause) throw error;
            const cancelled = error instanceof WorkflowCancelledError
                || this.options.abortSignal.aborted;
            record.status = cancelled ? 'cancelled' : 'failed';
            record.finishedAt = Date.now();
            record.error = error?.message || String(error);
            this.rememberStep(record);
            await this.options.session.upsertStep(record);
            await this.options.session.emit(cancelled ? 'step.cancelled' : 'step.failed', {
                path: step.stepPath,
                id: step.name,
                error: record.error,
            });
            throw error;
        }
    }

    private async executeKind(
        definition: Record<string, any>,
        step: {
            stepPath: string;
            name: string;
            depth: number;
            vars: Record<string, unknown>;
            context: Record<string, unknown>;
            signal: AbortSignal;
            expressionContext: WorkflowExpressionContext;
        },
    ): Promise<{ output?: unknown; usage?: WorkflowUsage; approval?: WorkflowApprovalState }> {
        const call = definition.call;
        if (typeof call === 'string') {
            if (call === 'workflow') {
                return this.executeSubworkflow(definition, step);
            }
            const kind = call as WorkflowStepKind;
            if (!CALLABLE_KINDS.has(kind)) {
                throw new WorkflowUnsupportedError(`不支持的 call: ${call}`, step.stepPath);
            }
            return this.executeCallable(kind, definition, step);
        }

        if (definition.run !== undefined) {
            if (definition.run?.shell !== undefined) {
                return this.executeCallable('shell', definition, step);
            }
            if (definition.run?.http !== undefined) {
                return this.executeCallable('http', definition, step);
            }
            if (definition.run?.workflow !== undefined) {
                return this.executeSubworkflow(definition, step);
            }
            throw new WorkflowUnsupportedError(
                '仅支持 run.shell / run.http / run.workflow；run.script/run.container 尚未启用',
                step.stepPath,
            );
        }

        if (definition.set !== undefined) {
            const resolved = resolveDeep(definition.set, step.expressionContext);
            if (resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
                for (const [key, value] of Object.entries(resolved as Record<string, unknown>)) {
                    if (isForbiddenPropertyKey(key)) continue;
                    step.context[key] = value;
                }
            }
            return { output: resolved };
        }

        if (definition.switch !== undefined) {
            return this.executeSwitch(definition, step);
        }

        if (definition.for !== undefined) {
            return this.executeFor(definition, step);
        }

        if (definition.try !== undefined) {
            return this.executeTry(definition, step);
        }

        if (definition.fork !== undefined) {
            return this.executeFork(definition, step);
        }

        if (definition.wait !== undefined) {
            const waitValue = typeof definition.wait === 'object' && definition.wait !== null
                ? (definition.wait.duration ?? definition.wait)
                : definition.wait;
            const durationMs = parseDurationMs(resolveDeep(waitValue, step.expressionContext));
            if (durationMs === undefined) {
                throw new WorkflowError('wait 步骤缺少有效时长', 'validation', step.stepPath);
            }
            await this.sleep(durationMs, step.signal);
            return { output: { waitedMs: durationMs } };
        }

        if (definition.raise !== undefined) {
            const raise = resolveDeep(definition.raise, step.expressionContext);
            const message = typeof raise === 'string'
                ? raise
                : (raise?.error?.message || raise?.message || 'Workflow raised an error');
            const type = typeof raise === 'object' && raise?.error?.type
                ? String(raise.error.type).split('/').pop()
                : undefined;
            throw new WorkflowError(String(message), type === 'timeout' ? 'timeout' : 'step', step.stepPath, raise);
        }

        if (definition.emit !== undefined || definition.listen !== undefined) {
            await this.options.session.emit('run.log', {
                path: step.stepPath,
                message: 'emit/listen 在 v1 暂不支持，已忽略',
            });
            return { output: undefined };
        }

        throw new WorkflowUnsupportedError('无法识别的步骤类型', step.stepPath);
    }

    private async executeCallable(
        kind: WorkflowStepKind,
        definition: Record<string, any>,
        step: {
            stepPath: string;
            name: string;
            signal: AbortSignal;
            context: Record<string, unknown>;
            expressionContext: WorkflowExpressionContext;
        },
    ): Promise<{ output?: unknown; usage?: WorkflowUsage; approval?: WorkflowApprovalState }> {
        const resolvedDefinition = this.resolveCallableDefinition(kind, definition, step.expressionContext);
        return this.options.executor.execute(kind, resolvedDefinition, {
            runId: this.options.session.runId,
            traceId: this.options.traceId,
            userId: this.options.userId,
            root: this.options.root,
            workflowName: this.options.definition.summary.name,
            stepPath: step.stepPath,
            stepName: step.name,
            abortSignal: step.signal,
            inputs: this.options.inputs,
            context: { ...step.context },
            provider: this.options.provider,
            model: this.options.model,
            reasoningEffort: this.options.reasoningEffort,
            locale: this.options.locale,
            log: async (message, data) => {
                await this.options.session.emit('step.log', {
                    path: step.stepPath,
                    message,
                    ...(data || {}),
                });
            },
        });
    }

    private resolveCallableDefinition(
        kind: WorkflowStepKind,
        definition: Record<string, any>,
        ctx: WorkflowExpressionContext,
    ): Record<string, any> {
        const clone: Record<string, any> = { ...definition };
        if (definition.with !== undefined) {
            clone.with = resolveDeep(definition.with, ctx);
        }
        if (definition.run !== undefined) {
            clone.run = resolveDeep(definition.run, ctx);
        }
        if (definition.output !== undefined) {
            clone.output = resolveDeep(definition.output, ctx);
        }
        if (definition.timeout !== undefined) {
            clone.timeout = resolveDeep(definition.timeout, ctx);
        }
        return clone;
    }

    private async executeSwitch(
        definition: Record<string, any>,
        step: {
            stepPath: string;
            depth: number;
            vars: Record<string, unknown>;
            context: Record<string, unknown>;
            signal: AbortSignal;
            expressionContext: WorkflowExpressionContext;
        },
    ): Promise<{ output?: unknown }> {
        const rawCases = Array.isArray(definition.switch)
            ? definition.switch
            : (Array.isArray(definition.switch?.cases) ? definition.switch.cases : []);
        let defaultCase: any;

        for (let caseIndex = 0; caseIndex < rawCases.length; caseIndex++) {
            const entry = rawCases[caseIndex];
            if (!entry || typeof entry !== 'object') continue;
            if (entry.default !== undefined) {
                defaultCase = entry.default;
                continue;
            }
            if (entry.when === undefined) continue;
            const condition = this.evaluateCondition(entry.when, step.expressionContext);
            if (!condition) continue;
            const doSteps = Array.isArray(entry.do) ? entry.do : [];
            const result = await this.executeSequence(
                doSteps,
                `${step.stepPath}/case-${caseIndex}/do`,
                { depth: step.depth + 1, vars: step.vars, context: step.context, signal: step.signal },
            );
            return { output: result.lastOutput };
        }

        if (defaultCase) {
            const doSteps = Array.isArray(defaultCase)
                ? defaultCase
                : (Array.isArray(defaultCase.do) ? defaultCase.do : []);
            const result = await this.executeSequence(
                doSteps,
                `${step.stepPath}/default/do`,
                { depth: step.depth + 1, vars: step.vars, context: step.context, signal: step.signal },
            );
            return { output: result.lastOutput };
        }

        return { output: undefined };
    }

    private async executeFor(
        definition: Record<string, any>,
        step: {
            stepPath: string;
            depth: number;
            vars: Record<string, unknown>;
            context: Record<string, unknown>;
            signal: AbortSignal;
            expressionContext: WorkflowExpressionContext;
        },
    ): Promise<{ output?: unknown }> {
        const forConfig = (definition.for && typeof definition.for === 'object') ? definition.for : {};
        const each = typeof forConfig.each === 'string' ? forConfig.each : 'item';
        const at = typeof forConfig.at === 'string' ? forConfig.at : 'index';
        const rawCollection = resolveDeep(forConfig.in, step.expressionContext);
        const collection = normalizeCollection(rawCollection);
        const doSteps = Array.isArray(definition.do) ? definition.do : [];
        const outputs: unknown[] = [];
        const whileExpression = forConfig.while ?? definition.while;

        for (let index = 0; index < collection.length; index++) {
            if (step.signal.aborted) throw new WorkflowCancelledError('Workflow cancelled', step.stepPath);
            const vars = { ...step.vars, [each]: collection[index], [at]: index };
            if (whileExpression !== undefined) {
                const condition = this.evaluateCondition(whileExpression, this.buildExpressionContext(vars, step.context));
                if (!condition) break;
            }
            const result = await this.executeSequence(
                doSteps,
                `${step.stepPath}/iter-${index}/do`,
                { depth: step.depth + 1, vars, context: step.context, signal: step.signal },
            );
            outputs.push(result.lastOutput);
            if (result.exited) break;
        }

        return { output: outputs };
    }

    private async executeTry(
        definition: Record<string, any>,
        step: {
            stepPath: string;
            depth: number;
            vars: Record<string, unknown>;
            context: Record<string, unknown>;
            signal: AbortSignal;
            expressionContext: WorkflowExpressionContext;
        },
    ): Promise<{ output?: unknown }> {
        const trySteps = Array.isArray(definition.try)
            ? definition.try
            : (Array.isArray(definition.try?.do) ? definition.try.do : []);
        const catchConfig = (definition.catch && typeof definition.catch === 'object') ? definition.catch : undefined;
        const catchSteps = Array.isArray(catchConfig?.do)
            ? catchConfig.do
            : (Array.isArray(catchConfig) ? catchConfig : []);
        const retryLimit = Math.max(0, Number(
            catchConfig?.retry?.limit?.attempt?.count
            ?? catchConfig?.retry?.limit?.attempt
            ?? catchConfig?.retry?.limit?.count
            ?? 0,
        ) || 0);
        const retryDelay = parseDurationMs(catchConfig?.retry?.delay) ?? 1000;
        const exponential = Boolean(catchConfig?.retry?.backoff?.exponential);
        const errorFilter = catchConfig?.errors?.with?.type;

        let lastError: any;
        for (let attempt = 0; attempt <= retryLimit; attempt++) {
            try {
                const result = await this.executeSequence(
                    trySteps,
                    `${step.stepPath}/try`,
                    { depth: step.depth + 1, vars: step.vars, context: step.context, signal: step.signal },
                );
                return { output: result.lastOutput };
            } catch (error: any) {
                if (error instanceof WorkflowApprovalPause || error instanceof WorkflowCancelledError) throw error;
                if (error instanceof WorkflowBudgetExceededError) throw error;
                if (!this.matchesErrorFilter(error, errorFilter)) throw error;
                lastError = error;
                if (attempt >= retryLimit) break;
                await this.options.session.emit('step.retried', {
                    path: step.stepPath,
                    attempt: attempt + 1,
                    error: error?.message || String(error),
                });
                const delay = exponential ? retryDelay * Math.pow(2, attempt) : retryDelay;
                await this.sleep(delay, step.signal);
            }
        }

        if (catchSteps.length > 0) {
            const vars = {
                ...step.vars,
                error: {
                    message: lastError?.message || String(lastError),
                    type: lastError?.type || 'step',
                },
            };
            const result = await this.executeSequence(
                catchSteps,
                `${step.stepPath}/catch`,
                { depth: step.depth + 1, vars, context: step.context, signal: step.signal },
            );
            return { output: result.lastOutput };
        }

        throw lastError;
    }

    private async executeFork(
        definition: Record<string, any>,
        step: {
            stepPath: string;
            depth: number;
            vars: Record<string, unknown>;
            context: Record<string, unknown>;
            signal: AbortSignal;
        },
    ): Promise<{ output?: unknown }> {
        const forkConfig = (definition.fork && typeof definition.fork === 'object' && !Array.isArray(definition.fork))
            ? definition.fork
            : {};
        const rawBranches: unknown[] = Array.isArray(definition.fork)
            ? definition.fork
            : (Array.isArray(forkConfig.branches) ? forkConfig.branches : []);
        if (rawBranches.length === 0) {
            throw new WorkflowError('fork 缺少 branches', 'validation', step.stepPath);
        }
        const compete = forkConfig.compete === true;
        const branches = rawBranches.map((branch: unknown, index: number) => {
            const record = (branch && typeof branch === 'object' && !Array.isArray(branch))
                ? branch as Record<string, any>
                : undefined;
            const branchSteps = Array.isArray(branch)
                ? branch
                : (Array.isArray(record?.do) ? record.do : [branch]);
            return {
                index,
                steps: branchSteps as Record<string, any>[],
                context: Object.assign(Object.create(null), step.context),
                controller: new AbortController(),
            };
        });

        const onParentAbort = () => {
            for (const branch of branches) {
                if (!branch.controller.signal.aborted) {
                    branch.controller.abort(step.signal.reason
                        || new WorkflowCancelledError('Workflow cancelled', step.stepPath));
                }
            }
        };
        if (step.signal.aborted) onParentAbort();
        else step.signal.addEventListener('abort', onParentAbort, { once: true });

        try {
            const outcomes = await new Promise<Array<
                | { status: 'fulfilled'; index: number; output: unknown; branch: typeof branches[number] }
                | { status: 'rejected'; index: number; reason: unknown }
            >>((resolve) => {
                const results: Array<any> = [];
                let winner: number | undefined;
                for (const branch of branches) {
                    void this.executeSequence(
                        branch.steps,
                        `${step.stepPath}/branch-${branch.index}/do`,
                        {
                            depth: step.depth + 1,
                            vars: { ...step.vars },
                            context: branch.context,
                            signal: branch.controller.signal,
                        },
                    ).then(
                        (value) => {
                            results.push({
                                status: 'fulfilled',
                                index: branch.index,
                                output: value.lastOutput,
                                branch,
                            });
                            if (winner === undefined && compete) {
                                winner = branch.index;
                                for (const other of branches) {
                                    if (other.index !== branch.index && !other.controller.signal.aborted) {
                                        other.controller.abort(new WorkflowCancelledError(
                                            'fork.compete 其他分支已完成',
                                            step.stepPath,
                                        ));
                                    }
                                }
                            }
                        },
                        (reason) => {
                            results.push({ status: 'rejected', index: branch.index, reason });
                        },
                    ).finally(() => {
                        if (results.length === branches.length) resolve(results as any);
                    });
                }
                if (branches.length === 0) resolve([]);
            });

            if (step.signal.aborted) {
                throw step.signal.reason || new WorkflowCancelledError('Workflow cancelled', step.stepPath);
            }

            outcomes.sort((left, right) => left.index - right.index);

            if (compete) {
                const winner = outcomes.find((entry) => entry.status === 'fulfilled');
                if (!winner || winner.status !== 'fulfilled') {
                    const failed = outcomes.find((entry) => entry.status === 'rejected');
                    const reason = failed && failed.status === 'rejected' ? failed.reason : undefined;
                    throw reason instanceof Error
                        ? reason
                        : new WorkflowError('fork 所有分支均失败', 'step', step.stepPath);
                }
                Object.assign(step.context, winner.branch.context);
                return { output: winner.output };
            }

            const failure = outcomes.find((entry) => entry.status === 'rejected');
            if (failure && failure.status === 'rejected') {
                throw failure.reason instanceof Error
                    ? failure.reason
                    : new WorkflowError(String(failure.reason), 'step', step.stepPath);
            }

            const outputs: unknown[] = [];
            for (const entry of outcomes) {
                if (entry.status !== 'fulfilled') continue;
                outputs.push(entry.output);
                // 分支内 set 的结果按声明顺序合并回父上下文
                Object.assign(step.context, entry.branch.context);
            }
            return { output: outputs };
        } finally {
            step.signal.removeEventListener('abort', onParentAbort);
        }
    }

    private async executeSubworkflow(
        definition: Record<string, any>,
        step: {
            stepPath: string;
            name: string;
            context: Record<string, unknown>;
            signal: AbortSignal;
            expressionContext: WorkflowExpressionContext;
        },
    ): Promise<{ output?: unknown }> {
        const resolvedDefinition = this.resolveCallableDefinition('agent', definition, step.expressionContext);
        const source = resolvedDefinition.run?.workflow ?? resolvedDefinition.with;
        let target: string | undefined;
        let rawInputs: unknown;
        if (typeof source === 'string') {
            target = source;
        } else if (source && typeof source === 'object') {
            const record = source as Record<string, unknown>;
            if (typeof record.name === 'string') target = record.name;
            else if (typeof record.workflow === 'string') target = record.workflow;
            rawInputs = record.inputs ?? record.input;
        }
        if (rawInputs === undefined && resolvedDefinition.with && typeof resolvedDefinition.with === 'object') {
            const withConfig = resolvedDefinition.with as Record<string, unknown>;
            rawInputs = withConfig.inputs ?? withConfig.input;
        }
        if (!target || !target.trim()) {
            throw new WorkflowError('子工作流步骤缺少 name', 'validation', step.stepPath);
        }

        const stack = this.options.workflowStack || [
            this.options.definition.summary.name,
            this.options.definition.summary.path,
        ].filter(Boolean);
        const depth = this.options.subworkflowDepth || 0;
        const maxDepth = this.options.maxSubworkflowDepth ?? globalConfig.workflow.maxSubworkflowDepth;
        if (depth >= maxDepth) {
            throw new WorkflowError(
                `子工作流嵌套超过上限 ${maxDepth}`,
                'validation',
                step.stepPath,
            );
        }

        const registry = new WorkflowRegistry(this.options.root);
        const nestedDefinition = await registry.loadDefinition(target.trim());
        if (!nestedDefinition) {
            throw new WorkflowError(`子工作流不存在: ${target}`, 'validation', step.stepPath);
        }
        if (!nestedDefinition.validation.ok) {
            throw new WorkflowError(
                `子工作流校验失败: ${target}`,
                'validation',
                step.stepPath,
                nestedDefinition.validation.issues,
            );
        }
        if (stack.includes(nestedDefinition.summary.name)
            || stack.includes(nestedDefinition.summary.path)) {
            throw new WorkflowError(
                `检测到循环子工作流: ${[...stack, nestedDefinition.summary.name].join(' -> ')}`,
                'validation',
                step.stepPath,
            );
        }

        const prepared = prepareWorkflowInputs(
            nestedDefinition,
            rawInputs && typeof rawInputs === 'object' && !Array.isArray(rawInputs)
                ? rawInputs as Record<string, unknown>
                : {},
        );
        if (!prepared.ok) {
            throw new WorkflowError(prepared.error, 'validation', step.stepPath);
        }

        const nestedRunner = new WorkflowRunner({
            session: this.options.session,
            definition: nestedDefinition,
            inputs: prepared.inputs,
            executor: this.options.executor,
            abortSignal: step.signal,
            traceId: `${this.options.traceId}/sub/${nestedDefinition.summary.name}`,
            userId: this.options.userId,
            root: this.options.root,
            provider: this.options.provider,
            model: this.options.model,
            reasoningEffort: this.options.reasoningEffort,
            locale: this.options.locale,
            basePath: `${step.stepPath}/subworkflow/do`,
            allowApproval: false,
            workflowStack: [
                ...stack,
                nestedDefinition.summary.name,
                nestedDefinition.summary.path,
            ].filter(Boolean),
            subworkflowDepth: depth + 1,
            maxSubworkflowDepth: maxDepth,
            sharedBudget: this.budgetState,
            startedAt: this.startedAt,
        });
        const result = await nestedRunner.run();
        return { output: result.lastOutput };
    }

    private evaluateCondition(value: unknown, ctx: WorkflowExpressionContext): boolean {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number') return value !== 0;
        if (typeof value === 'string') {
            const trimmed = value.trim();
            if (!trimmed) return false;
            if (trimmed.startsWith('${')) {
                return Boolean(resolveTemplate(trimmed, ctx));
            }
            try {
                return Boolean(evaluateExpression(trimmed, ctx));
            } catch {
                return Boolean(trimmed);
            }
        }
        return Boolean(value);
    }

    private matchesErrorFilter(error: any, filter: unknown): boolean {
        if (filter === undefined || filter === null || filter === '' || filter === '*') return true;
        const filters = Array.isArray(filter) ? filter : [filter];
        const message = String(error?.message || '');
        const type = String(error?.type || '');
        return filters.some((entry) => {
            const text = String(entry);
            if (text.endsWith('/all') || text === '*') return true;
            const suffix = text.split('/').pop() || text;
            return suffix === type || message.includes(text) || message.includes(suffix);
        });
    }

    private buildExpressionContext(
        vars: Record<string, unknown> = {},
        context: Record<string, unknown> = this.contextValues,
    ): WorkflowExpressionContext {
        const steps: WorkflowExpressionContext['steps'] = Object.create(null);
        for (const [name, record] of this.stepByName) {
            if (isForbiddenPropertyKey(name)) continue;
            steps[name] = {
                status: record.status,
                output: record.output,
                error: record.error,
            };
        }
        return {
            inputs: this.options.inputs,
            env: buildMaskedEnv(),
            workspace: this.options.root,
            run: {
                id: this.options.session.runId,
                traceId: this.options.traceId,
            },
            steps,
            context,
            vars,
        };
    }

    private beginStep(path: string, name: string): WorkflowStepInfo {
        const existing = this.stepByPath.get(path);
        const record: WorkflowStepInfo = {
            path,
            name,
            status: 'running',
            attempts: (existing?.attempts || 0) + 1,
            startedAt: Date.now(),
        };
        this.rememberStep(record);
        return record;
    }

    private rememberStep(record: WorkflowStepInfo): void {
        this.stepByPath.set(record.path, record);
        this.stepByName.set(record.name, record);
    }

    private assertBudget(stepPath: string): void {
        this.budgetState.stepCount++;
        if (this.budgetState.stepCount > this.maxSteps) {
            throw new WorkflowBudgetExceededError(
                `Workflow 超过最大步骤数 ${this.maxSteps}`,
                stepPath,
            );
        }
        if (Date.now() - this.startedAt > this.maxWallClockMs) {
            throw new WorkflowBudgetExceededError(
                `Workflow 超过最大执行时长 ${this.maxWallClockMs}ms`,
                stepPath,
            );
        }
        if (this.options.abortSignal.aborted) {
            throw new WorkflowCancelledError('Workflow cancelled', stepPath);
        }
    }

    private async withTimeout<T>(
        run: (signal: AbortSignal) => Promise<T>,
        timeoutMs: number,
        parentSignal: AbortSignal,
        stepPath: string,
    ): Promise<T> {
        if (parentSignal.aborted) throw new WorkflowCancelledError('Workflow cancelled', stepPath);

        const controller = new AbortController();
        const onAbort = () => controller.abort(new WorkflowCancelledError('Workflow cancelled', stepPath));
        parentSignal.addEventListener('abort', onAbort, { once: true });
        if (parentSignal.aborted) onAbort();

        const timer = setTimeout(() => {
            controller.abort(new WorkflowTimeoutError(
                `步骤超时（>${timeoutMs}ms）`,
                stepPath,
            ));
        }, timeoutMs);

        try {
            return await Promise.race([
                run(controller.signal),
                new Promise<never>((_resolve, reject) => {
                    controller.signal.addEventListener('abort', () => {
                        reject(controller.signal.reason ?? new WorkflowCancelledError('Workflow cancelled', stepPath));
                    }, { once: true });
                }),
            ]);
        } finally {
            clearTimeout(timer);
            parentSignal.removeEventListener('abort', onAbort);
        }
    }

    private async sleep(ms: number, signal: AbortSignal): Promise<void> {
        if (ms <= 0) return;
        if (signal.aborted) throw new WorkflowCancelledError('Workflow cancelled');
        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            }, ms);
            const onAbort = () => {
                clearTimeout(timer);
                reject(new WorkflowCancelledError('Workflow cancelled'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
    }
}

function normalizeCollection(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    if (typeof value === 'string') {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) return parsed;
        } catch {
            // ignore
        }
        return value ? value.split(',') : [];
    }
    if (value && typeof value === 'object') return Object.values(value as Record<string, unknown>);
    if (value === undefined || value === null) return [];
    return [value];
}

function truncate(value: string, maxChars: number): string {
    return value.length <= maxChars ? value : `${value.slice(0, maxChars)}…`;
}

function buildMaskedEnv(): Record<string, string | undefined> {
    const result: Record<string, string | undefined> = {};
    for (const [key, value] of Object.entries(process.env)) {
        if (value === undefined) continue;
        result[key] = /key|token|secret|password|credential/i.test(key) ? '******' : value;
    }
    return result;
}

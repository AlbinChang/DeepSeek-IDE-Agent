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
import type { WorkflowRunSession } from '@/workflow/WorkflowRunSession.js';
import type { WorkflowStepExecutor, WorkflowStepKind } from '@/workflow/WorkflowStepExecutor.js';
import type {
    WorkflowApprovalState,
    WorkflowDefinition,
    WorkflowStepInfo,
    WorkflowUsage,
} from '@/workflow/types.js';

const CALLABLE_KINDS = new Set<WorkflowStepKind>(['agent', 'tool', 'shell', 'evaluator', 'approval']);

export interface WorkflowRunnerOptions {
    session: WorkflowRunSession;
    definition: WorkflowDefinition;
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
    /** 恢复时从顶层 do 的第 N 个步骤继续（审批恢复） */
    startIndex?: number;
    initialContext?: Record<string, unknown>;
}

interface SequenceOptions {
    depth: number;
    vars: Record<string, unknown>;
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
    private stepCount = 0;
    private readonly startedAt = Date.now();
    private readonly maxSteps = globalConfig.workflow.maxSteps;
    private readonly maxWallClockMs = globalConfig.workflow.maxRunDurationMs;
    private readonly defaultStepTimeoutMs = globalConfig.workflow.defaultStepTimeoutMs;
    private readonly maxOutputChars = globalConfig.workflow.maxStepOutputChars;

    constructor(private readonly options: WorkflowRunnerOptions) {
        this.contextValues = Object.assign(Object.create(null), options.initialContext || {});
        for (const step of options.session.snapshot.steps) {
            this.rememberStep(step);
        }
    }

    public async run(): Promise<SequenceResult> {
        try {
            return await this.executeSequence(
                this.options.definition.steps,
                '/do',
                { depth: 0, vars: {} },
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
                topLevelIndex,
            });
            lastOutput = result.output;
            if (result.exited) {
                return { lastOutput, exited: true };
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
            topLevelIndex?: number;
        },
    ): Promise<{ output?: unknown; exited?: boolean }> {
        this.assertBudget(step.stepPath);
        const expressionContext = this.buildExpressionContext(step.vars);
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
                this.options.abortSignal,
                step.stepPath,
            );

            if (result.approval) {
                if (step.depth > 0 || step.topLevelIndex === undefined) {
                    throw new WorkflowUnsupportedError(
                        '审批步骤 Phase 1 仅支持顶层 do；嵌套审批将在 Phase 2 支持',
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
            signal: AbortSignal;
            expressionContext: WorkflowExpressionContext;
        },
    ): Promise<{ output?: unknown; usage?: WorkflowUsage; approval?: WorkflowApprovalState }> {
        const call = definition.call;
        if (typeof call === 'string') {
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
            throw new WorkflowUnsupportedError(
                '仅支持 run.shell；run.workflow/run.script/run.container 尚未启用',
                step.stepPath,
            );
        }

        if (definition.set !== undefined) {
            const resolved = resolveDeep(definition.set, step.expressionContext);
            if (resolved && typeof resolved === 'object' && !Array.isArray(resolved)) {
                for (const [key, value] of Object.entries(resolved as Record<string, unknown>)) {
                    if (isForbiddenPropertyKey(key)) continue;
                    this.contextValues[key] = value;
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
            throw new WorkflowUnsupportedError('fork 并行分支尚未启用（Phase 2）', step.stepPath);
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
            context: { ...this.contextValues },
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
                { depth: step.depth + 1, vars: step.vars },
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
                { depth: step.depth + 1, vars: step.vars },
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
                const condition = this.evaluateCondition(whileExpression, this.buildExpressionContext(vars));
                if (!condition) break;
            }
            const result = await this.executeSequence(
                doSteps,
                `${step.stepPath}/iter-${index}/do`,
                { depth: step.depth + 1, vars },
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
                    { depth: step.depth + 1, vars: step.vars },
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
                { depth: step.depth + 1, vars },
            );
            return { output: result.lastOutput };
        }

        throw lastError;
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

    private buildExpressionContext(vars: Record<string, unknown> = {}): WorkflowExpressionContext {
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
            context: this.contextValues,
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
        this.stepCount++;
        if (this.stepCount > this.maxSteps) {
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

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentService } from '@/services/AgentService.js';
import { AgentTurnEngine } from '@/services/AgentTurnEngine.js';
import { AIProviderFactory } from '@/services/AIProviderFactory.js';
import { EvaluationAgentService } from '@/services/EvaluationAgentService.js';
import { SettingsService } from '@/services/SettingsService.js';
import { DefaultWorkflowStepExecutor, type WorkflowStepExecutionContext } from '@/workflow/WorkflowStepExecutor.js';

const createContext = (root: string): WorkflowStepExecutionContext => ({
    runId: 'wf-test-run',
    traceId: 'trace-test',
    userId: 'workflow-executor-user',
    root,
    workflowName: 'demo',
    stepPath: '/do/0/step',
    stepName: 'step',
    abortSignal: new AbortController().signal,
    inputs: {},
    context: {},
    log: async () => {},
});

describe('DefaultWorkflowStepExecutor', () => {
    let root: string;
    let executor: DefaultWorkflowStepExecutor;

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'workflow-executor-'));
        executor = new DefaultWorkflowStepExecutor({ agentService: AgentService.getInstance() });
    });

    afterEach(async () => {
        vi.restoreAllMocks();
        await rm(root, { recursive: true, force: true });
    });

    it('executes tool steps through the existing ToolManager', async () => {
        await writeFile(path.join(root, 'a.txt'), 'hello workflow', 'utf8');

        const result = await executor.execute(
            'tool',
            { with: { tool: 'read_file', args: { path: 'a.txt' } } },
            createContext(root),
        );

        expect(JSON.stringify(result.output)).toContain('hello workflow');
    });

    it('rejects workflow-management tools inside workflow steps', async () => {
        await expect(executor.execute(
            'tool',
            { with: { tool: 'run_workflow', args: { name: 'other' } } },
            createContext(root),
        )).rejects.toThrow('禁止调用工具');
    });

    it('executes shell steps through ProcessSafetyGuard-backed tools', async () => {
        const result = await executor.execute(
            'shell',
            { run: { shell: { command: 'Write-Output workflow-shell-test' } } },
            createContext(root),
        );

        expect(JSON.stringify(result.output)).toContain('workflow-shell-test');
    });

    it('rejects invalid shell environment values instead of ignoring them', async () => {
        await expect(executor.execute(
            'shell',
            { run: { shell: { command: 'Write-Output test', environment: { COUNT: 3 } } } },
            createContext(root),
        )).rejects.toThrow('environment 必须是字符串键值对象');
    });

    it('returns an approval request for approval steps', async () => {
        const result = await executor.execute(
            'approval',
            { with: { message: '确认？', risk: 'low' } },
            createContext(root),
        );

        expect(result.approval).toMatchObject({
            stepPath: '/do/0/step',
            message: '确认？',
            risk: 'low',
        });
    });

    it('applies request gating and usage accounting to agent and evaluator calls', async () => {
        const agentService = AgentService.getInstance();
        const providerConfig = SettingsService.getDefaultSettings().providers[0];
        vi.spyOn(AIProviderFactory, 'getClient').mockReturnValue({} as ReturnType<typeof AIProviderFactory.getClient>);
        vi.spyOn(agentService, 'buildSystemPrompt').mockResolvedValue('system');
        const acquireRequestToken = vi.fn().mockResolvedValue(undefined);
        const recordUsage = vi.fn();
        const checkTokenBudget = vi.fn();
        const verifyTokenBudget = vi.fn();
        const usage = { inputTokens: 2, outputTokens: 3, totalTokens: 5 };
        vi.spyOn(AgentTurnEngine, 'runTurns').mockImplementation(async (options) => {
            await options.beforeApiRequest?.();
            options.telemetrySink?.(usage, 'model');
            options.afterApiRequest?.(usage);
            return {
                activeHistory: [], usage, totalSteps: 1,
                finalAssistantContent: 'agent output', finalAssistantReasoning: '',
            };
        });
        vi.spyOn(EvaluationAgentService.getInstance(), 'runEvaluation').mockImplementation(async (options) => {
            await options.beforeApiRequest?.();
            options.telemetrySink?.(usage, 'model');
            options.afterApiRequest?.(usage);
            return { decision: 'goal_achieved', finalReply: 'ok', reportContent: 'ok', usage };
        });
        executor = new DefaultWorkflowStepExecutor({
            agentService,
            resolveProvider: () => ({ providerConfig, provider: 'provider', modelId: 'model' }),
            acquireRequestToken,
        });
        const context = {
            ...createContext(root), recordUsage, checkTokenBudget, verifyTokenBudget, requireTokenUsage: true,
        };
        await executor.execute('agent', { with: { prompt: 'test' } }, context);
        await executor.execute('evaluator', { with: { target: 'test' } }, context);
        expect(acquireRequestToken).toHaveBeenCalledTimes(2);
        expect(recordUsage).toHaveBeenCalledTimes(2);
        expect(checkTokenBudget).toHaveBeenCalledTimes(4);
        expect(verifyTokenBudget).toHaveBeenCalledTimes(2);
    });

    it('propagates a failed asynchronous workflow log instead of succeeding', async () => {
        const agentService = AgentService.getInstance();
        const providerConfig = SettingsService.getDefaultSettings().providers[0];
        vi.spyOn(AIProviderFactory, 'getClient').mockReturnValue({} as ReturnType<typeof AIProviderFactory.getClient>);
        vi.spyOn(agentService, 'buildSystemPrompt').mockResolvedValue('system');
        vi.spyOn(AgentTurnEngine, 'runTurns').mockImplementation(async (options) => {
            options.emit({ type: 'stage', content: 'working' });
            return {
                activeHistory: [], usage: null, totalSteps: 1,
                finalAssistantContent: 'agent output', finalAssistantReasoning: '',
            };
        });
        executor = new DefaultWorkflowStepExecutor({
            agentService, resolveProvider: () => ({ providerConfig, provider: 'provider', modelId: 'model' }),
        });
        await expect(executor.execute('agent', { with: { prompt: 'test' } }, {
            ...createContext(root), log: async () => { throw new Error('disk full'); },
        })).rejects.toThrow('disk full');
    });

    it('keeps the original step error when logging also fails', async () => {
        const agentService = AgentService.getInstance();
        const providerConfig = SettingsService.getDefaultSettings().providers[0];
        vi.spyOn(AIProviderFactory, 'getClient').mockReturnValue({} as ReturnType<typeof AIProviderFactory.getClient>);
        vi.spyOn(agentService, 'buildSystemPrompt').mockResolvedValue('system');
        vi.spyOn(AgentTurnEngine, 'runTurns').mockImplementation(async (options) => {
            options.emit({ type: 'stage', content: 'working' });
            throw new Error('model exploded');
        });
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        executor = new DefaultWorkflowStepExecutor({
            agentService, resolveProvider: () => ({ providerConfig, provider: 'provider', modelId: 'model' }),
        });
        await expect(executor.execute('agent', { with: { prompt: 'test' } }, {
            ...createContext(root), log: async () => { throw new Error('disk full'); },
        })).rejects.toThrow('model exploded');
        expect(warn).toHaveBeenCalled();
    });
});

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentService } from '@/services/AgentService.js';
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
});

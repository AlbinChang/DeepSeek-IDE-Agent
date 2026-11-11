/**
 * Workflow IPC Handler
 *
 * 桌面端唯一入口：renderer 通过 preload 暴露的 `workflow.*` 调用。
 * 服务层不依赖 Electron；HTTP/SSE 入口留给 standalone server。
 */
import { IpcMain } from 'electron';

import { WorkspaceRegistry } from '@/services/WorkspaceRegistry.js';
import { PathUtils } from '@/utils/PathUtils.js';
import type { WorkflowRunRequest, WorkflowRunStatus } from '@/workflow/types.js';
import { WorkflowRuntime } from '../workflow/workflow-runtime.js';

interface WorkflowIpcBaseParams {
    userId: string;
    root?: string;
}

function toErrorMessage(error: any): string {
    return error?.message || String(error);
}

function isSamePath(left: string, right: string): boolean {
    const normalizedLeft = PathUtils.normalizePath(left);
    const normalizedRight = PathUtils.normalizePath(right);
    if (process.platform === 'win32') {
        return normalizedLeft.toLowerCase() === normalizedRight.toLowerCase();
    }
    return normalizedLeft === normalizedRight;
}

/**
 * 不信任 renderer 传入的 root：只允许当前用户已注册的工作区。
 */
function resolveWorkspaceRoot(userId: string, requestedRoot?: string): string {
    if (!userId) throw new Error('userId is required');
    const registeredRoot = WorkspaceRegistry.getInstance().get(userId);
    if (!registeredRoot) {
        throw new Error('Workspace not initialized');
    }
    const normalizedRoot = PathUtils.normalizePath(registeredRoot);
    if (requestedRoot && !isSamePath(normalizedRoot, requestedRoot)) {
        throw new Error('Workspace root mismatch');
    }
    return normalizedRoot;
}

export function registerWorkflowIpc(ipcMain: IpcMain) {
    const service = WorkflowRuntime.getInstance().getService();

    ipcMain.handle('workflow:list', async (_event, params: WorkflowIpcBaseParams) => {
        try {
            const root = resolveWorkspaceRoot(params?.userId, params?.root);
            const workflows = await service.list(root);
            return { success: true, workflows };
        } catch (error: any) {
            return { success: false, error: toErrorMessage(error) };
        }
    });

    ipcMain.handle('workflow:get', async (_event, params: WorkflowIpcBaseParams & { name: string }) => {
        try {
            const root = resolveWorkspaceRoot(params?.userId, params?.root);
            if (!params?.name) throw new Error('name is required');
            const workflow = await service.get(root, params.name);
            if (!workflow) return { success: false, error: `Workflow not found: ${params.name}` };
            return { success: true, workflow };
        } catch (error: any) {
            return { success: false, error: toErrorMessage(error) };
        }
    });

    ipcMain.handle('workflow:validate', async (_event, params: WorkflowIpcBaseParams & { name?: string }) => {
        try {
            const root = resolveWorkspaceRoot(params?.userId, params?.root);
            const validation = await service.validate(root, params?.name);
            return { success: true, validation };
        } catch (error: any) {
            return { success: false, error: toErrorMessage(error) };
        }
    });

    ipcMain.handle('workflow:run', async (_event, params: WorkflowIpcBaseParams & {
        name: string;
        inputs?: Record<string, unknown>;
        provider?: string;
        model?: string;
        reasoningEffort?: WorkflowRunRequest['reasoningEffort'];
        wait?: boolean;
        timeoutSeconds?: number;
        concurrencyGroup?: string;
    }) => {
        try {
            const root = resolveWorkspaceRoot(params?.userId, params?.root);
            if (!params?.name) throw new Error('name is required');

            const workflow = await service.get(root, params.name);
            if (!workflow) return { success: false, error: `Workflow not found: ${params.name}` };
            if (!workflow.validation.ok) {
                return {
                    success: false,
                    error: 'Workflow validation failed',
                    validation: workflow.validation,
                };
            }

            const result = await service.run({
                userId: params.userId,
                root,
                name: workflow.summary.name,
                path: workflow.summary.path,
                inputs: params.inputs,
                provider: params.provider,
                model: params.model,
                reasoningEffort: params.reasoningEffort,
                wait: params.wait,
                timeoutSeconds: params.timeoutSeconds,
                concurrencyGroup: params.concurrencyGroup,
            });
            if (!result.ok) {
                return {
                    success: false,
                    error: result.error,
                    runId: result.runId,
                    status: result.status,
                    issues: result.issues,
                };
            }
            return {
                success: true,
                runId: result.runId,
                status: result.status,
                position: result.position,
                run: result.run,
            };
        } catch (error: any) {
            return { success: false, error: toErrorMessage(error) };
        }
    });

    ipcMain.handle('workflow:listRuns', async (_event, params: WorkflowIpcBaseParams & {
        status?: string;
    }) => {
        try {
            const root = resolveWorkspaceRoot(params?.userId, params?.root);
            const runs = await service.listRuns({
                userId: params.userId,
                root,
                status: params?.status as WorkflowRunStatus | undefined,
            });
            return {
                success: true,
                runs: runs.filter((run) => run.userId === params.userId && isSamePath(run.root, root)),
            };
        } catch (error: any) {
            return { success: false, error: toErrorMessage(error) };
        }
    });

    ipcMain.handle('workflow:getRun', async (_event, params: WorkflowIpcBaseParams & {
        runId: string;
        includeEvents?: boolean;
    }) => {        try {
            const root = resolveWorkspaceRoot(params?.userId, params?.root);
            if (!params?.runId) throw new Error('runId is required');
            const run = await service.getRun({
                userId: params.userId,
                root,
                runId: params.runId,
                includeEvents: params.includeEvents,
            });
            if (!run || run.userId !== params.userId || !isSamePath(run.root, root)) {
                return { success: false, error: `Workflow run not found: ${params.runId}` };
            }
            return { success: true, run };
        } catch (error: any) {
            return { success: false, error: toErrorMessage(error) };
        }
    });

    ipcMain.handle('workflow:cancel', async (_event, params: WorkflowIpcBaseParams & { runId: string }) => {
        try {
            const root = resolveWorkspaceRoot(params?.userId, params?.root);
            if (!params?.runId) throw new Error('runId is required');
            const run = await service.getRun({ userId: params.userId, root, runId: params.runId });
            if (!run || run.userId !== params.userId || !isSamePath(run.root, root)) {
                return { success: false, error: `Workflow run not found: ${params.runId}` };
            }
            const cancelled = await service.cancel({ userId: params.userId, root, runId: params.runId });
            return { success: true, cancelled };
        } catch (error: any) {
            return { success: false, error: toErrorMessage(error) };
        }
    });

    ipcMain.handle('workflow:resume', async (_event, params: WorkflowIpcBaseParams & {
        runId: string;
        decision?: unknown;
        inputs?: Record<string, unknown>;
    }) => {
        try {
            const root = resolveWorkspaceRoot(params?.userId, params?.root);
            if (!params?.runId) throw new Error('runId is required');
            const run = await service.getRun({ userId: params.userId, root, runId: params.runId });
            if (!run || run.userId !== params.userId || !isSamePath(run.root, root)) {
                return { success: false, error: `Workflow run not found: ${params.runId}` };
            }
            const resumed = await service.resume({
                userId: params.userId,
                root,
                runId: params.runId,
                decision: params.decision,
                inputs: params.inputs,
            });
            if (!resumed) {
                const current = await service.getRun({ userId: params.userId, root, runId: params.runId });
                return {
                    success: false,
                    resumed: false,
                    error: current?.error || 'Workflow cannot be resumed in its current state',
                };
            }
            return { success: true, resumed };
        } catch (error: any) {
            return { success: false, error: toErrorMessage(error) };
        }
    });

    ipcMain.handle('workflow:workers', async () => {
        try {
            const stats = service.getStats();
            return { success: true, ...stats };
        } catch (error: any) {
            return { success: false, error: toErrorMessage(error) };
        }
    });

    console.log('[WorkflowIPC] Workflow IPC handlers registered');
}

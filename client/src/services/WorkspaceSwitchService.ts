import { USER_ID } from '@/config';
import { disconnectWorkspaceConnections } from '@/services/WorkspaceConnectionService';
import { electronBridge } from '@/services/electron-bridge';
import { addRecentWorkspace } from '@/services/RecentWorkspaces';

let switchQueue: Promise<void> = Promise.resolve();
let latestSwitchToken = 0;

interface SwitchResult {
    status: 'success';
    workspaceRoot: string | null;
}

interface SwitchWorkspaceOptions {
    forceRebind?: boolean;
}

async function waitForWorkspaceStatus(expectedRoot: string | null, timeoutMs = 6000) {
    const start = Date.now();
    const normalizedExpected = normalizeRootForCompare(expectedRoot);

    while (Date.now() - start < timeoutMs) {
        try {
            let initialized = false;
            let serverRoot: string | null = null;
            const status = await electronBridge.getWorkspaceStatus({ userId: USER_ID });
            initialized = status.initialized;
            serverRoot = status.workspaceRoot;
            const normalizedServer = normalizeRootForCompare(serverRoot);

            if (!expectedRoot) {
                if (!initialized || !serverRoot) return null;
            } else if (initialized && normalizedServer === normalizedExpected) {
                return serverRoot;
            }
        } catch {
            // Keep polling until timeout; transient failures are expected during switch.
        }

        await new Promise((resolve) => setTimeout(resolve, 120));
    }

    throw new Error('Workspace status convergence timeout');
}

function normalizeRootForCompare(value: string | null): string {
    if (!value) return '';
    let normalized = value.trim().replace(/\\/g, '/').replace(/\/+$/, '');
    normalized = normalized.replace(/^([A-Z]):/, (m) => m.toLowerCase());
    return normalized;
}

export async function switchWorkspace(
    nextPath: string | null,
    currentWorkspaceRoot: string | null,
    options: SwitchWorkspaceOptions = {}
): Promise<SwitchResult> {
    const requestedPath = typeof nextPath === 'string' ? nextPath.trim() : '';
    const token = ++latestSwitchToken;
    const forceRebind = !!options.forceRebind;

    const normalizedCurrent = normalizeRootForCompare(currentWorkspaceRoot);
    const normalizedRequested = normalizeRootForCompare(requestedPath || null);

    // Same-root selection is not a workspace switch; keep active connections intact.
    if (!forceRebind && requestedPath && normalizedCurrent && normalizedCurrent === normalizedRequested) {
        return { status: 'success', workspaceRoot: currentWorkspaceRoot };
    }

    const execute = async (): Promise<SwitchResult> => {
        const disconnectResult = await disconnectWorkspaceConnections({
            reason: forceRebind ? 'workspace-rebind' : (requestedPath ? 'workspace-switch' : 'workspace-reset'),
            previousWorkspaceRoot: currentWorkspaceRoot
        });

        if (!disconnectResult.acknowledged) {
            // Extra safety gap when backend ack was not confirmed.
            await new Promise((resolve) => setTimeout(resolve, 120));
        }

        if (requestedPath) {
            const result = await electronBridge.initWorkspace({ userId: USER_ID, root: requestedPath });
            if (!result.success) throw new Error(result.error || 'Workspace init failed');
            const root = result.root || requestedPath;
            const confirmedRoot = await waitForWorkspaceStatus(root);
            const finalRoot = confirmedRoot || root;
            // 记录到最近工作区列表
            if (finalRoot) {
                addRecentWorkspace(finalRoot);
            }
            return { status: 'success', workspaceRoot: finalRoot };
        }

        await electronBridge.resetWorkspace({ userId: USER_ID });
        await waitForWorkspaceStatus(null);
        return { status: 'success', workspaceRoot: null };
    };

    const task = switchQueue.then(execute, execute);
    switchQueue = task.then(() => undefined, () => undefined);

    const result = await task;
    if (token !== latestSwitchToken) {
        throw new Error('Workspace switch superseded by a newer request.');
    }

    return result;
}

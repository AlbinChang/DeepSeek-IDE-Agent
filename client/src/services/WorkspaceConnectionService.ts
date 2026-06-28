import axios from 'axios';
import { WorkerManager } from '@/services/WorkerManager';
import { API_BASE, USER_ID } from '@/config';
import { electronBridge } from '@/services/electron-bridge';

interface DisconnectPayload {
    reason?: string;
    previousWorkspaceRoot?: string | null;
}

interface DisconnectResult {
    acknowledged: boolean;
}

async function postDisconnect(reason: string, previousWorkspaceRoot: string | null, timeoutMs: number) {
    // Electron 模式下无需 HTTP 断开连接（没有 WebSocket 连接）
    if (electronBridge.isElectron) {
        return { data: { acknowledged: true } };
    }
    return axios.post(
        `${API_BASE}/api/workspace/disconnect`,
        {
            userId: USER_ID,
            reason,
            previousWorkspaceRoot
        },
        {
            timeout: timeoutMs
        }
    );
}

export async function disconnectWorkspaceConnections(payload: DisconnectPayload = {}): Promise<DisconnectResult> {
    const { reason = 'workspace-switch', previousWorkspaceRoot = null } = payload;
    let acknowledged = false;

    // Frontend-first teardown to avoid stale frames being rendered during switch.
    WorkerManager.closeWorkspaceScopedConnections();

    try {
        await postDisconnect(reason, previousWorkspaceRoot, 4000);
        acknowledged = true;
    } catch (error) {
        // Retry once to improve robustness under transient backend startup/network jitter.
        try {
            await postDisconnect(reason, previousWorkspaceRoot, 6000);
            acknowledged = true;
        } catch (retryError) {
            // Keep switch flow resilient; local teardown already happened.
            console.warn('[Workspace Switch] Backend disconnect request failed after retry:', retryError);
        }
    }

    // Give gateways a brief drain window so old sockets fully close before re-init.
    await new Promise((resolve) => setTimeout(resolve, acknowledged ? 120 : 220));

    return { acknowledged };
}

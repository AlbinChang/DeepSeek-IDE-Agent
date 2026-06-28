import { electronBridge } from '@/services/electron-bridge';

interface DisconnectPayload {
    reason?: string;
    previousWorkspaceRoot?: string | null;
}

interface DisconnectResult {
    acknowledged: boolean;
}

// 桌面应用模式：无 WebSocket 连接，直接确认
function postDisconnect(_reason: string, _previousWorkspaceRoot: string | null, _timeoutMs: number) {
    return { data: { acknowledged: true } };
}

export async function disconnectWorkspaceConnections(payload: DisconnectPayload = {}): Promise<DisconnectResult> {
    // 桌面应用模式：无需断开 WebSocket，直接确认
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { acknowledged: true };
}

interface DisconnectPayload {
    reason?: string;
    previousWorkspaceRoot?: string | null;
}

interface DisconnectResult {
    acknowledged: boolean;
}

export async function disconnectWorkspaceConnections(_payload: DisconnectPayload = {}): Promise<DisconnectResult> {
    // 桌面应用模式：无需断开 WebSocket，直接确认
    await new Promise((resolve) => setTimeout(resolve, 120));
    return { acknowledged: true };
}

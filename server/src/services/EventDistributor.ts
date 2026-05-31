import { FastifyInstance } from 'fastify';

/**
 * 对应技术规范 3.2 & 4.1 节：副作用分发器与实时同步
 */
export class EventDistributor {
    private static fastify: FastifyInstance;
    // [2026.04] 添加 SSE 系统级消息分发器
    private static sysListeners: Map<string, Set<(payload: any) => void>> = new Map();

    private static sysListenerKey(userId: string, workspaceRoot?: string): string {
        return workspaceRoot ? `${userId}\u0000${workspaceRoot}` : userId;
    }

    private static parseSysListenerKey(key: string): { userId: string; workspaceRoot?: string } {
        const delimiter = key.indexOf('\u0000');
        if (delimiter < 0) return { userId: key };
        return { userId: key.slice(0, delimiter), workspaceRoot: key.slice(delimiter + 1) };
    }

    static init(instance: FastifyInstance) {
        this.fastify = instance;
    }

    static userIsInWorkspace(userId: string, root: string): boolean {
        const fastifyAny = this.fastify as any;
        if (!fastifyAny || !fastifyAny.websocketServer) return false;
        
        let found = false;
        fastifyAny.websocketServer.clients.forEach((client: any) => {
            if (client.userId === userId && client.workspaceRoot === root) {
                found = true;
            }
        });
        return found;
    }

    // [2026.04.05] 订阅系统级推送到 SSE 通道
    static subscribeSysMessage(userId: string, listener: (payload: any) => void, workspaceRoot?: string) {
        const key = this.sysListenerKey(userId, workspaceRoot);
        if (!this.sysListeners.has(key)) {
            this.sysListeners.set(key, new Set());
        }
        this.sysListeners.get(key)!.add(listener);
    }

    static unsubscribeSysMessage(userId: string, listener: (payload: any) => void, workspaceRoot?: string) {
        const key = this.sysListenerKey(userId, workspaceRoot);
        const listeners = this.sysListeners.get(key);
        if (listeners) {
            listeners.delete(listener);
            if (listeners.size === 0) {
                this.sysListeners.delete(key);
            }
        }
    }

    static async broadcast(type: string, data: any, filter?: (client: any) => boolean) {
        // [2026.04.05] 将后端 chat:stream 直接同步派发给 SSE 客户端群
        if (type === 'chat:stream' && filter) {
            for (const [key, listeners] of this.sysListeners.entries()) {
                const clientScope = this.parseSysListenerKey(key);
                if (filter(clientScope)) {
                    listeners.forEach(l => l(data));
                }
            }
        }

        const fastifyAny = this.fastify as any;
        if (!fastifyAny || !fastifyAny.websocketServer) return;

        fastifyAny.websocketServer.clients.forEach((client: any) => {
            if (client.readyState === 1) { // OPEN
                if (!filter || filter(client)) {
                    client.send(JSON.stringify({
                        jsonrpc: '2.0',
                        method: 'event/push',
                        params: { type, payload: data }
                    }));
                }
            }
        });
    }
}

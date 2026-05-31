export class WorkerManager {
    private static worker: Worker | null = null;
    private static handlers: Map<string, (data: any) => void> = new Map();
    private static statusHandlers: Map<string, (status: string) => void> = new Map();

    static init() {
        if (this.worker) return;
        
        // Vite 语法加载 Worker
        this.worker = new Worker(new URL('@/workers/socket.worker.ts', import.meta.url), {
            type: 'module'
        });

        this.worker.onmessage = (e) => {
            const payload = e.data;
            if (payload?.jsonrpc !== '2.0') return;

            const { method, params } = payload;
            const id = params?.id;
            const data = params?.data;
            const error = params?.error;

            if (method === 'MESSAGE' || method === 'BATCH_MESSAGE') {
                const handler = id ? this.handlers.get(id) : undefined;
                if (handler) {
                    // 统一处理数据：若是单个对象则包装成数组，若是 batch 则取 items
                    let itemsToHandle: any[] = [];
                    if (data?.jsonrpc === '2.0' && data?.method === 'batch' && Array.isArray(data?.params?.items)) {
                        itemsToHandle = data.params.items;
                    } else if (data && data.method === 'data/legacy' && data.params) {
                        itemsToHandle = [data.params];
                    } else {
                        itemsToHandle = [data];
                    }

                    // 批量调用 handler，减少 React 异步更新冲突
                    handler(itemsToHandle);
                }
            } else if (method === 'RAW_MESSAGE') {
                // 新增：支持透传未经包裹的原始 JSON-RPC 消息 (如 terminal/stream)
                const handler = id ? this.handlers.get(id) : undefined;
                if (handler) {
                    handler([data]);
                }
            } else if (method === 'OPEN' || method === 'CLOSE' || method === 'ERROR') {
                const statusHandler = id ? this.statusHandlers.get(id) : undefined;
                if (statusHandler) statusHandler(method);

                if (method === 'ERROR') {
                    // 对齐 43.1 节：工业级详细报错日志
                    const errorDetail = data || error || 'Connection Failed';
                    console.error(`[WorkerManager] Socket Error [${id}]:`, errorDetail);
                }
            }
        };
    }

    static connect(id: string, url: string, onMessage: (data: any) => void, onStatus?: (status: string) => void) {
        this.init();
        
        // [2026.03] 全局单例保护：如果该 ID 以 -singleton 结尾且已有 handler
        // 仅更新 handler 而不重新发起 WebWorker 的 CONNECT 指令，防止链路闪断
        const isSingleton = id.endsWith('-singleton');
        const hasExistingHandler = this.handlers.has(id);

        this.handlers.set(id, onMessage);
        if (onStatus) this.statusHandlers.set(id, onStatus);

        if (isSingleton && hasExistingHandler) {
            console.log(`[WorkerManager] Re-attaching UI to existing singleton connection: ${id}`);
            // 立即广播当前已知的 OPEN 状态（如果 Worker 内部连接是好的）
            this.worker?.postMessage({ 
                jsonrpc: '2.0', 
                method: 'GET_STATUS', 
                params: { id } 
            });
            return;
        }

        this.worker?.postMessage({ jsonrpc: '2.0', method: 'CONNECT', params: { id, url } });
    }

    static send(id: string, data: any) {
        this.worker?.postMessage({ jsonrpc: '2.0', method: 'SEND', params: { id, data } });
    }

    static close(id: string) {
        this.worker?.postMessage({ jsonrpc: '2.0', method: 'CLOSE', params: { id } });
        this.handlers.delete(id);
        this.statusHandlers.delete(id);
    }

    static closeWorkspaceScopedConnections() {
        const ids = Array.from(this.handlers.keys());
        ids.forEach((id) => {
            const isPersistent = id.includes('-singleton');
            const isWorkspaceScoped =
                id === 'chat' ||
                id === 'context' ||
                id === 'completion-shared' ||
                id === 'system-events';

            if (isWorkspaceScoped) {
                if (id === 'chat') {
                    this.stop(id);
                }
                
                if (!isPersistent) {
                    this.close(id);
                } else {
                    console.debug(`[WorkerManager] Connection ${id} is managed by global worker, skipping teardown.`);
                }
            }
        });
    }

    static stop(id: string) {
        this.worker?.postMessage({ jsonrpc: '2.0', method: 'STOP', params: { id } });
    }
}

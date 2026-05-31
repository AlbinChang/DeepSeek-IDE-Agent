/**
 * WebSocket Proxy Worker
 * 对齐技术规范 第 3.1 & 4.5.2 节 & 47.0 (JSON-RPC 2.0)
 * 负责管理所有与后端的长连接，并在后台线程解析负载与流式分帧，避免阻塞 UI 主线程。
 */

const sockets: Map<string, WebSocket> = new Map();
const socketConfigs: Map<string, { url: string; retryCount: number; isPersistent?: boolean; workspaceRoot?: string }> = new Map();
const messageBuffers: Map<string, any[]> = new Map();
const sendQueues: Map<string, any[]> = new Map(); // 新增：发送队列，支持断连重试
const flushTimers: Map<string, any> = new Map();
const heartbeatIntervals: Map<string, any> = new Map();
const intentionalCloseIds: Set<string> = new Set();

function bufferMessage(id:string, payload: any) {
    // [2026.03] 对齐：如果收到的本身就是标准 JSON-RPC 2.0 消息（如 system/ready）
    // 且不是业务负载 BATCH_MESSAGE，则通过 RAW_MESSAGE 通道立即透传，避免被节流导致延迟
    if (payload?.jsonrpc === '2.0' && payload?.method && payload.method !== 'MESSAGE') {
        self.postMessage({
            jsonrpc: '2.0',
            method: 'RAW_MESSAGE',
            params: { id, data: payload }
        });
        return;
    }

    if (!messageBuffers.has(id)) {
        messageBuffers.set(id, []);
    }
    const buffer = messageBuffers.get(id)!;
    buffer.push(payload);

    if (!flushTimers.has(id)) {
        const timer = setTimeout(() => {
            flush(id);
        }, 16); // ~60fps 节流
        flushTimers.set(id, timer);
    }
}

function flush(id: string) {
    const buffer = messageBuffers.get(id);
    if (buffer && buffer.length > 0) {
        self.postMessage({
            jsonrpc: '2.0',
            method: 'BATCH_MESSAGE',
            params: { id, data: { jsonrpc: '2.0', method: 'batch', params: { items: [...buffer] } } }
        });
        buffer.length = 0;
    }
    if (flushTimers.has(id)) {
        clearTimeout(flushTimers.get(id));
        flushTimers.delete(id);
    }
}

// 新增：刷新发送队列
function flushSendQueue(id: string, socket: WebSocket) {
    const queue = sendQueues.get(id);
    if (queue && queue.length > 0) {
        console.log(`[Worker] Flushing ${queue.length} queued messages for ${id}`);
        while (queue.length > 0) {
            const data = queue.shift();
            const payload = typeof data === 'string' ? data : JSON.stringify(data);
            socket.send(payload);
        }
    }
}

function startHeartbeat(id: string, socket: WebSocket) {
    // [2026.03] 严格清理：在开启新心跳定时器前，优先清理旧的，防止心跳堆叠
    const existing = heartbeatIntervals.get(id);
    if (existing) {
        clearInterval(existing);
        heartbeatIntervals.delete(id);
    }
    
    // 如果 socket 已关闭，不再启动心跳
    if (socket.readyState !== WebSocket.OPEN) return;

    const interval = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'ping', params: {} }));
        } else {
            // 如果连接已失效，清理当前定时器并退出
            clearInterval(interval);
            heartbeatIntervals.delete(id);
        }
    }, 30000);
    heartbeatIntervals.set(id, interval);
}

self.onmessage = (e: MessageEvent) => {
    const { jsonrpc, method, params } = e.data || {};
    
    // 强制 JSON-RPC 2.0 防腐层
    if (jsonrpc !== '2.0') return;

    // 提取旧逻辑对应的 id, url, data 避免下层改动太大
    const id = params?.id;
    const url = params?.url;
    const data = params?.data;
    const workspaceRoot = params?.workspaceRoot;

    if (!id) return;

    switch (method) {
        case 'GET_STATUS':
            const sock = sockets.get(id);
            if (sock) {
                self.postMessage({ 
                    jsonrpc: '2.0', 
                    method: sock.readyState === WebSocket.OPEN ? 'OPEN' : 'CLOSE', 
                    params: { id } 
                });
            }
            break;
        case 'CONNECT':
            if (url) {
                // 如果 ID 含 singleton，标记为永久连接，开启自动重连
                const isPersistent = id.includes('-singleton');
                socketConfigs.set(id, { url, retryCount: 0, isPersistent, workspaceRoot });
                connect(id, url);
            }
            break;
        case 'SEND':
            // [2026.03] 后端现在统一维护状态，前端可选传递 workspaceRoot 进行路由隔离
            if (typeof data === 'object' && !data.workspaceRoot) {
                const config = socketConfigs.get(id);
                if (config?.workspaceRoot) {
                    if (data.params) {
                        data.params = { ...data.params, workspaceRoot: config.workspaceRoot };
                    } else {
                        data.workspaceRoot = config.workspaceRoot;
                    }
                }
            }
            send(id, data);
            break;
        case 'STOP':
            // 对齐 15.2：终止当前 Agent 运行任务流水线
            send(id, { jsonrpc: '2.0', method: 'stop', params: {} });
            break;
        case 'CLOSE':
            // [Section 2026.03]: 持久化连接建立后禁止通过 CLOSE 指令销毁，仅移除配置防止重试
            // 除非显式传递 force: true。全局单例连接通常不应被销毁。
            const force = params?.force === true;
            const isPersistent = id.includes('-singleton') || id === 'global-singleton';

            if (isPersistent && !force) {
                console.warn(`[Worker] Persistent connection ${id} is protected. CLOSE ignored unless force=true.`);
                // 即使不关闭连接，也需要通知主线程当前状态，确保逻辑闭环
                const socket = sockets.get(id);
                if (socket) {
                    self.postMessage({ 
                        jsonrpc: '2.0', 
                        method: 'OPEN', 
                        params: { id, status: socket.readyState === WebSocket.OPEN ? 'OPEN' : 'CONNECTING' } 
                    });
                }
            } else {
                // 彻底移除配置和连接
                socketConfigs.delete(id);
                const reconnectKey = `reconnect-${id}`;
                if (flushTimers.has(reconnectKey)) {
                    clearTimeout(flushTimers.get(reconnectKey));
                    flushTimers.delete(reconnectKey);
                }
                close(id);
            }
            break;
    }
};

/**
 * 优化后的断线重连机制 (对齐 2026.03 重构规范)
 * 增加随机抖动 (Jitter) 避免集群重连冲击
 */
function attemptReconnect(id: string) {
    const config = socketConfigs.get(id);
    if (!config) return;

    // 指数避退策略 (Exponential Backoff) + Jitter
    const baseDelay = Math.min(1000 * Math.pow(2, config.retryCount), 30000);
    const jitter = Math.random() * 1000;
    const delay = baseDelay + jitter;
    
    config.retryCount++;
    
    console.log(`[Worker] Attempting reconnect for ${id} in ${Math.round(delay)}ms (Retry #${config.retryCount})`);
    
    // 如果已有定时器在跑，先清理掉
    const oldTimer = flushTimers.get(`reconnect-${id}`);
    if (oldTimer) {
        clearTimeout(oldTimer);
    }

    const timerId = setTimeout(() => {
        if (socketConfigs.has(id)) {
            connect(id, config.url);
        }
    }, delay);

    // 将重载后的定时器记录在 flushTimers 中
    flushTimers.set(`reconnect-${id}`, timerId);
}

function connect(id: string, url: string) {
    if (sockets.has(id)) {
        const existing = sockets.get(id);
        if (existing?.readyState === WebSocket.OPEN || existing?.readyState === WebSocket.CONNECTING) {
            return;
        }
        // 非正常状态下清理旧 socket，标记为主动关闭以抑制无效重连。
        intentionalCloseIds.add(id);
        existing?.close();
        sockets.delete(id);
    }

    const socket = new WebSocket(url);
    sockets.set(id, socket);

    socket.onopen = () => {
        const config = socketConfigs.get(id);
        if (config) config.retryCount = 0; // 重置重试计数

        startHeartbeat(id, socket);
        // [2026.03] 连接成功后立即刷新发送队列，确保异步请求不丢失
        flushSendQueue(id, socket);
        self.postMessage({ jsonrpc: '2.0', method: 'OPEN', params: { id } });
    };

    socket.onmessage = (event) => {
        let payload = event.data;
        
        // 1. 协议解析 Marshalling (如果是 JSON 字符串)
        if (typeof payload === 'string') {
            try {
                const parsed = JSON.parse(payload);
                // 过滤掉 PONG 消息，不传回主线程
                if (parsed.result === 'pong' || parsed.method === 'pong') return;
                payload = parsed;
            } catch (e) {
                // 保持原样
            }
        }
        
        // 2. 消息路由与分帧
        bufferMessage(id, payload);
    };

    socket.onerror = (error: any) => {
        const errorMsg = error?.message || (typeof error === 'string' ? error : 'WebSocket handshake failed or connection lost');
        // 后端状态完全交给后端，前端只保留必要的连接状态上报
        console.debug(`[Worker] Socket error ${id}: ${errorMsg}`);
    };

    socket.onclose = (event) => {
        flush(id);
        // 主动上报关闭状态，前端 Service 会根据此状态在重连后清除缓存
        self.postMessage({ jsonrpc: '2.0', method: 'CLOSE', params: { id, code: event.code } });
        sockets.delete(id);

        const intentional = intentionalCloseIds.has(id);
        if (intentional) {
            intentionalCloseIds.delete(id);
        }

        // 如果显式配置了重试的消息通道且非主动关闭，触发重连。
        if (!intentional && socketConfigs.has(id)) {
            attemptReconnect(id);
        }
    };
}

function send(id: string, data: any) {
    const socket = sockets.get(id);
    if (socket && socket.readyState === WebSocket.OPEN) {
        // 命令序列化
        const payload = typeof data === 'string' ? data : JSON.stringify(data);
        socket.send(payload);
    } else {
        // [2026.03] 如果连接未就绪且是持久化连接（如 Completion/Events），进入队列等待重连
        const config = socketConfigs.get(id);
        if (config?.isPersistent) {
            if (!sendQueues.has(id)) {
                sendQueues.set(id, []);
            }
            const q = sendQueues.get(id)!;
            // 队列限制，防止内存溢出（保留最近 100 条请求）
            if (q.length > 100) q.shift();
            q.push(data);
            
            // 触发自动重连（如果还没在尝试的话）
            if (!socket || socket.readyState === WebSocket.CLOSED) {
                attemptReconnect(id);
            }
        }
    }
}

function close(id: string) {
    const socket = sockets.get(id);
    if (socket) {
        // [2026.03] 关闭前最后一次刷新残余消息
        flush(id);
        intentionalCloseIds.add(id);
        socket.close();
        sockets.delete(id);
    }
    if (flushTimers.has(id)) {
        clearTimeout(flushTimers.get(id));
        flushTimers.delete(id);
    }
    if (messageBuffers.has(id)) {
        messageBuffers.delete(id);
    }
    if (heartbeatIntervals.has(id)) {
        clearInterval(heartbeatIntervals.get(id));
        heartbeatIntervals.delete(id);
    }
}


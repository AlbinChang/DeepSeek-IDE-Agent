import { FastifyInstance } from 'fastify';
import { CompletionService } from '@/services/CompletionService.js';

/**
 * 4.5.1 节：高性能代码补全 WebSocket 网关 (Hardened Version)
 * 对齐 15.0 节：永久 WebSocket 政策 & SSOT 磁盘优先恢复 (Wait-and-Activate)。
 */
export function setupCompletionWebSocket(fastify: FastifyInstance, agentService: any) {
    fastify.get('/ws/completion', { websocket: true } as any, async (connection: any, req: any) => {
        const socket = connection.socket || connection;
        
        // [永久驻存加固: Agent助手防线]
        const standbyHandler = async (message: Buffer) => {
            try {
                const parsed = JSON.parse(message.toString());
                const { jsonrpc, method, id } = parsed;
                if (!jsonrpc) {
                    return;
                }
                if (method === 'ping' && socket.readyState === 1) {
                    if (id !== undefined) {
                        socket.send(JSON.stringify({ jsonrpc: '2.0', id, result: 'pong' }));
                    } else {
                        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'pong', params: {} }));
                    }
                }
            } catch (e) {}
        };
        socket.on('message', standbyHandler);

        try {
            const rawUrl = req.raw.url || req.url || '';
            const urlObj = new URL(rawUrl, 'http://localhost');
            const queryUserId = (req.query as any)?.userId || urlObj.searchParams.get('userId');
            const queryRoot = (req.query as any)?.root || urlObj.searchParams.get('root');

            // [加固] 允许匿名直连并在待命周期中热挂载
            const userId = queryUserId || 'anonymous';
            (socket as any).userId = userId;
            let isCompletionActivated = false;

            const activateCompletion = (root: string) => {
                if (isCompletionActivated && (socket as any).workspaceRoot === root) return;
                isCompletionActivated = true;
                (socket as any).workspaceRoot = root;
                
                // [加固] 强制 100ms 物理延迟，确保 101 HL 握手无感完成 (Section 15.0)
                setTimeout(() => {
                    if (socket.readyState === 1) {
                        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'system/ready', params: { message: 'Completion service activated via SSOT.' } }));
                    }
                }, 100);
            };

            const onReady = ({ userId: readyUserId, workspaceRoot: readyRoot }: any) => {
                if (readyUserId === userId && socket.readyState === 1) {
                    // [加固] 业务挂载原子化
                    if (isCompletionActivated && (socket as any).workspaceRoot === readyRoot) return;
                    if (readyRoot) {
                        // [加固] 增加 100ms 物理延迟，确保 HTTP 101 Handshake 响应完全从 TCP 缓冲区发出 (Section 15.0)
                        setTimeout(() => {
                            if (socket.readyState === 1 && !isCompletionActivated) {
                                activateCompletion(readyRoot);
                            }
                        }, 100);
                    }
                }
            };
            agentService.on('workspace:ready', onReady);

            const onDisconnect = ({ userId: targetUserId, reason }: any) => {
                if (targetUserId === userId && socket.readyState === 1) {
                    console.log(`[Completion WS] Closing by explicit disconnect: ${userId} (${reason || 'workspace-switch'})`);
                    socket.close(4001, 'workspace-disconnect');
                }
            };
            agentService.on('workspace:disconnect', onDisconnect);
            
            socket.on('close', () => {
                agentService.off('workspace:ready', onReady);
                agentService.off('workspace:disconnect', onDisconnect);
            });

            // SSOT Discovery (Disk-First Rescue)
            // 对齐 15.0 节：握手期优先执行 SSOT 抢救
            const workspaceRoot = agentService.getWorkspaceRoot(userId, queryRoot);
            if (workspaceRoot && !isCompletionActivated) {
                // [加固] 增加 100ms 物理延迟，确保 HTTP 101 HL 握手成功建立 (Section 15.0)
                setTimeout(() => {
                    if (socket.readyState === 1 && !isCompletionActivated) {
                        activateCompletion(workspaceRoot);
                    }
                }, 100);
            } else if (!workspaceRoot) {
                // [加固] 即使处于待命状态，也必须延迟首个状态包，确保 101 握手优先于业务 (Section 15.0)
                setTimeout(() => {
                    if (socket.readyState === 1) {
                        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'system/standby', params: { message: "[Completion] Gateway parked. Waiting for workspace mount." } }));
                    }
                }, 100);
            }

            socket.on('message', async (message: Buffer) => {
                try {
                    const parsed = JSON.parse(message.toString());
                    const { jsonrpc, method, params, id } = parsed;

                    // Support fallback logic for ping inside processing just in case
                    if (!jsonrpc) return;

                    if (method === 'completion/request' && params) {
                        const { prefix, suffix, filePath } = params;
                        
                        const root = (socket as any).workspaceRoot || agentService.getWorkspaceRoot(userId);
                        if (!root) {
                            if (socket.readyState === 1) socket.send(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32001, message: 'No active workspace for completions. Gateway is in Standby.' } }));
                            return;
                        }

                        if (!isCompletionActivated) activateCompletion(root);

                        // ACK start
                        if (socket.readyState === 1 && id) {
                            socket.send(JSON.stringify({ jsonrpc: '2.0', id, result: 'started' }));
                        }

                        const result = await CompletionService.streamCompletion({
                            workspaceRoot: root,
                            userId,
                            prefix,
                            suffix,
                            filePath
                        });

                        for await (const chunk of result) {
                            const delta = chunk.choices[0]?.delta;
                            if (delta?.content) {
                                if (socket.readyState === 1) {
                                    socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'completion/stream', params: { streamId: id, type: 'delta', text: delta.content } }));
                                }
                            }
                        }

                        if (socket.readyState === 1) {
                            socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'completion/stream', params: { streamId: id, type: 'done' } }));
                        }
                    }
                } catch (e: any) {
                    console.error('[Completion WS] Error:', e);
                    if (socket.readyState === 1) socket.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: e.message } }));
                }
            });

            // [持久存根] (Section 15.1)
            await new Promise<void>((resolve) => {
                socket.on('close', resolve);
                socket.on('error', resolve);
            });
        } catch (err: any) {
            console.error('[Completion WS] Handshake Setup Exception:', err);
            try {
                if (socket.readyState === 1) {
                    socket.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: `Completion setup failure: ${err.message}` } }));
                }
            } catch (e) {}
            await new Promise<void>((resolve) => {
                socket.on('close', resolve);
                socket.on('error', resolve);
            });
        }
    });
}


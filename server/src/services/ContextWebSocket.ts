import { FastifyInstance } from 'fastify';
import { AgentService } from '@/services/AgentService.js';
import { EventDistributor } from '@/services/EventDistributor.js';
import { PathUtils } from '@/utils/PathUtils.js';

export function setupContextWebSocket(fastify: FastifyInstance, agentService: AgentService) {
    fastify.get('/ws/context', { websocket: true } as any, (connection: any, req: any) => {
        const socket = connection.socket || connection;
        const rawUrl = req.raw.url || req.url || '';
        const urlObj = new URL(rawUrl, 'http://localhost');
        const queryUserId = (req.query as any)?.userId || urlObj.searchParams.get('userId');
        const queryRoot = (req.query as any)?.root || urlObj.searchParams.get('root');
        const handshakeUserId = queryUserId || 'anonymous';
        console.log(`Context WebSocket connected. Handshake UserID: ${handshakeUserId}`);

        const onDisconnect = ({ userId: targetUserId, reason }: any) => {
            if (targetUserId === handshakeUserId && socket.readyState === 1) {
                console.log(`[Context WS] Closing by explicit disconnect: ${handshakeUserId} (${reason || 'workspace-switch'})`);
                socket.close(4001, 'workspace-disconnect');
            }
        };
        agentService.on('workspace:disconnect', onDisconnect);

        socket.on('message', async (message: Buffer | string) => {
            try {
                const event = JSON.parse(message.toString());
                const { jsonrpc, method, params, id } = event;

                if (!jsonrpc) {
                    return;
                }

                if (method === 'ping') {
                    if (id !== undefined) {
                        socket.send(JSON.stringify({ jsonrpc: '2.0', id, result: 'pong' }));
                    } else {
                        socket.send(JSON.stringify({ jsonrpc: '2.0', method: 'pong', params: {} }));
                    }
                    return;
                }

                // 对齐 33.1 节：身份绑定校验 (优先使用握手 ID)
                const userId = handshakeUserId || params?.userId;
                if (!userId) {
                    socket.send(JSON.stringify({ jsonrpc: '2.0', id: id || null, error: { code: -32600, message: 'UserId is required' } }));
                    socket.close(1008, 'UserId is required');
                    return;
                }

                // 绑定到当前 Socket 以便 EventDistributor 识别
                (socket as any).userId = userId;

                const workspaceRoot = agentService.getWorkspaceRoot(userId, queryRoot);
                if (!workspaceRoot) {
                    socket.send(JSON.stringify({ jsonrpc: '2.0', id: id || null, error: { code: -32001, message: 'Workspace not initialized for user ' + userId } }));
                    return;
                }
                (socket as any).workspaceRoot = workspaceRoot;

                switch (method) {
                    case 'context/selection':
                        if (params?.data) {
                            agentService.updateContextSelection(userId, { ...params.data, workspaceRoot });
                            if (id) socket.send(JSON.stringify({ jsonrpc: '2.0', id, result: 'success' }));
                        }
                        break;
                    case 'context/focus':
                        if (params?.data?.focused !== undefined) {
                            agentService.updateContextFocus(userId, params.data.focused, workspaceRoot);
                            if (id) socket.send(JSON.stringify({ jsonrpc: '2.0', id, result: 'success' }));
                        }
                        break;
                    case 'context/click':
                        if (params?.data) {
                            // 对齐 3.1 节，辅助定位视觉焦点
                            agentService.updateContextClick(userId, { ...params.data, workspaceRoot });
                            if (id) socket.send(JSON.stringify({ jsonrpc: '2.0', id, result: 'success' }));
                        }
                        break;
                }
            } catch (err: any) {
                console.error('Failed to process context message:', err);
                socket.send(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32603, message: err.message } }));
            }
        });

        socket.on('close', () => {
            agentService.off('workspace:disconnect', onDisconnect);
            console.log('Context WebSocket closed');
        });
    });
}

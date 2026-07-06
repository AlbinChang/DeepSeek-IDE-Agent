import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import dotenv from 'dotenv';
import path from 'path';
import * as fsSync from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { patchConsoleWithBeijingTime } from '@/utils/ConsoleTimestamp.js';

// 从 PathUtils 导入，解决循环依赖导致的 SERVER_ROOT 初始化顺序问题
import { SERVER_ROOT, PROJECT_ROOT, CONFIG_ROOT } from '@/utils/PathUtils.js';

patchConsoleWithBeijingTime();

// 依次尝试加载 PROJECT_ROOT 和 SERVER_ROOT 下的 .env
// 在生产环境部署中，.env 通常被放在部署包的根目录 (PROJECT_ROOT)
const envPathRoot = path.join(PROJECT_ROOT, '.env');
const envPathServer = path.join(SERVER_ROOT, '.env');

if (fsSync.existsSync(envPathRoot)) {
    dotenv.config({ path: envPathRoot });
    console.log(`[Env] 当前使用根 .env: ${envPathRoot}`);
} else if (fsSync.existsSync(envPathServer)) {
    dotenv.config({ path: envPathServer });
    console.log(`[Env] 当前使用 server/.env: ${envPathServer}`);
} else {
    // Fallback to default behavior
    dotenv.config();
    console.log('[Env] 未找到根 .env 或 server/.env，已使用 dotenv 默认查找逻辑');
}

import { setupChatSSE } from '@/services/ChatSSERoute.js';
import { setupContextWebSocket } from '@/services/ContextWebSocket.js';
import { setupCompletionWebSocket } from '@/services/CompletionWebSocket.js';
import { EventDistributor } from '@/services/EventDistributor.js';
import { AgentService } from '@/services/AgentService.js';
import { CompletionService } from '@/services/CompletionService.js';
import { TelemetryService } from '@/services/TelemetryService.js';
import { SettingsService, UserSettings, ModelProviderConfig } from '@/services/SettingsService.js';
import { AIProviderFactory } from '@/services/AIProviderFactory.js';
import { UserService } from '@/services/UserService.js';
import { TodoService } from '@/services/TodoService.js';
import { GitService } from '@/services/GitService.js';
import { FileTools } from '@/tools/FileTools.js';
import { FileIO } from '@/utils/FileIO.js';
import { PathUtils } from '@/utils/PathUtils.js';
import { config as globalConfig } from '@/config/index.js';
import { performance } from 'perf_hooks';
import * as os from 'os';
import * as v8 from 'v8';

const server = Fastify({
    // 对齐 43.1 节：日志精简 — 默认关闭 Fastify 原生详细 Request 日志，除非环境变量明确开启
    logger: process.env.ENABLE_VERBOSE_LOGS === 'true',
    // [2026.03] 修复：长连接“续命”机制 (Section 43.5: HTTP Resilience)
    // 解决执行长耗时任务（如编译、安装、复杂思考）导致的 TCP 过早断开问题。
    // 设置为 0 表示禁用请求级超时，由业务逻辑（如 SystemTools 的 timeout 参数）自行控制。
    requestTimeout: 0,
    keepAliveTimeout: 0
});

// 对齐 3.4 节：初始不默认任何 Workspace，由用户通过前端选择
const agentService = AgentService.getInstance();

async function bootstrap() {
    try {
        const workspaceMutationQueue = new Map<string, Promise<void>>();

        const runWorkspaceMutation = async <T>(userId: string, task: () => Promise<T>): Promise<T> => {
            const prev = workspaceMutationQueue.get(userId) || Promise.resolve();
            const nextTask = prev.catch(() => undefined).then(task);
            const queueToken = nextTask.then(() => undefined, () => undefined);
            workspaceMutationQueue.set(userId, queueToken);

            try {
                return await nextTask;
            } finally {
                if (workspaceMutationQueue.get(userId) === queueToken) {
                    workspaceMutationQueue.delete(userId);
                }
            }
        };

        await server.register(cors, {
            origin: '*'
        });

        await server.register(websocket);

        EventDistributor.init(server);
        // EventDistributor.startFSWatcher(workspaceRoot); // 对齐 3.4 节：等待显式初始化

        // 身份验证预检 (对齐 18.0 & 17.0 节：Security & Compliance)
        server.addHook('preHandler', async (request, reply) => {
            (request as any).startTime = performance.now();

            if (request.url.startsWith('/api/') && !request.url.includes('/chat') && !request.url.includes('/workspace/init') && !request.url.includes('/user/register')) {
                // 模拟 JWT / API Key 校验逻辑
                const auth = request.headers.authorization;
                if (process.env.NODE_ENV === 'production' && !auth) {
                    server.log.warn(`Unauthorized access attempt to ${request.url}`);
                    return reply.status(401).send({ error: 'Unauthorized' });
                }
            }
        });

        server.addHook('onResponse', async (request, reply) => {
            const duration = (request as any).startTime ? (performance.now() - (request as any).startTime) : 0;
            const isSuccess = reply.statusCode < 400;
            TelemetryService.recordRequest(isSuccess, duration);
        });

        // 注册 SSE 与网关推送子系统 (对齐 43.1 节)
        await server.register(async (instance) => {
            setupChatSSE(instance, agentService);
            // WebSocket 网关现仅用于：代码补全、IDE 状态同步。
            setupContextWebSocket(instance, agentService);
            setupCompletionWebSocket(instance, agentService);

            // 系统状态推送信道 (对齐 3.1 节)
            instance.get('/ws/events', { websocket: true }, (connection: any, req) => {
                const socket = connection.socket || connection;
                const userId = (req.query as any).userId;
                const queryRoot = (req.query as any).root; // 对齐解耦 36.1: 优先从 URL 提取 root
                
                if (!userId) {
                    socket.close(1008, 'UserId is required');
                    return;
                }
                
                (socket as any).userId = userId;
                // 获取当前有效的工作区
                const workspaceRoot = queryRoot || agentService.getWorkspaceRoot(userId);
                (socket as any).workspaceRoot = workspaceRoot; // 必须绑定到 socket，供 EventDistributor.broadcast 过滤使用
                
                console.log(`System Events WebSocket client connected: ${userId} (Root: ${workspaceRoot || 'none'})`);
                
                // 推送初始化状态
                socket.send(JSON.stringify({ 
                    jsonrpc: '2.0',
                    method: 'event/push',
                    params: {
                        type: 'system:ready',
                        payload: { workspaceRoot: workspaceRoot || null, initialized: !!workspaceRoot }
                    }
                }));

                const onDisconnect = ({ userId: targetUserId, reason }: any) => {
                    if (targetUserId === userId && socket.readyState === 1) {
                        console.log(`[Events WS] Closing by explicit disconnect: ${userId} (${reason || 'workspace-switch'})`);
                        socket.close(4001, 'workspace-disconnect');
                    }
                };
                agentService.on('workspace:disconnect', onDisconnect);

                socket.on('close', (code: number, reason: Buffer) => {
                    agentService.off('workspace:disconnect', onDisconnect);
                    const reasonStr = reason?.toString() || 'none';
                    console.log(`System Events client disconnected: ${userId} (Code: ${code}, Reason: ${reasonStr})`);
                });
            });
        });

        server.post('/api/user/register', async (request, reply) => {
            const { userId, userName } = request.body as { userId: string, userName: string };
            if (!userId || !userName) return reply.status(400).send({ error: 'userId and userName are required' });
            
            const workspaceRoot = agentService.getWorkspaceRoot(userId);
            if (!workspaceRoot) {
                return reply.status(412).send({ error: 'Workspace not initialized for user' });
            }

            try {
                const user = await UserService.registerUser(workspaceRoot, userId, userName);
                agentService.setUserIdentity(userId, userName);
                return reply.send({ status: 'success', user });
            } catch (error: any) {
                return reply.status(400).send({ error: error.message });
            }
        });

        /**
         * 显式初始化 Workspace (对齐 3.4 & 24.0 节)
         * 用户在前端点击“选择目录”后调用
         */
        server.post('/api/workspace/init', async (request, reply) => {
            const { path: newPath, userId } = request.body as { path: string, userId: string };
            if (!newPath || !userId) return reply.status(400).send({ error: 'Path and UserId are required' });
            
            try {
                const workspaceRoot = await runWorkspaceMutation(userId, async () => {
                    await agentService.initializeWorkspace(userId, newPath);
                    return agentService.getWorkspaceRoot(userId) || newPath;
                });

                // 若此前在未初始化 Workspace 时已保存过设置（memory_synced），此处补持久化到 .llm。
                try {
                    const flushed = await SettingsService.flushTransientSettingsToWorkspace(workspaceRoot, userId);
                    if (flushed) {
                        console.log(`[Settings] Flushed transient settings to workspace .llm for user ${userId}: ${workspaceRoot}`);
                    }
                } catch (flushErr: any) {
                    console.warn(`[Settings] Failed to flush transient settings on workspace init: ${flushErr?.message || flushErr}`);
                }

                return reply.send({ status: 'success', workspaceRoot });
            } catch (error: any) {
                return reply.status(500).send({ error: error.message });
            }
        });

        /**
         * 显式重置 Workspace (对齐 Scenario D)
         */
        server.post('/api/workspace/reset', async (request, reply) => {
            const { userId } = request.body as { userId: string };
            if (!userId) return reply.status(400).send({ error: 'UserId is required' });
            
            try {
                await runWorkspaceMutation(userId, async () => {
                    await agentService.resetWorkspace(userId);
                });
                return reply.send({ status: 'success' });
            } catch (error: any) {
                return reply.status(500).send({ error: error.message });
            }
        });

        /**
         * 获取系统实时全量状态 (对齐 36.1 节新规 - 前端 2s 轮询接口)
         */
        server.get('/api/system/status/realtime', async (request, reply) => {
            const { userId, root: queryRoot } = request.query as { userId: string, root?: string };
            if (!userId) return reply.status(400).send({ error: 'UserId is required' });

            try {
                // 优先级：Query 中指定的 root > AgentService 中缓存的 root
                const workspaceRoot = queryRoot || agentService.getWorkspaceRoot(userId);
                const telemetry = TelemetryService.getSystemStatus(workspaceRoot || '');
                const userIdentity = agentService.getUserIdentity(userId);

                // 获取 Git 状态 (对齐 33.7 节)
                // 优化：显式返回 initialized，避免未初始化仓库被错误展示为 MASTER。
                let gitInfo = { initialized: false, branch: '', isDirty: false };
                const fallbackProvider = AIProviderFactory.getFallbackProvider();
                let modelInfo = {
                    provider: fallbackProvider.name,
                    id: fallbackProvider.modelId,
                };

                if (workspaceRoot) {
                    try {
                        const gitService = new GitService(workspaceRoot);
                        if (await gitService.isRepo()) {
                            const status = await gitService.getStatus();
                            gitInfo = {
                                initialized: true,
                                branch: (status.current || '').trim() || 'HEAD',
                                isDirty: status.files.length > 0
                            };
                        }
                    } catch (e) {
                        console.warn(`[StatusBar] Git status failed for ${workspaceRoot}:`, e);
                    }

                    try {
                        const settings = await SettingsService.getSettings(workspaceRoot, userId);
                        const selected = AIProviderFactory.resolveSelection(
                            settings.providers,
                            settings.activeProvider,
                            settings.activeModel,
                        );
                        modelInfo = {
                            provider: selected.providerConfig.name || selected.provider,
                            id: selected.modelId,
                        };
                    } catch (e) {
                        console.warn(`[StatusBar] Model status failed for ${workspaceRoot}:`, e);
                    }
                }

                // 组装 StatusBarData 结构
                const statusBarData = {
                    user: userIdentity ? { id: userId, name: userIdentity } : undefined,
                    model: modelInfo,
                    git: {
                        initialized: gitInfo.initialized,
                        branch: gitInfo.branch,
                        isDirty: gitInfo.isDirty
                    },
                    tokens: {
                        total: telemetry.totalTokens
                    },
                    memory: {
                        heapUsed: (process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1) + 'MB',
                        heapLimit: (v8.getHeapStatistics().heap_size_limit / 1024 / 1024 / 1024).toFixed(0) + 'GB',
                        percent: ((process.memoryUsage().heapUsed / v8.getHeapStatistics().heap_size_limit) * 100).toFixed(1)
                    },
                    telemetry: telemetry // 包含更详细的指标
                };

                return reply.send({
                    status: 'success',
                    payload: statusBarData
                });
            } catch (error: any) {
                return reply.status(500).send({ error: error.message });
            }
        });

        /**
         * 工作区切换预处理：显式关闭当前用户所有旧连接。
         */
        server.post('/api/workspace/disconnect', async (request, reply) => {
            const { userId, reason, previousWorkspaceRoot } = request.body as {
                userId: string;
                reason?: string;
                previousWorkspaceRoot?: string | null;
            };
            if (!userId) return reply.status(400).send({ error: 'UserId is required' });

            try {
                await runWorkspaceMutation(userId, async () => {
                    agentService.disconnectWorkspaceConnections(userId, reason || 'workspace-switch', previousWorkspaceRoot || null);
                    // Give gateway listeners a short grace period to close old sockets deterministically.
                    await new Promise((resolve) => setTimeout(resolve, 80));
                });
                return reply.send({ status: 'success' });
            } catch (error: any) {
                return reply.status(500).send({ error: error.message });
            }
        });

        /**
         * 工作区状态查询：用于前端切换后的最终一致性确认。
         */
        server.get('/api/workspace/status', async (request, reply) => {
            const { userId } = request.query as { userId: string };
            if (!userId) return reply.status(400).send({ error: 'UserId is required' });

            try {
                const workspaceRoot = agentService.getWorkspaceRoot(userId);
                return reply.send({
                    status: 'success',
                    initialized: !!workspaceRoot,
                    workspaceRoot: workspaceRoot || null
                });
            } catch (error: any) {
                return reply.status(500).send({ error: error.message });
            }
        });

        // 文件列表接口 (对齐 3.2 & 24.0 节 / 2026.03 解耦重构)
        server.get('/api/files', async (request, reply) => {
            const { path: subDir = '.', root } = request.query as { path?: string, root?: string };
            
            // Decoupling: Require explicit root for IO operations
            const workspaceRoot = root ? PathUtils.normalizePath(root) : undefined;
            if (!workspaceRoot) return reply.status(412).send({ error: 'Workspace path is required' });

            try {
                // 规范化子路径，FileIO.listFiles 现在统一接受 unsafePath 并通过 resolvePath 处理
                const files = await FileIO.listFiles(subDir, workspaceRoot);
                return reply.send(files);
            } catch (error: any) {
                return reply.status(500).send({ error: error.message });
            }
        });

        // 文件内容获取 (对齐 4.1 & 24.0 节 / 2026.03 解耦重构)
        server.get('/api/files/content', async (request, reply) => {
            const { path: filePath, root, offset, limit } = request.query as { 
                path: string, 
                root?: string, 
                offset?: string, 
                limit?: string 
            };
            if (!filePath) return reply.status(400).send({ error: 'Missing path parameter' });
            
            // 规范化 WorkspaceRoot
            const workspaceRoot = root ? PathUtils.normalizePath(root) : undefined;
            if (!workspaceRoot) return reply.status(412).send({ error: 'Workspace path is required' });

            try {
                // FileIO.readFile 现在统一接受 (path, root) 格式并强制绝对路径校验
                const { content, encoding } = await FileIO.readFile(filePath, workspaceRoot);
                return reply.send({ content, encoding });
            } catch (error: any) {
                server.log.warn(`API File Read Exception: ${error.message}`);

                // Deleted/missing file should be explicit to avoid rendering a misleading blank editor.
                if (error?.code === 'ENOENT' || /no such file|enoent/i.test(String(error?.message || ''))) {
                    return reply.status(404).send({ error: `File not found: ${filePath}` });
                }

                // Keep payload explicit for oversized/binary reads so frontend can render a meaningful warning.
                if (/File too large/i.test(String(error?.message || ''))) {
                    return reply.status(413).send({ error: error.message });
                }

                return reply.status(500).send({ error: error.message || 'Failed to read file content' });
            }
        });

        /**
         * 文件保存接口 (对齐 1.0 & 14.1 节：支持用户手动/自动保存)
         */
        server.post('/api/files/save', async (request, reply) => {
            const { path: filePath, content, encoding: clientEncoding, userId, root } = request.body as { path: string, content: string, encoding?: string, userId: string, root?: string };
            if (!filePath || content === undefined) {
                return reply.status(400).send({ error: 'Missing path or content' });
            }

            const workspaceRoot = root ? PathUtils.normalizePath(root) : (userId ? agentService.getWorkspaceRoot(userId) : undefined);
            if (!workspaceRoot) return reply.status(412).send({ error: 'Workspace path is required' });

            try {
                const normalizedPath = PathUtils.normalizePath(filePath);
                // 优先使用前端原路回传的 encoding，避免二次嗅探导致读写不对称；
                // 缺失时（旧客户端）降级使用 detectEncoding 高精度采样。
                const targetEncoding = (clientEncoding && FileIO.encodingExists(clientEncoding))
                    ? clientEncoding
                    : await FileIO.detectEncoding(normalizedPath);
                const finalBuffer = FileIO.encodeString(content, targetEncoding);
                await FileIO.writeFile(normalizedPath, workspaceRoot, finalBuffer);
                
                return reply.send({ status: 'success', path: normalizedPath });
            } catch (error: any) {
                return reply.status(500).send({ error: error.message });
            }
        });

        /**
         * 文件/目录删除接口 (对齐 33.4 节 / 2026.03 解耦重构)
         */
        server.post('/api/files/delete', async (request, reply) => {
            const { path: filePath, root, recursive = false } = request.body as { 
                path: string, 
                root?: string, 
                recursive?: boolean 
            };
            if (!filePath) return reply.status(400).send({ error: 'Missing path' });

            const workspaceRoot = root ? PathUtils.normalizePath(root) : undefined;
            if (!workspaceRoot) return reply.status(412).send({ error: 'Workspace path is required' });

            try {
                const normalizedPath = PathUtils.normalizePath(filePath);
                await FileIO.deletePath(normalizedPath, workspaceRoot, recursive);
                
                return reply.send({ status: 'success', path: normalizedPath });
            } catch (error: any) {
                return reply.status(500).send({ error: error.message });
            }
        });

        /**
         * 文件/目录重命名接口 (2026.05 右键重命名功能)
         */
        server.post('/api/files/rename', async (request, reply) => {
            const { path: filePath, newName, newPath, root } = request.body as {
                path: string,
                newName?: string,
                newPath?: string,
                root?: string,
            };
            if (!filePath) return reply.status(400).send({ error: 'Missing path' });
            // newPath 用于跨目录移动；newName 用于同目录重命名。两者至少提供一个
            if (!newPath && (!newName || typeof newName !== 'string' || !newName.trim())) {
                return reply.status(400).send({ error: 'Missing or invalid newName or newPath' });
            }

            const workspaceRoot = root ? PathUtils.normalizePath(root) : undefined;
            if (!workspaceRoot) return reply.status(412).send({ error: 'Workspace path is required' });

            try {
                const normalizedPath = PathUtils.normalizePath(filePath);
                const newFullPath = await FileIO.renamePath(
                    normalizedPath,
                    newName?.trim() || '',
                    workspaceRoot,
                    newPath,
                );

                return reply.send({ status: 'success', oldPath: normalizedPath, newPath: newFullPath });
            } catch (error: any) {
                return reply.status(500).send({ error: error.message });
            }
        });

        // 对话Agent助手接口 (对齐 7.0 & 27.1 节，支持 20 步自主迭代)
        server.post('/api/chat', async (request, reply) => {
            const { messages, userId, traceId, locale } = request.body as any;
            const normalized = AIProviderFactory.normalizeSelection();
            if (!userId) return reply.status(400).send({ error: 'UserId is required' });
            if (typeof traceId !== 'string' || !traceId.trim()) {
                return reply.status(400).send({ error: 'traceId is required and must be a non-empty string' });
            }

            try {
                const result = await agentService.chat(
                    userId,
                    normalized.provider,
                    normalized.modelId,
                    messages,
                    traceId,
                    locale,
                );
                const effectiveTraceId = (result as any)?.traceId;
                if (effectiveTraceId && effectiveTraceId !== traceId) {
                    return reply.status(500).send({ error: `TraceId mutation detected. client=${traceId}, service=${effectiveTraceId}` });
                }
                const response = result.toDataStreamResponse();
                
                // 将 Web API Response 适配到 Fastify Reply (对齐 4.5.1 节流式传输)
                for (const [key, value] of response.headers.entries()) {
                    reply.header(key, value);
                }
                reply.header('x-trace-id', traceId);
                return reply.send(response.body);
            } catch (error: any) {
                server.log.error(error);
                return reply.status(500).send({ error: error.message });
            }
        });

        // 获取会话历史 (对齐 9.0 节：热寻回)
        server.get('/api/chat/history', async (request, reply) => {
            const { userId, workspaceRoot, root } = request.query as { userId: string, workspaceRoot?: string, root?: string };
            if (!userId) return reply.status(400).send({ error: 'UserId is required' });
            const requestedRoot = workspaceRoot || root || agentService.getWorkspaceRoot(userId);
            const history = agentService.getSessionHistory(userId, requestedRoot);
            return reply.send(history);
        });

        // 获取历史用户指令 (向上/向下翻阅使用)
        server.get('/api/chat/instructs', async (request, reply) => {
            const { userId, workspace } = request.query as { userId: string, workspace?: string };
            if (!userId) return reply.status(400).send({ error: 'UserId is required' });
            
            const root = workspace || agentService.getWorkspaceRoot(userId);
            if (!root) return reply.send([]);
            
            try {
                const { MemoryService } = await import('@/services/MemoryService.js');
                const instructs = await MemoryService.getInstructions(root);
                return reply.send(instructs.map(i => i.instruction));
            } catch (e) {
                console.error('[API] Failed to fetch user instructs', e);
                return reply.send([]);
            }
        });

        // 设置读取 (对齐 4.4 & 24.0 节：支持显式 root 或会话内 root)
        server.get('/api/settings', async (request, reply) => {
            const { userId, root } = request.query as { userId: string, root?: string };
            if (!userId) return reply.status(400).send({ error: 'UserId is required' });

            const workspaceRoot = root ? PathUtils.normalizePath(root) : agentService.getWorkspaceRoot(userId);
            // 异步预警修复：如果 Workspace 未初始化，设置接口返回 204 No Content 而非 412 Error
            // 这允许前端在引导页静默加载
            if (!workspaceRoot) {
                return reply.code(204).send();
            }

            try {
                const settings = await SettingsService.getSettings(workspaceRoot, userId);
                const maskedSettings = {
                    ...settings,
                    providers: settings.providers.map((p: any) => ({
                        ...p,
                        // 仅返回 Key 的尾部用于前端 UI 回显识别，并标记为已加密/已恢复 (Section 4.4)
                        apiKey: p.apiKey
                            ? (p.apiKey.length > 6
                                ? `${p.apiKey.slice(0, 2)}***${p.apiKey.slice(-4)}`
                                : '***')
                            : ''
                    }))
                };
                return reply.send(maskedSettings);
            } catch (error: any) {
                return reply.status(500).send({ error: error.message });
            }
        });

        /**
         * 模型配置持久化同步接口 (对齐 4.4 节：Persistence & Memory Cache)
         * 由前端在设置变更时触发，后端实时持久化到 .llm/users/{userId}/settings.json
         */
        server.post('/api/settings/sync', async (request, reply) => {
            const { userId, settings, workspaceRoot: bodyWorkspaceRoot } = request.body as { userId: string, settings: UserSettings, workspaceRoot?: string };
            if (!userId || !settings) return reply.status(400).send({ error: 'userId and settings are required' });

            const incomingSettings = settings;
            const normalizedBodyRoot = typeof bodyWorkspaceRoot === 'string' && bodyWorkspaceRoot.trim().length > 0
                ? PathUtils.normalizePath(bodyWorkspaceRoot)
                : undefined;

            const workspaceRoot = normalizedBodyRoot || agentService.getWorkspaceRoot(userId);
            if (!workspaceRoot) {
                // 如果 Workspace 还没初始化，仅更新内存
                SettingsService.updateTransientSettings(userId, incomingSettings);
                return reply.send({ status: 'memory_synced' });
            }

            try {
                // 若客户端显式提供了 root，则把后端会话根与客户端当前根对齐。
                if (normalizedBodyRoot && agentService.getWorkspaceRoot(userId) !== normalizedBodyRoot) {
                    agentService.setWorkspace(userId, normalizedBodyRoot);
                }

                const existing = await SettingsService.getSettings(workspaceRoot, userId);
                const merged = SettingsService.mergeWithExistingSecrets(existing, incomingSettings);
                await SettingsService.syncSettings(workspaceRoot, userId, merged);
                return reply.send({ status: 'persisted', workspaceRoot });
            } catch (error: any) {
                return reply.status(500).send({ error: `Failed to persist settings: ${error.message}` });
            }
        });

        /**
         * LLM 节点测试连接接口
         * 用于配置中心对单个 Provider 执行最小探测请求，验证 baseURL/apiKey/model 组合可用性。
         */
        server.post('/api/settings/test-connection', async (request, reply) => {
            const body = request.body as {
                userId?: string;
                workspaceRoot?: string;
                provider?: Partial<ModelProviderConfig>;
            };

            const userId = (body?.userId || '').trim();
            if (!userId) return reply.status(400).send({ error: 'userId is required' });

            const providerInput = body?.provider || {};
            const providerId = (providerInput.id || '').trim().toLowerCase();
            const modelId = (providerInput.modelId || '').trim();
            if (!modelId) {
                return reply.status(400).send({ error: 'provider.modelId is required' });
            }

            const normalizedBodyRoot = typeof body?.workspaceRoot === 'string' && body.workspaceRoot.trim().length > 0
                ? PathUtils.normalizePath(body.workspaceRoot)
                : undefined;
            const workspaceRoot = normalizedBodyRoot || agentService.getWorkspaceRoot(userId);

            const isMaskedApiKey = (raw: string | undefined): boolean => {
                if (!raw) return false;
                const v = raw.trim();
                if (!v) return false;
                return /^sk-\*{3,}/.test(v) || /^\*+$/.test(v) || /\*{3,}/.test(v);
            };

            const rawApiKey = (providerInput.apiKey || '').trim();
            let resolvedApiKey = rawApiKey;

            // 支持配置中心回显掩码 key（如 sk***1234）：优先回填已有明文密钥后再探测。
            if ((!resolvedApiKey || isMaskedApiKey(resolvedApiKey)) && workspaceRoot && providerId) {
                try {
                    const existing = await SettingsService.getSettings(workspaceRoot, userId);
                    const existingProvider = existing.providers.find((p) => p.id === providerId);
                    if (existingProvider?.apiKey) {
                        resolvedApiKey = existingProvider.apiKey;
                    }
                } catch (e) {
                    // Ignore settings restore errors here; we'll validate key below.
                }
            }

            if (!resolvedApiKey || isMaskedApiKey(resolvedApiKey)) {
                return reply.status(400).send({
                    error: 'API key is required for connection test. Please enter a valid key first.'
                });
            }

            const providerForTest: Partial<ModelProviderConfig> = {
                ...providerInput,
                id: providerId || providerInput.id,
                modelId,
                apiKey: resolvedApiKey,
                baseURL: (providerInput.baseURL || '').trim(),
            };

            try {
                const selectedProvider = AIProviderFactory.normalizeProvider(providerForTest);
                const client = AIProviderFactory.getClient(selectedProvider);
                const startedAt = Date.now();
                const probeTimeoutMs = 15000;

                const probe = client.chat.completions.create({
                    model: selectedProvider.modelId,
                    messages: [{ role: 'user', content: 'ping' }],
                    max_tokens: 1,
                    stream: false,
                } as any);

                const timeoutGuard = new Promise((_, reject) => {
                    setTimeout(() => reject(new Error('Connection test timed out (15s).')), probeTimeoutMs);
                });

                await Promise.race([probe, timeoutGuard]);

                return reply.send({
                    status: 'ok',
                    providerId: selectedProvider.id,
                    modelId: selectedProvider.modelId,
                    latencyMs: Date.now() - startedAt,
                    message: 'Connection test passed.'
                });
            } catch (error: any) {
                const statusCode = Number(error?.status) || 502;
                const reason = error?.error?.message || error?.message || 'Unknown connection error';
                return reply.status(statusCode).send({
                    status: 'error',
                    providerId,
                    modelId,
                    error: reason
                });
            }
        });

        server.get('/api/health', async () => ({ status: 'ok' }));

        // 任务清单 (对齐 29.0 & 19.0 节 / 2026.03 解耦重构)
        server.get('/api/todos', async (request, reply) => {
            const { userId, root } = request.query as { userId: string, root?: string };
            const workspaceRoot = root ? PathUtils.normalizePath(root) : (userId ? agentService.getWorkspaceRoot(userId) : undefined);
            
            if (!workspaceRoot) return reply.status(412).send({ error: 'Workspace path is required' });

            // 虽然任务逻辑通常由 AgentService 驱动，但查询操作应当允许由路径作为索引
            const todos = await TodoService.getTodos(workspaceRoot, userId || 'default');
            return reply.send(todos);
        });

        /**
         * 全局搜索接口 (对齐 38.1 节 / 2026.03 解耦重构)
         */
        server.get('/api/search', async (request, reply) => {
            const { q, root, type = 'file' } = request.query as { q: string, root: string, type?: 'file' | 'grep' };
            if (!q || !root) return reply.status(400).send({ error: 'q and root are required' });

            const workspaceRoot = PathUtils.normalizePath(root);
            if (!workspaceRoot) return reply.status(412).send({ error: 'Valid workspaceRoot is required' });

            try {
                const results = await FileIO.searchFiles(workspaceRoot, q);
                return reply.send(results);
            } catch (error: any) {
                return reply.status(500).send({ error: error.message });
            }
        });

        /**
         * Git 状态查询接口（显式模式）
         * 彻底解耦: 不再依赖 AgentService 内部的工作空间状态。
         * 允许前端直接显式传递 path；若仓库未初始化则返回 uninitialized，不执行任何隐式初始化或同步。
         */
        server.get('/api/git/status', async (request, reply) => {
            const { path: requestedPath } = request.query as { path?: string };
            if (!requestedPath) return reply.status(400).send({ error: 'path is required' });

            try {
                const gitInstalled = await GitService.isInstalled();
                if (!gitInstalled) {
                    return reply.status(503).send({ error: 'Git CLI is not installed on server' });
                }

                const git = new GitService(requestedPath);
                if (!(await git.isRepo())) {
                    return reply.send({ status: 'uninitialized' });
                }

                const status = await git.getStatus();
                return reply.send({ status });
            } catch (error: any) {
                return reply.status(500).send({ error: error.message });
            }
        });

        /**
         * 获取 Git 原始快照 (HEAD 版本)
         * 用于 Monaco DiffEditor 渲染
         */
        server.get('/api/git/show', async (request, reply) => {
            const { path: filePath, root } = request.query as { path: string, root: string };
            if (!filePath || !root) return reply.status(400).send({ error: 'Path and Root are required' });

            try {
                const gitService = new GitService(PathUtils.normalizePath(root));
                const content = await gitService.getOriginalContent(filePath);
                return reply.send({ content });
            } catch (error: any) {
                if (error.message === 'FILE_NOT_IN_HEAD') {
                    return reply.status(404).send({ error: 'File not found in HEAD (Untracked)' });
                }
                return reply.status(500).send({ error: error.message });
            }
        });

        // 获取仓库级提交历史
        server.get('/api/git/history', async (request, reply) => {
            const { path: requestedPath, limit } = request.query as { path?: string; limit?: string };
            if (!requestedPath) return reply.status(400).send({ error: 'path is required' });

            try {
                const gitInstalled = await GitService.isInstalled();
                if (!gitInstalled) {
                    return reply.status(503).send({ error: 'Git CLI is not installed on server' });
                }

                const git = new GitService(requestedPath);
                if (!(await git.isRepo())) {
                    return reply.send({ status: 'uninitialized', commits: [] });
                }

                const limitNum = Number(limit) || globalConfig.git.historyLimit;
                const commits = await git.getHistory(limitNum);
                return reply.send({ commits });
            } catch (error: any) {
                return reply.status(500).send({ error: error.message });
            }
        });

        // 获取单文件提交历史
        server.get('/api/git/file-history', async (request, reply) => {
            const { path: requestedPath, filePath, limit } = request.query as { path?: string; filePath?: string; limit?: string };
            if (!requestedPath || !filePath) {
                return reply.status(400).send({ error: 'path and filePath are required' });
            }

            try {
                const gitInstalled = await GitService.isInstalled();
                if (!gitInstalled) {
                    return reply.status(503).send({ error: 'Git CLI is not installed on server' });
                }

                const git = new GitService(requestedPath);
                if (!(await git.isRepo())) {
                    return reply.send({ status: 'uninitialized', commits: [] });
                }

                const limitNum = Number(limit) || globalConfig.git.historyLimit;
                const commits = await git.getFileHistory(filePath, limitNum);
                return reply.send({ commits });
            } catch (error: any) {
                return reply.status(500).send({ error: error.message });
            }
        });

        // 获取某次提交的差异（支持限定单文件）
        server.get('/api/git/commit-diff', async (request, reply) => {
            const { path: requestedPath, commit, filePath } = request.query as { path?: string; commit?: string; filePath?: string };
            if (!requestedPath || !commit) {
                return reply.status(400).send({ error: 'path and commit are required' });
            }

            try {
                const gitInstalled = await GitService.isInstalled();
                if (!gitInstalled) {
                    return reply.status(503).send({ error: 'Git CLI is not installed on server' });
                }

                const git = new GitService(requestedPath);
                if (!(await git.isRepo())) {
                    return reply.status(404).send({ error: 'Git repository not initialized' });
                }

                const diff = await git.getCommitDiff(commit, filePath);
                return reply.send({ diff });
            } catch (error: any) {
                return reply.status(500).send({ error: error.message });
            }
        });

        server.post('/api/git/init', async (request, reply) => {
            const { path: requestedPath } = request.body as { path?: string };
            if (!requestedPath) return reply.status(400).send({ error: 'path is required' });

            try {
                const gitInstalled = await GitService.isInstalled();
                if (!gitInstalled) {
                    return reply.status(503).send({ error: 'Git CLI is not installed on server' });
                }

                const git = new GitService(requestedPath);
                if (await git.isRepo()) {
                    return reply.send({ status: 'already_initialized', initialized: false });
                }

                await git.initRepo();
                return reply.send({ status: 'success', initialized: true });
            } catch (error: any) {
                return reply.status(500).send({ error: error.message });
            }
        });

        const basePort = Number(globalConfig.port) || 3001;
        const maxPortRetries = Number(globalConfig.portRetryLimit) || 20;
        const bindHost = String(globalConfig.host || '0.0.0.0');
        let boundPort = -1;

        for (let offset = 0; offset <= maxPortRetries; offset++) {
            const candidatePort = basePort + offset;
            try {
                await server.listen({ port: candidatePort, host: bindHost });
                boundPort = candidatePort;
                break;
            } catch (e: any) {
                if (e?.code === 'EADDRINUSE' && offset < maxPortRetries) {
                    console.warn(`[Server] Port ${candidatePort} is in use, trying ${candidatePort + 1}...`);
                    continue;
                }
                throw e;
            }
        }

        if (boundPort === -1) {
            throw new Error(`[Server] Failed to bind any port from ${basePort} to ${basePort + maxPortRetries}`);
        }

        console.log(`Server listening on http://${bindHost}:${boundPort}`);
        
        /**
         * 优雅关闭 (对齐 23.1 & 33.3 节：资源释放)
         */
        const shutdown = async (signal: string) => {
            console.log(`[Server] Received ${signal}. Shutting down...`);
            
            // 1. 停止接收新请求
            await server.close();
            
            console.log('[Server] Cleanup complete. Goodbye.');
            process.exit(0);
        };

        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('SIGINT', () => shutdown('SIGINT'));
    } catch (err) {
        server.log.error(err);
        process.exit(1);
    }
}

bootstrap();


import { LiveContextStore } from '@/services/LiveContextStore.js';
import { ToolManager } from '@/services/ToolManager.js';
import type { ToolMetadata } from '@/services/ToolManager.js';
import { WorkspaceRegistry } from '@/services/WorkspaceRegistry.js';
import { SkillService } from '@/services/SkillService.js';
import { BuiltinSkillService, buildAutoLoadedSkills, buildBuiltinSkillIndex } from '@/services/BuiltinSkillService.js';
import { RuleService } from '@/services/RuleService.js';
import { TodoTools } from '@/tools/TodoTools.js';
import { NeverMistakeTools } from '@/tools/NeverMistakeTools.js';
import { UserPreferenceTools } from '@/tools/UserPreferenceTools.js';
import { FileTools } from '@/tools/FileTools.js';
import { BrowserMcpAdapter } from '@/services/BrowserMcpAdapter.js';
import { ProcessSafetyGuard } from '@/services/ProcessSafetyGuard.js';
import { FileIO } from '@/utils/FileIO.js';
import { SystemTools } from '@/tools/SystemTools.js';
import { CalculatorTool } from '@/tools/custom/CalculatorTool.js';
import { WorkflowTools } from '@/tools/WorkflowTools.js';
import { McpService } from '@/services/McpService.js';
import { detectRepeatedControlToken, findControlToken, probeLeadingContent } from '@/services/ModelOutputGuard.js';
import { SERVER_ROOT, CONFIG_ROOT } from '@/utils/PathUtils.js';
import { BEIJING_TIME_ZONE, formatBeijingDate } from '@/utils/TimeUtils.js';
import { WORKSPACE_SKILL_DIRECTORIES } from '@/utils/WorkspaceSkillPaths.js';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as globalConfig } from '@/config/index.js';
import { SyntaxCheckService } from '@/services/SyntaxCheckService.js';

// SOLID 重构：新的提示词构建架构（可逐步迁移）
import { createStandardBuilder, buildSystemPrompt as buildPromptV2 } from '@/services/PromptSectionFactory.js';
import type { PromptBuildContext } from '@/types/prompt.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function normalizeCommandEnvironment(value: unknown): Record<string, string> | undefined {
    if (value === undefined) return undefined;
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('environment 必须是字符串键值对象');
    }
    const env: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (!key.trim() || /[=\0]/.test(key) || typeof entry !== 'string' || entry.includes('\0')) {
            throw new Error(`无效的 environment 变量: ${key}`);
        }
        env[key.trim()] = entry;
    }
    return Object.keys(env).length > 0 ? env : undefined;
}

export class AgentService extends EventEmitter {
    private static instance: AgentService;
    public contextStore = LiveContextStore.getInstance();
    public toolManager = new ToolManager();
    public sessionUsage: Map<string, number> = new Map();
    public sessionLastAccess: Map<string, number> = new Map();
    public activeModels: Map<string, { provider: string, modelId: string }> = new Map();
    private readonly workspaces = WorkspaceRegistry.getInstance();
    private userHistories: Map<string, any[]> = new Map();
    private readonly sessionHistoryKeepLast: number;
    /**
     * Maven 项目 JVM 编码缓存（每次 buildSystemPrompt 时更新）
     * - key 不存在：从未扫描 / 工作区无 pom.xml（非 Maven 项目）→ executeCommand 默认注入 UTF-8
     * - value === null：发现 pom.xml 但无显式 <encoding> → 不注入，让 Maven/系统默认决定
     * - value === string：pom.xml 中明确声明的编码（如 "GBK"）→ 注入该编码
     */
    private userProjectEncodings: Map<string, string | null> = new Map();
    /** 当前 workspace 已注册的 MCP 工具名集合（用于切换 workspace 时清理） */
    private currentMcpToolNames: Set<string> = new Set();
    /** 当前 workspace 已注册的 Playwright MCP 桥接工具名集合 */
    private currentPlaywrightToolNames: Set<string> = new Set();

    // ============================================================
    // 系统提示词缓存（对话维度 FIFO，替代旧的时间维度 TTL 策略）
    // ============================================================
    /**
     * 系统提示词缓存。
     * key = `${requestId}::${agentConfigFile}`（如 `abc123::main-agent.json`）
     * 同一 request 下不同 Agent（主 Agent / 评估 Agent）各自独立缓存，互不污染。
     */
    private systemPromptCache: Map<string, string> = new Map();
    /** FIFO 淘汰队列：按插入顺序记录复合 key */
    private systemPromptCacheOrder: string[] = [];
    /** 最大缓存条目数（FIFO 淘汰） */
    private readonly MAX_SYSTEM_PROMPT_CACHE = 10;

    /** 构建缓存复合 key：`${requestId}::${agentConfigFile}` */
    private buildCacheKey(requestId: string, agentConfigFile: string): string {
        return `${requestId}::${agentConfigFile}`;
    }

    public stats = {
        totalRequests: 0,
        totalErrors: 0,
        totalLatency: 0,
        lastErrors: [] as string[]
    };

    public static getInstance(): AgentService {
        if (!AgentService.instance) {
            AgentService.instance = new AgentService();
        }
        return AgentService.instance;
    }

    private constructor() {
        super();
        this.sessionHistoryKeepLast = this.resolveSessionHistoryKeepLast();
        console.log(`[AgentService] Session history keep-last limit: ${this.sessionHistoryKeepLast}`);
        this.initializeTools();
    }

    private resolveSessionHistoryKeepLast(): number {
        const raw = Number(process.env.AGENT_SESSION_HISTORY_KEEP_LAST);
        if (!Number.isFinite(raw)) return 10;
        const normalized = Math.floor(raw);
        return normalized > 0 ? normalized : 10;
    }

    private initializeTools() {
        console.log('[AgentService] Initializing global tools...');
        
        console.log('[AgentService] Registering TodoTools (atomic)...');
        // 注册 Todo 原子工具集 (list_todos / append_todo / update_todo / delete_todo)
        for (const def of TodoTools.getDefinitions()) {
            const toolName = def.name;
            this.toolManager.registerTool({
                ...def,
                execute: async (params, context) => {
                    const root = this.resolveWorkspaceRootFromContext(context);
                    if (!root) throw new Error('Workspace not initialized');
                    const tools = new TodoTools(root);
                    switch (toolName) {
                        case 'list_todos': return await tools.listTodos(params, context);
                        case 'append_todo': return await tools.appendTodo(params, context);
                        case 'update_todo': return await tools.updateTodo(params, context);
                        case 'delete_todo': return await tools.deleteTodo(params, context);
                        default: throw new Error(`Unknown todo tool: ${toolName}`);
                    }
                }
            });
        }

        console.log('[AgentService] Registering NeverMistakeTools (atomic)...');
        // 注册防重复犯错记忆原子工具集 (list_never_mistake_rules / append_never_mistake_rule / delete_never_mistake_rule)
        for (const def of NeverMistakeTools.getDefinitions()) {
            const toolName = def.name;
            this.toolManager.registerTool({
                ...def,
                execute: async (params, context) => {
                    const root = this.resolveWorkspaceRootFromContext(context);
                    if (!root) throw new Error('Workspace not initialized');
                    const tools = new NeverMistakeTools(root);
                    switch (toolName) {
                        case 'list_never_mistake_rules': return await tools.listRules(context);
                        case 'append_never_mistake_rule': return await tools.appendRule(params, context);
                        case 'delete_never_mistake_rule': return await tools.deleteRule(params, context);
                        default: throw new Error(`Unknown never-mistake tool: ${toolName}`);
                    }
                }
            });
        }

        console.log('[AgentService] Registering UserPreferenceTools (atomic)...');
        // 注册用户偏好记忆原子工具集 (list_user_preferences / upsert_user_preference / delete_user_preference)
        for (const def of UserPreferenceTools.getDefinitions()) {
            const toolName = def.name;
            this.toolManager.registerTool({
                ...def,
                execute: async (params, context) => {
                    const root = this.resolveWorkspaceRootFromContext(context);
                    if (!root) throw new Error('Workspace not initialized');
                    const tools = new UserPreferenceTools(root);
                    switch (toolName) {
                        case 'list_user_preferences': return await tools.listPreferences(params, context);
                        case 'upsert_user_preference': return await tools.upsertPreference(params, context);
                        case 'delete_user_preference': return await tools.deletePreference(params, context);
                        default: throw new Error(`Unknown user-preference tool: ${toolName}`);
                    }
                }
            });
        }

        console.log('[AgentService] Registering read_skill...');
        // 专项技能按需加载（内置技能 + 工作区技能）：系统提示词只放索引，正文由模型按需拉取
        this.toolManager.registerTool({
            name: 'read_skill',
            description: '按名称加载专项技能完整规范（见系统提示词技能索引）。',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: '技能名称，如 ppt-design。' }
                },
                required: ['name']
            },
            execute: async (params, context) => {
                const root = this.resolveWorkspaceRootFromContext(context);
                const name = typeof params?.name === 'string' ? params.name.trim() : '';
                if (!name) throw new Error('The "name" parameter is missing or invalid.');

                const builtin = await BuiltinSkillService.getInstance().getSkill(name);
                if (builtin) {
                    return `[skill] ${builtin.name} (builtin)\n\n${builtin.content}`;
                }

                if (root) {
                    const workspaceSkill = await SkillService.getInstance().findSkill(root, name);
                    if (workspaceSkill) {
                        const content = await SkillService.getInstance().readSkillBody(root, workspaceSkill);
                        return `[skill] ${workspaceSkill.name} (workspace: ${workspaceSkill.skillFilePath})\n\n${content}`;
                    }
                }

                const available = [
                    ...(await BuiltinSkillService.getInstance().listSkills()).map((skill) => skill.name),
                    ...(root ? (await SkillService.getInstance().getSkills(root)).map((skill) => skill.name) : []),
                ];
                throw new Error(`技能 "${name}" 不存在。可用技能：${available.join(', ') || '(无)'}`);
            }
        });

        console.log('[AgentService] Registering read_file...');
        // 注册文件核心工具 (原子化 IO)
        this.toolManager.registerTool({
            name: 'read_file',
            description: `按行读取工作区文件。单次上限 ${globalConfig.readFile.maxLines} 行、约 ${Math.round(globalConfig.readFile.maxContentBytes / 1024)}KB；大文件用 startLine/lineCount 分段，超长行截断后改用 read_file_by_byte。`,
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '工作区相对路径。' },
                    startLine: { type: 'number', description: '起始行号（从 1 开始）。默认为 1。' },
                    lineCount: { type: 'number', description: '要读取的行数。' }
                },
                required: ['path']
            },
            execute: async (params, context) => {
                const root = this.resolveWorkspaceRootFromContext(context);
                if (!root) throw new Error('Workspace not initialized');
                if (!params || !params.path || typeof params.path !== 'string') {
                    throw new Error('The "path" parameter is missing or invalid.');
                }
                const result = await FileTools.readFile(root, params.path, params.startLine, params.lineCount);
                // 【Token 优化】将结构化 JSON 对象扁平化为纯文本字符串。
                // 消除 JSON.stringify 导致的 \n → \\n 和 \" → \\\" 双重转义（实测节省 10-15% token）。
                // AgentTurnEngine 对 string 类型 result 直接作为 tool message content 使用，不经过 JSON 序列化。
                if (result.status === 'error') {
                    throw new Error(result.message || result.error || 'read_file failed');
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TS 窄化不足，运行时已通过 status !== 'error' 守卫
                const ok = result as any;
                const flags: string[] = [];
                if (ok.truncated) flags.push('truncated');
                if (ok.hasMore) flags.push('has more');
                const flagStr = flags.length > 0 ? ` (${flags.join(', ')})` : '';
                const header = `[read_file] path=${params.path} lines=${ok.startLine}-${ok.endLine}/${ok.totalLines}${flagStr}`;
                return header + '\n' + (ok.content || '');
            }
        });


        console.log('[AgentService] Registering read_file_by_byte...');
        this.toolManager.registerTool({
            name: 'read_file_by_byte',
            description: '按字节范围读取；仅用于 read_file 的超长单行截断或二进制/混淆内容，不适用于普通文本读取。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '工作区相对路径。' },
                    offset: { type: 'number', description: '字节偏移量（从 0 开始）' },
                    length: { type: 'number', description: '读取字节长度（单次上限 2.5KB）' }
                },
                required: ['path']
            },
            execute: async (params, context) => {
                const root = this.resolveWorkspaceRootFromContext(context);
                if (!root) throw new Error('Workspace not initialized');
                const result = await FileTools.readFileByByte(root, params.path, params.offset, params.length);
                // 【Token 优化】将结构化 JSON 对象扁平化为纯文本字符串，对标 read_file。
                if ((result as any).status === 'error') {
                    throw new Error((result as any).message || (result as any).error || 'read_file_by_byte failed');
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const ok = result as any;
                const flags: string[] = [];
                if (ok.hasMore) flags.push('has more');
                if (ok.boundaryWarning) flags.push('boundary');
                const flagStr = flags.length > 0 ? ` (${flags.join(', ')})` : '';
                const header = `[read_file_by_byte] path=${params.path} offset=${ok.offset ?? params.offset ?? 0} bytes=${ok.bytesRead ?? 0}/${ok.totalSize ?? '?'}${flagStr}`;
                const warning = ok.boundaryWarning ? `\n⚠ ${ok.boundaryWarning}` : '';
                return header + '\n' + (ok.content || '') + warning;
            }
        });

        console.log('[AgentService] Registering file_write...');
        this.toolManager.registerTool({
            name: 'file_write',
            description: '创建文件或完整覆写现有文件；局部修改用 file_replace/file_insert，多处替换用 file_replace_all。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '文件相对路径' },
                    content: { type: 'string', description: '要写入的完整文本。' },
                    encoding: { type: 'string', description: '可选：指定写入编码（如 GBK、UTF-8）。仅对新建文件生效；已有文件自动沿用原编码。' }
                },
                required: ['path', 'content']
            },
            execute: async (params, context) => {
                const root = this.resolveWorkspaceRootFromContext(context);
                if (!root) throw new Error('Workspace not initialized');
                if (!params || !params.path || typeof params.path !== 'string') {
                    return {
                        status: 'error',
                        error: 'INVALID_PARAMS',
                        errorPhase: 'write',
                        message: 'The "path" parameter is missing or invalid.'
                    };
                }
                if (typeof params.content !== 'string') {
                    return {
                        status: 'error',
                        error: 'INVALID_PARAMS',
                        errorPhase: 'write',
                        message: 'The "content" parameter is missing or invalid.'
                    };
                }
                const writeResult = await FileTools.writeFile(root, params.path, params.content, params.encoding);

                if (!writeResult || writeResult.status !== 'success') {
                    return {
                        ...(writeResult || { status: 'error', error: 'WRITE_FAILED', message: 'Unknown write failure' }),
                        errorPhase: 'write'
                    };
                }

                const [syntaxCheck] = await SyntaxCheckService.checkFiles(root, [params.path]);
                const gatePass = SyntaxCheckService.isGatePass(syntaxCheck);
                return {
                    ...writeResult,
                    ...(gatePass ? {} : { syntax: `errors: ${syntaxCheck?.diagnostics?.length || '?'}` }),
                };
            }
        });

        console.log('[AgentService] Registering list_files...');
        // 补全文件系统工具：listFiles, searchFiles, deletePath
        this.toolManager.registerTool({
            name: 'list_files',
            description: '列出工作区目录树（目录以 / 结尾，最多 1200 项）。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '目录相对路径；默认为 "."。' },
                    depth: { type: 'number', description: '递归深度（1-10）。' }
                },
                required: ['depth']
            },
            execute: async (params, context) => {
                const root = this.resolveWorkspaceRootFromContext(context);
                if (!root) throw new Error('Workspace not initialized');
                const result = await FileTools.listFiles(root, params.path, params.depth);
                // 【Token 优化】将结构化 JSON 对象扁平化为纯文本字符串。
                // 消除 JSON.stringify 导致的 \n → \\n 双重转义（实测节省 15-20% token）。
                // AgentTurnEngine 对 string 类型 result 直接作为 tool message content 使用，不经过 JSON 序列化。
                if (result.status === 'error') {
                    throw new Error(result.message || result.error || 'list_files failed');
                }
                // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TS 窄化不足，运行时已通过 status !== 'error' 守卫
                const ok = result as any;
                const suffix = ok.truncated ? ' (已截断，仅显示前1200项)' : '';
                const header = `[list_files] path=${ok.path || '.'} depth=${ok.depth} count=${ok.count}${suffix}`;
                const ignored = ok.ignoredDirs?.length
                    ? `\n[已忽略系统目录: ${ok.ignoredDirs.join(', ')}]`
                    : '';
                return header + ignored + '\n' + (ok.tree || '');
            }
        });

        console.log('[AgentService] Registering delete_path...');
        this.toolManager.registerTool({
            name: 'delete_path',
            description: '物理删除文件或目录；禁止将其用于内容修复，修改请用 file_replace 或 file_insert。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '文件相对路径' },
                    recursive: { type: 'boolean', description: '是否递归删除目录' }
                },
                required: ['path']
            },
            execute: async (params, context) => {
                const root = this.resolveWorkspaceRootFromContext(context);
                if (!root) throw new Error('Workspace not initialized');
                return await FileTools.deletePath(root, params.path, params.recursive);
            }
        });

        // ── file_replace：精准文本替换 ──
        console.log('[AgentService] Registering file_replace...');
        this.toolManager.registerTool({
            name: 'file_replace',
            description: '在文件中精确替换唯一匹配的 oldText；匹配多处时返回歧义错误，newText 为空时删除匹配内容。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '文件相对路径' },
                    oldText: { type: 'string', description: '原文片段。' },
                    newText: { type: 'string', description: '替换文本。' }
                },
                required: ['path', 'oldText', 'newText']
            },
            execute: async (params, context) => {
                const root = this.resolveWorkspaceRootFromContext(context);
                if (!root) throw new Error('Workspace not initialized');
                if (!params || !params.path || typeof params.path !== 'string') {
                    return {
                        status: 'error',
                        error: 'INVALID_PARAMS',
                        errorPhase: 'replace',
                        message: 'The "path" parameter is missing or invalid.'
                    };
                }
                if (typeof params.oldText !== 'string' || !params.oldText) {
                    return {
                        status: 'error',
                        error: 'INVALID_PARAMS',
                        errorPhase: 'replace',
                        message: 'oldText 不能为空。若要插入内容请使用 file_insert。'
                    };
                }
                if (typeof params.newText !== 'string') {
                    return {
                        status: 'error',
                        error: 'INVALID_PARAMS',
                        errorPhase: 'replace',
                        message: 'The "newText" parameter is missing or invalid.'
                    };
                }
                const editResult = await FileTools.editFileByReplace(root, params.path, params.oldText, params.newText);
                if (!editResult || editResult.status !== 'success') {
                    return {
                        ...(editResult || { status: 'error', error: 'REPLACE_FAILED', message: 'Unknown replace failure' }),
                        errorPhase: 'replace'
                    };
                }
                const [syntaxCheck] = await SyntaxCheckService.checkFiles(root, [params.path]);
                const gatePass = SyntaxCheckService.isGatePass(syntaxCheck);
                return {
                    ...editResult,
                    ...(gatePass ? {} : { syntax: `errors: ${syntaxCheck?.diagnostics?.length || '?'}` }),
                };
            }
        });

        // ── file_insert：行号精准插入 ──
        console.log('[AgentService] Registering file_insert...');
        this.toolManager.registerTool({
            name: 'file_insert',
            description: '在 startLine 指定的行号前插入内容；文件总行数 + 1 表示追加到末尾。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '文件相对路径' },
                    startLine: { type: 'integer', minimum: 1, description: '起始行号（从 1 开始）。' },
                    newText: { type: 'string', description: '要插入的文本。' }
                },
                required: ['path', 'startLine', 'newText']
            },
            execute: async (params, context) => {
                const root = this.resolveWorkspaceRootFromContext(context);
                if (!root) throw new Error('Workspace not initialized');
                if (!params || !params.path || typeof params.path !== 'string') {
                    return {
                        status: 'error',
                        error: 'INVALID_PARAMS',
                        errorPhase: 'insert',
                        message: 'The "path" parameter is missing or invalid.'
                    };
                }
                if (typeof params.startLine !== 'number' || !Number.isInteger(params.startLine) || params.startLine < 1) {
                    return {
                        status: 'error',
                        error: 'INVALID_PARAMS',
                        errorPhase: 'insert',
                        message: 'startLine 必须为 >= 1 的整数。'
                    };
                }
                if (typeof params.newText !== 'string') {
                    return {
                        status: 'error',
                        error: 'INVALID_PARAMS',
                        errorPhase: 'insert',
                        message: 'The "newText" parameter is missing or invalid.'
                    };
                }
                const editResult = await FileTools.editFileByInsert(root, params.path, params.startLine, params.newText);
                if (!editResult || editResult.status !== 'success') {
                    return {
                        ...(editResult || { status: 'error', error: 'INSERT_FAILED', message: 'Unknown insert failure' }),
                        errorPhase: 'insert'
                    };
                }
                const [syntaxCheck] = await SyntaxCheckService.checkFiles(root, [params.path]);
                const gatePass = SyntaxCheckService.isGatePass(syntaxCheck);
                return {
                    ...editResult,
                    ...(gatePass ? {} : { syntax: `errors: ${syntaxCheck?.diagnostics?.length || '?'}` }),
                };
            }
        });

        console.log('[AgentService] Registering file_replace_all...');
        this.toolManager.registerTool({
            name: 'file_replace_all',
            description: '将文件中所有字面匹配的 oldText 替换为 newText，适合批量重命名、术语或格式调整。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '文件相对路径' },
                    oldText: { type: 'string', description: '待匹配文本。' },
                    newText: { type: 'string', description: '替换文本；空字符串表示删除匹配项。' }
                },
                required: ['path', 'oldText', 'newText']
            },
            execute: async (params, context) => {
                const root = this.resolveWorkspaceRootFromContext(context);
                if (!root) throw new Error('Workspace not initialized');
                if (!params || !params.path || typeof params.path !== 'string') {
                    return {
                        status: 'error',
                        error: 'INVALID_PARAMS',
                        errorPhase: 'replace_all',
                        message: 'The "path" parameter is missing or invalid.'
                    };
                }
                if (typeof params.oldText !== 'string' || !params.oldText) {
                    return {
                        status: 'error',
                        error: 'INVALID_PARAMS',
                        errorPhase: 'replace_all',
                        message: 'The "oldText" parameter is missing or empty.'
                    };
                }
                if (typeof params.newText !== 'string') {
                    return {
                        status: 'error',
                        error: 'INVALID_PARAMS',
                        errorPhase: 'replace_all',
                        message: 'The "newText" parameter is missing or invalid.'
                    };
                }

                const replaceResult = await FileTools.replaceAllInFile(root, params.path, params.oldText, params.newText);

                if (!replaceResult || replaceResult.status !== 'success') {
                    return {
                        ...(replaceResult || { status: 'error', error: 'REPLACE_ALL_FAILED', message: 'Unknown replace_all failure' }),
                        errorPhase: 'replace_all'
                    };
                }

                const [syntaxCheck] = await SyntaxCheckService.checkFiles(root, [params.path]);
                const gatePass = SyntaxCheckService.isGatePass(syntaxCheck);
                return {
                    ...replaceResult,
                    ...(gatePass ? {} : { syntax: `errors: ${syntaxCheck?.diagnostics?.length || '?'}` }),
                };
            }
        });

        console.log('[AgentService] Registering run_powershell_command...');
        this.toolManager.registerTool({
            name: 'run_powershell_command',
            description: '在工作区执行 PowerShell 命令。',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'PowerShell 原生命令体。' },
                    timeout: { type: 'number', description: '超时毫秒数。' },
                    environment: {
                        type: 'object',
                        description: '可选：追加/覆盖子进程环境变量（仅字符串值）。',
                        additionalProperties: { type: 'string' },
                    },
                },
                required: ['command', 'timeout']
            },
            execute: async (params, context) => {
                const root = this.resolveWorkspaceRootFromContext(context);
                if (!root) throw new Error('Workspace not initialized');
                const userId = context?.userId;
                if (!userId) throw new Error('User not initialized');
                const javaEncoding = this.getProjectJavaEncoding(userId, root);
                return await SystemTools.executePowerShellCommand(
                    params.command,
                    root,
                    userId,
                    params.timeout,
                    javaEncoding,
                    root,
                    normalizeCommandEnvironment(params.environment),
                    context?.abortSignal,
                );
            }
        });

        console.log('[AgentService] Registering run_cmd_command...');
        this.toolManager.registerTool({
            name: 'run_cmd_command',
            description: '仅限 Windows，在工作区执行 CMD 命令；适合简单文本和文件操作。',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'CMD 原生命令体。' },
                    timeout: { type: 'number', description: '超时毫秒数。' },
                    environment: {
                        type: 'object',
                        description: '可选：追加/覆盖子进程环境变量（仅字符串值）。',
                        additionalProperties: { type: 'string' },
                    },
                },
                required: ['command', 'timeout']
            },
            execute: async (params, context) => {
                const root = this.resolveWorkspaceRootFromContext(context);
                if (!root) throw new Error('Workspace not initialized');
                const userId = context?.userId;
                if (!userId) throw new Error('User not initialized');
                const javaEncoding = this.getProjectJavaEncoding(userId, root);
                return await SystemTools.executeCmdCommand(
                    params.command,
                    root,
                    userId,
                    params.timeout,
                    javaEncoding,
                    root,
                    normalizeCommandEnvironment(params.environment),
                    context?.abortSignal,
                );
            }
        });

        // BrowserAutomationTools 已重构为 BrowserMcpAdapter（纯适配器模式）
        // Playwright MCP 工具在 workspace 初始化时通过 registerBrowserMcpAdapter 动态注册
        console.log('[AgentService] Browser MCP adapter will be initialized per workspace.');

        console.log('[AgentService] Registering CalculatorTool (JS script executor + math engine)...');
        // 注册 JS 脚本执行器（mathjs 表达式求值 + vm 沙箱脚本执行）
        this.toolManager.registerTool(CalculatorTool);

        console.log('[AgentService] Registering WorkflowTools (declarative .workflow)...');
        if (globalConfig.workflow.enabled) {
            for (const definition of WorkflowTools.getDefinitions()) {
                this.toolManager.registerTool(definition);
            }
        } else {
            console.log('[AgentService] Workflow feature disabled; skipping WorkflowTools registration.');
        }

        // MCP 工具和 Playwright MCP 工具在 workspace 初始化时动态注册（见 registerMcpTools / registerBrowserMcpAdapter）
        console.log('[AgentService] All built-in tools initialized. MCP & Playwright tools will be registered per workspace.');

        console.log('[AgentService] All tools initialized successfully.');
    }

    /**
     * 为当前 workspace 注册 MCP 桥接工具
     * 应在 workspace 初始化时调用（AgentChatComponent.handleChat）
     * 会自动清理上一个 workspace 的 MCP 工具
     */
    public async registerMcpTools(userId: string, workspaceRoot: string): Promise<void> {
        // 1. 清理旧的 MCP 工具
        this.clearMcpTools();

        // 2. 连接 MCP 服务器
        const mcpService = McpService.getInstance();
        await mcpService.connectAll(userId, workspaceRoot);

        // 3. 注册桥接工具
        const definitions = mcpService.getBridgeToolDefinitions(userId, workspaceRoot);
        for (const def of definitions) {
            this.toolManager.registerTool(def);
            this.currentMcpToolNames.add(def.name);
        }

        console.log(`[AgentService] Registered ${definitions.length} MCP tools for user ${userId} @ ${workspaceRoot}`);
    }

    /**
     * 为当前 workspace 注册 Playwright MCP 桥接工具
     * 应在 workspace 初始化时调用（AgentChatComponent.handleChat）
     * 与 registerMcpTools 同级，独立管理 Playwright MCP 连接
     */
    public async registerBrowserMcpAdapter(userId: string, workspaceRoot: string): Promise<void> {
        // 1. 清理旧的 Playwright MCP 工具
        this.clearPlaywrightTools();

        // 2. 连接 Playwright MCP 服务器
        const adapter = BrowserMcpAdapter.getInstance();
        await adapter.connect(userId, workspaceRoot);

        // 3. 注册桥接工具
        const definitions = adapter.getBridgeToolDefinitions(userId, workspaceRoot);
        for (const def of definitions) {
            this.toolManager.registerTool(def);
            this.currentPlaywrightToolNames.add(def.name);
        }

        console.log(`[AgentService] Registered ${definitions.length} Playwright MCP tools for user ${userId} @ ${workspaceRoot}`);
    }

    /**
     * 清理当前 workspace 的所有 Playwright MCP 工具
     */
    private clearPlaywrightTools(): void {
        this.currentPlaywrightToolNames.clear();
    }

    /**
     * 打印当前 ToolManager 中所有已注册工具的完整定义清单。
     * 在 Agent 初始化完成后调用，方便用户排查"哪些工具可用"。
     */
    public logRegisteredTools(): void {
        const allTools = this.toolManager.getAllTools();
        const builtIn: typeof allTools = [];
        const mcp: typeof allTools = [];
        const playwright: typeof allTools = [];

        for (const t of allTools) {
            if (this.currentPlaywrightToolNames.has(t.name)) {
                playwright.push(t);
            } else if (this.currentMcpToolNames.has(t.name)) {
                mcp.push(t);
            } else {
                builtIn.push(t);
            }
        }

        const separator = '─'.repeat(72);
        console.log(`\n${separator}`);
        console.log(`📋 [AgentService] 已注册工具清单 — 共 ${allTools.length} 个工具`);
        console.log(`${separator}`);

        const printGroup = (label: string, tools: typeof allTools) => {
            if (tools.length === 0) return;
            console.log(`\n  📦 ${label} (${tools.length} 个)`);
            for (const t of tools) {
                const required = Array.isArray(t.parameters?.required) && t.parameters.required.length > 0
                    ? ` [必填: ${t.parameters.required.join(', ')}]`
                    : '';
                const desc = (t.description || '(无描述)').replace(/\s+/g, ' ').trim();
                const shortDesc = desc.length > 100 ? desc.slice(0, 97) + '...' : desc;
                console.log(`    • ${t.name}${required}`);
                console.log(`      ${shortDesc}`);
            }
        };

        printGroup('内置工具', builtIn);
        printGroup('MCP 桥接工具 (.mcp/)', mcp);
        printGroup('Playwright MCP 工具', playwright);

        console.log(`\n${separator}\n`);
    }

    /**
     * 清理当前 workspace 的所有 MCP 工具（从 ToolManager 中移除）
     * MCP 工具名以服务器名为前缀，通过 currentMcpToolNames 追踪
     */
    private clearMcpTools(): void {
        // ToolManager 没有 unregister 方法，但 registerTool 会覆盖同名工具。
        // 切换 workspace 时，新 workspace 的 MCP 工具会覆盖旧的；
        // 若新 workspace 没有 MCP 工具（服务器名不同），旧工具残留不会造成问题：
        //   - execute 中通过 context.workspaceRoot 定位正确的 MCP 连接
        //   - 旧 workspace 的 MCP 连接已断开，调用会返回错误
        this.currentMcpToolNames.clear();
    }

    private resolveWorkspaceRootFromContext(context?: any): string | undefined {
        const root = typeof context?.workspaceRoot === 'string' && context.workspaceRoot.trim()
            ? context.workspaceRoot.trim()
            : undefined;
        return root || this.getWorkspaceRoot(context?.userId);
    }

    private getWorkspaceStateKey(userId: string, workspaceRoot?: string): string {
        return workspaceRoot ? this.getIsolationKey(userId, workspaceRoot) : userId;
    }

    public getSessionHistory(userId: string, workspaceRoot?: string): any[] {
        const key = this.getWorkspaceStateKey(userId, workspaceRoot);
        const stored = this.userHistories.get(key) || [];
        const sanitized = this.dropCorruptedHistory(stored);
        if (sanitized !== stored) {
            this.userHistories.set(key, sanitized);
        }
        return sanitized;
    }

    /**
     * 丢弃历史上“模型控制标记被当成正文/工具参数”的异常消息，避免继续回传给模型造成上下文污染。
     * 对应 tool_calls 的 assistant 消息被丢弃时，一并丢弃其 tool 结果，保持消息序列合法。
     */
    private dropCorruptedHistory(history: any[]): any[] {
        if (!globalConfig.agent.modelOutputGuard || history.length === 0) return history;
        const kept: any[] = [];
        const droppedToolCallIds = new Set<string>();
        let dropped = 0;
        for (const message of history) {
            if (message?.role === 'tool' && droppedToolCallIds.has(message.tool_call_id)) {
                continue;
            }
            if (message?.role === 'assistant') {
                if (this.hasCorruptedAssistantPayload(message)) {
                    dropped++;
                    for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
                        if (typeof call?.id === 'string') droppedToolCallIds.add(call.id);
                    }
                    continue;
                }
            }
            kept.push(message);
        }
        if (dropped > 0) {
            console.warn(
                `[AgentService] 已丢弃 ${dropped} 条包含模型控制标记的历史消息（疑似模型输出异常），`
                + '避免继续污染上下文',
            );
        }
        return kept;
    }

    private hasCorruptedAssistantPayload(message: any): boolean {
        for (const field of ['content', 'reasoning_content'] as const) {
            const value = message[field];
            if (typeof value !== 'string' || !value) continue;
            const leading = probeLeadingContent(value);
            if (leading.state === 'suspect') return true;
            if (detectRepeatedControlToken(value)) return true;
        }
        // 工具调用参数必须是 JSON，正常模型不会在其中输出控制标记；
        // 这类消息会带着垃圾参数被回放给模型，并让历史里的 tool 结果永久残留。
        for (const call of Array.isArray(message.tool_calls) ? message.tool_calls : []) {
            if (findControlToken(call?.function?.name) || findControlToken(call?.function?.arguments)) {
                return true;
            }
        }
        return false;
    }

    public updateSessionHistory(userId: string, history: any[], workspaceRoot?: string) {
        const safeHistory = Array.isArray(history) ? history : [];
        const trimmed = safeHistory.length > this.sessionHistoryKeepLast
            ? safeHistory.slice(-this.sessionHistoryKeepLast)
            : safeHistory;
        this.userHistories.set(this.getWorkspaceStateKey(userId, workspaceRoot), trimmed);
    }

    public clearSessionHistory(userId: string, workspaceRoot?: string) {
        this.userHistories.delete(this.getWorkspaceStateKey(userId, workspaceRoot));
    }

    public getWorkspaceRoot(userId: string, preferredRoot?: string): string | undefined {
        if (typeof preferredRoot === 'string' && preferredRoot.trim()) return preferredRoot.trim();
        return this.workspaces.get(userId);
    }

    /**
     * 获取当前用户 Maven 项目的 JVM 编码策略（由 buildSystemPrompt 探测后缓存）
     * - undefined：无 pom.xml / 非 Maven 项目
     * - null：有 pom.xml 但无显式 encoding（告知 executeCommand 不要注入，保留系统默认）
     * - string：pom.xml 中声明的编码（如 "GBK"）
     */
    public getProjectJavaEncoding(userId: string, workspaceRoot?: string): string | null | undefined {
        const key = this.getWorkspaceStateKey(userId, workspaceRoot);
        if (!this.userProjectEncodings.has(key)) return undefined;
        return this.userProjectEncodings.get(key);
    }

    public checkWorkspace(userId: string, workspaceRoot?: string): string {
        const root = workspaceRoot || this.getWorkspaceRoot(userId);
        if (!root) throw new Error('Workspace not initialized for user: ' + userId);
        return root;
    }

    public getIsolationKey(userId: string, root: string): string {
        return userId + ':' + root;
    }

    /**
     * 【SOLID v2】基于插件架构的系统提示词构建。
     *
     * 与 buildSystemPrompt 功能等价，但使用 SystemPromptBuilder + IPromptSection 插件体系，
     * 实现 SRP（每个片段独立维护）、OCP（通过 register/unregister 扩展）、DIP（依赖抽象接口）。
     *
     * 建议新 Agent 类型优先使用此方法；原有 buildSystemPrompt 保持兼容。
     * 迁移路径：评估 Agent 可先行切换，待稳定后统一迁移主 Agent。
     */
    public async buildSystemPromptV2(
        userId: string,
        locale: string,
        agentConfigFile: string = 'main-agent.json',
        workspaceRoot?: string,
        requestId?: string,
        userInstruction?: string,
    ): Promise<string> {
        // 缓存命中逻辑复用
        if (requestId) {
            const cacheKey = this.buildCacheKey(requestId, agentConfigFile);
            if (this.systemPromptCache.has(cacheKey)) {
                console.log(`[AgentService] System prompt cache HIT (v2) for key: ${cacheKey}`);
                return this.systemPromptCache.get(cacheKey)!;
            }
        }

        const root = this.checkWorkspace(userId, workspaceRoot);
        const envInfo = await SystemTools.getEnvInfo();

        // 加载 Agent 配置
        const configPath = path.join(CONFIG_ROOT, agentConfigFile);
        let agentConfig: any;
        try {
            const fs = await import('fs/promises');
            const data = await fs.readFile(configPath, 'utf-8');
            agentConfig = JSON.parse(data);
        } catch (e) {
            throw new Error(`Failed to load agent configuration (${agentConfigFile}): ` + e);
        }

        // 构建上下文
        const ctx: PromptBuildContext = {
            userId,
            workspaceRoot: root,
            locale,
            envInfo,
            projectVersions: await this.detectProjectVersions(root),
            projectSourceEncoding: null,
            isMavenProject: false,
            localDate: formatBeijingDate(),
            localTimeZone: BEIJING_TIME_ZONE,
            agentConfigFile,
            userInstruction,
        };

        // 使用插件架构构建提示词
        const prompt = await buildPromptV2(agentConfig, ctx);

        // 缓存写入
        if (requestId) {
            this.setSystemPromptCache(requestId, agentConfigFile, prompt);
        }

        console.log(`[AgentService] Generated system prompt (v2) for user ${userId}${requestId ? ` (requestId: ${requestId})` : ''}`);
        return prompt;
    }

    /** 提取项目版本检测为独立方法（SRP） */
    private async detectProjectVersions(root: string): Promise<{ java?: string | null; python?: string | null; go?: string | null }> {
        const result: { java?: string | null; python?: string | null; go?: string | null } = {};
        try {
            // 复用现有检测逻辑（避免重复实现，保持与 buildSystemPrompt 一致）
            const nodePath = await import('path');
            const searchRoots = [root, nodePath.join(root, '..'), nodePath.join(root, '..', '..')];
            const normalizeJava = (raw: string) => raw.replace(/_/g, '.').replace(/^1\.([0-9]+)$/, '$1');

            for (const sr of searchRoots) {
                if (result.java) break;
                try {
                    const fs = await import('fs/promises');
                    const xml = await fs.readFile(nodePath.join(sr, 'pom.xml'), 'utf-8');
                    const m = xml.match(/<java\.version>\s*([^<]+)\s*<\/java\.version>/) ||
                             xml.match(/<maven\.compiler\.release>\s*([^<]+)\s*<\/maven\.compiler\.release>/) ||
                             xml.match(/<maven\.compiler\.source>\s*([^<]+)\s*<\/maven\.compiler\.source>/);
                    if (m) result.java = `Java ${normalizeJava(m[1].trim())}`;
                } catch {}
                if (!result.java) {
                    for (const gf of ['build.gradle', 'build.gradle.kts']) {
                        try {
                            const fs = await import('fs/promises');
                            const gradle = await fs.readFile(nodePath.join(sr, gf), 'utf-8');
                            const m = gradle.match(/sourceCompatibility\s*[=:]\s*['"]?([0-9.]+)['"]?/);
                            if (m) { result.java = `Java ${normalizeJava(m[1].trim())}`; break; }
                        } catch {}
                    }
                }
            }
            for (const sr of searchRoots) {
                if (result.python) break;
                try {
                    const fs = await import('fs/promises');
                    const ver = (await fs.readFile(nodePath.join(sr, '.python-version'), 'utf-8')).trim();
                    if (ver) result.python = `Python ${ver}`;
                } catch {}
                if (!result.python) {
                    try {
                        const fs = await import('fs/promises');
                        const toml = await fs.readFile(nodePath.join(sr, 'pyproject.toml'), 'utf-8');
                        const m = toml.match(/requires-python\s*=\s*["']([^"']+)["']/);
                        if (m) result.python = `Python ${m[1].trim()}`;
                    } catch {}
                }
            }
            for (const sr of searchRoots) {
                if (result.go) break;
                try {
                    const fs = await import('fs/promises');
                    const goMod = await fs.readFile(nodePath.join(sr, 'go.mod'), 'utf-8');
                    const m = goMod.match(/^go\s+([0-9.]+)/m);
                    if (m) result.go = `Go ${m[1]}`;
                } catch {}
            }
        } catch {}
        return result;
    }

    /**
     * 构建系统提示词，支持 (requestId, agentConfigFile) 复合维度的缓存策略。
     *
     * 缓存策略（对话维度 FIFO，Agent 隔离）：
     * - 用户每次发送指令 → 后端生成 requestId
     * - 缓存 key = `${requestId}::${agentConfigFile}`，不同 Agent 的提示词互不污染
     * - 同一 request 同一 Agent 的多次调用命中缓存直接返回
     * - 仅当主 Agent 完成任务 或 评估 Agent 判定目标达成后，调用方按 requestId 前缀批量清除
     * - 最多缓存 10 条，超出时 FIFO 淘汰最早的条目
     *
     * 提示词按「静态前缀 → 低频区 → 动态区」组装：
     * - 专业任务长规范（PPT/SVG/代码检视/文档/PDF/联网检索）不常驻，只注入技能索引；
     * - 传入 userInstruction 时按关键词自动装配命中的技能正文，其余场景由模型调用 read_skill 拉取。
     */
    public async buildSystemPrompt(
        userId: string,
        locale: string,
        agentConfigFile: string = 'main-agent.json',
        workspaceRoot?: string,
        requestId?: string,
        userInstruction?: string,
    ): Promise<string> {
        // 【缓存命中】同一对话同一 Agent 内复用已构建的系统提示词
        if (requestId) {
            const cacheKey = this.buildCacheKey(requestId, agentConfigFile);
            if (this.systemPromptCache.has(cacheKey)) {
                console.log(`[AgentService] System prompt cache HIT for key: ${cacheKey}`);
                return this.systemPromptCache.get(cacheKey)!;
            }
        }

        const root = this.checkWorkspace(userId, workspaceRoot);
        // 0. 获取环境元数据 (对齐 Section 3.2: 环境感知注入)
        const envInfo = await SystemTools.getEnvInfo();

        const localTimeZone = BEIJING_TIME_ZONE;
        const localDate = formatBeijingDate();

        // 0.2 探测项目语言版本约束（支持 Maven / Gradle / Python / Go，无项目文件时静默跳过）
        let projectJavaVersion: string | null = null;   // Java 编译目标版本
        let projectPythonVersion: string | null = null; // Python 版本约束
        let projectGoVersion: string | null = null;     // Go 模块版本
        let projectSourceEncoding: string | null = null; // Maven/Gradle 项目源文件编码
        let foundMavenProject = false; // 是否发现 pom.xml（用于区分「未探测」与「有 pom 但无 encoding」）
        try {
            const fs = await import('fs/promises');
            const nodePath = await import('path');
            // 向上最多 3 层搜索项目根目录（支持 monorepo 子模块）
            const searchRoots = [
                root!,
                nodePath.join(root!, '..'),
                nodePath.join(root!, '..', '..'),
            ];

            // 版本号规范化：1.8 → 8，VERSION_1_8 → 8，17 不变
            const normalizeJava = (raw: string) =>
                raw.replace(/_/g, '.').replace(/^1\.([0-9]+)$/, '$1');

            for (const sr of searchRoots) {
                if (projectJavaVersion) break;

                // --- Maven: pom.xml ---
                try {
                    const xml = await fs.readFile(nodePath.join(sr, 'pom.xml'), 'utf-8');
                    foundMavenProject = true; // 标记：这是 Maven 项目
                    const mavenPatterns: [string, RegExp][] = [
                        ['java.version',            /<java\.version>\s*([^<]+)\s*<\/java\.version>/],
                        ['maven.compiler.release',  /<maven\.compiler\.release>\s*([^<]+)\s*<\/maven\.compiler\.release>/],
                        ['maven.compiler.source',   /<maven\.compiler\.source>\s*([^<]+)\s*<\/maven\.compiler\.source>/],
                        ['plugin source',           /<artifactId>maven-compiler-plugin<\/artifactId>[\s\S]{0,500}?<source>\s*([^<]+)\s*<\/source>/],
                    ];
                    for (const [label, re] of mavenPatterns) {
                        const m = xml.match(re);
                        if (m) {
                            const raw = m[1].trim();
                            projectJavaVersion = `Java ${normalizeJava(raw)} (pom.xml ${label}: ${raw})`;
                            break;
                        }
                    }

                    // pom.xml 源文件编码探测
                    if (!projectSourceEncoding) {
                        const encodingPatterns: [string, RegExp][] = [
                            ['project.build.sourceEncoding',
                             /<project\.build\.sourceEncoding>\s*([^<]+)\s*<\/project\.build\.sourceEncoding>/],
                            ['maven-compiler-plugin encoding',
                             /<artifactId>maven-compiler-plugin<\/artifactId>[\s\S]{0,600}?<encoding>\s*([^<]+)\s*<\/encoding>/],
                            ['maven-resources-plugin encoding',
                             /<artifactId>maven-resources-plugin<\/artifactId>[\s\S]{0,600}?<encoding>\s*([^<]+)\s*<\/encoding>/],
                        ];
                        for (const [elabel, ere] of encodingPatterns) {
                            const em = xml.match(ere);
                            if (em) {
                                projectSourceEncoding = em[1].trim().toUpperCase();
                                break;
                            }
                        }
                    }
                } catch { /* 无 pom.xml */ }

                // --- Gradle: build.gradle / build.gradle.kts ---
                if (!projectJavaVersion) {
                    for (const gradleFile of ['build.gradle', 'build.gradle.kts']) {
                        try {
                            const gradle = await fs.readFile(nodePath.join(sr, gradleFile), 'utf-8');
                            const gradlePatterns: [string, RegExp][] = [
                                ['sourceCompatibility', /sourceCompatibility\s*[=:]\s*['"]?([0-9.]+)['"]?/],
                                ['sourceCompatibility JavaVersion', /sourceCompatibility\s*[=:]\s*JavaVersion\.VERSION_([0-9_]+)/],
                                ['java block', /java\s*\{[\s\S]{0,300}?sourceCompatibility\s*[=:]\s*JavaVersion\.VERSION_([0-9_]+)/],
                                ['options.release', /options\.release\s*[=:]\s*([0-9]+)/],
                            ];
                            for (const [label, re] of gradlePatterns) {
                                const m = gradle.match(re);
                                if (m) {
                                    const raw = m[1].trim();
                                    projectJavaVersion = `Java ${normalizeJava(raw)} (${gradleFile} ${label}: ${raw})`;
                                    break;
                                }
                            }
                            if (projectJavaVersion) break;
                        } catch { /* 无 build.gradle */ }
                    }
                }
            }

            // --- Python 版本：.python-version / pyproject.toml / setup.cfg ---
            for (const sr of searchRoots) {
                if (projectPythonVersion) break;
                // pyenv .python-version（最精确）
                try {
                    const ver = (await fs.readFile(nodePath.join(sr, '.python-version'), 'utf-8')).trim();
                    if (ver) projectPythonVersion = `Python ${ver} (.python-version)`;
                } catch {}
                // pyproject.toml [tool.poetry.dependencies] python 或 [project] requires-python
                if (!projectPythonVersion) {
                    try {
                        const toml = await fs.readFile(nodePath.join(sr, 'pyproject.toml'), 'utf-8');
                        const m = toml.match(/requires-python\s*=\s*["']([^"']+)["']/) ||
                                  toml.match(/(?<![a-z_])python\s*=\s*["']([^"']+)["']/);
                        if (m) projectPythonVersion = `Python ${m[1].trim()} (pyproject.toml)`;
                    } catch {}
                }
                // setup.cfg python_requires
                if (!projectPythonVersion) {
                    try {
                        const cfg = await fs.readFile(nodePath.join(sr, 'setup.cfg'), 'utf-8');
                        const m = cfg.match(/python_requires\s*=\s*([^\n\r]+)/);
                        if (m) projectPythonVersion = `Python ${m[1].trim()} (setup.cfg)`;
                    } catch {}
                }
            }

            // --- Go 版本：go.mod ---
            for (const sr of searchRoots) {
                if (projectGoVersion) break;
                try {
                    const goMod = await fs.readFile(nodePath.join(sr, 'go.mod'), 'utf-8');
                    const m = goMod.match(/^go\s+([0-9.]+)/m);
                    if (m) projectGoVersion = `Go ${m[1]} (go.mod)`;
                } catch {}
            }
        } catch { /* 整体探测失败，不影响主流程 */ }

        // 将 Maven 编码探测结果持久化，供当次会话的 run_powershell_command / run_cmd_command 读取
        // foundMavenProject=false → 删除条目，executeCommandInternal 回落到 UTF-8 默认行为
        const workspaceStateKey = this.getWorkspaceStateKey(userId, root);
        if (foundMavenProject) {
            this.userProjectEncodings.set(workspaceStateKey, projectSourceEncoding);
        } else {
            this.userProjectEncodings.delete(workspaceStateKey);
        }

        // 对齐 31.0 节：绝对路径强制执行
        const configPath = path.join(CONFIG_ROOT, agentConfigFile);
        
        let config;
        try {
            const fs = await import('fs/promises');
            const data = await fs.readFile(configPath, 'utf-8');
            config = JSON.parse(data);
        } catch (e) {
            throw new Error(`Failed to load agent configuration (${agentConfigFile}): ` + e);
        }

        // TODO 提示词策略：使用稳定前缀，避免每轮注入动态快照导致 KV 缓存命中下降
        const todoPrompt = [
            '### TODO 工具使用策略 (TODO TOOLING POLICY)',
            '为提升前缀稳定性与 KV 缓存命中率，系统提示词不再按轮次注入完整 TODO 明细快照。',
            '`list_todos` / `append_todo` / `update_todo` / `delete_todo` 仅允许顶层 Agent（主 Agent/评估 Agent）直接调用，子代理不得直接操作全局任务清单。',
            '⚠️ 职责区分：`list_todos` 为纯只读查询工具（无必填参数），绝不会保存任何传入参数！新建/规划任务必须调用 `append_todo`，更新状态调用 `update_todo`。',
            '当你需要确认最新任务状态、任务 ID，或怀疑历史裁剪导致状态不清晰时，必须优先调用 `list_todos` 获取当前真值（SSOT）。',
            '`list_todos` 无必填参数，直接调用 `{}` 即可获取完整清单。',
            '如果用户明确要求查看当前 TODO 状态，应直接调用 `list_todos` 并基于工具结果答复。',
            '',
            '**【终态强制门禁】给出最终回复前的强制检查流程（不可跳过）**：',
            '1. 调用 `list_todos` 获取当前任务清单；',
            '2. 对状态为 `not-started` 或 `in-progress` 的任务，调用 `update_todo` 将其状态置为 `completed` 或 `failed`；',
            '3. 确认全部任务已进入终态后，才允许输出最终答复给用户；',
            '4. 若发现仍有任务可推进（非卡用户输入），禁止强行终态——应继续执行直到任务真正完成或确认不可达为止。',
            '',
            '**【记忆反思与持久化 — 任务完成后的知识沉淀】**：',
            '在确认全部 TODO 任务已进入终态（completed/failed）、准备输出最终答复之前，必须执行记忆反思流程：',
            '1. **反思本轮是否有值得持久化的知识**，逐项检查：',
            '   - 工具失败模式 → 调用 `append_never_mistake_rule`（概括失败模式，不引用具体文件路径）',
            '   - 用户偏好变化 → 调用 `upsert_user_preference`（type 使用 style/language/format/behavior/tool 等）',
            '   - 项目特定知识（架构约定、端口配置、命名规范等）→ 调用 `upsert_user_preference`（type=`project`，source=`inferred`）',
            '   - 与已有记忆冲突 → 先 `list_user_preferences` 获取冲突项 ID，通过 `conflictIds` 淘汰旧偏好',
            '2. **持久化判断标准**（满足任一即记录）：反复使用≥2次 / 因缺少该知识走了弯路 / 对后续有明确指导价值 / 用户要求"记住"',
            '3. **不应记录**：通用常识 / 一次性临时信息 / 已有重复内容 / 未经验证的推测',
            '4. 若本轮无值得持久化的知识，跳过此步骤直接输出最终答复。禁止为了记录而记录。'
        ].join('\n');

        // 动态注入“防重复犯错”记忆规则
        let neverMistakePrompt = "";
        try {
            const { MemoryService } = await import('./MemoryService.js');
            const rules = await MemoryService.getNeverMistakeRules(root!);
            const lines = [
                '### 防重复犯错记忆 (NEVER MISTAKE AGAIN SSOT)',
                '以下规则来自 `.memory/never_mistake_again.json`，是当前工作区已沉淀的“反复踩坑防线”。你必须先自检再执行。',
                ...(rules && rules.length > 0
                    ? rules.map((rule, index) => `${index + 1}. 不应该做什么：${rule.shouldNot}\n   应该做什么：${rule.shouldDo}`)
                    : ['- (EMPTY) 暂无历史反错规则。']),
                '**强制行为**：',
                '1. 命中规则时，禁止继续执行“应该避免”的动作，必须直接执行“应该做”的替代动作；',
                '2. 若用户指出你重复犯错，或工具结果证明你刚犯了同类错误，必须立即调用 `append_never_mistake_rule` 记录新规则；',
                '3. 规则过时或与当前工程约束冲突时，调用 `delete_never_mistake_rule` 删除；',
                '4. 默认不要在本轮起手调用 `list_never_mistake_rules`，该快照已是本轮最新注入。'
            ];
            neverMistakePrompt = lines.join('\n');
        } catch (neverMistakeErr) {
            console.warn('[AgentService] Failed to inject never_mistake rules into prompt:', neverMistakeErr);
        }

        // 用户偏好改为“工具拉取”策略：不再注入动态快照，避免提示词抖动与快照-真值冲突
        const userPreferencePrompt = [
            '### 用户偏好记忆策略 (USER PREFERENCES VIA TOOLS ONLY)',
            '你必须把 `list_user_preferences` 工具返回结果视为唯一真值（SSOT）。',
            '**强制行为**：',
            '1. 当任务涉及输出风格、语言、格式、技术选型或执行习惯时，优先调用 `list_user_preferences` 拉取最新偏好，再执行；',
            '2. 当用户明确表达新偏好时，立即调用 `upsert_user_preference` 记录；',
            '3. 若新偏好与已有偏好冲突，先 `list_user_preferences` 获取冲突项 ID，再通过 `conflictIds` 淘汰旧偏好；',
            '4. 若偏好与本轮用户最新明确指令冲突，以用户最新明确指令为准，并同步更新偏好记忆。',
            '5. 禁止依赖历史上下文中可能过期的偏好描述；如有不确定，必须重新 `list_user_preferences`。'
        ].join('\n');

        const tempFilePolicyPrompt = [
            '### 临时文件治理策略 (TEMP FILES SSOT POLICY)',
            '- 临时产物（调试脚本、构建中转、格式转换中间产物、一次性抓取缓存等用完即弃内容）只能写入工作区 `.temp/`，禁止散落到 `src/`、`test/`、`docs/` 或工作区根目录。',
            '- 最终交付文件禁止放 `.temp/`：用户指定路径时按用户指定，未指定时写入合适的业务目录并在回复中说明。',
            '- `.temp/` 由用户自行清理，不要把清理临时文件列为任务、TODO 或交付门禁。',
            '- 技术文章、参考文档、白皮书、API 规范、研究论文等有长期参考价值的材料不是临时文件，必须存入 `docs/references/<主题>/`（无 docs 结构时主动创建），禁止混入 `.temp/`。'
        ].join('\n');

        const terminalShellPrompt = [
            '### 终端工具可用性 (TERMINAL TOOLS)',
            `- run_powershell_command：${envInfo.powershellAvailable ? `✅ 可用（${envInfo.powershellVersion}）` : '❌ 不可用，禁止调用'}。跨平台，Windows 调 powershell.exe，Linux/macOS 调 pwsh。`,
            `- run_cmd_command：${envInfo.cmdAvailable ? `✅ 可用（${envInfo.cmdVersion}）` : '❌ 不可用，禁止调用'}。仅限 Windows，调 cmd.exe。`,
            '- 工具名即执行器。command 直接写原生命令体。',
            '- PowerShell 5.1 不支持 &&，多个命令用分号连接。',
            '- timeout 单位为毫秒；简单命令建议 30000，构建/测试 120000~300000，依赖安装 600000。',
            '- Windows 上优先用 run_powershell_command；仅在用户明确要求或命令确实只能在 cmd.exe 下执行时才用 run_cmd_command；Linux/macOS 上仅能用 run_powershell_command。',
            '- **输出持久化**：每次命令执行后，完整输出（stdout+stderr+元数据）自动写入 .command/output.txt。返回给 LLM 的结果可能被截断，长输出场景请用 read_file 读取 .command/output.txt 获取完整内容。',
        ].join('\n');

        const processSafetyGuard = ProcessSafetyGuard.getInstance();
        processSafetyGuard.refreshProtectedPorts();
        const protectedPortsText = processSafetyGuard.getProtectedPortsText();
        const servicePortProtectionPrompt = [
            '### Agent 服务端口保护 (AGENT SERVICE PORT PROTECTION)',
            `- 当前 Agent 已占用/保留的核心端口：${protectedPortsText}。这些端口来自各服务 server_conf.json 与环境变量，是系统资产，不是用户项目可清理资源。`,
            '- 禁止杀死、释放、清理或重启这些端口上的进程；禁止使用 taskkill、Stop-Process、kill、kill-port、fkill、fuser -k，或 netstat/lsof/ss/Get-NetTCPConnection 管道到杀进程命令来处理这些端口。',
            '- 编写、修改、生成或启动用户项目代码、配置、脚本、Docker 映射、示例命令、文档时，禁止把这些端口作为用户应用监听端口或宿主端口。',
            '- 如果用户应用遇到这些端口 EADDRINUSE 或启动冲突，必须改用非保留端口（如 3000、3002、3004、5173、8000、8080），而不是尝试释放 Agent 端口。'
        ].join('\n');

        const gitAutomationPrompt = envInfo.gitAvailable
            ? [
                '### Git 版本管理策略 (LLM-DRIVEN GIT VIA TERMINAL)',
                `- 当前环境已检测到可用 Git 命令：${envInfo.gitVersion}。在用户有版本管理需求时，应执行智能 Git 管理流程。`,
                '- Git 版本管理完全由你通过 `run_powershell_command` 或 `run_cmd_command` 显式执行；系统不会在后台自动 `git init` / `git add` / `git commit` / `.gitignore` 同步。',
                '- 所有 Git 操作必须分步透明：每执行一条命令，都要先观察输出再决定下一步，禁止一次拼接长命令链隐藏中间状态。',
                '- 建议顺序：`git --version` -> `git rev-parse --is-inside-work-tree` -> (需要时) `git init` -> `git status --short --branch` -> `git add` / `git commit` / `git log` / `git diff`。',
                '- **提交前强制门禁（MANDATORY PRE-COMMIT IGNORE HYGIENE）**：在执行 `git commit` 之前，必须先检查并补全 `.gitignore`，确保无必要文件/目录不会进入版本库。',
                '- **强制步骤**：1) `git status --short --branch` 识别未跟踪项；2) 判断是否存在无必要文件/目录（构建产物、依赖目录、日志、缓存、临时文件、IDE 元数据、本地密钥）；3) 用 `read_file` 读取 `.gitignore`，若缺规则用 `file_insert`（追加）或 `file_write`（首次创建）补齐并去重；4) 再次执行 `git status --short` 验证噪声项已被忽略；5) 仅在复检通过后再 `git add` / `git commit`。',
                '- 如果发现不确定是否应忽略的文件，先向用户确认，再提交。禁止在未完成忽略体检时直接提交。',
                '- 任何会改变版本库状态的命令执行前，都应在回复中说明目的；提交完成后必须反馈 commit hash、提交信息和影响范围。',
                '- 若用户未要求版本管理，不要擅自提交；若用户明确要求 Git 操作，优先用终端工具完成，保持全程可见、可追溯。'
            ].join('\n')
            : [
                '### Git 版本管理策略 (LLM-DRIVEN GIT VIA TERMINAL)',
                `- 当前环境未检测到可用 Git 命令（${envInfo.gitVersion || 'Not Found'}）。本轮不要执行智能 Git 版本管理。`,
                '- 禁止尝试执行 `git init` / `git add` / `git commit` / `git log` / `git diff` 等 Git 命令，避免无效重试。',
                '- 如果用户明确要求 Git 操作，先告知当前环境缺少 Git 工具并给出安装/启用建议；随后继续处理非 Git 任务。'
            ].join('\n');



        // 浏览器自动化策略：动态从 Playwright MCP 适配器获取可用工具列表
        let browserAutomationPrompt = '';
        try {
            const browserAdapter = BrowserMcpAdapter.getInstance();
            browserAutomationPrompt = browserAdapter.buildSystemPrompt(userId, root);
        } catch (browserErr) {
            console.warn('[AgentService] Failed to build browser automation system prompt:', browserErr);
        }
        const langPrompt = config.i18n?.[locale.split('-')[0]] || config.i18n?.zh || "";

        // 动态检测互联网搜索结果
        const capabilities = config.capabilities?.map((c: string) => `- ${c}`).join('\n') || "";
        const guidelines = Object.entries(config.operation_guidelines || {})
            .map(([k, v]) => `- **${k}**: ${v}`).join('\n') || "";
        const tips = config.important_tips?.map((t: string) => `- ${t}`).join('\n') || "";
        const batchRules = config.batch_rules?.map((r: string) => `- ${r}`).join('\n') || "";

        // 技能索引（内置专项技能随 Agent 分发 + 工作区专项技能）
        // 只注入「名称 + 一句话用途」，完整规范由 read_skill 按需拉取，避免系统提示词常驻长文本。
        let skillPrompt = "";
        try {
            const skillParts: string[] = [];
            const builtinIndex = await buildBuiltinSkillIndex();
            if (builtinIndex) skillParts.push(builtinIndex);

            const skills = await SkillService.getInstance().getSkills(root!);
            if (skills && skills.length > 0) {
                skillParts.push([
                    '### 工作区专项技能 (WORKSPACE SKILLS INDEX)',
                    `扫描路径：${WORKSPACE_SKILL_DIRECTORIES.join('、')}。命中场景时用 \`read_skill("<name>")\` 加载，或直接 \`read_file\` 读取入口文件：`,
                    ...skills.map(s => `- **${s.name}**: ${s.description} (路径: ${s.skillFilePath})`),
                    '**核心指令**：Skill 包含特定领域的 SOP 和 Expert Knowledge，严禁在未加载的情况下凭空猜测；复杂多步骤工作流请用 `append_todo` 拆解追踪。历史被裁剪后若遗忘技能内容，随时重新加载。'
                ].join('\n'));
            }
            skillPrompt = skillParts.join('\n\n');
        } catch (skillErr) {
            console.warn('[AgentService] Failed to inject skills into prompt:', skillErr);
        }

        // 按用户指令按需装配技能正文：命中关键词才注入，未命中不占用任何 token
        let autoLoadedSkillPrompt = "";
        if (userInstruction) {
            try {
                autoLoadedSkillPrompt = await buildAutoLoadedSkills(userInstruction);
            } catch (skillErr) {
                console.warn('[AgentService] Failed to auto-load skills into prompt:', skillErr);
            }
        }
        
        // 仅保留“意图维持准则”框架，不在 system prompt 中注入具体用户指令。
        // 具体用户意图由 MessagePreparationService.buildMessages 置顶注入，避免双重注入造成 token 浪费与语义重复。

        // 动态加载工程级规范 (.rules/rule.md 或 .lingma/rules/project_rule.md)
        let projectRulePrompt = "";
        try {
            const ruleResult = await RuleService.getInstance().loadWorkspaceRules(root!);
            if (ruleResult) {
                const parts = [
                    '### 工程级规范约束 (PROJECT RULES & CONSTRAINTS)',
                    '检测到当前工程特定的约束规范。你接下来的所有行为必须**严格遵守**这些规范：',
                    `#### [核心主规范] ${ruleResult.mainFileName}\n\n\`\`\`markdown\n${ruleResult.mainRule}\n\`\`\``
                ];
                
                if (ruleResult.referencedRules.length > 0) {
                    parts.push('#### [子规范按需加载]');
                    for (const sub of ruleResult.referencedRules) {
                        parts.push(`- **${sub.name}** (使用 \`read_file\` 读取 \`${ruleResult.ruleDirectory}/${sub.name}\`)`);
                    }
                }

                parts.push(`**核心指令**：由于复杂长任务中对话历史会裁剪，当你发现需要某个规范的具体细则时，**一定要随时使用 \`read_file\` 重新加载上文对应的子规范内容 (${ruleResult.ruleDirectory}/*.md)**。如果遇到非常复杂的规范、多步骤或工作流，**请优先使用 \`append_todo\` 工具将其拆分添加为 TODO 任务进行追踪防止丢失细节**。不要试图凭借猜测编写可能会违背规则的代码！`);

                if (ruleResult.error) {
                    parts.push(`> **系统警报**: ${ruleResult.error}`);
                }

                projectRulePrompt = parts.join('\n\n');
            }
        } catch (ruleErr) {
            console.warn('[AgentService] Failed to inject workspace rules:', ruleErr);
        }

        const intentBlock = [
            '### 用户意图识别与对齐 (INTENT TRACKING & ALIGNMENT)',  
            '**意图维持准则**：',
            '1. **核心驱动**：你接下来的所有行为、思考链 (CoT) 及工具调用必须严防“意图漂移”，必须满足【当前意图】。',
            '2. **历史参考**：如果【当前意图】模糊或涉及连续操作，请参考 assistant 消息来补全上下文，但不要被旧任务带偏。',
            '3. **任务一致性**：若任务状态或任务 ID 存在不确定性（尤其历史被裁剪后），先调用 `list_todos` 获取最新清单，再执行 `append_todo` / `update_todo` / `delete_todo`。`update_todo` 通过 `todos` 数组传参（每项含 id + 更新字段），`delete_todo` 通过 `ids` 传参；如与【当前意图】冲突，以【当前意图】为准并更新或删除旧 TODO。',
            '4. **终态前置**：在输出最终答复前，必须确保所有 TODO 任务均已进入 `completed` 或 `failed` 状态，否则视为流程未完成，不允许结束。'
        ].join('\n');        

        // MCP 工具系统提示词（动态：随 workspace 的 .mcp/ 配置变化）
        let mcpSystemPrompt = '';
        try {
            const mcpService = McpService.getInstance();
            mcpSystemPrompt = mcpService.buildMcpSystemPrompt(userId, root);
        } catch (mcpErr) {
            console.warn('[AgentService] Failed to build MCP system prompt:', mcpErr);
        }

        const systemPrompt = [
            // ============================================================
            // 【STATIC PREFIX 静态区】 — 整个会话生命周期内稳定不变
            //   - 把所有不随回合变化的内容集中放在最前面，
            //     让上游模型 (DeepSeek / OpenAI / Anthropic) 的 prefix cache 能稳定命中，
            //     大幅降低重复计费 token 与首字延迟。
            //   - 任何会随用户输入 / TODO 状态 / 时间戳改变的内容，必须放到下方 DYNAMIC SUFFIX。
            // ============================================================

            // 1. 角色定义与本地化人格
            config.role,
            langPrompt,

            // 2. 核心能力与操作约束（来自 agentConfigFile 参数指定的配置文件）
            '### 核心能力 (Core Capabilities)',
            capabilities,
            '### 操作准则与约束 (Operational Guidelines)',
            guidelines,
            '### 批量操作规范 (batch Rules)',
            batchRules,
            '### 运行建议 (Important Tips)',
            tips,

            // 2.5 编码设计规范：先画流程图后写代码
            '### 编码设计规范：先画流程图，后写代码 (DESIGN-FIRST CODING DISCIPLINE)',
            [
                '**核心铁律**：任何非平凡编码任务（多文件改动、架构调整、新模块/组件、跨服务交互、数据流设计、状态机、异步流程等），必须先设计 Mermaid 流程图作为方案约束，再动手写代码。',
                '',
                '**触发条件（满足任一即必须画图）**：≥2 文件改动 | 前后端交互/API 调用链 | 数据模型变更 | 状态管理 | 异步流程 | 组件树重构 | 第三方集成 | 用户明确要求',
                '**可跳过场景**：单函数小改（≤20行净增）| 纯文案/翻译/注释 | 单键值配置 | 单文件单函数 Bug 修复 | 用户说"不用设计"',
                '',
                '**图表类型选择**：flowchart（业务流程/决策分支）、sequenceDiagram（前后端交互/API调用链）、classDiagram（数据模型/类型关系）、stateDiagram（状态机/生命周期）、erDiagram（数据库表关系）、graph（系统拓扑/模块依赖）',
                '**覆盖要素**：参与者 | 数据流向 | 决策点 | 边界条件（异常/超时/空值） | 状态变更',
                '',
                '**执行顺序**：需求分析 → 画 Mermaid 流程图 → 确认 → 拆解为 TODO → 逐项编码 → 对照流程图自检覆盖度',
                '**反模式**：写完代码补画图 | 流程图与代码脱节 | 用文字替代流程图 | 过于笼统（三框了事） | 方案变更不同步更新流程图',
            ].join('\n'),

            // 3. 工作区维度的稳定上下文（同一 workspace 内不变）
            '### 静态环境与项目元信息 (Static Workspace Profile)',
            [
                `- **工作目录（唯一作业边界）**: ${root}`,
                '  ⚠️ 所有文件操作与配置读取都限定在该目录内；越界访问 DeepSeek IDE / Agent 自身工程或启动配置属于 P0 违规（见 workspace_host_isolation_contract）。',
                `- **用户标识**: ${userId}`,
                `- **操作系统**: ${envInfo.os} (${envInfo.arch})`,
                `- **Node.js**: ${envInfo.nodeVersion}`,
                `- **JDK (运行时)**: ${envInfo.javaVersion}`,
                `- **CPU 核心**: ${envInfo.cpuCores}`,
                `- **可用内存**: ${envInfo.totalMemory}`,
                `- **Shell版本**: ${envInfo.shell}`,
                `- **PowerShell 可用性**: ${envInfo.powershellAvailable ? `可用 (${envInfo.powershellVersion})` : '不可用 (Not Found)'}`,
                `- **CMD 可用性**: ${envInfo.cmdAvailable ? `可用 (${envInfo.cmdVersion})` : '不可用 (Not Found)'}`,
                `- **Git 命令可用性**: ${envInfo.gitAvailable ? `可用 (${envInfo.gitVersion})` : `不可用 (${envInfo.gitVersion || 'Not Found'})`}`,
                projectJavaVersion ? `- **Java 编译目标版本**: ${projectJavaVersion}\n  ⚠️ 编写 Java 代码时必须严格遵守此版本，禁止使用高版本语言特性（如 var/record/sealed/text block 等需 Java 11+/16+/17+）。` : null,
                projectSourceEncoding ? `- **Maven 项目源文件编码**: ${projectSourceEncoding}\n  ⚠️ 创建或覆写 Java/XML/Properties 文件时，必须将 \`encoding\` 参数显式传入 file_write 工具（如 \`encoding: "${projectSourceEncoding}"\`），防止新建文件默认 UTF-8 与项目编码不一致造成乱码。局部编辑（file_replace / file_insert）会自动沿用文件原编码无需显式传 encoding。` : null,
                projectPythonVersion ? `- **Python 版本约束**: ${projectPythonVersion}\n  ⚠️ 编写 Python 代码时必须严格遵守此版本，禁止使用高版本语言特性。` : null,
                projectGoVersion ? `- **Go 版本**: ${projectGoVersion}` : null,
            ].filter(Boolean).join('\n'),

            // 4. 工作区附加资产（Skills 与 Rules，针对 workspace 路径稳定）
            skillPrompt,
            projectRulePrompt,

            // ============================================================
            // 【DYNAMIC SUFFIX 动态区】 — 每个回合都可能变化
            //   严禁向上回插静态内容；新增动态内容也只能往这个区追加。
            // ============================================================
            '### ⚡ 低频运行时上下文 (Low-Churn Runtime Context)',
            [
                `- **当前系统日期**: ${localDate} (\`${localTimeZone}\`)`,
            ].join('\n'),

            // 4.5 Git 策略（LLM 显式驱动，命令行透明执行）
            gitAutomationPrompt,

            // 4.55 终端 shell 选择策略（按可用性显式选 shell）
            terminalShellPrompt,

            // 4.555 Agent 服务端口保护（避免杀死自身或抢占核心端口）
            servicePortProtectionPrompt,

            // 4.56 临时文件治理策略（默认 .temp）
            tempFilePolicyPrompt,

            // 4.6 浏览器与网页抓取策略（Playwright MCP 直连）
            browserAutomationPrompt,

            // 4.8 用户 MCP 工具（来自 workspace .mcp/ 配置，动态注入）
            mcpSystemPrompt,

            // 6. 防重复犯错记忆（每次发新消息都会刷新）
            neverMistakePrompt,

            // 7. 用户偏好记忆（置信度衰减，高置信优先）
            userPreferencePrompt,

            // 7.5 按用户指令自动装配的技能正文（仅命中时存在，放在动态区避免污染静态前缀缓存）
            autoLoadedSkillPrompt,

            // 8. 当前意图（最关键，放最后让模型最近期看到）
            intentBlock,

            // 9. TODO 工具策略（状态不清晰时主动 list 对齐）
            todoPrompt
           
        ].filter(Boolean).join('\n\n');

        //打印system prompt的
        console.log(`[AgentService] Generated system prompt for user ${userId}${requestId ? ` (requestId: ${requestId})` : ''}:\n${systemPrompt}`);

        // 【缓存写入】按复合 key 存储，同一 request 不同 Agent 各自独立
        if (requestId) {
            this.setSystemPromptCache(requestId, agentConfigFile, systemPrompt);
        }

        return systemPrompt;
    }

    /**
     * 写入系统提示词缓存（FIFO，最多 MAX_SYSTEM_PROMPT_CACHE 条）
     * @param requestId 对话级请求 ID
     * @param agentConfigFile Agent 配置文件名（如 main-agent.json / evaluator-agent.json）
     * @param prompt 系统提示词内容
     */
    private setSystemPromptCache(requestId: string, agentConfigFile: string, prompt: string): void {
        const cacheKey = this.buildCacheKey(requestId, agentConfigFile);

        if (this.systemPromptCache.has(cacheKey)) {
            // 已存在则更新（不改变 FIFO 顺序）
            this.systemPromptCache.set(cacheKey, prompt);
            return;
        }

        // 淘汰最旧的条目
        while (this.systemPromptCacheOrder.length >= this.MAX_SYSTEM_PROMPT_CACHE) {
            const oldest = this.systemPromptCacheOrder.shift()!;
            this.systemPromptCache.delete(oldest);
            console.log(`[AgentService] System prompt cache EVICTED (FIFO) key: ${oldest}`);
        }

        this.systemPromptCache.set(cacheKey, prompt);
        this.systemPromptCacheOrder.push(cacheKey);
        console.log(`[AgentService] System prompt cache STORED for key: ${cacheKey} (total: ${this.systemPromptCacheOrder.length})`);
    }

    /**
     * 清除指定 requestId 下所有 Agent 的系统提示词缓存（按前缀批量清除）。
     * 调用时机：
     * - 主 Agent 任务完成（goal achieved / goal unachievable）
     * - 评估 Agent 判定目标已达成，无需继续迭代
     * - 用户取消 / 连接断开
     */
    public clearSystemPromptCache(requestId: string): void {
        const prefix = `${requestId}::`;
        let clearedCount = 0;

        // 遍历 FIFO 队列，找到所有匹配前缀的 key 并移除
        const remaining: string[] = [];
        for (const key of this.systemPromptCacheOrder) {
            if (key.startsWith(prefix)) {
                this.systemPromptCache.delete(key);
                clearedCount++;
            } else {
                remaining.push(key);
            }
        }
        this.systemPromptCacheOrder = remaining;

        if (clearedCount > 0) {
            console.log(`[AgentService] System prompt cache CLEARED ${clearedCount} entries for requestId: ${requestId} (remaining: ${this.systemPromptCacheOrder.length})`);
        }
    }

    public setWorkspace(userId: string, root: string) {
        this.workspaces.set(userId, root);
    }

    public setUserIdentity(userId: string, userName: string) {
        // Store user identity if needed
        this.contextStore.updateContext(userId, { userName });
    }

    public getUserIdentity(userId: string): string | undefined {
        return this.contextStore.getContext(userId)?.userName;
    }

    public async initializeWorkspace(userId: string, root: string): Promise<void> {
        await this.workspaces.switchWorkspace(userId, root);
        // Additional initialization logic can be added here
    }

    public async resetWorkspace(userId: string): Promise<void> {
        // 先断开 MCP 连接和 Playwright MCP 连接
        const root = this.workspaces.get(userId);
        if (root) {
            try {
                this.clearMcpTools();
                this.clearPlaywrightTools();
                await Promise.all([
                    McpService.getInstance().disconnectAll(userId, root),
                    BrowserMcpAdapter.getInstance().disconnect(userId, root),
                ]);
            } catch (err) {
                console.warn('[AgentService] Failed to disconnect MCP/Playwright during workspace reset:', err);
            }
        }

        await this.workspaces.reset(userId);
        const isoKey = this.getIsolationKey(userId, '');
        this.sessionUsage.delete(isoKey);
        this.sessionLastAccess.delete(isoKey);
        this.activeModels.delete(isoKey);
    }

    public disconnectWorkspaceConnections(userId: string, reason: string, previousWorkspaceRoot: string | null): void {
        // Handle workspace disconnection logic
        console.log(`Disconnecting workspace for user ${userId}: ${reason}`);

        // 断开 MCP 连接和 Playwright MCP 连接
        if (previousWorkspaceRoot) {
            this.clearMcpTools();
            this.clearPlaywrightTools();
            McpService.getInstance().disconnectAll(userId, previousWorkspaceRoot).catch((err) => {
                console.warn('[AgentService] Failed to disconnect MCP during workspace switch:', err);
            });
            BrowserMcpAdapter.getInstance().disconnect(userId, previousWorkspaceRoot).catch((err) => {
                console.warn('[AgentService] Failed to disconnect Playwright MCP during workspace switch:', err);
            });
        }
    }

    public async chat(userId: string, provider: string, model: string, messages: any[], traceId?: string, locale?: string): Promise<any> {
        // This should be implemented or delegated to AgentChatComponent
        throw new Error('Chat method not implemented');
    }

    public async getTodos(userId: string): Promise<any[]> {
        // Return todos
        return [];
    }

    public getToolManager(userId: string): ToolManager {
        return this.toolManager;
    }

    public getSharedToolsMetadata(names?: Iterable<string>): ToolMetadata[] {
        const allowed = names ? new Set(names) : undefined;
        return this.toolManager.getAllTools()
            .filter((t) => !allowed || allowed.has(t.name))
            .map((t) => ({
                type: 'function' as const,
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                    // strict: true 强制模型遵守 JSON Schema 的 required 字段，
                    // 配合 /beta 端点使用，防止模型依赖预训练记忆忽略必填参数
                    strict: true,
                },
            }));
    }

    public updateContextSelection(userId: string, data: any): void {
        this.contextStore.updateSelection(userId, data);
    }

    public updateContextFocus(userId: string, focused: any, workspaceRoot?: string): void {
        this.contextStore.updateFocus(userId, Boolean(focused), workspaceRoot);
    }

    public updateContextClick(userId: string, data: any): void {
        this.contextStore.updateClick(userId, data);
    }
}

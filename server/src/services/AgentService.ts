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
import { MainAgentReplyTools } from '@/tools/MainAgentReplyTools.js';
import { KnowledgeGraphTools } from '@/tools/KnowledgeGraphTools.js';
import { FileTools } from '@/tools/FileTools.js';
import { BrowserMcpAdapter } from '@/services/BrowserMcpAdapter.js';
import { ProcessSafetyGuard } from '@/services/ProcessSafetyGuard.js';
import { FileIO } from '@/utils/FileIO.js';
import { SystemTools } from '@/tools/SystemTools.js';
import { CalculatorTool } from '@/tools/custom/CalculatorTool.js';
import { SvgCheckTool } from '@/tools/custom/SvgCheckTool.js';
import { WorkflowTools } from '@/tools/WorkflowTools.js';
import { McpService } from '@/services/McpService.js';
import { detectRepeatedControlToken, findControlToken, probeLeadingContent } from '@/services/ModelOutputGuard.js';
import { CONFIG_ROOT } from '@/utils/PathUtils.js';
import { BEIJING_TIME_ZONE, formatBeijingDate } from '@/utils/TimeUtils.js';
import { WORKSPACE_SKILL_DIRECTORIES } from '@/utils/WorkspaceSkillPaths.js';
import { EventEmitter } from 'node:events';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as globalConfig } from '@/config/index.js';
import { SyntaxCheckService } from '@/services/SyntaxCheckService.js';

// SOLID 重构：新的提示词构建架构（可逐步迁移）

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

        console.log('[AgentService] Registering MainAgentReplyTools (atomic)...');
        // 注册主 Agent 历史最终回复记忆原子工具集 (list_main_agent_replies / read_main_agent_reply)
        for (const def of MainAgentReplyTools.getDefinitions()) {
            const toolName = def.name;
            this.toolManager.registerTool({
                ...def,
                execute: async (params, context) => {
                    const root = this.resolveWorkspaceRootFromContext(context);
                    if (!root) throw new Error('Workspace not initialized');
                    const tools = new MainAgentReplyTools(root);
                    switch (toolName) {
                        case 'list_main_agent_replies': return await tools.listReplies(params);
                        case 'read_main_agent_reply': return await tools.readReply(params);
                        default: throw new Error(`Unknown main-agent-reply tool: ${toolName}`);
                    }
                }
            });
        }

        console.log('[AgentService] Registering KnowledgeGraphTools (atomic)...');
        // 注册 DuckDB 知识图谱原子工具集 (kg_admin / kg_query / kg_upsert / kg_delete /
        // kg_traverse / kg_path / kg_analyze / kg_import / kg_define_attr / kg_list_attrs /
        // kg_delete_attr / kg_find / kg_vocab / kg_lint / kg_merge)；全部经独立 Worker 进程访问 .duckdb。
        for (const def of KnowledgeGraphTools.getDefinitions()) {
            const toolName = def.name;
            this.toolManager.registerTool({
                ...def,
                execute: async (params, context) => {
                    const root = this.resolveWorkspaceRootFromContext(context);
                    if (!root) throw new Error('Workspace not initialized');
                    const tools = new KnowledgeGraphTools(root);
                    switch (toolName) {
                        case 'kg_admin': return await tools.admin(params, context);
                        case 'kg_query': return await tools.query(params, context);
                        case 'kg_upsert': return await tools.upsert(params, context);
                        case 'kg_delete': return await tools.delete(params, context);
                        case 'kg_traverse': return await tools.traverse(params, context);
                        case 'kg_path': return await tools.path(params, context);
                        case 'kg_analyze': return await tools.analyze(params, context);
                        case 'kg_import': return await tools.importData(params, context);
                        case 'kg_define_attr': return await tools.attrDefine(params, context);
                        case 'kg_list_attrs': return await tools.attrList(params, context);
                        case 'kg_delete_attr': return await tools.attrDelete(params, context);
                        case 'kg_find': return await tools.find(params, context);
                        case 'kg_vocab': return await tools.vocab(params, context);
                        case 'kg_lint': return await tools.lint(params, context);
                        case 'kg_merge': return await tools.merge(params, context);
                        default: throw new Error(`Unknown knowledge-graph tool: ${toolName}`);
                    }
                }
            });
        }

        console.log('[AgentService] Registering read_skill...');        // 专项技能按需加载（内置技能 + 工作区技能）：系统提示词只放索引，正文由模型按需拉取
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
            description: `按行读工作区文件，自动识别 UTF-8/GBK/UTF-16，乱码可传 encoding 强制；上限 ${globalConfig.readFile.maxLines} 行/约 ${Math.round(globalConfig.readFile.maxContentBytes / 1024)}KB；大文件用 startLine/lineCount 分段且不要重叠回读，超长行改用 read_file_by_byte。相同范围重复读取只返回摘要，需要正文传 force:true。`,
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '工作区相对路径' },
                    startLine: { type: 'number', description: '起始行号，默认 1' },
                    lineCount: { type: 'number', description: '读取行数' },
                    force: { type: 'boolean', description: '重复读取同一范围时强制返回正文（默认返回摘要提示）' },
                    encoding: { type: 'string', description: '可选：强制解码编码（GBK/GB18030/UTF-8 等）；默认自动识别' },
                },
                required: ['path']
            },
            execute: async (params, context) => {
                const root = this.resolveWorkspaceRootFromContext(context);
                if (!root) throw new Error('Workspace not initialized');
                if (!params || !params.path || typeof params.path !== 'string') {
                    throw new Error('The "path" parameter is missing or invalid.');
                }
                const encodingOverride = typeof params.encoding === 'string' && params.encoding.trim()
                    ? params.encoding.trim()
                    : undefined;
                const result = await FileTools.readFile(
                    root, params.path, params.startLine, params.lineCount, params.force === true, encodingOverride,
                );
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
                if (ok.deduplicated) flags.push('duplicate-omitted');
                const flagStr = flags.length > 0 ? ` (${flags.join(', ')})` : '';
                const header = `[read_file] path=${params.path} lines=${ok.startLine}-${ok.endLine}/${ok.totalLines} encoding=${ok.encoding}${flagStr}`;
                return header + '\n' + (ok.content || '');
            }
        });


        console.log('[AgentService] Registering read_file_by_byte...');
        this.toolManager.registerTool({
            name: 'read_file_by_byte',
            description: '按字节范围读取；仅用于超长单行截断或二进制/混淆内容，普通文本请用 read_file。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '工作区相对路径' },
                    offset: { type: 'number', description: '字节偏移，从 0 开始' },
                    length: { type: 'number', description: '字节长度，上限 2.5KB' }
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

        console.log('[AgentService] Registering write_file...');
        this.toolManager.registerTool({
            name: 'write_file',
            description: '创建或完整覆写文件；局部修改用 replace_in_file/insert_in_file，多处替换用 replace_all_in_file。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '文件相对路径' },
                    content: { type: 'string', description: '完整文本内容' },
                    encoding: { type: 'string', description: '写入编码（如 GBK、UTF-8），仅新建文件生效' }
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
                return {
                    ...writeResult,
                    ...SyntaxCheckService.buildWriteFeedback(syntaxCheck),
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
                    path: { type: 'string', description: '目录相对路径，默认 "."' },
                    depth: { type: 'number', description: '递归深度 1-10' }
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
            description: '物理删除文件或目录；不可用于内容修复，改内容请用 replace_in_file/insert_in_file。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '文件相对路径' },
                    recursive: { type: 'boolean', description: '递归删除目录' }
                },
                required: ['path']
            },
            execute: async (params, context) => {
                const root = this.resolveWorkspaceRootFromContext(context);
                if (!root) throw new Error('Workspace not initialized');
                return await FileTools.deletePath(root, params.path, params.recursive);
            }
        });

        // ── replace_in_file：精准文本替换 ──
        console.log('[AgentService] Registering replace_in_file...');
        this.toolManager.registerTool({
            name: 'replace_in_file',
            description: '精确替换唯一匹配的 oldText；多处匹配返回歧义错误，newText 为空时删除匹配内容。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '文件相对路径' },
                    oldText: { type: 'string', description: '原文片段' },
                    newText: { type: 'string', description: '替换文本' }
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
                        message: 'oldText 不能为空。若要插入内容请使用 insert_in_file。'
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
                return {
                    ...editResult,
                    ...SyntaxCheckService.buildWriteFeedback(syntaxCheck),
                };
            }
        });

        // ── insert_in_file：行号精准插入 ──
        console.log('[AgentService] Registering insert_in_file...');
        this.toolManager.registerTool({
            name: 'insert_in_file',
            description: '在 startLine 行前插入内容；传「总行数+1」即追加到末尾。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '文件相对路径' },
                    startLine: { type: 'integer', minimum: 1, description: '起始行号，从 1 开始' },
                    newText: { type: 'string', description: '插入文本' }
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
                return {
                    ...editResult,
                    ...SyntaxCheckService.buildWriteFeedback(syntaxCheck),
                };
            }
        });

        console.log('[AgentService] Registering replace_all_in_file...');
        this.toolManager.registerTool({
            name: 'replace_all_in_file',
            description: '把所有字面匹配的 oldText 替换为 newText，适合批量重命名与术语调整。',
            parameters: {
                type: 'object',
                properties: {
                    path: { type: 'string', description: '文件相对路径' },
                    oldText: { type: 'string', description: '待匹配文本' },
                    newText: { type: 'string', description: '替换文本，空串表示删除' }
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
                return {
                    ...replaceResult,
                    ...SyntaxCheckService.buildWriteFeedback(syntaxCheck),
                };
            }
        });

        console.log('[AgentService] Registering run_powershell_command...');
        this.toolManager.registerTool({
            name: 'run_powershell_command',
            description: '在工作区执行 PowerShell 命令；输出自动识别 UTF-8/GBK。读文本文件优先 read_file（自动识别编码，可传 encoding）；PS 5.1 的 Get-Content 默认 ANSI，读中文请显式 -Encoding Default/UTF8。',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'PowerShell 原生命令体' },
                    timeout: { type: 'number', description: '超时毫秒数' },
                    environment: {
                        type: 'object',
                        description: '追加/覆盖子进程环境变量（仅字符串值）',
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
            description: '仅限 Windows，在工作区执行 CMD 命令；输出自动识别 UTF-8/GBK。读文本文件优先 read_file（自动识别编码，可传 encoding）。',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string', description: 'CMD 原生命令体' },
                    timeout: { type: 'number', description: '超时毫秒数' },
                    environment: {
                        type: 'object',
                        description: '追加/覆盖子进程环境变量（仅字符串值）',
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

        console.log('[AgentService] Registering SvgCheckTool (SVG bounds/overflow checker)...');
        // 注入工作区根目录，供 path 形式的 SVG 文件解析
        this.toolManager.registerTool({
            ...SvgCheckTool,
            execute: async (params, context) => SvgCheckTool.execute(params, {
                ...context,
                workspaceRoot: this.resolveWorkspaceRootFromContext(context),
            }),
        });

        console.log('[AgentService] Registering WorkflowTools (declarative .workflow)...');
        if (globalConfig.workflow.enabled) {
            for (const definition of WorkflowTools.getDefinitions({
                knownTools: () => this.toolManager.getAllTools().map((tool) => tool.name),
            })) {
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

        // 动态注入“防重复犯错”记忆规则
        let neverMistakePrompt = "";
        try {
            const { MemoryService } = await import('./MemoryService.js');
            const rules = await MemoryService.getNeverMistakeRules(root!);
            const lines = [
                '### 防重复犯错记忆',
                '规则来自 `.memory/never_mistake_again.json`，执行前自检：',
                ...(rules && rules.length > 0
                    ? rules.map((rule, index) => `${index + 1}. 不应该做什么：${rule.shouldNot}\n   应该做什么：${rule.shouldDo}`)
                    : ['- (EMPTY) 暂无历史反错规则。']),
                '**强制**：① 命中规则直接执行「应该做」的替代动作；② 用户指出重复犯错或工具证明同类错误时立即 `append_never_mistake_rule`；③ 规则过时用 `delete_never_mistake_rule` 删除；④ 本快照即最新，起手不要调 `list_never_mistake_rules`。'
            ];
            neverMistakePrompt = lines.join('\n');
        } catch (neverMistakeErr) {
            console.warn('[AgentService] Failed to inject never_mistake rules into prompt:', neverMistakeErr);
        }

        // 用户偏好改为“工具拉取”策略：不再注入动态快照，避免提示词抖动与快照-真值冲突
        const userPreferencePrompt = [
            '### 用户偏好记忆',
            '`list_user_preferences` 是唯一真值（SSOT）。涉及输出风格、语言、格式、技术选型时先拉最新偏好；用户表达新偏好时立即 `upsert_user_preference`；冲突时先取旧 ID 再用 `conflictIds` 淘汰；与本轮明确指令冲突时以指令为准；禁止依赖历史中可能过期的偏好。'
        ].join('\n');

        // 主 Agent 历史最终回复记忆：与 user_instructs.json 的对话编号一一对应
        const mainAgentReplyMemoryPrompt = [
            '### 主Agent 历史最终回复记忆 (MAIN AGENT REPLY MEMORY)',
            '每轮最终回复写入 `.memory/user_instructs_reply.json`，编号「对话编号.回复序号」（如 `11.2`）。',
            '**检索时机**：用户以「继续」「之前那个方案」等指代历史而上下文缺细节；需确认已承诺/已交付内容；需核对本轮与上轮结论是否矛盾。',
            '**方式**：先 `list_main_agent_replies` 取 id 与摘要，再 `read_main_agent_reply({ id })`；跨条对比才 `read_file` 整文件。',
            '**禁止**：每轮无差别加载历史回复；以历史回复替代真实证据；修改该文件或写入变更清单。'
        ].join('\n');

        const tempFilePolicyPrompt = [
            '### 临时文件治理',
            '- 临时产物只写 `.temp/<YYYYMMDD-HHMMSS>-<slug>/{src,data,out,logs,cache}` + `manifest.json`；根目录不放文件，最终交付禁止放 `.temp/`。',
            '- 文件名 `<step>-<purpose>[-vNN]`，禁止 `ev_1.py`/`vd_a.json`/`final2`；长期数据放 `data/`，>50MB 数据禁止整份复制到多个用例（用原路径/硬链接/子集）。',
            '- 结束删本轮 src/logs/cache、失败分支和重复副本，留 out + manifest；整理存量先 `read_skill("temp-hygiene")`，默认 dry-run，确认后再删。'
        ].join('\n');

        const terminalShellPrompt = [
            '### 终端工具选择',
            `- run_powershell_command：${envInfo.powershellAvailable ? `✅ 可用（${envInfo.powershellVersion}）` : '❌ 不可用，禁止调用'}。跨平台；Windows 调 powershell.exe，Linux/macOS 调 pwsh。command 直接写原生命令体；PS 5.1 无 &&，多命令用分号。`,
            `- run_cmd_command：${envInfo.cmdAvailable ? `✅ 可用（${envInfo.cmdVersion}）` : '❌ 不可用，禁止调用'}。仅限 Windows，仅在用户明确要求或只能 cmd.exe 时使用。`,
            '- timeout 毫秒：简单命令 30000，构建/测试 120000~300000，装依赖 600000。完整输出写入 `.command/output.txt`，返回被截断时用 `read_file` 读全文。',
            '- 查文件优先 `read_file` 分段，不重叠回读已读区间；编辑后只读变更附近。终端只输出摘要：`Get-Content -TotalCount/-Tail`、`Select-String ... | Select-Object -First N`、`git diff --stat`。',
        ].join('\n');

        const processSafetyGuard = ProcessSafetyGuard.getInstance();
        processSafetyGuard.refreshProtectedPorts();
        const protectedPortsText = processSafetyGuard.getProtectedPortsText();
        const servicePortProtectionPrompt = [
            '### Agent 服务端口保护',
            `- Agent 保留端口：${protectedPortsText}。属系统资产，不是用户项目资源。`,
            '- 禁止杀死/释放/重启这些端口上的进程；禁止 taskkill、Stop-Process、kill、kill-port、fkill、fuser -k 及 netstat/lsof/ss/Get-NetTCPConnection 管道到杀进程命令。',
            '- 用户项目的代码、配置、脚本、Docker 映射与文档禁止使用这些端口；遇 EADDRINUSE 改用 3000、3002、3004、5173、8000、8080。'
        ].join('\n');

        const gitAutomationPrompt = envInfo.gitAvailable
            ? [
                '### Git 版本管理策略',
                `- 已检测到 Git：${envInfo.gitVersion}。仅当用户需要版本管理时才执行，否则不要擅自提交。`,
                '- 通过 `run_powershell_command`/`run_cmd_command` 分步执行，每条命令先看输出；系统不会后台自动 git 或同步 .gitignore。',
                '- **提交前门禁**：`git status --short --branch` 找未跟踪项 → 剔除构建产物/依赖/日志/缓存/临时文件/IDE 元数据/本地密钥 → 缺规则时用 `insert_in_file`/`write_file` 补 `.gitignore` → 复跑 `git status --short` 确认 → 才 `git add`/`git commit`。',
                '- 改版本库状态前说明目的；提交后反馈 commit hash、提交信息与影响范围。'
            ].join('\n')
            : [
                '### Git 版本管理策略',
                `- 未检测到 Git（${envInfo.gitVersion || 'Not Found'}），禁止尝试 git 命令；用户要求时说明缺失并给安装建议。`
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
        const tips = [
            ...(config.important_tips || []),
            ...(config.batch_rules || []),
        ].map((t: string) => `- ${t}`).join('\n') || "";

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
                    '### 工作区专项技能',
                    `扫描路径：${WORKSPACE_SKILL_DIRECTORIES.join('、')}。命中场景用 \`read_skill("<name>")\` 加载，或 \`read_file\` 读入口文件：`,
                    ...skills.map(s => `- **${s.name}**: ${s.description} (路径: ${s.skillFilePath})`),
                    '**核心指令**：Skill 是特定领域 SOP 与专家知识，未加载不得凭空猜测；复杂流程用 `append_todo` 拆解。历史裁剪后若遗忘，随时重新加载。'
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
                    '### 工程级规范约束',
                    '以下工程规范对所有行为强制生效：',
                    `#### [核心主规范] ${ruleResult.mainFileName}\n\n\`\`\`markdown\n${ruleResult.mainRule}\n\`\`\``
                ];
                
                if (ruleResult.referencedRules.length > 0) {
                    parts.push('#### [子规范按需加载]');
                    for (const sub of ruleResult.referencedRules) {
                        parts.push(`- **${sub.name}** (使用 \`read_file\` 读取 \`${ruleResult.ruleDirectory}/${sub.name}\`)`);
                    }
                }

                parts.push(`**核心指令**：对话历史会被裁剪，需要细则时随时用 \`read_file\` 重新加载 ${ruleResult.ruleDirectory}/*.md；复杂多步骤规范先用 \`append_todo\` 拆分追踪。禁止凭猜测编写可能违背规则的代码。`);

                if (ruleResult.error) {
                    parts.push(`> **系统警报**: ${ruleResult.error}`);
                }

                projectRulePrompt = parts.join('\n\n');
            }
        } catch (ruleErr) {
            console.warn('[AgentService] Failed to inject workspace rules:', ruleErr);
        }

        const intentBlock = [
            '### 用户意图与 TODO 对齐',
            '1. 所有行为与工具调用必须服务【当前意图】，严防意图漂移；【当前意图】模糊或涉及连续操作时参考 assistant 消息补全上下文，但不要被旧任务带偏。',
            '2. `list_todos` 是纯只读真值（SSOT），无必填参数，传 `{}` 即取全量；新建任务用 `append_todo`，改状态用 `update_todo`。状态/ID 不确定、历史被裁剪或用户询问时先 `list_todos`；与【当前意图】冲突时以【当前意图】为准。仅顶层 Agent 可操作。',
            '3. **【终态门禁】最终答复前**：调 `list_todos` → 把 `not-started`/`in-progress` 项置为 `completed`/`failed` → 全部终态才可答复；仍有可推进任务时禁止强行终态。',
            '4. **【记忆反思】终态确认后**：失败模式→`append_never_mistake_rule`；用户偏好或项目知识→`upsert_user_preference`（项目知识 type=`project`、source=`inferred`）；冲突→先取旧 ID 再用 `conflictIds` 淘汰。仅记录复用≥2次/曾因此走弯路/有指导价值/用户要求记住者。'
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
            '### 核心能力',
            capabilities,
            '### 操作准则',
            guidelines,
            '### 运行建议',
            tips,

            // 2.5 编码设计规范：先画流程图后写代码
            '### 编码设计规范：先画流程图，后写代码',
            [
                '**铁律**：非平凡编码任务（多文件改动、架构调整、新模块、跨服务交互、数据流、状态机、异步流程）必须先出 Mermaid 流程图再写代码。',
                '**触发**：≥2 文件 | 前后端/API 调用链 | 数据模型变更 | 状态管理 | 异步流程 | 组件树重构 | 第三方集成 | 用户要求。**可跳过**：单函数小改（≤20 行）| 纯文案 | 单键值配置 | 用户说"不用设计"。',
                '**图型**：flowchart 流程分支 / sequenceDiagram 调用链 / classDiagram 类型关系 / stateDiagram 状态机 / erDiagram 表关系 / graph 拓扑。要素：参与者、流向、决策点、边界条件（异常/超时/空值）、状态变更。',
                '**顺序**：需求分析 → 流程图 → 拆 TODO → 编码 → 对照图自检；禁止写完补画或图文脱节。',
            ].join('\n'),

            // 3. 工作区维度的稳定上下文（同一 workspace 内不变）
            '### 静态环境与项目元信息',
            [
                `- **工作目录（唯一作业边界）**: ${root}`,
                '  ⚠️ 文件与配置操作限定在该目录内；越界访问 IDE 自身工程属 P0 违规。',
                `- **操作系统**: ${envInfo.os} (${envInfo.arch})`,
                `- **Node.js**: ${envInfo.nodeVersion}`,
                `- **JDK (运行时)**: ${envInfo.javaVersion}`,
                `- **CPU 核心**: ${envInfo.cpuCores}`,
                `- **可用内存**: ${envInfo.totalMemory}`,
                `- **Shell版本**: ${envInfo.shell}`,
                projectJavaVersion ? `- **Java 编译目标版本**: ${projectJavaVersion}\n  ⚠️ 严格遵守，禁用高版本语言特性（var/record/sealed/text block 等）。` : null,
                projectSourceEncoding ? `- **Maven 源文件编码**: ${projectSourceEncoding}\n  ⚠️ 用 write_file 创建/覆写 Java/XML/Properties 时必须传 \`encoding: "${projectSourceEncoding}"\`。` : null,
                projectPythonVersion ? `- **Python 版本约束**: ${projectPythonVersion}\n  ⚠️ 严格遵守，禁用高版本语言特性。` : null,
                projectGoVersion ? `- **Go 版本**: ${projectGoVersion}` : null,
            ].filter(Boolean).join('\n'),

            // 4. 工作区附加资产（Skills 与 Rules，针对 workspace 路径稳定）
            skillPrompt,
            projectRulePrompt,

            // ============================================================
            // 【DYNAMIC SUFFIX 动态区】 — 每个回合都可能变化
            //   严禁向上回插静态内容；新增动态内容也只能往这个区追加。
            // ============================================================
            '### 运行时上下文',
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

            // 7.2 主Agent 历史最终回复记忆（按需检索，不注入快照）
            mainAgentReplyMemoryPrompt,

            // 7.5 按用户指令自动装配的技能正文（仅命中时存在，放在动态区避免污染静态前缀缓存）
            autoLoadedSkillPrompt,

            // 8. 当前意图 + TODO 策略（最关键，放最后让模型最近期看到）
            intentBlock
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

    public getContextFocus(userId: string, workspaceRoot?: string): any {
        const ctx = this.contextStore.getContext(userId, workspaceRoot);
        return ctx ? ctx.isFocused : undefined;
    }
}

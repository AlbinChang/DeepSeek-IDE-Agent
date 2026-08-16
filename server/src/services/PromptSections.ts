/**
 * 提示词片段具体实现 (Prompt Sections)
 *
 * 每个文件负责一个独立的提示词关注点，遵循 SRP。
 * 新增策略/契约只需新建文件并注册到 SystemPromptBuilder。
 */

import type { IPromptSection, PromptBuildContext, PromptPriority } from '@/types/prompt.js';
import { SkillService } from '@/services/SkillService.js';
import { RuleService } from '@/services/RuleService.js';
import { MemoryService } from '@/services/MemoryService.js';
import { BrowserMcpAdapter } from '@/services/BrowserMcpAdapter.js';
import { McpService } from '@/services/McpService.js';
import { ProcessSafetyGuard } from '@/services/ProcessSafetyGuard.js';
import { WORKSPACE_SKILL_DIRECTORIES } from '@/utils/WorkspaceSkillPaths.js';
import { config as globalConfig } from '@/config/index.js';
import { CONFIG_ROOT } from '@/utils/PathUtils.js';
import * as path from 'node:path';
import { readFile } from 'node:fs/promises';

// ============================================================
// 抽象基类（减少样板代码）
// ============================================================

abstract class BasePromptSection implements IPromptSection {
    abstract readonly id: string;
    abstract readonly priority: PromptPriority;
    abstract build(ctx: PromptBuildContext): Promise<string>;
}

// ============================================================
// Static 区 — 会话生命周期内稳定不变
// ============================================================

/**
 * 角色定义 + 本地化语言
 * priority: static
 */
export class RoleSection extends BasePromptSection {
    readonly id = 'role';
    readonly priority: PromptPriority = 'static';

    private readonly config: any;

    constructor(config: any) {
        super();
        this.config = config;
    }

    async build(_ctx: PromptBuildContext): Promise<string> {
        const langKey = _ctx.locale.split('-')[0] || 'zh';
        const langPrompt = this.config.i18n?.[langKey] || this.config.i18n?.zh || '';
        return [this.config.role, langPrompt].filter(Boolean).join('\n');
    }
}

/**
 * 核心能力 + 操作准则（来自 agent JSON 配置）
 * priority: static
 */
export class CapabilitiesSection extends BasePromptSection {
    readonly id = 'capabilities';
    readonly priority: PromptPriority = 'static';

    private readonly config: any;

    constructor(config: any) {
        super();
        this.config = config;
    }

    async build(_ctx: PromptBuildContext): Promise<string> {
        const capabilities = (this.config.capabilities || [])
            .map((c: string) => `- ${c}`).join('\n');
        const guidelines = Object.entries(this.config.operation_guidelines || {})
            .map(([k, v]) => `- **${k}**: ${v}`).join('\n');
        const batchRules = (this.config.batch_rules || [])
            .map((r: string) => `- ${r}`).join('\n');
        const tips = (this.config.important_tips || [])
            .map((t: string) => `- ${t}`).join('\n');

        return [
            '### 核心能力 (Core Capabilities)',
            capabilities,
            '### 操作准则与约束 (Operational Guidelines)',
            guidelines,
            '### 批量操作规范 (Batch Rules)',
            batchRules,
            '### 运行建议 (Important Tips)',
            tips,
        ].filter(Boolean).join('\n\n');
    }
}

/**
 * 静态环境与项目元信息
 * priority: static
 */
export class WorkspaceProfileSection extends BasePromptSection {
    readonly id = 'workspace-profile';
    readonly priority: PromptPriority = 'static';

    async build(ctx: PromptBuildContext): Promise<string> {
        const { envInfo, workspaceRoot: root, userId, projectVersions, projectSourceEncoding } = ctx;
        const lines: (string | null)[] = [
            `- **工作目录（唯一作业边界）**: ${root}`,
            `  ⚠️ 【工作区隔离绝对铁律】：当前任务的唯一作业边界为上述工作目录。用户在指令中提及的 .env、配置文件、源代码、依赖等 100% 严格限定在上述工作目录内部（如 \`${root}/.env\`）。严禁跨出此目录去探索、读取、修改或引用 DeepSeek IDE / Agent 宿主自身的工程目录（如 IDE 自身源码、IDE 启动用 .env、DEEPSEEK_API_KEY 等）！`,
            `- **用户标识**: ${userId}`,
            `- **操作系统**: ${envInfo.os} (${envInfo.arch})`,
            `- **Node.js**: ${envInfo.nodeVersion}`,
            `- **JDK (运行时)**: ${envInfo.javaVersion}`,
            `- **CPU 核心**: ${envInfo.cpuCores}`,
            `- **可用内存**: ${envInfo.totalMemory}`,
            `- **Shell版本**: ${envInfo.shell}`,
            pwInfo(envInfo),
            cmdInfo(envInfo),
            gitInfo(envInfo),
            javaConstraint(projectVersions.java),
            encodingConstraint(projectSourceEncoding),
            pythonConstraint(projectVersions.python),
            goConstraint(projectVersions.go),
        ];

        return [
            '### 静态环境与项目元信息 (Static Workspace Profile)',
            lines.filter(Boolean).join('\n'),
        ].join('\n');
    }
}

/** 辅助格式化函数（模块内私有） */
function pwInfo(e: Record<string, any>): string {
    return `- **PowerShell 可用性**: ${e.powershellAvailable ? `可用 (${e.powershellVersion})` : '不可用 (Not Found)'}`;
}
function cmdInfo(e: Record<string, any>): string {
    return `- **CMD 可用性**: ${e.cmdAvailable ? `可用 (${e.cmdVersion})` : '不可用 (Not Found)'}`;
}
function gitInfo(e: Record<string, any>): string {
    return `- **Git 命令可用性**: ${e.gitAvailable ? `可用 (${e.gitVersion})` : `不可用 (${e.gitVersion || 'Not Found'})`}`;
}
function javaConstraint(ver: string | null | undefined): string | null {
    if (!ver) return null;
    return `- **Java 编译目标版本**: ${ver}\n  ⚠️ 编写 Java 代码时必须严格遵守此版本。`;
}
function encodingConstraint(enc: string | null | undefined): string | null {
    if (!enc) return null;
    return `- **Maven 项目源文件编码**: ${enc}\n  ⚠️ 创建文件时必须传入 \`encoding: "${enc}"\`。`;
}
function pythonConstraint(ver: string | null | undefined): string | null {
    if (!ver) return null;
    return `- **Python 版本约束**: ${ver}\n  ⚠️ 编写 Python 代码时必须严格遵守此版本。`;
}
function goConstraint(ver: string | null | undefined): string | null {
    if (!ver) return null;
    return `- **Go 版本**: ${ver}`;
}

// ============================================================
// Low-Churn 区 — 低频变化
// ============================================================

/**
 * 工作区 Skills 索引
 * priority: low-churn
 */
export class SkillsIndexSection extends BasePromptSection {
    readonly id = 'skills-index';
    readonly priority: PromptPriority = 'low-churn';

    async build(ctx: PromptBuildContext): Promise<string> {
        try {
            const skills = await SkillService.getInstance().getSkills(ctx.workspaceRoot);
            if (!skills || skills.length === 0) return '';

            return [
                '### 工作区专项技能 (WORKSPACE SKILLS INDEX)',
                `检测到当前工作空间提供以下专项技能（扫描路径：${WORKSPACE_SKILL_DIRECTORIES.join('、')}）。`,
                '当用户请求涉及以下领域时，请**务必**先调用 `read_file` 读取对应 Skill 入口文件。',
                ...skills.map(s => `- **${s.name}**: ${s.description} (路径: ${s.skillFilePath})`),
                '**核心指令**：Skill 包含特定领域的 SOP，严禁凭空猜测。由于历史可能被裁剪，请随时用 `read_file` 重新查阅。',
            ].join('\n');
        } catch {
            return '';
        }
    }
}

/**
 * 工程级规范 (.rules/)
 * priority: low-churn
 */
export class ProjectRulesSection extends BasePromptSection {
    readonly id = 'project-rules';
    readonly priority: PromptPriority = 'low-churn';

    async build(ctx: PromptBuildContext): Promise<string> {
        try {
            const { workspaceRoot } = ctx;
            const result = await RuleService.getInstance().loadWorkspaceRules(workspaceRoot);
            if (!result) return '';

            const parts = [
                '### 工程级规范约束 (PROJECT RULES & CONSTRAINTS)',
                '以下规范必须严格遵守：',
                `#### [核心主规范] rule.md\n\n\`\`\`markdown\n${result.mainRule}\n\`\`\``,
            ];

            if (result.referencedRules.length > 0) {
                parts.push('#### [子规范按需加载]');
                for (const sub of result.referencedRules) {
                    parts.push(`- **${sub.name}** (使用 \`read_file\` 读取 \`.rules/${sub.name}\`)`);
                }
            }

            parts.push('**核心指令**：历史裁剪后请用 `read_file` 重新加载子规范。遇到复杂规范请用 `append_todo` 拆分追踪。');
            if (result.error) {
                parts.push(`> **系统警报**: ${result.error}`);
            }
            return parts.join('\n\n');
        } catch {
            return '';
        }
    }
}

// ============================================================
// Dynamic 区 — 每轮可能变化
// ============================================================

/**
 * 本地时间信息
 * priority: dynamic
 */
export class DateTimeSection extends BasePromptSection {
    readonly id = 'date-time';
    readonly priority: PromptPriority = 'dynamic';

    async build(ctx: PromptBuildContext): Promise<string> {
        return [
            '### ⚡ 低频运行时上下文 (Low-Churn Runtime Context)',
            `- **当前系统日期**: ${ctx.localDate} (\`${ctx.localTimeZone}\`)`,
        ].join('\n');
    }
}

/**
 * Git 版本管理策略
 * priority: dynamic
 */
export class GitPolicySection extends BasePromptSection {
    readonly id = 'git-policy';
    readonly priority: PromptPriority = 'dynamic';

    async build(ctx: PromptBuildContext): Promise<string> {
        const { envInfo } = ctx;
        return envInfo.gitAvailable
            ? GIT_AVAILABLE_PROMPT(envInfo.gitVersion)
            : GIT_UNAVAILABLE_PROMPT(envInfo.gitVersion);
    }
}

const GIT_AVAILABLE_PROMPT = (version: string) => [
    '### Git 版本管理策略 (LLM-DRIVEN GIT VIA TERMINAL)',
    `- 已检测到 Git：${version}。所有 Git 操作由你通过终端工具显式执行。`,
    '- 操作必须分步透明，禁止一次拼接长命令链。',
    '- **提交前强制门禁**：先 `git status` 识别未跟踪项 → 检查并补全 `.gitignore` → 复检通过后再 `git add`/`git commit`。',
    '- 不确定是否忽略的文件先向用户确认。',
    '- 用户未要求版本管理时不擅自提交。',
].join('\n');

const GIT_UNAVAILABLE_PROMPT = (version: string) => [
    '### Git 版本管理策略',
    `- 当前环境未检测到可用 Git（${version || 'Not Found'}），本轮不执行 Git 操作。`,
    '- 禁止尝试 `git init`/`git add`/`git commit` 等命令。',
].join('\n');

/**
 * 终端 Shell 选择策略
 * priority: dynamic
 */
export class ShellPolicySection extends BasePromptSection {
    readonly id = 'shell-policy';
    readonly priority: PromptPriority = 'dynamic';

    async build(ctx: PromptBuildContext): Promise<string> {
        const { envInfo } = ctx;
        const psAvailable = envInfo.powershellAvailable;
        const cmdAvailable = envInfo.cmdAvailable;

        const quotingContract = psAvailable ? [
            '',
            '#### PowerShell JSON 传参免转义策略（powershell_quoting_contract）',
            '核心原则：**优先用 PowerShell 语法特性避免 JSON 转义，而非死记转义规则。**',
            '',
            '**策略 1 — 字符串参数用单引号（最重要！）**',
            '  ✅ Write-Host \'Hello World\'          # 单引号在 JSON 字符串中无需转义',
            '  ❌ Write-Host "Hello World"          # 双引号需写成 \\"Hello World\\"',
            '  ✅ Select-String -Pattern \'error\'   # 正则/模式匹配用单引号',
            '  ✅ curl -d \'{"key":"val"}\' url       # JSON 体用单引号包裹，内层双引号无需转义',
            '  ⚠️ 单引号字符串内变量不展开：$var 保持字面值，需要变量展开时用双引号（此时必须转义）',
            '',
            '**策略 2 — Windows 路径用正斜杠**',
            '  ✅ Get-ChildItem C:/Users/zhang        # 正斜杠在 JSON 中无需转义',
            '  ❌ Get-ChildItem C:\\Users\\zhang       # 反斜杠需写成 C:\\\\Users\\\\zhang',
            '  ⚠️ 部分 cmd 原生命令（dir、type）不接受正斜杠 → 改用 run_cmd_command 或写双反斜杠',
            '',
            '**策略 3 — 多行命令用分号**',
            '  ✅ pnpm install; pnpm run build        # 分号分隔（PS 5.1 不支持 &&）',
            '  ✅ "pnpm install`npnpm run build"      # 反引号 n 表示换行（PS 特有，JSON 中须转义反引号为 ``）',
            '  ❌ pnpm install\\npnpm run build        # \\n 在 JSON 中需写成 \\\\n（极易出错）',
            '',
            '**策略 4 — JSON 内嵌 JSON 用 here-string**',
            '  ✅ curl -Method POST -Body (@\'',
            '       {"key": "value"}',
            '       \'@) https://api.example.com',
            '     # here-string @\'...\'@ 内双引号无需转义',
            '',
            '**策略 5 — 必须用双引号时的自检清单**',
            '  调用前逐字通读 command 参数值，确认：',
            '  ☐ 每个 " 已写为 \\"',
            '  ☐ 每个 \\ 已写为 \\\\（路径特别注意）',
            '  ☐ 换行写为 `n（PowerShell 用反引号，不是 \\n）',
            '  ☐ $ 在JSON中无须转义，仅PS双引号字符串内需用 `$ 转义变量',
            '  ☐ 反引号 ` 在 JSON 中无须转义（非 JSON 特殊字符）',
            '',
            '**常见错误速查**',
            '  ❌ "command":"echo "hello""         → 内层引号未转义，JSON 解析失败',
            '  ❌ "command":"dir C:\\Users"         → 单反斜杠，\\U 被当作转义序列',
            '  ✅ "command":"echo \'hello\'"         → 单引号免转义',
            '  ✅ "command":"dir C:/Users"          → 正斜杠免转义',
        ].join('\n') : '';

        return [
            '### 终端工具可用性 (TERMINAL TOOLS)',
            `- run_powershell_command：${psAvailable ? `✅ 可用（${envInfo.powershellVersion}）` : '❌ 不可用'}`,
            `- run_cmd_command：${cmdAvailable ? `✅ 可用（${envInfo.cmdVersion}）` : '❌ 不可用'}`,
            '- Windows 优先用 run_powershell_command；仅在用户明确要求或命令确实只能在 cmd.exe 下执行时才用 run_cmd_command。',
            '- 每次命令执行后，完整输出自动持久化到 .command/output.txt；返回给 LLM 的结果可能已被截断，长输出场景用 read_file 获取完整内容。',
            quotingContract,
        ].filter(Boolean).join('\n');
    }
}

/**
 * Agent 服务端口保护策略
 * priority: dynamic
 */
export class PortProtectionSection extends BasePromptSection {
    readonly id = 'port-protection';
    readonly priority: PromptPriority = 'dynamic';

    async build(_ctx: PromptBuildContext): Promise<string> {
        const guard = ProcessSafetyGuard.getInstance();
        guard.refreshProtectedPorts();
        const ports = guard.getProtectedPortsText();

        return [
            '### Agent 服务端口保护 (AGENT SERVICE PORT PROTECTION)',
            `- Agent 核心端口：${ports}。这些是系统资产，不是可清理资源。`,
            '- 禁止杀死/释放/清理这些端口上的进程。',
            '- 编写用户项目代码/配置/脚本时，禁止用这些端口作为监听端口。',
            '- 冲突时改用 3000/3002/3004/5173/8000/8080 等非保留端口。',
        ].join('\n');
    }
}

/**
 * 临时文件治理策略
 * priority: dynamic
 */
export class TempFilePolicySection extends BasePromptSection {
    readonly id = 'temp-file-policy';
    readonly priority: PromptPriority = 'dynamic';

    async build(_ctx: PromptBuildContext): Promise<string> {
        return [
            '### 临时文件治理策略 (TEMP FILES SSOT POLICY)',
            '- 临时产物（调试脚本、构建中转、格式转换中间产物、一次性抓取缓存等用完即弃的内容）必须放在 `.temp/` 下，禁止散落业务目录。',
            '- 最终交付文件禁止写入 `.temp/`。',
            '- **【参考资料不入临时目录】下载的技术文章、参考文档、白皮书、API 规范、研究论文等具有持久参考价值的材料，严禁视为临时文件存入 `.temp/`。这些是项目知识资产，应统一存入 `docs/references/` 下按主题归档。**',
            '- `.temp/` 由用户自行清理，不要主动要求清理。',
        ].join('\n');
    }
}

/**
 * 浏览器自动化策略（Playwright MCP）
 * priority: dynamic
 */
export class BrowserPolicySection extends BasePromptSection {
    readonly id = 'browser-policy';
    readonly priority: PromptPriority = 'dynamic';

    async build(ctx: PromptBuildContext): Promise<string> {
        try {
            return BrowserMcpAdapter.getInstance().buildSystemPrompt(
                ctx.userId, ctx.workspaceRoot
            );
        } catch {
            return '';
        }
    }
}

/**
 * MCP 工具集成提示词
 * priority: dynamic
 */
export class McpToolsSection extends BasePromptSection {
    readonly id = 'mcp-tools';
    readonly priority: PromptPriority = 'dynamic';

    async build(ctx: PromptBuildContext): Promise<string> {
        try {
            return McpService.getInstance().buildMcpSystemPrompt(
                ctx.userId, ctx.workspaceRoot
            );
        } catch {
            return '';
        }
    }
}

/**
 * 近期历史指令记忆
 * priority: dynamic
 */
export class RecentInstructionsSection extends BasePromptSection {
    readonly id = 'recent-instructions';
    readonly priority: PromptPriority = 'dynamic';

    async build(ctx: PromptBuildContext): Promise<string> {
        try {
            const { workspaceRoot } = ctx;
            const records = await MemoryService.getRecentInstructions(
                workspaceRoot,
                globalConfig.memory.recentInstructionsLimit,
                globalConfig.memory.recentInstructionsSkip,
            );
            if (!records || records.length === 0) return '';

            return [
                '### 历史用户指令记录 (Recent Instructions Memory)',
                '以下为此工作区最近的指令（时间倒序）：',
                ...records.map((r, i) => `${i + 1}. [${r.date}] ${r.instruction}`),
            ].join('\n');
        } catch {
            return '';
        }
    }
}

/**
 * 防重复犯错记忆规则
 * priority: dynamic
 */
export class NeverMistakeSection extends BasePromptSection {
    readonly id = 'never-mistake';
    readonly priority: PromptPriority = 'dynamic';

    async build(ctx: PromptBuildContext): Promise<string> {
        try {
            const rules = await MemoryService.getNeverMistakeRules(ctx.workspaceRoot);
            const lines = [
                '### 防重复犯错记忆 (NEVER MISTAKE AGAIN SSOT)',
                '以下规则来自 `.memory/never_mistake_again.json`，请先自检再执行。',
                ...(rules && rules.length > 0
                    ? rules.map((r, i) => `${i + 1}. ❌ 不应：${r.shouldNot}\n   ✅ 应做：${r.shouldDo}`)
                    : ['- (EMPTY) 暂无历史规则。']),
                '**强制行为**：命中规则时必须执行替代动作；发现同类错误立即调用 `append_never_mistake_rule`。',
            ];
            return lines.join('\n');
        } catch {
            return '';
        }
    }
}

/**
 * 用户偏好记忆策略（工具拉取模式）
 * priority: dynamic
 */
export class UserPreferenceSection extends BasePromptSection {
    readonly id = 'user-preferences';
    readonly priority: PromptPriority = 'dynamic';

    async build(_ctx: PromptBuildContext): Promise<string> {
        return [
            '### 用户偏好记忆策略 (USER PREFERENCES VIA TOOLS ONLY)',
            '`list_user_preferences` 返回结果视为唯一真值（SSOT）。',
            '**强制行为**：',
            '1. 任务涉及输出风格/语言/格式/技术选型时，优先调用 `list_user_preferences`；',
            '2. 用户表达新偏好时，立即调用 `upsert_user_preference` 记录；',
            '3. 冲突时以用户最新明确指令为准，并同步更新偏好记忆。',
        ].join('\n');
    }
}

/**
 * 用户意图识别与对齐（置顶注入，由 MessagePreparationService 负责）
 * priority: dynamic
 */
export class IntentAlignmentSection extends BasePromptSection {
    readonly id = 'intent-alignment';
    readonly priority: PromptPriority = 'dynamic';

    async build(_ctx: PromptBuildContext): Promise<string> {
        return [
            '### 用户意图识别与对齐 (INTENT TRACKING & ALIGNMENT)',
            '**意图维持准则**：',
            '1. 所有行为必须严防"意图漂移"，必须满足当前意图。',
            '2. 历史裁剪后若 TODO 状态不确定，先调用 `list_todos` 获取最新清单。',
            '3. 终态前置：最终答复前必须确保所有 TODO 任务进入 `completed` 或 `failed` 状态。',
        ].join('\n');
    }
}

/**
 * TODO 工具使用策略
 * priority: dynamic
 */
export class TodoPolicySection extends BasePromptSection {
    readonly id = 'todo-policy';
    readonly priority: PromptPriority = 'dynamic';

    async build(_ctx: PromptBuildContext): Promise<string> {
        return [
            '### TODO 工具使用策略 (TODO TOOLING POLICY)',
            '`list_todos`/`append_todo`/`update_todo`/`delete_todo` 仅允许顶层 Agent 调用。',
            '⚠️ 职责区分：`list_todos` 为纯只读查询工具（无必填参数），绝不会保存任何传入参数！新建/规划任务必须调用 `append_todo`，更新状态调用 `update_todo`。',
            '状态不确定时优先 `list_todos` 获取当前真值（SSOT），`list_todos` 无必填参数。',
            '',
            '**【执行前置检查 — 防止历史遗留污染】**：',
            '每次收到用户指令后、开始执行任何业务任务之前，必须先调用 `list_todos` 检查当前 TODO 清单状态。',
            '若清单中存在与用户最新指令不相符的旧任务（包括但不限于：上一轮遗留的未完成任务、',
            '用户已改变意图导致旧规划过时、或与当前指令存在冲突的任务项），',
            '必须立即清空所有旧 TODO 项，确保清单从干净状态开始，再根据用户最新指令重新规划 TODO。',
            '此规则旨在防止历史遗留 TODO 污染新一轮任务规划，是 `planning_first` 的前置条件。',
            '',
            '**【终态强制门禁】**：',
            '1. 调用 `list_todos` 获取当前任务清单；',
            '2. 将 `not-started`/`in-progress` 任务标记为终态；',
            '3. 确认全部任务终态后，才允许输出最终答复；',
            '4. 仍有可推进任务时禁止强行终态。',
            '',
            '**【记忆反思与持久化 — 任务完成后的知识沉淀】**：',
            '在确认全部 TODO 任务已进入终态（completed/failed）、准备输出最终答复之前，必须执行记忆反思流程：',
            '',
            '1. **反思本轮是否有值得持久化的知识**，逐项检查以下维度：',
            '   - **工具失败模式**：本轮是否遇到工具调用失败并通过重试找到正确做法？→ 调用 `append_never_mistake_rule` 记录（概括失败模式，不引用具体文件路径）',
            '   - **用户偏好变化**：用户是否表达了新的风格/语言/格式/技术选型/行为习惯偏好？→ 调用 `upsert_user_preference` 记录（type 使用对应分类如 style/language/format/behavior/tool）',
            '   - **项目特定知识**：是否发现了项目特定的架构约定、端口配置、依赖版本约束、命名规范、目录结构约定等对后续任务有指导价值的信息？→ 调用 `upsert_user_preference` 记录（type 使用 `project`，source 使用 `inferred`）',
            '   - **冲突淘汰**：新发现是否与已有记忆冲突？→ 先 `list_user_preferences` 获取冲突项 ID，再通过 `conflictIds` 参数淘汰旧偏好',
            '',
            '2. **持久化判断标准**（满足任一即应记录）：',
            '   - 该知识在本轮对话中被反复使用 ≥2 次',
            '   - 本轮因缺少该知识而走了弯路或产生了返工',
            '   - 该知识对后续同类任务有明确的指导/约束价值',
            '   - 用户明确要求"记住这个"或"保存这个偏好"',
            '',
            '3. **不应记录的内容**（跳过）：',
            '   - 显而易见的通用编程常识（如"JavaScript 用 const 声明常量"）',
            '   - 仅适用于本轮一次性临时任务的信息',
            '   - 已经存在于现有记忆中的重复内容（先 `list_user_preferences` 或 `list_never_mistake_rules` 确认不重复）',
            '   - 不确定、未经本轮验证的推测性内容',
            '',
            '4. **执行顺序**：终态门禁 → 记忆反思 → 记忆更新（如有）→ 最终答复。',
            '5. 若本轮无值得持久化的知识，跳过此步骤直接输出最终答复。**禁止为了记录而记录，禁止记录通用常识。**',
        ].join('\n');
    }
}

/**
 * 编码设计规范：先画流程图后写代码
 * priority: static —— 编码方法论，会话生命周期内不变
 * 
 * 核心原则：非平凡编码任务必须先通过 Mermaid 流程图理清架构/流程/数据流，
 * 再动手写代码。流程图作为设计方案的可视化载体，帮助 Agent 在代码生成前
 * 做足全局思考，减少返工和遗漏。
 */
export class CodeDesignFlowSection extends BasePromptSection {
    readonly id = 'code-design-flow';
    readonly priority: PromptPriority = 'static';

    async build(_ctx: PromptBuildContext): Promise<string> {
        return [
            '### 编码设计规范：先画流程图，后写代码 (DESIGN-FIRST CODING DISCIPLINE)',
            '',
            '**核心铁律**：任何非平凡编码任务（多文件改动、架构调整、新模块/组件、跨服务交互、',
            '数据流设计、状态机、异步流程等），必须先设计 Mermaid 流程图作为方案约束，再动手写代码。',
            '流程图是设计方案的可视化载体，不是事后补的文档。',
            '',
            '**何时必须画流程图（满足任一条件即触发）**：',
            '- 涉及 ≥2 个文件的修改或新增',
            '- 涉及前后端交互 / API 调用链路 / IPC 通信',
            '- 涉及数据模型变更（新增/修改数据库表、接口 Schema、类型定义）',
            '- 涉及状态管理（React state、Redux、Context、全局状态流转）',
            '- 涉及异步流程（Promise 链、事件驱动、消息队列、定时任务）',
            '- 涉及组件树重构或新增 ≥1 个组件',
            '- 涉及第三方服务集成（MCP、WebSocket、SSE、OAuth 等）',
            '- 用户明确要求"设计方案"/"画流程"/"架构设计"',
            '',
            '**何时可以跳过流程图**：',
            '- 纯单文件单函数的小修改（≤20 行净增）',
            '- 纯文案/翻译/注释修改',
            '- 纯配置项修改（JSON/YAML/ENV 单键值变更）',
            '- 纯 Bug 修复（已有明确定位，改动范围 ≤1 文件 1 函数）',
            '- 用户明确说"不用设计"/"直接改"',
            '',
            '**流程图绘制规范**：',
            '1. 使用 Mermaid 语法，写在 Markdown 代码块中（```mermaid ... ```）',
            '2. 选择合适的图表类型：',
            '   - **流程图 (flowchart)**: 业务流程、决策分支、操作步骤',
            '   - **时序图 (sequenceDiagram)**: 前后端交互、API 调用链、IPC 通信',
            '   - **类图 (classDiagram)**: 数据模型、类型关系、接口继承',
            '   - **状态图 (stateDiagram)**: 状态机、生命周期、模态流转',
            '   - **ER 图 (erDiagram)**: 数据库表关系',
            '   - **架构图 (graph/flowchart)**: 系统组件拓扑、模块依赖',
            '3. 流程图必须覆盖以下要素（按需选择）：',
            '   - **参与者**：哪些模块/组件/服务参与交互',
            '   - **数据流向**：数据从哪里来、经过哪些处理、最终落到哪里',
            '   - **决策点**：关键的条件分支和判断逻辑',
            '   - **边界条件**：异常路径、超时、空值、权限不足等',
            '   - **状态变更**：哪些状态会被修改、由谁触发',
            '4. 流程图应与后续 TODO 清单联动：图中的关键节点 → TODO 项',
            '',
            '**执行顺序**：',
            '1. 分析需求 → 确定是否需要流程图',
            '2. 绘制 Mermaid 流程图并展示给用户',
            '3. 用户确认（或自检通过）后，将流程节点拆解为 TODO 清单',
            '4. 按 TODO 逐项编码实现',
            '5. 编码完成后对照流程图自检覆盖度',
            '',
            '**反模式（严禁）**：',
            '- 写完代码再补画流程图（本末倒置）',
            '- 流程图与代码实现脱节（各说各话）',
            '- 用大量文字描述代替流程图（一图胜千言）',
            '- 流程图过于笼统（如"用户→系统→数据库"三个框）',
            '- 在多轮迭代中遗忘更新流程图（方案变更必须同步更新流程图）',
        ].join('\n');
    }
}

/**
 * 共享契约注入（从 shared-contracts.json 加载）
 * priority: static —— 契约在会话生命周期内不变
 */
export class SharedContractsSection extends BasePromptSection {
    readonly id = 'shared-contracts';
    readonly priority: PromptPriority = 'static';

    async build(_ctx: PromptBuildContext): Promise<string> {
        try {
            const contractsPath = path.join(CONFIG_ROOT, 'shared-contracts.json');
            const raw = await readFile(contractsPath, 'utf-8');
            const contracts = JSON.parse(raw);
            const shared = contracts.shared_contracts;
            if (!shared) return '';

            const lines: string[] = [
                '### 共享契约 (SHARED CONTRACTS — 主Agent与评估Agent共同遵循)',
            ];

            for (const [key, contract] of Object.entries(shared)) {
                const c = contract as any;
                // 跳过已废弃的契约（已被 simplicity_principle 覆盖，不再注入提示词）
                if (c._deprecated) continue;
                // 跳过无规则的契约
                if (!Array.isArray(c.rules) || c.rules.length === 0) continue;
                lines.push(`#### ${c.description || key}`);
                for (const rule of c.rules) {
                    lines.push(`- ${rule}`);
                }
            }

            return lines.join('\n');
        } catch {
            return '';
        }
    }
}

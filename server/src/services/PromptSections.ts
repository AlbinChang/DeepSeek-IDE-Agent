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
            `- **工作目录**: ${root}`,
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
        return [
            '### 终端工具可用性 (TERMINAL TOOLS)',
            `- run_powershell_command：${envInfo.powershellAvailable ? `✅ 可用（${envInfo.powershellVersion}）` : '❌ 不可用'}`,
            `- run_cmd_command：${envInfo.cmdAvailable ? `✅ 可用（${envInfo.cmdVersion}）` : '❌ 不可用'}`,
            '- Windows 优先用 run_powershell_command；仅在用户明确要求或命令确实只能在 cmd.exe 下执行时才用 run_cmd_command。',
            '- 每次命令执行后，完整输出（stdout+stderr+元数据）自动持久化到 .command/output.txt；返回给 LLM 的结果可能已被截断。',
            '- 长命令输出场景：先观察返回结果中的关键信息；若信息不足，用 read_file 读取 .command/output.txt 获取完整输出。',
        ].join('\n');
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
            '- 临时产物必须放在 `.temp/` 下，禁止散落业务目录。',
            '- 最终交付文件禁止写入 `.temp/`。',
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
            '状态不确定时优先 `list_todos` 获取当前真值（SSOT），`list_todos` 无必填参数。',
            '',
            '**【终态强制门禁】**：',
            '1. 调用 `list_todos` 获取当前任务清单；',
            '2. 将 `not-started`/`in-progress` 任务标记为终态；',
            '3. 确认全部任务终态后，才允许输出最终答复；',
            '4. 仍有可推进任务时禁止强行终态。',
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

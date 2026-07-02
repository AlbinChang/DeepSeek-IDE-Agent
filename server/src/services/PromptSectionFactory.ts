/**
 * PromptSectionFactory — 提示词片段工厂
 *
 * 遵循 DIP：返回 SystemPromptBuilder（已注册全部片段），
 * 调用方只需调用 builder.build(ctx) 即可获得完整提示词。
 *
 * 新增 Agent 类型只需：
 * 1. 新建 JSON 配置文件（如 my-agent.json）
 * 2. 调用 createBuilder(config) 即可复用全部片段
 * 3. 如需特殊片段，通过 builder.register(customSection) 扩展
 */

import { SystemPromptBuilder } from '@/services/SystemPromptBuilder.js';
import {
    RoleSection,
    CapabilitiesSection,
    WorkspaceProfileSection,
    SkillsIndexSection,
    ProjectRulesSection,
    DateTimeSection,
    GitPolicySection,
    ShellPolicySection,
    PortProtectionSection,
    TempFilePolicySection,
    BrowserPolicySection,
    McpToolsSection,
    RecentInstructionsSection,
    NeverMistakeSection,
    UserPreferenceSection,
    IntentAlignmentSection,
    TodoPolicySection,
    SharedContractsSection,
} from '@/services/PromptSections.js';

import type { IPromptSection } from '@/types/prompt.js';

/**
 * 创建预配置的 SystemPromptBuilder（包含所有标准片段）。
 * 调用方可通过 builder.register()/unregister() 按需定制。
 *
 * @param agentConfig - 已解析的 Agent JSON 配置对象
 * @returns 已注册全部标准片段的 SystemPromptBuilder
 */
export function createStandardBuilder(agentConfig: any): SystemPromptBuilder {
    const builder = new SystemPromptBuilder();

    // Static 区 — 会话生命周期内稳定不变（利于 KV Cache 命中）
    builder.register(new SharedContractsSection());
    builder.register(new RoleSection(agentConfig));
    builder.register(new CapabilitiesSection(agentConfig));
    builder.register(new WorkspaceProfileSection());

    // Low-Churn 区 — 低频变化（随 workspace 切换变化）
    builder.register(new SkillsIndexSection());
    builder.register(new ProjectRulesSection());

    // Dynamic 区 — 每轮可能变化
    builder.register(new DateTimeSection());
    builder.register(new GitPolicySection());
    builder.register(new ShellPolicySection());
    builder.register(new PortProtectionSection());
    builder.register(new TempFilePolicySection());
    builder.register(new BrowserPolicySection());
    builder.register(new McpToolsSection());
    builder.register(new RecentInstructionsSection());
    builder.register(new NeverMistakeSection());
    builder.register(new UserPreferenceSection());
    builder.register(new IntentAlignmentSection());
    builder.register(new TodoPolicySection());

    return builder;
}

/**
 * 便捷函数：直接构建提示词（一步到位）
 */
export async function buildSystemPrompt(
    agentConfig: any,
    ctx: import('@/types/prompt.js').PromptBuildContext,
    extraSections?: IPromptSection[],
): Promise<string> {
    const builder = createStandardBuilder(agentConfig);
    if (extraSections && extraSections.length > 0) {
        builder.registerAll(extraSections);
    }
    return builder.build(ctx);
}

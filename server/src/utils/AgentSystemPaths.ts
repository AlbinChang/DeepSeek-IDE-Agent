/**
 * Agent 内部状态目录的写保护。
 *
 * 这些目录只由系统服务写入，Agent 工具不得修改或删除其中任何文件：
 * - `.evaluate/` 最近一次评估 Agent 报告 —— 只有用户显式点击「清空历史会话」时才清除，
 *   其余任何时刻（新对话、任务结束、工作区切换、评估失败）都必须保留。
 * - `.memory/`   长期记忆（用户指令 / 主 Agent 回复 / 反错规则 / 用户偏好），
 *   由 MemoryService 与记忆工具维护；直接改写会破坏 `dialogIndex` 编号与一一对应关系。
 *
 * 需要读写记忆时请使用对应工具：`append_never_mistake_rule` / `upsert_user_preference` /
 * `list_main_agent_replies` / `read_main_agent_reply` 等。
 */

const AGENT_PROTECTED_STATE_DIRS = ['.evaluate', '.memory'] as const;

export class ProtectedAgentStateError extends Error {
    constructor(
        public readonly relativePath: string,
        public readonly protectedDir: string,
        public readonly action: string,
    ) {
        super(
            `禁止通过 ${action} 修改或删除 Agent 系统内部路径 "${relativePath}"（位于 ${protectedDir}/）。` +
            '该目录由系统维护：评估报告只保留最近一次且仅由用户「清空历史会话」清除，' +
            '长期记忆请使用记忆工具（append_never_mistake_rule / upsert_user_preference / ' +
            'list_main_agent_replies / read_main_agent_reply 等），不要直接改文件。',
        );
        this.name = 'ProtectedAgentStateError';
    }
}

/** 返回该相对路径命中的受保护目录名；未命中返回 null。 */
export function findProtectedAgentStateDir(relativePath: string): string | null {
    const normalized = String(relativePath || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!normalized) return null;
    const segments = normalized.split('/').filter(Boolean);
    for (const segment of segments) {
        const lower = segment.toLowerCase();
        const matched = AGENT_PROTECTED_STATE_DIRS.find((dir) => dir === lower);
        if (matched) return matched;
    }
    return null;
}

/** 写操作前调用：命中受保护目录时抛出 {@link ProtectedAgentStateError}。 */
export function assertAgentStatePathWritable(relativePath: string, action: string): void {
    const matched = findProtectedAgentStateDir(relativePath);
    if (matched) {
        throw new ProtectedAgentStateError(relativePath, matched, action);
    }
}

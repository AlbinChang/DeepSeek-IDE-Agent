/**
 * 最近打开的工作区管理服务
 * 
 * 功能：
 * - 在 localStorage 中持久化最近打开的工作区列表（最多 10 条）
 * - 自动去重：重复路径会更新时间戳并提升到列表顶部
 * - 提供检索、添加、移除、清空接口
 */

const STORAGE_KEY = 'agent-recent-workspaces';
const MAX_ENTRIES = 10;

export interface RecentWorkspaceEntry {
    path: string;
    timestamp: number; // Date.now()
}

function load(): RecentWorkspaceEntry[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (e: any) => typeof e?.path === 'string' && typeof e?.timestamp === 'number'
        );
    } catch {
        return [];
    }
}

function save(entries: RecentWorkspaceEntry[]): void {
    try {
        const trimmed = entries.slice(0, MAX_ENTRIES);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
    } catch {
        // localStorage 写入失败时静默忽略（如配额不足）
    }
}

/**
 * 获取最近打开的工作区列表（按时间倒序）
 */
export function getRecentWorkspaces(): RecentWorkspaceEntry[] {
    const entries = load();
    // 按时间戳降序排列（最近的在前面）
    entries.sort((a, b) => b.timestamp - a.timestamp);
    return entries.slice(0, MAX_ENTRIES);
}

/**
 * 记录一次工作区打开事件
 * 如果路径已存在，更新时间戳并提升到顶部；否则新增条目
 */
export function addRecentWorkspace(workspacePath: string): void {
    const trimmed = workspacePath.trim();
    if (!trimmed) return;

    const entries = load();
    const now = Date.now();

    // 查找是否已存在
    const existingIdx = entries.findIndex(
        (e) => e.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
            === trimmed.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    );

    if (existingIdx >= 0) {
        // 更新时间戳，移到顶部
        entries.splice(existingIdx, 1);
    }

    // 在数组头部插入（最新的在最前面）
    entries.unshift({ path: trimmed, timestamp: now });

    // 保持最多 MAX_ENTRIES 条
    save(entries.slice(0, MAX_ENTRIES));
}

/**
 * 从最近列表中移除指定路径
 */
export function removeRecentWorkspace(workspacePath: string): void {
    const trimmed = workspacePath.trim();
    if (!trimmed) return;

    const entries = load();
    const filtered = entries.filter(
        (e) => e.path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
            !== trimmed.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
    );
    save(filtered);
}

/**
 * 清空所有最近工作区记录
 */
export function clearRecentWorkspaces(): void {
    localStorage.removeItem(STORAGE_KEY);
}

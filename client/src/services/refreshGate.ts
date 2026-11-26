/**
 * 目录树刷新闸门。
 *
 * 为什么需要：文件树是 Virtuoso 虚拟滚动列表，数据一变就会重新测量、必要时调整滚动位置，
 * 而右键菜单靠全局 `scroll` 监听来关闭——于是「Agent 正在写文件 → 树刷新 → 菜单瞬间消失」，
 * 用户根本来不及点。做法是：菜单打开期间冻结刷新，把待刷新目录记下来，菜单关闭后合并补一次。
 *
 * 纯逻辑、无 React 依赖，便于单测。
 */

/** 冻结期间最多记住多少个待刷新路径（超出后退化成只保证根目录，避免无限堆积） */
export const DEFAULT_MAX_DEFERRED_PATHS = 8;

export interface RefreshGate {
    /** 当前是否冻结 */
    isFrozen(): boolean;
    /** 冻结刷新（右键菜单打开时调用） */
    freeze(): void;
    /** 记下被冻结的刷新请求 */
    defer(path: string): void;
    /** 解除冻结并返回需要补刷的路径（只返回一次、已去重） */
    release(): string[];
    /** 当前排队的路径数量（诊断/测试用） */
    pendingCount(): number;
}

export const createRefreshGate = (maxDeferred = DEFAULT_MAX_DEFERRED_PATHS): RefreshGate => {
    const limit = Number.isFinite(maxDeferred) && maxDeferred > 0
        ? Math.floor(maxDeferred)
        : DEFAULT_MAX_DEFERRED_PATHS;

    let frozen = false;
    const deferred = new Set<string>();

    return {
        isFrozen: () => frozen,

        freeze() {
            frozen = true;
        },

        defer(path: string) {
            const key = typeof path === 'string' && path ? path : '.';
            if (deferred.has(key)) return;
            if (deferred.size < limit) {
                deferred.add(key);
                return;
            }
            // 队列满：放弃记录具体目录，只保证根目录一定会补刷
            deferred.add('.');
        },

        release(): string[] {
            frozen = false;
            const paths = Array.from(deferred);
            deferred.clear();
            return paths;
        },

        pendingCount: () => deferred.size,
    };
};

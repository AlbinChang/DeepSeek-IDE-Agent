/**
 * @deprecated BrowserAutomationTools 已全面重构为 BrowserMcpAdapter（纯适配器模式）。
 *
 * 所有浏览器自动化能力现已通过 `server/src/services/BrowserMcpAdapter.ts` 提供：
 * - 不再管理浏览器会话（Playwright MCP 自身具备会话管理能力）
 * - Agent 初始化阶段即建立 MCP Client 连接，获取工具定义 / 资源定义 / 提示模板
 * - 原生 Playwright MCP 工具以 `playwright__` 前缀桥接为 Agent ToolDefinition
 *
 * 迁移指南：
 * - 旧 `browser_open` → 直接调用 `playwright__browser_navigate` 等 Playwright 原生工具
 * - 旧 `browser_mcp_call` → 直接调用对应的 `playwright__*` 桥接工具
 * - 旧 `browser_mcp_list_tools` → 系统提示词中已动态列出所有可用 Playwright 工具
 * - 旧 `browser_close_all` → Playwright MCP 自动管理浏览器生命周期
 * - 旧 `browser_list_sessions` → 不再需要（无会话管理）
 *
 * 本文件保留为兼容性存根，实际逻辑已迁移至 BrowserMcpAdapter。
 * 若需使用浏览器自动化，请直接使用 BrowserMcpAdapter.getInstance()。
 */

// ============================================================
// 兼容性存根 — 所有逻辑已迁移至 BrowserMcpAdapter
// ============================================================

export class BrowserAutomationTools {
    /**
     * @deprecated 构造函数仅保留兼容性。workspaceRoot 参数不再使用。
     */
    constructor(_workspaceRoot?: string) {
        // 兼容性存根：不再执行任何初始化
    }

    /**
     * @deprecated 所有浏览器工具已通过 BrowserMcpAdapter 动态桥接。
     * 请使用 BrowserMcpAdapter.getInstance().getBridgeToolDefinitions(userId, workspaceRoot)。
     */
    static getDefinitions(): Array<{
        name: string;
        description: string;
        parameters: { type: string; properties: Record<string, unknown> };
    }> {
        return [];
    }

    /**
     * @deprecated execute() 不再支持。请使用 BrowserMcpAdapter。
     */
    async execute(_toolName: string, _params: Record<string, unknown>, _context?: { userId?: string }): Promise<Record<string, unknown>> {
        throw new Error(
            'BrowserAutomationTools.execute() is deprecated. ' +
            'All browser automation is now handled by BrowserMcpAdapter. ' +
            'Use playwright__browser_* tools directly.'
        );
    }
}
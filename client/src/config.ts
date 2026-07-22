// 对应技术规范 10.2 节：动态用户标识 (Dynamic User Identity)
// Electron 可通过 preload 同步提供 Windows 本地用户名；浏览器端继续使用本地持久化标识。
const getBrowserUserId = () => {
    try {
        // [E2E] 支持 Playwright 注入固定的 UserId 以通过断言
        if (typeof window !== 'undefined' && (window as any).__E2E_USER_ID__) {
            return (window as any).__E2E_USER_ID__;
        }

        // 桌面端必须优先使用真实本地用户，避免沿用浏览器端生成的 windows-xxxx 随机 ID。
        if (typeof window !== 'undefined' && (window as any).__ELECTRON_USER_ID__) {
            const electronUserId = String((window as any).__ELECTRON_USER_ID__).trim();
            if (electronUserId) return electronUserId;
        }

        const saved = localStorage.getItem('DEEPSEEK_IDE_USER_ID');
        if (saved) return saved;
        
        // 尝试从 navigator.userAgentData 获取平台信息 (Windows/macOS/Linux)
        const platform = ((navigator as any).userAgentData?.platform || navigator.platform || 'desktop').toLowerCase();
        const randomId = Math.random().toString(36).substring(2, 6);
        const generated = `${platform.replace(/[^a-z0-9]/g, '')}-${randomId}`;
        
        localStorage.setItem('DEEPSEEK_IDE_USER_ID', generated);
        return generated;
    } catch {
        return 'default-user';
    }
};

export const USER_ID = getBrowserUserId();

// 事件总线标识
export const GATEWAY_EVENT = 'ui:gateway:message';
export const LEGACY_WS_EVENT = 'ui:ws:message';

// @deprecated 桌面应用模式下不再使用 HTTP/WS 端点，保留导出以兼容未清理的旧代码路径
export const API_BASE = 'http://localhost:3001';
export const WS_BASE = 'ws://localhost:3001';
export const TERMINAL_HTTP_BASE = 'http://localhost:3003';


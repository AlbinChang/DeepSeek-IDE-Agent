// 对应技术规范 10.2 节：动态用户标识 (Dynamic User Identity)
// 默认获取浏览器端操作系统平台。注：出于隐私保护，浏览器无法直接 whoami，通过本地持久化模拟当前用户
const getBrowserUserId = () => {
    try {
        // [E2E] 支持 Playwright 注入固定的 UserId 以通过断言
        if (typeof window !== 'undefined' && (window as any).__E2E_USER_ID__) {
            return (window as any).__E2E_USER_ID__;
        }

        const saved = localStorage.getItem('DEEPSEEK_IDE_USER_ID');
        if (saved) return saved;
        
        // 尝试从 navigator.userAgentData 获取平台信息 (Windows/macOS/Linux)
        const platform = ((navigator as any).userAgentData?.platform || navigator.platform || 'web').toLowerCase();
        const randomId = Math.random().toString(36).substring(2, 6);
        const generated = `${platform.replace(/[^a-z0-9]/g, '')}-${randomId}`;
        
        localStorage.setItem('DEEPSEEK_IDE_USER_ID', generated);
        return generated;
    } catch {
        return 'default-user';
    }
};

export const USER_ID = getBrowserUserId();

// [对齐 16.4 节：宽松绑定] 动态解析后端地址，兼容跨网卡和 WSL 访问
const HOST = typeof window !== 'undefined' ? window.location.hostname : '127.0.0.1';

declare const __SERVER_CONF__: {
    devPort: number;
    staticPort: number;
    host: string;
    apiPort: number;
    wsPort: number;
    terminalPort: number;
};

const SERVER_CONF = (typeof __SERVER_CONF__ !== 'undefined' && __SERVER_CONF__)
    ? __SERVER_CONF__
    : {
        devPort: 5174,
        staticPort: 5174,
        host: '0.0.0.0',
        apiPort: 3001,
        wsPort: 3001,
        terminalPort: 3003,
    };

export const API_BASE = `http://${HOST}:${SERVER_CONF.apiPort}`;
export const WS_BASE = `ws://${HOST}:${SERVER_CONF.wsPort}`;
export const GATEWAY_EVENT = 'ui:gateway:message';
export const LEGACY_WS_EVENT = 'ui:ws:message';

/**
 * 对应技术规范 16.0 节：多端口负载隔离策略 (Multi-Port Isolation)
 * API 中心: REST API, Context, Completion, Events, Chat
 * 终端信道: Terminal PTY
 * 端口统一来自 client/server_conf.json
 */
export const WS_TERMINAL_BASE = `ws://${HOST}:${SERVER_CONF.terminalPort}`;
export const TERMINAL_HTTP_BASE = `http://${HOST}:${SERVER_CONF.terminalPort}`;


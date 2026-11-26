import { describe, expect, it } from 'vitest';

import {
    buildPlaywrightToolName,
    parsePlaywrightToolName,
    resolvePlaywrightToolTimeout,
} from '@/services/BrowserMcpAdapter.js';

describe('Playwright 工具超时预算', () => {
    it('导航类工具按 --timeout-navigation 预算额外留余量', () => {
        const timeout = resolvePlaywrightToolTimeout('browser_navigate', {});
        // 默认导航预算 120s + 30s 余量
        expect(timeout).toBe(150_000);
    });

    it('动作类工具至少保留 30s 下限，且覆盖动作预算', () => {
        expect(resolvePlaywrightToolTimeout('browser_click', {})).toBe(30_000);
        expect(resolvePlaywrightToolTimeout('browser_click', { BROWSER_MCP_TIMEOUT_ACTION: '45000' })).toBe(65_000);
    });

    it('导航预算可配置，且非法值回退默认', () => {
        expect(resolvePlaywrightToolTimeout('browser_navigate', { BROWSER_MCP_TIMEOUT_NAVIGATION: '60000' }))
            .toBe(90_000);
        expect(resolvePlaywrightToolTimeout('browser_navigate', { BROWSER_MCP_TIMEOUT_NAVIGATION: 'abc' }))
            .toBe(150_000);
        expect(resolvePlaywrightToolTimeout('browser_navigate', { BROWSER_MCP_TIMEOUT_NAVIGATION: '0' }))
            .toBe(150_000);
    });
});

describe('Playwright 桥接工具名', () => {
    it('前缀可往返解析', () => {
        const agentName = buildPlaywrightToolName('browser_navigate');
        expect(agentName).toBe('playwright__browser_navigate');
        expect(parsePlaywrightToolName(agentName)).toEqual({ nativeToolName: 'browser_navigate' });
    });

    it('非 playwright 前缀的工具名解析失败', () => {
        expect(parsePlaywrightToolName('read_file')).toBeNull();
        expect(parsePlaywrightToolName('__browser_navigate')).toBeNull();
    });
});

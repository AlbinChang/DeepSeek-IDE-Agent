import { describe, expect, it } from 'vitest';

import {
    PLAYWRIGHT_WORKER_PROTOCOL_VERSION,
    isMainToWorkerMessage,
    isWorkerToMainMessage,
} from '@/services/playwrightWorkerProtocol.js';

describe('playwrightWorkerProtocol 守卫', () => {
    it('协议版本号已固定', () => {
        expect(PLAYWRIGHT_WORKER_PROTOCOL_VERSION).toBe(1);
    });

    it('接受合法的 mcp.call 消息', () => {
        expect(isMainToWorkerMessage({
            type: 'mcp.call',
            requestId: 'call-1',
            name: 'browser_navigate',
            args: { url: 'https://example.com' },
            timeoutMs: 30_000,
        })).toBe(true);
    });

    it('拒绝缺少必填字段的 mcp.call（args 缺失）', () => {
        expect(isMainToWorkerMessage({
            type: 'mcp.call',
            requestId: 'call-1',
            name: 'browser_navigate',
            timeoutMs: 30_000,
        })).toBe(false);
    });

    it('拒绝 args 为数组的消息（必须可序列化成对象）', () => {
        expect(isMainToWorkerMessage({
            type: 'mcp.call',
            requestId: 'call-1',
            name: 'browser_navigate',
            args: [],
            timeoutMs: 30_000,
        })).toBe(false);
    });

    it('拒绝未知消息类型与原始值', () => {
        expect(isMainToWorkerMessage({ type: 'mcp.unknown', requestId: 'x' })).toBe(false);
        expect(isMainToWorkerMessage(null)).toBe(false);
        expect(isMainToWorkerMessage('mcp.call')).toBe(false);
        expect(isMainToWorkerMessage(['mcp.call'])).toBe(false);
    });

    it('mcp.connect 需要 config 对象', () => {
        expect(isMainToWorkerMessage({
            type: 'mcp.connect',
            requestId: 'connect-1',
            config: { command: 'node', args: [], cwd: '/tmp', env: {} },
        })).toBe(true);
        expect(isMainToWorkerMessage({ type: 'mcp.connect', requestId: 'connect-1' })).toBe(false);
    });

    it('mcp.cancel 需要目标 requestId', () => {
        expect(isMainToWorkerMessage({
            type: 'mcp.cancel',
            requestId: 'cancel-1',
            targetRequestId: 'call-1',
        })).toBe(true);
        expect(isMainToWorkerMessage({ type: 'mcp.cancel', requestId: 'cancel-1' })).toBe(false);
    });

    it('接受 worker 上报的 ready/result/state/log', () => {
        expect(isWorkerToMainMessage({
            type: 'worker.ready',
            protocolVersion: PLAYWRIGHT_WORKER_PROTOCOL_VERSION,
            pid: 1234,
        })).toBe(true);
        expect(isWorkerToMainMessage({
            type: 'mcp.result',
            requestId: 'call-1',
            ok: false,
            code: 'tool_timeout',
            error: 'timed out',
            durationMs: 30_000,
        })).toBe(true);
        expect(isWorkerToMainMessage({ type: 'mcp.state', connected: false, reason: 'transport_closed' })).toBe(true);
        expect(isWorkerToMainMessage({ type: 'worker.log', level: 'warn', message: 'hi' })).toBe(true);
    });

    it('拒绝非法 worker 消息', () => {
        // ok 必须是布尔值：宿主靠它决定 resolve 还是 reject
        expect(isWorkerToMainMessage({ type: 'mcp.result', requestId: 'call-1', ok: 'true' })).toBe(false);
        expect(isWorkerToMainMessage({ type: 'mcp.state', connected: 'yes' })).toBe(false);
        expect(isWorkerToMainMessage({ type: 'worker.ready' })).toBe(false);
        expect(isWorkerToMainMessage(undefined)).toBe(false);
    });
});

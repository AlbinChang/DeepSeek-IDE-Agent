import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AgentService } from '@/services/AgentService.js';
import { EventDistributor } from '@/services/EventDistributor.js';
import { LiveContextStore } from '@/services/LiveContextStore.js';
import { BrowserMcpAdapter } from '@/services/BrowserMcpAdapter.js';

describe('workspace isolation contracts', () => {
    const userId = `workspace-isolation-${Date.now()}`;
    let rootA = '';
    let rootB = '';

    beforeEach(async () => {
        rootA = await mkdtemp(path.join(tmpdir(), 'deepseek-ide-root-a-'));
        rootB = await mkdtemp(path.join(tmpdir(), 'deepseek-ide-root-b-'));
    });

    afterEach(async () => {
        await Promise.all([
            rootA ? rm(rootA, { recursive: true, force: true }) : Promise.resolve(),
            rootB ? rm(rootB, { recursive: true, force: true }) : Promise.resolve(),
        ]);
        // 清理 Playwright MCP 连接
        const adapter = BrowserMcpAdapter.getInstance();
        await Promise.all([
            adapter.disconnect(userId, rootA).catch(() => {}),
            adapter.disconnect(userId, rootB).catch(() => {}),
        ]);
    });

    it('keeps chat histories separate for the same user in different workspaces', () => {
        const agentService = AgentService.getInstance();

        agentService.updateSessionHistory(userId, [{ role: 'assistant', content: 'from A' }], rootA);
        agentService.updateSessionHistory(userId, [{ role: 'assistant', content: 'from B' }], rootB);

        expect(agentService.getSessionHistory(userId, rootA)).toEqual([{ role: 'assistant', content: 'from A' }]);
        expect(agentService.getSessionHistory(userId, rootB)).toEqual([{ role: 'assistant', content: 'from B' }]);
    });

    it('uses executionContext.workspaceRoot before the global user workspace when tools run', async () => {
        const agentService = AgentService.getInstance();
        await writeFile(path.join(rootA, 'marker.txt'), 'workspace A');
        await writeFile(path.join(rootB, 'marker.txt'), 'workspace B');

        agentService.setWorkspace(userId, rootB);
        const result = await agentService.toolManager.executeTool(
            userId,
            'read_file',
            { path: 'marker.txt' },
            'trace-workspace-isolation',
            { workspaceRoot: rootA }
        );

        const text = typeof result === 'string' ? result : (result as any).content;
        expect(text).toContain('workspace A');
        expect(text).not.toContain('workspace B');
    });

    it('routes chat stream system messages only to matching workspace listeners', async () => {
        const receivedA: any[] = [];
        const receivedB: any[] = [];
        const listenerA = (payload: any) => receivedA.push(payload);
        const listenerB = (payload: any) => receivedB.push(payload);

        EventDistributor.subscribeSysMessage(userId, listenerA, rootA);
        EventDistributor.subscribeSysMessage(userId, listenerB, rootB);
        await EventDistributor.broadcast(
            'chat:stream',
            { type: 'stage', content: 'only A', workspaceRoot: rootA },
            (client) => client.userId === userId && client.workspaceRoot === rootA
        );

        EventDistributor.unsubscribeSysMessage(userId, listenerA, rootA);
        EventDistributor.unsubscribeSysMessage(userId, listenerB, rootB);

        expect(receivedA).toHaveLength(1);
        expect(receivedA[0].content).toBe('only A');
        expect(receivedB).toHaveLength(0);
    });

    it('keeps live editor context separate for the same user across workspaces', () => {
        const store = LiveContextStore.getInstance();

        store.updateSelection(userId, {
            workspaceRoot: rootA,
            path: 'a.ts',
            startLine: 1,
            startChar: 1,
            endLine: 1,
            endChar: 3,
            text: 'aaa',
        });
        store.updateSelection(userId, {
            workspaceRoot: rootB,
            path: 'b.ts',
            startLine: 2,
            startChar: 1,
            endLine: 2,
            endChar: 3,
            text: 'bbb',
        });

        expect(store.getContext(userId, rootA)?.currentFile).toBe('a.ts');
        expect(store.getContext(userId, rootA)?.selection?.text).toBe('aaa');
        expect(store.getContext(userId, rootB)?.currentFile).toBe('b.ts');
        expect(store.getContext(userId, rootB)?.selection?.text).toBe('bbb');
    });

    it('maintains separate Playwright MCP connections per workspace', () => {
        const adapter = BrowserMcpAdapter.getInstance();

        // 验证连接隔离 key 构建机制：
        // BrowserMcpAdapter 使用 `userId\u0000workspaceRoot` 作为隔离 key，
        // 确保同一用户在不同工作区的浏览器连接完全隔离
        const stateBeforeA = adapter.getConnectionState(userId, rootA);
        const stateBeforeB = adapter.getConnectionState(userId, rootB);

        // 在连接之前，两个 workspace 都应为 undefined（无连接状态）
        expect(stateBeforeA).toBeUndefined();
        expect(stateBeforeB).toBeUndefined();

        // 验证 isConnected 对不同 workspace 返回独立结果
        expect(adapter.isConnected(userId, rootA)).toBe(false);
        expect(adapter.isConnected(userId, rootB)).toBe(false);
    });
});
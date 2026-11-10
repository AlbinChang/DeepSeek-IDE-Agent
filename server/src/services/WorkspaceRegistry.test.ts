import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { WorkspaceRegistry } from '@/services/WorkspaceRegistry.js';

describe('WorkspaceRegistry', () => {
    let rootA: string;
    let rootB: string;
    const userId = `workspace-registry-${Date.now()}`;
    const registry = WorkspaceRegistry.getInstance();

    beforeEach(async () => {
        registry.clearForTests();
        rootA = await mkdtemp(path.join(tmpdir(), 'workflow-registry-a-'));
        rootB = await mkdtemp(path.join(tmpdir(), 'workflow-registry-b-'));
    });

    afterEach(async () => {
        registry.clearForTests();
        await Promise.all([
            rm(rootA, { recursive: true, force: true }),
            rm(rootB, { recursive: true, force: true }),
        ]);
    });

    it('stores and returns the workspace root', () => {
        expect(registry.get(userId)).toBeUndefined();
        registry.set(userId, rootA);
        expect(registry.get(userId)).toBe(rootA);
    });

    it('notifies listeners when switching to a different root', async () => {
        const listener = vi.fn();
        registry.onWorkspaceChange(listener);
        registry.set(userId, rootA);

        await registry.switchWorkspace(userId, rootB);

        expect(listener).toHaveBeenCalledWith({
            userId,
            previousRoot: rootA,
            reason: 'switch',
        });
        expect(registry.get(userId)).toBe(rootB);
    });

    it('does not notify when switching to the same root', async () => {
        const listener = vi.fn();
        registry.onWorkspaceChange(listener);
        registry.set(userId, rootA);

        await registry.switchWorkspace(userId, rootA);

        expect(listener).not.toHaveBeenCalled();
    });

    it('notifies and removes the root on reset', async () => {
        const listener = vi.fn();
        registry.onWorkspaceChange(listener);
        registry.set(userId, rootA);

        const previousRoot = await registry.reset(userId);

        expect(previousRoot).toBe(rootA);
        expect(registry.get(userId)).toBeUndefined();
        expect(listener).toHaveBeenCalledWith({
            userId,
            previousRoot: rootA,
            reason: 'reset',
        });
    });

    it('keeps resetting even if a listener throws', async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        registry.onWorkspaceChange(() => {
            throw new Error('listener failure');
        });
        registry.set(userId, rootA);

        await expect(registry.reset(userId)).resolves.toBe(rootA);
        expect(registry.get(userId)).toBeUndefined();
        expect(warn).toHaveBeenCalled();
        warn.mockRestore();
    });
});

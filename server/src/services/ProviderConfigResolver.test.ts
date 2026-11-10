import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ProviderConfigResolver } from '@/services/ProviderConfigResolver.js';

const writeSettings = async (settingsPath: string, settings: any) => {
    await mkdir(path.dirname(settingsPath), { recursive: true });
    await writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
};

describe('ProviderConfigResolver', () => {
    let projectRoot: string;
    let workspaceRoot: string;
    const userId = 'provider-user';

    beforeEach(async () => {
        projectRoot = await mkdtemp(path.join(tmpdir(), 'provider-project-'));
        workspaceRoot = await mkdtemp(path.join(tmpdir(), 'provider-workspace-'));
    });

    afterEach(async () => {
        await Promise.all([
            rm(projectRoot, { recursive: true, force: true }),
            rm(workspaceRoot, { recursive: true, force: true }),
        ]);
    });

    it('prefers workspace settings over global settings', async () => {
        await writeSettings(path.join(projectRoot, '.electron-store', 'settings.json'), {
            [`user:${userId}`]: {
                providers: [{ id: 'global', name: 'Global', modelId: 'global-model', apiKey: 'global-key' }],
                activeProvider: 'global',
                activeModel: 'global-model',
            },
        });
        await writeSettings(path.join(workspaceRoot, '.llm', 'users', userId, 'settings.json'), {
            providers: [{ id: 'workspace', name: 'Workspace', modelId: 'workspace-model', apiKey: 'workspace-key' }],
            activeProvider: 'workspace',
            activeModel: 'workspace-model',
        });

        const resolved = ProviderConfigResolver.resolveForUser(
            userId,
            workspaceRoot,
            undefined,
            undefined,
            { projectRoot },
        );

        expect(resolved.provider).toBe('workspace');
        expect(resolved.modelId).toBe('workspace-model');
        expect(resolved.providerConfig.apiKey).toBe('workspace-key');
    });

    it('reads the electron-store user wrapper when no workspace settings exist', async () => {
        await writeSettings(path.join(projectRoot, '.electron-store', 'settings.json'), {
            [`user:${userId}`]: {
                providers: [{ id: 'stored', name: 'Stored', modelId: 'stored-model', apiKey: 'stored-key' }],
                activeProvider: 'stored',
                activeModel: 'stored-model',
            },
        });

        const resolved = ProviderConfigResolver.resolveForUser(
            userId,
            workspaceRoot,
            undefined,
            undefined,
            { projectRoot },
        );

        expect(resolved.provider).toBe('stored');
        expect(resolved.providerConfig.apiKey).toBe('stored-key');
    });

    it('honors requested provider and model', async () => {
        await writeSettings(path.join(projectRoot, '.electron-store', 'settings.json'), {
            [`user:${userId}`]: {
                providers: [
                    { id: 'first', name: 'First', modelId: 'first-model', apiKey: 'key-1' },
                    { id: 'second', name: 'Second', modelId: 'second-model', apiKey: 'key-2' },
                ],
                activeProvider: 'first',
                activeModel: 'first-model',
            },
        });

        const resolved = ProviderConfigResolver.resolveForUser(
            userId,
            undefined,
            'second',
            'override-model',
            { projectRoot },
        );

        expect(resolved.provider).toBe('second');
        expect(resolved.modelId).toBe('override-model');
        expect(resolved.providerConfig.modelId).toBe('override-model');
    });

    it('reports the settings path that was actually loaded', async () => {
        const settingsPath = path.join(projectRoot, '.electron-store', 'settings.json');
        await writeSettings(settingsPath, {
            [`user:${userId}`]: {
                providers: [{ id: 'stored', name: 'Stored', modelId: 'stored-model', apiKey: 'key' }],
                activeProvider: 'stored',
                activeModel: 'stored-model',
            },
        });
        const onLoaded = vi.fn();

        ProviderConfigResolver.resolveForUser(userId, undefined, undefined, undefined, {
            projectRoot,
            onLoaded,
        });

        expect(onLoaded).toHaveBeenCalledWith(settingsPath);
    });
});

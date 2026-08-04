import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { FileIO } from '@/utils/FileIO.js';

describe('FileIO.createPath', () => {
    const tempDirs: string[] = [];

    const createWorkspace = async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-ide-agent-fileio-create-'));
        tempDirs.push(dir);
        return dir;
    };

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    });

    it('creates an empty text file at the target path', async () => {
        const workspaceRoot = await createWorkspace();

        const fullPath = await FileIO.createPath('notes.txt', workspaceRoot, false);

        expect(fullPath).toBe(path.join(workspaceRoot, 'notes.txt').replace(/\\/g, '/'));
        const stat = await fs.stat(fullPath);
        expect(stat.isFile()).toBe(true);
        expect(await fs.readFile(fullPath, 'utf8')).toBe('');
    });

    it('creates nested files by auto-creating missing parent directories', async () => {
        const workspaceRoot = await createWorkspace();

        const fullPath = await FileIO.createPath('src/components/Button.tsx', workspaceRoot, false);

        expect(fullPath).toBe(path.join(workspaceRoot, 'src', 'components', 'Button.tsx').replace(/\\/g, '/'));
        expect((await fs.stat(fullPath)).isFile()).toBe(true);
    });

    it('creates a directory', async () => {
        const workspaceRoot = await createWorkspace();

        const fullPath = await FileIO.createPath('assets/icons', workspaceRoot, true);

        expect(fullPath).toBe(path.join(workspaceRoot, 'assets', 'icons').replace(/\\/g, '/'));
        expect((await fs.stat(fullPath)).isDirectory()).toBe(true);
    });

    it('rejects creation when the target already exists (EEXIST)', async () => {
        const workspaceRoot = await createWorkspace();
        await fs.writeFile(path.join(workspaceRoot, 'existing.txt'), 'data', 'utf8');

        await expect(FileIO.createPath('existing.txt', workspaceRoot, false)).rejects.toMatchObject({ code: 'EEXIST' });
    });

    it('rejects creation when an existing directory occupies the target path (EEXIST)', async () => {
        const workspaceRoot = await createWorkspace();
        await fs.mkdir(path.join(workspaceRoot, 'existing-dir'), { recursive: true });

        await expect(FileIO.createPath('existing-dir', workspaceRoot, false)).rejects.toMatchObject({ code: 'EEXIST' });
    });

    it('rejects paths escaping the workspace boundary', async () => {
        const workspaceRoot = await createWorkspace();

        await expect(FileIO.createPath('../escape.txt', workspaceRoot, false)).rejects.toThrow(/SECURITY_VIOLATION|escapes workspace/i);
        await expect(FileIO.createPath('../../outside.txt', workspaceRoot, false)).rejects.toThrow(/SECURITY_VIOLATION|escapes workspace/i);
    });
});

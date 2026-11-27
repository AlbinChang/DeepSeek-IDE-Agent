import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';

import { FileIO } from '@/utils/FileIO.js';

describe('FileIO encoding inference', () => {
    it('decodes short and mixed GBK samples instead of falling back to UTF-8', () => {
        const samples = [
            '中文',
            '你好，世界',
            'hello 中文 world',
            'This is a long ASCII line with one Chinese word: 测试',
            '中文编码测试：既有 GBK 文档，也有 UTF-8 文档。',
        ];
        for (const text of samples) {
            const { content, encoding } = FileIO.decodeBuffer(iconv.encode(text, 'gbk'));
            expect(content, encoding).toBe(text);
            expect(encoding.toUpperCase()).toMatch(/GB/);
        }
    });

    it('keeps valid UTF-8 (with and without BOM) intact', () => {
        const text = '中文编码测试：既有 GBK 文档，也有 UTF-8 文档。';
        const plain = FileIO.decodeBuffer(Buffer.from(text, 'utf8'));
        expect(plain.content).toBe(text);
        expect(plain.encoding).toBe('utf-8');

        const bom = FileIO.decodeBuffer(Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(text, 'utf8')]));
        expect(bom.content).toBe(text);
        expect(bom.encoding).toBe('UTF-8-BOM');
    });

    it('honors a forced encoding override', () => {
        const result = FileIO.decodeBuffer(iconv.encode('中文', 'gbk'), 'gbk');
        expect(result.content).toBe('中文');
    });

    it('does not misclassify short Russian/Japanese/Korean samples as GB18030', () => {
        const samples: Array<[string, string]> = [
            ['Привет', 'koi8-r'],
            ['これは日本語のテストです。', 'shift_jis'],
            ['안녕하세요.', 'euc-kr'],
        ];
        for (const [text, encoding] of samples) {
            expect(FileIO.decodeBuffer(iconv.encode(text, encoding)).content).toBe(text);
        }
    });
});

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

describe('FileIO.listFiles ordering', () => {
    const tempDirs: string[] = [];

    const createWorkspace = async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-ide-agent-fileio-sort-'));
        tempDirs.push(dir);
        return dir;
    };

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    });

    it('returns directories first and Chinese chapter files in numeric order', async () => {
        const workspaceRoot = await createWorkspace();
        await fs.mkdir(path.join(workspaceRoot, 'docs10'));
        await fs.mkdir(path.join(workspaceRoot, 'docs2'));
        await fs.writeFile(path.join(workspaceRoot, '教程-第二章.md'), '', 'utf8');
        await fs.writeFile(path.join(workspaceRoot, '教程-第一章.md'), '', 'utf8');
        await fs.writeFile(path.join(workspaceRoot, '教程-第十章.md'), '', 'utf8');

        const entries = await FileIO.listFiles('.', workspaceRoot);

        expect(entries.map(({ name }) => name)).toEqual([
            'docs2',
            'docs10',
            '教程-第一章.md',
            '教程-第二章.md',
            '教程-第十章.md',
        ]);
    });
});

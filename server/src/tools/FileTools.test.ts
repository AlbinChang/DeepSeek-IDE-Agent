import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { config as globalConfig } from '@/config/index.js';
import { FileTools } from '@/tools/FileTools.js';

describe('FileTools.readFile', () => {
    const tempDirs: string[] = [];

    const createWorkspace = async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-ide-agent-read-file-'));
        tempDirs.push(dir);
        return dir;
    };

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    });

    it('uses the configured default max line count when no lineCount is provided', async () => {
        const workspaceRoot = await createWorkspace();
        const filePath = path.join(workspaceRoot, 'large.txt');
        const totalLines = globalConfig.readFile.maxLines + 25;
        const content = Array.from({ length: totalLines }, (_, index) => `line-${index + 1}`).join('\n');
        await fs.writeFile(filePath, content, 'utf8');

        const result = await FileTools.readFile(workspaceRoot, 'large.txt', 1);

        expect(result.startLine).toBe(1);
        expect(result.endLine).toBe(globalConfig.readFile.maxLines);
        expect(result.totalLines).toBe(totalLines);
        expect(result.hasMore).toBe(true);
    });

    it('rejects oversized whole-file reads above the configured 200KB limit', async () => {
        const workspaceRoot = await createWorkspace();
        const filePath = path.join(workspaceRoot, 'oversized.txt');
        const oversizedContent = 'a'.repeat(globalConfig.readFile.maxFileSizeBytes + 128);
        await fs.writeFile(filePath, oversizedContent, 'utf8');

        const result = await FileTools.readFile(workspaceRoot, 'oversized.txt', 1);

        expect(result.status).toBe('error');
        expect(result.error).toBe('FILE_TOO_LARGE');
    });

    it('allows segmented reads even when the file exceeds the whole-file size guard', async () => {
        const workspaceRoot = await createWorkspace();
        const filePath = path.join(workspaceRoot, 'segmented.txt');
        const oversizedContent = Array.from({ length: 4000 }, (_, index) => `line-${index + 1}-${'x'.repeat(60)}`).join('\n');
        await fs.writeFile(filePath, oversizedContent, 'utf8');

        const result = await FileTools.readFile(workspaceRoot, 'segmented.txt', 200, 20);

        expect(result.status).toBeUndefined();
        expect(result.startLine).toBe(200);
        expect(result.endLine).toBe(219);
        expect(result.content).toContain('200: line-200-');
    });

    it('exposes workspace skill directories in the system prompt directory tree', async () => {
        const workspaceRoot = await createWorkspace();
        const skillPaths = [
            '.claude/skills/api-conventions/SKILL.md',
            '.github/skills/react-best-practices/SKILL.md',
            '.agents/skills/team-workflow/SKILL.md',
            '.skills/legacy-workflow/SKILL.md',
        ];

        for (const skillPath of skillPaths) {
            const absoluteSkillPath = path.join(workspaceRoot, ...skillPath.split('/'));
            await fs.mkdir(path.dirname(absoluteSkillPath), { recursive: true });
            await fs.writeFile(absoluteSkillPath, '---\nname: test\ndescription: test\n---\n', 'utf8');
        }

        const tree = await FileTools.getDirectoryTree(workspaceRoot, 1);

        expect(tree).toContain('📁 .claude/');
        expect(tree).toContain('📁 .github/');
        expect(tree).toContain('📁 .agents/');
        expect(tree).toContain('📁 .skills/');
        expect(tree).toContain('📁 api-conventions/');
        expect(tree).toContain('📁 react-best-practices/');
        expect(tree).toContain('📁 team-workflow/');
        expect(tree).toContain('📁 legacy-workflow/');
        expect(tree).toContain('📄 SKILL.md');
    });
});
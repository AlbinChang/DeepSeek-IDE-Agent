import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import iconv from 'iconv-lite';

import { config as globalConfig } from '@/config/index.js';
import { FileTools, buildNearestMatchHint } from '@/tools/FileTools.js';
import { hasLoneSurrogate } from '@/utils/UnicodeUtils.js';

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

    it('auto-detects short/mixed GBK files and honors an explicit encoding override', async () => {
        const workspaceRoot = await createWorkspace();
        const text = '中文编码测试：GBK 短文档';
        await fs.writeFile(path.join(workspaceRoot, 'short-gbk.md'), iconv.encode(text, 'gbk'));

        const auto = await FileTools.readFile(workspaceRoot, 'short-gbk.md');
        expect(auto.content).toContain(text);
        expect(String(auto.encoding).toUpperCase()).toMatch(/GB/);

        const forced = await FileTools.readFile(workspaceRoot, 'short-gbk.md', 1, undefined, true, 'gbk');
        expect(forced.content).toContain(text);
        expect(forced.encoding).toBe('gbk');
    });

    it('clamps an oversized explicit lineCount to the 1000-line hard cap', async () => {
        const workspaceRoot = await createWorkspace();
        const filePath = path.join(workspaceRoot, 'huge.txt');
        const totalLines = 1200;
        const content = Array.from({ length: totalLines }, (_, index) => `line-${index + 1}`).join('\n');
        await fs.writeFile(filePath, content, 'utf8');

        const result = await FileTools.readFile(workspaceRoot, 'huge.txt', 1, 5000);

        expect(globalConfig.readFile.maxLines).toBe(1000);
        expect(result.startLine).toBe(1);
        expect(result.endLine).toBe(1000);
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

    it('collapses an identical repeated read into a digest unless force is set', async () => {
        const workspaceRoot = await createWorkspace();
        await fs.writeFile(path.join(workspaceRoot, 'repeat.txt'), 'alpha\nbeta\ngamma', 'utf8');

        const first = await FileTools.readFile(workspaceRoot, 'repeat.txt', 1, 3);
        expect(first.content).toContain('1: alpha');
        expect(first.deduplicated).toBeUndefined();

        const second = await FileTools.readFile(workspaceRoot, 'repeat.txt', 1, 3);
        expect(second.deduplicated).toBe(true);
        expect(second.content).not.toContain('1: alpha');
        expect(second.content).toContain('force:true');
        expect(second.totalLines).toBe(3);

        const forced = await FileTools.readFile(workspaceRoot, 'repeat.txt', 1, 3, true);
        expect(forced.deduplicated).toBeUndefined();
        expect(forced.content).toContain('1: alpha');
    });

    it('returns fresh content when a repeat read sees changed text', async () => {
        const workspaceRoot = await createWorkspace();
        const filePath = path.join(workspaceRoot, 'changing.txt');
        await fs.writeFile(filePath, 'one\ntwo', 'utf8');
        await FileTools.readFile(workspaceRoot, 'changing.txt', 1, 2);

        await fs.writeFile(filePath, 'one\nchanged', 'utf8');
        const result = await FileTools.readFile(workspaceRoot, 'changing.txt', 1, 2);

        expect(result.deduplicated).toBeUndefined();
        expect(result.content).toContain('2: changed');
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

describe('FileTools.editFileByReplace & EOL Normalization', () => {
    const tempDirs: string[] = [];

    const createWorkspace = async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-ide-agent-edit-file-'));
        tempDirs.push(dir);
        return dir;
    };

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    });

    it('matches CRLF file content when LLM provides LF oldText, preserving CRLF EOL style', async () => {
        const workspaceRoot = await createWorkspace();
        const filePath = path.join(workspaceRoot, 'crlf_sample.js');
        // CRLF file content
        const crlfContent = 'function hello() {\r\n    console.log("hello");\r\n    return true;\r\n}';
        await fs.writeFile(filePath, crlfContent, 'utf8');

        // LLM inputs oldText using LF \n
        const lfOldText = 'function hello() {\n    console.log("hello");\n    return true;\n}';
        const lfNewText = 'function helloWorld() {\n    console.log("hello world");\n    return false;\n}';

        const result = await FileTools.editFileByReplace(
            workspaceRoot,
            'crlf_sample.js',
            lfOldText,
            lfNewText
        );

        expect(result.status).toBe('success');

        const fileAfter = await fs.readFile(filePath, 'utf8');
        // File content should be updated with new text formatted in CRLF
        expect(fileAfter).toBe('function helloWorld() {\r\n    console.log("hello world");\r\n    return false;\r\n}');
    });

    it('matches LF file content when LLM provides CRLF oldText, preserving LF EOL style', async () => {
        const workspaceRoot = await createWorkspace();
        const filePath = path.join(workspaceRoot, 'lf_sample.js');
        // LF file content
        const lfContent = 'const a = 1;\nconst b = 2;\nconst c = 3;';
        await fs.writeFile(filePath, lfContent, 'utf8');

        // LLM inputs oldText using CRLF \r\n
        const crlfOldText = 'const b = 2;\r\nconst c = 3;';
        const crlfNewText = 'const b = 200;\r\nconst c = 300;';

        const result = await FileTools.editFileByReplace(
            workspaceRoot,
            'lf_sample.js',
            crlfOldText,
            crlfNewText
        );

        expect(result.status).toBe('success');

        const fileAfter = await fs.readFile(filePath, 'utf8');
        expect(fileAfter).toBe('const a = 1;\nconst b = 200;\nconst c = 300;');
    });

    it('returns a bounded preview instead of echoing the whole replacement', async () => {
        const workspaceRoot = await createWorkspace();
        const filePath = path.join(workspaceRoot, 'large_edit.txt');
        const originalLines = Array.from({ length: 120 }, (_, index) => `line-${index + 1}`);
        await fs.writeFile(filePath, originalLines.join('\n'), 'utf8');

        const oldText = originalLines.slice(19, 80).join('\n');
        const newText = Array.from({ length: 60 }, (_, index) => `replacement-${index + 1}-${'x'.repeat(40)}`).join('\n');

        const result = await FileTools.editFileByReplace(
            workspaceRoot,
            'large_edit.txt',
            oldText,
            newText
        ) as any;

        expect(result.status).toBe('success');
        expect(result.contextSnapshot).toBeUndefined();
        expect(result.changedRange).toBe('20-79');
        expect(result.preview.length).toBeLessThanOrEqual(520);
        expect(result.preview.split('\n').length).toBeLessThan(10);

        const fileAfter = await fs.readFile(filePath, 'utf8');
        expect(fileAfter).toContain('replacement-60-');
    });

    it('replaceAllInFile handles CRLF/LF normalization across all occurrences', async () => {
        const workspaceRoot = await createWorkspace();
        const filePath = path.join(workspaceRoot, 'global_sample.txt');
        const crlfContent = 'item 1:\r\n  status: active\r\n\r\nitem 2:\r\n  status: active';
        await fs.writeFile(filePath, crlfContent, 'utf8');

        const lfOldText = 'status: active';
        const lfNewText = 'status: disabled';

        const result = await FileTools.replaceAllInFile(
            workspaceRoot,
            'global_sample.txt',
            lfOldText,
            lfNewText
        );

        expect(result.status).toBe('success');
        expect(result.occurrences).toBe(2);

        const fileAfter = await fs.readFile(filePath, 'utf8');
        expect(fileAfter).toBe('item 1:\r\n  status: disabled\r\n\r\nitem 2:\r\n  status: disabled');
    });
});

describe('FileTools 孤立代理码元修复', () => {
    const tempDirs: string[] = [];

    const createWorkspace = async () => {
        const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-ide-agent-unicode-'));
        tempDirs.push(dir);
        return dir;
    };

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    });

    it('insert_in_file 落盘内容与 preview 均不含孤立代理码元', async () => {
        const workspaceRoot = await createWorkspace();
        const filePath = path.join(workspaceRoot, 'Demo.java');
        await fs.writeFile(filePath, 'class Demo {\n}\n', 'utf8');
        const loneHigh = '\uD83D';

        const result = await FileTools.editFileByInsert(
            workspaceRoot,
            'Demo.java',
            2,
            `    // broken ${loneHigh}\n    void t() {}`,
        ) as any;

        expect(result.status).toBe('success');
        expect(hasLoneSurrogate(result.preview)).toBe(false);
        expect(result.preview).toContain('\uFFFD');

        const fileAfter = await fs.readFile(filePath, 'utf8');
        expect(hasLoneSurrogate(fileAfter)).toBe(false);
        expect(fileAfter).toContain('\uFFFD');
    });

    it('write_file 在落盘前修复孤立代理码元', async () => {
        const workspaceRoot = await createWorkspace();

        const result = await FileTools.writeFile(workspaceRoot, 'unicode.txt', `a\uDE00b`);

        expect(result.status).toBe('success');
        const fileAfter = await fs.readFile(path.join(workspaceRoot, 'unicode.txt'), 'utf8');
        expect(fileAfter).toBe('a\uFFFDb');
    });
});

describe('replace_in_file nearest-match hint', () => {
    it('points at the closest line when oldText is not found', () => {
        const content = [
            'def collect_universe(run_dir):',
            '    rows = fetch_quote()',
            '    return rows',
        ].join('\n');
        const hint = buildNearestMatchHint(content, '    rows = fetch_quote(pages=3)\n    return rows');
        expect(hint).toContain('最相近的行');
        expect(hint).toContain('2: rows = fetch_quote()');
    });

    it('falls back to the read_file guidance when nothing matches', () => {
        const hint = buildNearestMatchHint('alpha\nbeta', 'zzzz_unknown_token_value');
        expect(hint).toContain('read_file');
    });
});
import { describe, expect, it } from 'vitest';
import {
    buildExtractionScript,
    buildSaveWebpageToolDefinition,
    parseEvaluateResult,
    sanitizeFileName,
    WebPageSaver,
} from '@/services/WebPageSaver.js';

describe('WebPageSaver.parseEvaluateResult', () => {
    it('parses object results from Playwright MCP evaluate output', () => {
        const text = [
            '### Result',
            '{',
            '  "ok": true,',
            '  "length": 12345,',
            '  "title": "测试文章",',
            '  "imageCount": 5',
            '}',
            '### Ran Playwright code',
            '```js',
            "await page.evaluate('...');",
            '```',
        ].join('\n');
        expect(parseEvaluateResult(text)).toEqual({ ok: true, length: 12345, title: '测试文章', imageCount: 5 });
    });

    it('parses string chunk results (JSON-quoted, single line)', () => {
        const chunk = '{"html":"<p>段落 with \\"quotes\\" &amp; symbols</p>"';
        const text = `### Result\n${JSON.stringify(chunk)}\n### Ran Playwright code\n...`;
        expect(parseEvaluateResult(text)).toBe(chunk);
    });

    it('handles empty and null results', () => {
        expect(parseEvaluateResult('### Result\nundefined\n### Ran Playwright code')).toBeNull();
        expect(parseEvaluateResult('### Result\nnull\n### Ran Playwright code')).toBeNull();
    });

    it('throws when no Result section exists', () => {
        expect(() => parseEvaluateResult('### Error\nsomething broke')).toThrow();
    });
});

describe('WebPageSaver.sanitizeFileName', () => {
    it('strips Windows-illegal characters', () => {
        expect(sanitizeFileName('大模型应用监控不内卷！Java Agent带你躺平实现无侵入监控_代码无侵入监控java-CSDN博客'))
            .not.toMatch(/[\\/:*?"<>|]/);
        expect(sanitizeFileName('a/b\\c:d*e?f"g<h>i|j')).toBe('a b c d e f g h i j');
    });

    it('falls back for empty input and trims trailing dots', () => {
        expect(sanitizeFileName('')).toBe('webpage');
        expect(sanitizeFileName('   ')).toBe('webpage');
        expect(sanitizeFileName('name...')).toBe('name');
    });

    it('limits length to 80 chars', () => {
        expect(sanitizeFileName('x'.repeat(300)).length).toBeLessThanOrEqual(80);
    });
});

describe('WebPageSaver.buildExtractionScript', () => {
    it('produces syntactically valid JavaScript', () => {
        const script = buildExtractionScript();
        // 页内脚本必须是合法的箭头函数表达式（语法错误会导致 browser_evaluate 直接失败）
        expect(() => new Function(`return (${script});`)).not.toThrow();
    });

    it('injects user selector safely as a JSON string literal', () => {
        const script = buildExtractionScript(`#content"; alert('xss'); var x="`);
        expect(() => new Function(`return (${script});`)).not.toThrow();
        expect(script).toContain(JSON.stringify(`#content"; alert('xss'); var x="`));
    });

    it('contains no template literals or interpolation that could break String.raw embedding', () => {
        const script = buildExtractionScript('#main');
        expect(script).not.toContain('`');
        expect(script).not.toContain('${');
    });
});

describe('save_webpage tool contract', () => {
    it('declares outputDir as a required parameter (保存路径由 Agent 显式指定)', () => {
        const def = buildSaveWebpageToolDefinition({} as any, 'u1', 'D:\\ws');
        expect(def.name).toBe('save_webpage');
        expect(def.parameters.required).toContain('outputDir');
        expect(def.parameters.properties.outputDir.description).toContain('必填');
    });
});

describe('WebPageSaver.save parameter validation (fail-fast, 不触碰浏览器)', () => {
    const stubAdapter = {
        callNativeTool: async () => {
            throw new Error('adapter should not be called during param validation');
        },
    } as any;

    it('rejects missing outputDir with a params error', async () => {
        const res = await WebPageSaver.save(stubAdapter, 'u1', process.cwd(), {} as any);
        expect(res.status).toBe('error');
        expect(res.step).toBe('params');
        expect(String(res.message)).toContain('outputDir');
    });

    it('rejects blank outputDir', async () => {
        const res = await WebPageSaver.save(stubAdapter, 'u1', process.cwd(), { outputDir: '   ' } as any);
        expect(res.status).toBe('error');
        expect(res.step).toBe('params');
    });

    it('rejects path traversal outside the workspace', async () => {
        const res = await WebPageSaver.save(stubAdapter, 'u1', process.cwd(), { outputDir: '../outside' } as any);
        expect(res.status).toBe('error');
        expect(res.step).toBe('params');
        expect(String(res.message)).toContain('越界');
    });
});

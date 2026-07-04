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

describe('WebPageSaver.save 提取管线（模拟 Playwright MCP）', () => {
    /**
     * 构造模拟适配器：按 browser_evaluate 的 function 字符串路由到
     * 滚动/提取/分块/清理各阶段，复现真实 MCP 的响应形态。
     */
    function makeAdapter(options: {
        payload: Record<string, unknown>;
        /** 前 N 次提取调用返回"执行上下文被销毁"错误（复现 CSDN 跳转中断） */
        failExtractTimes?: number;
    }) {
        const payloadStr = JSON.stringify(options.payload);
        let extractFailuresLeft = options.failExtractTimes ?? 0;
        const calls: string[] = [];
        const adapter = {
            calls,
            callNativeTool: async (_u: string, _w: string, tool: string, args: Record<string, unknown>) => {
                calls.push(tool);
                if (tool === 'browser_navigate') {
                    return { text: '### Page\n- Page URL: mock', isError: false };
                }
                if (tool !== 'browser_evaluate') throw new Error(`unexpected tool ${tool}`);
                const fn = String(args.function || '');
                if (fn.includes('scrollTo')) {
                    return { text: '### Result\ntrue', isError: false };
                }
                if (fn.includes('delete window.__WEB_IDE_SAVE_PAGE__')) {
                    return { text: '### Result\ntrue', isError: false };
                }
                const sliceMatch = fn.match(/^\(\) => \(window\.__WEB_IDE_SAVE_PAGE__ \|\| ''\)\.slice\((\d+), (\d+)\)$/);
                if (sliceMatch) {
                    const chunk = payloadStr.slice(Number(sliceMatch[1]), Number(sliceMatch[2]));
                    return { text: `### Result\n${JSON.stringify(chunk)}`, isError: false };
                }
                // 提取脚本
                if (extractFailuresLeft > 0) {
                    extractFailuresLeft--;
                    return {
                        text: '### Error\nExecution context was destroyed, most likely because of a navigation.',
                        isError: true,
                    };
                }
                const meta = { ok: true, length: payloadStr.length, title: options.payload.title, imageCount: 0 };
                return { text: `### Result\n${JSON.stringify(meta)}`, isError: false };
            },
        };
        return adapter as any;
    }

    async function makeTmpWorkspace(): Promise<string> {
        const os = await import('node:os');
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        return await fs.mkdtemp(path.join(os.tmpdir(), 'webpagesaver-test-'));
    }

    it('页面跳转销毁执行上下文时自动重试并成功', async () => {
        const ws = await makeTmpWorkspace();
        const adapter = makeAdapter({
            payload: {
                ok: true, title: '重试文章', url: 'https://example.com/a',
                html: '<p>正文</p>', markdown: '正文', images: [], restriction: '',
            },
            failExtractTimes: 1,
        });
        const res = await WebPageSaver.save(adapter, 'u1', ws, {
            url: 'https://example.com/a', outputDir: 'articles', includeImages: false,
        });
        expect(res.status).toBe('success');
        expect(String(res.warnings)).toContain('已自动重试');
    }, 15_000);

    it('检测到付费墙时仍保存内容，但返回 accessRestricted 并在 .md 头部写入提醒', async () => {
        const ws = await makeTmpWorkspace();
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const adapter = makeAdapter({
            payload: {
                ok: true, title: '受限文章', url: 'https://example.com/paywalled',
                html: '<p>可见部分</p>', markdown: '可见部分', images: [],
                restriction: '正文区域出现 "解锁文章"',
            },
        });
        const res = await WebPageSaver.save(adapter, 'u1', ws, {
            url: 'https://example.com/paywalled', outputDir: 'articles', includeImages: false,
        }) as Record<string, any>;
        expect(res.status).toBe('success');
        expect(res.accessRestricted).toBe(true);
        expect(String(res.restrictionNotice)).toContain('登录');
        const mdContent = await fs.readFile(path.join(ws, res.files.markdown), 'utf-8');
        expect(mdContent).toContain('付费墙/登录限制');
        expect(mdContent).toContain('可见部分');
    });

    it('无访问限制时不携带 accessRestricted 字段', async () => {
        const ws = await makeTmpWorkspace();
        const adapter = makeAdapter({
            payload: {
                ok: true, title: '正常文章', url: 'https://example.com/free',
                html: '<p>全文</p>', markdown: '全文', images: [], restriction: '',
            },
        });
        const res = await WebPageSaver.save(adapter, 'u1', ws, {
            url: 'https://example.com/free', outputDir: 'articles', includeImages: false,
        }) as Record<string, any>;
        expect(res.status).toBe('success');
        expect(res.accessRestricted).toBeUndefined();
    });
});

describe('WebPageSaver 提取脚本行为（jsdom-free 静态断言）', () => {
    it('包含付费墙检测标记与代码语言归一化逻辑', () => {
        const script = buildExtractionScript();
        expect(script).toContain('restriction');
        expect(script).toContain('normalizeLang');
        expect(script).toContain('hide-article-box');
    });

    it('提取脚本仍是合法 JavaScript（新增逻辑未破坏语法）', () => {
        const script = buildExtractionScript('#main');
        expect(() => new Function(`return (${script});`)).not.toThrow();
        expect(script).not.toContain('`');
        expect(script).not.toContain('${');
    });
});

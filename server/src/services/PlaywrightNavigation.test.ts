import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
    buildSvgViewerHtml,
    isBrowserSessionUnhealthy,
    isSvgDocumentUrl,
    parseSvgIntrinsicSize,
    prepareNavigation,
    svgViewerFileName,
} from '@/services/PlaywrightNavigation.js';

/**
 * 回归用例：`browser_navigate` 打开 SVG 文档会让 @playwright/mcp 卡死 30s。
 *
 * 实测矩阵（同一份 SVG 字节）：
 * - `image/svg+xml`（有无 .svg 后缀都一样）→ 30s 超时，且浏览器后端僵死；
 * - `text/html` 或 HTML 内嵌 `<img src="*.svg">` → 1~2s 正常。
 *
 * 因此导航前把 SVG 目标改写成自动生成的 HTML 包装页。
 */

describe('isSvgDocumentUrl', () => {
    it('识别 file:// 与 http(s) 的 .svg 目标', () => {
        expect(isSvgDocumentUrl('file:///D:/ws/docs/供应链焦点-长鑫科技.svg')).toBe(true);
        expect(isSvgDocumentUrl('file:///D:/ws/a.svg')).toBe(true);
        expect(isSvgDocumentUrl('https://x.test/a.svg')).toBe(true);
        expect(isSvgDocumentUrl('https://x.test/a.SVG')).toBe(true);
        expect(isSvgDocumentUrl('https://x.test/a.svg?v=1')).toBe(true);
        expect(isSvgDocumentUrl('https://x.test/a.svg#page=1')).toBe(true);
    });

    it('不误伤其他目标', () => {
        expect(isSvgDocumentUrl('about:blank')).toBe(false);
        expect(isSvgDocumentUrl('https://x.test/a.html')).toBe(false);
        expect(isSvgDocumentUrl('https://x.test/a.svg.html')).toBe(false);
        expect(isSvgDocumentUrl('data:image/svg+xml,<svg/>')).toBe(false);
        expect(isSvgDocumentUrl('blob:http://x/123')).toBe(false);
        expect(isSvgDocumentUrl('')).toBe(false);
        expect(isSvgDocumentUrl('not-a-url.svg')).toBe(false);
    });
});

describe('parseSvgIntrinsicSize', () => {
    it('优先读 width/height 属性（含 px 与小数）', () => {
        expect(parseSvgIntrinsicSize('<svg width="1080" height="1360"></svg>')).toEqual({ width: 1080, height: 1360 });
        expect(parseSvgIntrinsicSize('<svg width="1200px" height="630.4px"/>')).toEqual({ width: 1200, height: 630 });
    });

    it('没有 width/height 时回退 viewBox', () => {
        expect(parseSvgIntrinsicSize('<svg viewBox="0 0 1920 1080"></svg>')).toEqual({ width: 1920, height: 1080 });
        expect(parseSvgIntrinsicSize('<svg viewBox="0,0,800,600"></svg>')).toEqual({ width: 800, height: 600 });
    });

    it('无法判定时返回 null', () => {
        expect(parseSvgIntrinsicSize('<svg></svg>')).toBeNull();
        expect(parseSvgIntrinsicSize('<svg width="100%"></svg>')).toBeNull();
        expect(parseSvgIntrinsicSize('')).toBeNull();
    });
});

describe('buildSvgViewerHtml', () => {
    it('生成内嵌 img 的包装页，并按固有尺寸渲染', () => {
        const html = buildSvgViewerHtml('file:///D:/a.svg', { width: 1080, height: 1360 });
        expect(html).toContain('<img src="file:///D:/a.svg" width="1080" height="1360"');
        expect(html.startsWith('<!doctype html>')).toBe(true);
    });

    it('URL 与标题做 HTML 转义', () => {
        const html = buildSvgViewerHtml('file:///D:/a&b.svg', null, { title: '<x>"q"' });
        expect(html).toContain('file:///D:/a&amp;b.svg');
        expect(html).toContain('&lt;x&gt;&quot;q&quot;');
    });
});

describe('svgViewerFileName', () => {
    it('同一 URL 文件名稳定，不同 URL 不同', () => {
        const a = svgViewerFileName('file:///D:/a.svg');
        expect(a).toMatch(/^[0-9a-f]{16}\.html$/);
        expect(svgViewerFileName('file:///D:/a.svg')).toBe(a);
        expect(svgViewerFileName('file:///D:/b.svg')).not.toBe(a);
    });
});

describe('prepareNavigation', () => {
    let workspaceRoot: string;

    beforeEach(async () => {
        workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pw-nav-'));
    });

    afterEach(async () => {
        await fs.rm(workspaceRoot, { recursive: true, force: true });
    });

    it('SVG 目标改写成工作区内的 HTML 包装页', async () => {
        const svgPath = path.join(workspaceRoot, 'chart.svg');
        await fs.writeFile(svgPath, '<svg width="640" height="480"></svg>', 'utf8');
        const svgUrl = `file:///${svgPath.replace(/\\/g, '/')}`;

        const prepared = await prepareNavigation(svgUrl, { workspaceRoot });

        expect(prepared.rewrittenFrom).toBe(svgUrl);
        expect(prepared.url.startsWith('file:///')).toBe(true);
        expect(prepared.url).toContain('.temp/playwright-mcp/view/');

        const html = await fs.readFile(
            path.join(workspaceRoot, '.temp', 'playwright-mcp', 'view', svgViewerFileName(svgUrl)),
            'utf8',
        );
        expect(html).toContain('<img');
        expect(html).toContain('width="640" height="480"');
    });

    it('中文路径能被解析并读取尺寸', async () => {
        const dir = path.join(workspaceRoot, '供应链焦点');
        await fs.mkdir(dir, { recursive: true });
        const svgPath = path.join(dir, '供应链焦点-长鑫科技.svg');
        await fs.writeFile(svgPath, '<svg viewBox="0 0 1080 1360"></svg>', 'utf8');
        const svgUrl = `file:///${svgPath.replace(/\\/g, '/')}`;

        const prepared = await prepareNavigation(svgUrl, { workspaceRoot });
        const html = await fs.readFile(
            path.join(workspaceRoot, '.temp', 'playwright-mcp', 'view', svgViewerFileName(svgUrl)),
            'utf8',
        );
        expect(prepared.rewrittenFrom).toBe(svgUrl);
        expect(html).toContain('width="1080" height="1360"');
    });

    it('非 SVG 目标原样返回，且不写任何文件', async () => {
        const url = 'https://data.eastmoney.com/notices/detail/600874/x.html';
        const prepared = await prepareNavigation(url, { workspaceRoot });
        expect(prepared).toEqual({ url });
        await expect(fs.access(path.join(workspaceRoot, '.temp'))).rejects.toBeTruthy();
    });

    it('本地 SVG 不存在时仍然生成包装页（不抛错）', async () => {
        const svgUrl = 'file:///D:/definitely-missing/chart.svg';
        const prepared = await prepareNavigation(svgUrl, { workspaceRoot });
        expect(prepared.rewrittenFrom).toBe(svgUrl);
        const html = await fs.readFile(
            path.join(workspaceRoot, '.temp', 'playwright-mcp', 'view', svgViewerFileName(svgUrl)),
            'utf8',
        );
        expect(html).toContain('<img src="file:///D:/definitely-missing/chart.svg"');
    });
});

describe('isBrowserSessionUnhealthy', () => {
    it('识别真实日志里出现的后端僵死信号', () => {
        expect(isBrowserSessionUnhealthy('### Error\nTimeoutError: browserBackend.callTool: Timeout 30000ms exceeded.')).toBe(true);
        expect(isBrowserSessionUnhealthy('### Error\nError: browserBackend.callTool: Target page, context or browser has been closed')).toBe(true);
        expect(isBrowserSessionUnhealthy('Target closed')).toBe(true);
    });

    it('普通导航超时不算后端僵死（不能因此丢掉当前会话）', () => {
        expect(isBrowserSessionUnhealthy('### Error\nTimeoutError: page.goto: Timeout 120000ms exceeded.')).toBe(false);
        expect(isBrowserSessionUnhealthy('### Error\nTimeoutError: locator.click: Timeout 10000ms exceeded.')).toBe(false);
    });

    it('正常结果与业务错误不误判', () => {
        expect(isBrowserSessionUnhealthy('### Ran Playwright code\n```js\nawait page.goto(...)\n```')).toBe(false);
        expect(isBrowserSessionUnhealthy('### Error\nError: ENOENT: no such file or directory')).toBe(false);
        expect(isBrowserSessionUnhealthy('')).toBe(false);
    });
});

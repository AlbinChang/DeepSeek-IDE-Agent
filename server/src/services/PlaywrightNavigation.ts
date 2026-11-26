/**
 * Playwright MCP 导航改写：把 SVG 文档换成一个 HTML 包装页。
 *
 * 背景（实测结论，2026-11-26）：
 * `@playwright/mcp` 的 `browser_navigate` 一旦导航目标被浏览器当作 `image/svg+xml`
 * 渲染，就必然在内部 30s 超时（`TimeoutError: browserBackend.callTool: Timeout 30000ms exceeded`），
 * 并把整个浏览器后端拖进僵死状态——之后 `browser_close` / `browser_tabs` / `browser_resize`
 * 也全部 30s 失败。隔离实验（同一份 SVG 字节）证明命中条件只看 Content-Type：
 *
 * | 服务方式                              | 结果            |
 * |--------------------------------------|-----------------|
 * | `.svg` + `image/svg+xml`             | ❌ 30s 超时      |
 * | 无后缀 + `image/svg+xml`             | ❌ 30s 超时      |
 * | `.svg` 内容 + `text/html`            | ✅ 2.1s          |
 * | `.html` 内嵌 `<img src="*.svg">`      | ✅ 1.5s          |
 *
 * 而直接用 Playwright `page.goto()` 打开同一个 SVG 只需 37ms，说明这是 MCP 自身的缺陷
 * （快照/初始化流程在 SVG 文档上卡住），不是 Chrome 的问题，也无法通过 CLI 参数规避。
 *
 * 因此这里在交给 MCP 之前把 `.svg` 目标改写成自动生成的 HTML 包装页，
 * 用 `<img>` 内嵌原文件：截图、视口调整、快照全部恢复正常。
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';

/** 包装页存放目录（相对工作区根），复用 MCP 输出目录，避免污染仓库 */
const VIEW_DIR_SEGMENTS = ['.temp', 'playwright-mcp', 'view'];

export interface SvgViewerOptions {
    /** 页面标题 */
    title?: string;
    /** 视口底色（默认白色，便于截图判断留白） */
    background?: string;
}

export interface PreparedNavigation {
    /** 实际交给 MCP 的 URL */
    url: string;
    /** 被改写的原始 URL（未改写时为 undefined） */
    rewrittenFrom?: string;
    /** 改写说明，用于日志 */
    reason?: string;
}

/** 判断目标是否是会被浏览器当作文档渲染的 SVG */
export const isSvgDocumentUrl = (url: string): boolean => {
    if (typeof url !== 'string' || !url.trim()) return false;
    let raw = url.trim();
    // 排除 data:/blob: 等内联形式（它们不会触发该缺陷）
    if (/^(data|blob):/i.test(raw)) return false;
    // about:blank 之类的特殊页
    if (!/^[a-z][a-z0-9+.-]*:/i.test(raw)) return false;
    const withoutHash = raw.split('#')[0].split('?')[0];
    return /\.svg$/i.test(withoutHash);
};

/** 从 SVG 源码里读固有尺寸（width/height 属性优先，其次 viewBox） */
export const parseSvgIntrinsicSize = (source: string): { width: number; height: number } | null => {
    if (typeof source !== 'string' || !source) return null;
    const tagMatch = source.match(/<svg\b[^>]*>/i);
    const tag = tagMatch ? tagMatch[0] : source.slice(0, 2000);

    const readLength = (name: string): number | null => {
        const match = tag.match(new RegExp(`${name}\\s*=\\s*["']\\s*([0-9.]+)\\s*(px)?\\s*["']`, 'i'));
        if (!match) return null;
        const value = Number(match[1]);
        return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
    };

    const width = readLength('width');
    const height = readLength('height');
    if (width && height) return { width, height };

    const viewBox = tag.match(/viewBox\s*=\s*["']\s*([-0-9.eE]+)[\s,]+([-0-9.eE]+)[\s,]+([0-9.eE]+)[\s,]+([0-9.eE]+)\s*["']/i);
    if (viewBox) {
        const boxWidth = Number(viewBox[3]);
        const boxHeight = Number(viewBox[4]);
        if (Number.isFinite(boxWidth) && Number.isFinite(boxHeight) && boxWidth > 0 && boxHeight > 0) {
            return { width: Math.round(boxWidth), height: Math.round(boxHeight) };
        }
    }
    return null;
};

const escapeHtml = (value: string): string => value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

/** 生成内嵌 SVG 的 HTML 包装页 */
export const buildSvgViewerHtml = (
    svgUrl: string,
    size: { width: number; height: number } | null,
    options: SvgViewerOptions = {},
): string => {
    const title = escapeHtml(options.title || 'SVG Preview');
    const background = escapeHtml(options.background || '#ffffff');
    const dimensionAttrs = size ? ` width="${size.width}" height="${size.height}"` : '';
    return [
        '<!doctype html>',
        '<html lang="zh-CN"><head>',
        '<meta charset="utf-8">',
        `<title>${title}</title>`,
        '<style>',
        `html,body{margin:0;padding:0;background:${background};}`,
        'body{display:flex;align-items:flex-start;justify-content:flex-start;}',
        'img{display:block;max-width:none;}',
        '</style>',
        '</head><body>',
        `<img src="${escapeHtml(svgUrl)}"${dimensionAttrs} alt="${title}">`,
        '</body></html>',
        '',
    ].join('\n');
};

/** 包装页文件名：URL 的稳定短哈希，保证同一目标复用同一文件 */
export const svgViewerFileName = (svgUrl: string): string => `${createHash('sha1').update(svgUrl).digest('hex').slice(0, 16)}.html`;

const toLocalPath = (url: string): string | null => {
    try {
        const parsed = new URL(url);
        if (parsed.protocol !== 'file:') return null;
        return decodeURIComponent(parsed.pathname.replace(/^\/([a-zA-Z]:)/, '$1')).replace(/\//g, path.sep);
    } catch {
        return null;
    }
};

export interface NavigationPreparationOptions extends SvgViewerOptions {
    /** 用于存放包装页的工作区根目录 */
    workspaceRoot: string;
}

/**
 * 需要时把导航目标改写成 HTML 包装页。
 * 非 SVG 目标原样返回。
 */
export const prepareNavigation = async (
    url: string,
    options: NavigationPreparationOptions,
): Promise<PreparedNavigation> => {
    const original = typeof url === 'string' ? url.trim() : '';
    if (!isSvgDocumentUrl(original)) {
        return { url: original };
    }

    // 本地 SVG：读出固有尺寸，让截图按真实像素渲染，避免 img 尺寸为 0
    let size: { width: number; height: number } | null = null;
    const localPath = toLocalPath(original);
    if (localPath) {
        try {
            size = parseSvgIntrinsicSize(await fs.readFile(localPath, 'utf8'));
        } catch {
            size = null;
        }
    }

    const viewDir = path.join(options.workspaceRoot, ...VIEW_DIR_SEGMENTS);
    const target = path.join(viewDir, svgViewerFileName(original));
    const html = buildSvgViewerHtml(original, size, options);
    await fs.mkdir(viewDir, { recursive: true });
    await fs.writeFile(target, html, 'utf8');

    return {
        url: pathToFileURL(target).href,
        rewrittenFrom: original,
        reason: 'svg-document-mcp-hang',
    };
};

/**
 * MCP 返回内容是否表示浏览器后端已经僵死（需要立刻重建，而不是继续排队）。
 *
 * 只认「后端级」信号：`browserBackend.callTool` 是 MCP 内部包装层的名字，
 * 出现它说明整条调用链已经卡住；`Target closed` 系列说明浏览器已经没了。
 * 普通的 `page.goto: Timeout 120000ms exceeded` 只是单次导航慢，
 * 不能让模型丢掉当前标签/会话，所以不在此列。
 */
const UNHEALTHY_PATTERNS = [
    /browserBackend\.callTool/i,
    /Target page, context or browser has been closed/i,
    /browser has been closed/i,
    /\bTarget closed\b/i,
];

export const isBrowserSessionUnhealthy = (text: string): boolean => {
    if (typeof text !== 'string' || !text) return false;
    return UNHEALTHY_PATTERNS.some((pattern) => pattern.test(text));
};

/**
 * WebPageSaver — 网页完整保存复合工具（save_webpage）
 *
 * 背景（真实案例驱动）：
 * LLM 通过 playwright__browser_evaluate 获取长文 HTML 时，内容必须穿越 LLM 上下文
 * 才能写入文件——超长文章导致分段读取繁琐、token 成本高昂、且极易失败，最终 Agent
 * 退化为"全页截图"交付，无法满足"完整下载文章（含图片）"的需求。
 *
 * 设计理念：
 * - 服务端聚合编排：navigate → 懒加载滚动 → 页内正文提取 → 分块取回 → 图片下载 → 落盘
 * - 内容零上下文占用：正文 HTML/Markdown 在服务端组装并直接写入工作区文件，
 *   仅向 LLM 返回一份精简摘要（标题、文件路径、图片统计）
 * - 页内 DOM→Markdown 转换：利用真实 DOM 结构精确处理代码块/表格/嵌套列表，
 *   比服务端正则解析 HTML 更可靠
 * - 分块取回：payload 存储在 window 临时变量上，按 60KB 分块通过 browser_evaluate
 *   取回，规避 MCP 单次响应体积风险
 * - 图片本地化：服务端 fetch 下载正文图片（携带 Referer 反防盗链），
 *   引用改写为相对路径，交付物离线可读
 */

import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { BrowserMcpAdapter } from '@/services/BrowserMcpAdapter.js';
import type { ToolDefinition } from '@/services/ToolManager.js';
import { getBeijingLogTimePrefix } from '@/utils/TimeUtils.js';

const getTS = () => getBeijingLogTimePrefix();

// ============================================================
// 常量
// ============================================================

export const SAVE_WEBPAGE_TOOL_NAME = 'save_webpage';

/** window 上的 payload 暂存变量名 */
const PAYLOAD_VAR = '__WEB_IDE_SAVE_PAGE__';

/** 分块取回的单块字符数（实测 Playwright MCP evaluate 可稳定承载 ~70K，取 60K 留余量） */
const CHUNK_SIZE = 60_000;

/** payload 上限（防止极端页面撑爆内存） */
const MAX_PAYLOAD_CHARS = 12 * 1024 * 1024;

/** 导航超时（与 Playwright MCP --timeout-navigation 对齐并留余量） */
const NAVIGATE_TIMEOUT_MS = 125_000;

/** 单次 evaluate 超时 */
const EVALUATE_TIMEOUT_MS = 30_000;

/**
 * 可自动重试的提取中断特征：
 * 真实案例——CSDN 等站点加载后触发客户端跳转，销毁执行上下文，
 * browser_evaluate 报 "Execution context was destroyed, most likely because of a navigation"。
 */
const RETRYABLE_EXTRACT_RE = /Execution context was destroyed|because of a navigation|Cannot find context|Target (page|context|browser).*?closed|payload 取回不完整/i;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 图片下载限制 */
const MAX_IMAGES = 80;
const IMAGE_FETCH_TIMEOUT_MS = 20_000;
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 120 * 1024 * 1024;
const IMAGE_CONCURRENCY = 4;

const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

// ============================================================
// 类型
// ============================================================

export interface SaveWebpageParams {
    url?: string;
    /** 保存目录（相对工作区根路径）——必填，由 Agent 根据用户意图与工作区结构显式指定 */
    outputDir: string;
    fileName?: string;
    selector?: string;
    format?: 'markdown' | 'html' | 'both';
    includeImages?: boolean;
    waitSeconds?: number;
}

interface ExtractedImage {
    src: string;
    alt: string;
}

interface ExtractedPayload {
    ok: boolean;
    title: string;
    url: string;
    html: string;
    markdown: string;
    images: ExtractedImage[];
    /** 访问限制识别结果（付费墙/登录墙/关注解锁），空串表示未检测到 */
    restriction?: string;
}

// ============================================================
// 页内脚本（在浏览器上下文中执行）
// ============================================================
// 注意：使用 String.raw 保持正则反斜杠字面量；脚本内禁止出现反引号与 "${"，
// 反引号一律通过 String.fromCharCode(96) 构造。

/** 懒加载触发：快速滚动到底部再回顶（最长约 3 秒） */
const SCROLL_SCRIPT = String.raw`() => new Promise(function (resolve) {
    var total = Math.min((document.body ? document.body.scrollHeight : 0), 30000);
    var y = 0;
    function tick() {
        if (y >= total) { window.scrollTo(0, 0); resolve(true); return; }
        y += 1200;
        window.scrollTo(0, y);
        setTimeout(tick, 120);
    }
    tick();
})`;

/** 清理 window 暂存变量 */
const CLEANUP_SCRIPT = String.raw`() => {
    try { delete window.__WEB_IDE_SAVE_PAGE__; } catch (e) { window.__WEB_IDE_SAVE_PAGE__ = undefined; }
    return true;
}`;

const EXTRACT_SCRIPT_PART1 = String.raw`() => {
    try {
        var BT = String.fromCharCode(96);
        var FENCE = BT + BT + BT;
        var USER_SELECTOR = `;

const EXTRACT_SCRIPT_PART2 = String.raw`;
        var doc = document;

        function textLen(el) { return ((el && el.textContent) || '').replace(/\s+/g, '').length; }

        // ---------- 1. 定位正文根节点 ----------
        var candidates = USER_SELECTOR ? [USER_SELECTOR] : [
            'article', '#content_views', '#article_content', '.markdown-body',
            '#js_content', '.rich_media_content', '.article-content', '.post-content',
            '.post_body', '.content-article', '.J-articleContent', '.article-detail', 'main'
        ];
        var root = null;
        for (var ci = 0; ci < candidates.length; ci++) {
            var candidate = null;
            try { candidate = doc.querySelector(candidates[ci]); } catch (e) {}
            if (candidate && textLen(candidate) >= 120) { root = candidate; break; }
        }
        if (!root) root = doc.body;
        if (!root) return { ok: false, error: 'no content root found' };

        var clone = root.cloneNode(true);

        // ---------- 2. 图片 src 修复（与原始节点并行对齐，优先真实渲染 src / 懒加载属性） ----------
        var origImgs = root.querySelectorAll('img');
        var cloneImgs = clone.querySelectorAll('img');
        for (var ii = 0; ii < cloneImgs.length; ii++) {
            var oi = origImgs[ii];
            var cimg = cloneImgs[ii];
            var srcCandidates = [];
            if (oi) {
                srcCandidates.push(oi.getAttribute('data-src'));
                srcCandidates.push(oi.getAttribute('data-original'));
                srcCandidates.push(oi.getAttribute('data-actualsrc'));
                if (oi.currentSrc) srcCandidates.push(oi.currentSrc);
                srcCandidates.push(oi.getAttribute('src'));
            } else {
                srcCandidates.push(cimg.getAttribute('src'));
            }
            var chosen = '';
            for (var si = 0; si < srcCandidates.length; si++) {
                var sc = srcCandidates[si];
                if (sc && typeof sc === 'string' && sc.trim() && sc.indexOf('data:') !== 0) { chosen = sc.trim(); break; }
            }
            if (!chosen) chosen = (oi && oi.getAttribute('src')) || cimg.getAttribute('src') || '';
            if (chosen && chosen.indexOf('data:') !== 0) {
                try { chosen = new URL(chosen, location.href).href; } catch (e) {}
            }
            if (chosen) cimg.setAttribute('src', chosen);
            cimg.removeAttribute('srcset');
            cimg.removeAttribute('data-src');
            cimg.removeAttribute('data-original');
            cimg.removeAttribute('loading');
        }

        // ---------- 3. 噪音清理 ----------
        var killSel = 'script,style,link,noscript,iframe,frame,embed,object,form,button,input,select,textarea,canvas,video,audio,nav,footer,.pre-numbering,.hljs-button,.code-block-extension-header';
        var killNodes = clone.querySelectorAll(killSel);
        for (var ki = 0; ki < killNodes.length; ki++) {
            if (killNodes[ki].parentNode) killNodes[ki].parentNode.removeChild(killNodes[ki]);
        }
        var noiseRe = /(comment|recommend|advert|adsbox|adsbygoogle|sidebar|related-|share-box|login-box|passport|subscribe-box|copy-btn|copy-code|clipboard|breadcrumb|navbar|topbar|toolbar|page-nav|site-nav)/i;
        var copyRe = /(copy-btn|copy-code|clipboard|hljs-button)/i;
        var noiseEls = clone.querySelectorAll('div,section,aside,ul,span,a');
        for (var ni = noiseEls.length - 1; ni >= 0; ni--) {
            var ne = noiseEls[ni];
            if (!ne.parentNode) continue;
            var idcls = (ne.id || '') + ' ' + (typeof ne.className === 'string' ? ne.className : '');
            if (!noiseRe.test(idcls)) continue;
            // pre/code 内部的语法高亮 span（如 hljs-comment）不能删，但复制按钮要删
            var inCode = false;
            var pp = ne.parentNode;
            while (pp && pp !== clone) {
                var pt = pp.tagName ? pp.tagName.toLowerCase() : '';
                if (pt === 'pre' || pt === 'code') { inCode = true; break; }
                pp = pp.parentNode;
            }
            if (inCode && !copyRe.test(idcls)) continue;
            ne.parentNode.removeChild(ne);
        }

        // ---------- 4. 链接绝对化 ----------
        var links = clone.querySelectorAll('a[href]');
        for (var li = 0; li < links.length; li++) {
            var href = links[li].getAttribute('href') || '';
            if (href && href.indexOf('javascript:') !== 0 && href.indexOf('#') !== 0) {
                try { links[li].setAttribute('href', new URL(href, location.href).href); } catch (e) {}
            }
        }

        // ---------- 5. 收集图片清单 ----------
        var images = [];
        var seen = {};
        var finalImgs = clone.querySelectorAll('img');
        for (var fi = 0; fi < finalImgs.length; fi++) {
            var fsrc = finalImgs[fi].getAttribute('src') || '';
            if (!fsrc || fsrc.indexOf('data:') === 0) continue;
            if (seen[fsrc]) continue;
            seen[fsrc] = true;
            if (images.length >= 120) break;
            images.push({ src: fsrc, alt: finalImgs[fi].getAttribute('alt') || '' });
        }

        // ---------- 6. DOM → Markdown 转换 ----------
        var BLOCK_TAGS = {
            address: 1, article: 1, aside: 1, blockquote: 1, details: 1, dd: 1, div: 1,
            dl: 1, dt: 1, fieldset: 1, figcaption: 1, figure: 1, footer: 1,
            h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, header: 1, hr: 1, li: 1,
            main: 1, nav: 1, ol: 1, p: 1, pre: 1, section: 1, table: 1, ul: 1
        };

        function hasBlockChild(node) {
            for (var i = 0; i < node.children.length; i++) {
                if (BLOCK_TAGS[node.children[i].tagName.toLowerCase()]) return true;
            }
            return false;
        }

        function imageMd(img) {
            var src = img.getAttribute('src') || '';
            if (!src) return '';
            var alt = (img.getAttribute('alt') || '').replace(/[\[\]]/g, '');
            return '![' + alt + '](' + src + ')';
        }

        function inlineNodes(nodes) {
            var out = '';
            for (var i = 0; i < nodes.length; i++) {
                var c = nodes[i];
                if (c.nodeType === 3) { out += (c.nodeValue || '').replace(/[ \t\r\n]+/g, ' '); continue; }
                if (c.nodeType !== 1) continue;
                var tag = c.tagName.toLowerCase();
                if (tag === 'br') { out += '  \n'; continue; }
                if (tag === 'img') { out += imageMd(c); continue; }
                if (tag === 'code') {
                    var ct = (c.textContent || '').replace(new RegExp(BT, 'g'), '');
                    out += BT + ct + BT;
                    continue;
                }
                if (tag === 'a') {
                    var ah = c.getAttribute('href') || '';
                    var at = inlineOf(c).trim();
                    out += ah ? '[' + (at || ah) + '](' + ah + ')' : at;
                    continue;
                }
                if (tag === 'strong' || tag === 'b') { out += '**' + inlineOf(c).trim() + '**'; continue; }
                if (tag === 'em' || tag === 'i') { out += '*' + inlineOf(c).trim() + '*'; continue; }
                if (tag === 'del' || tag === 's' || tag === 'strike') { out += '~~' + inlineOf(c).trim() + '~~'; continue; }
                if (BLOCK_TAGS[tag]) { out += blockOf(c, 0); continue; }
                out += inlineOf(c);
            }
            return out;
        }

        function toArray(list) {
            var arr = [];
            for (var i = 0; i < list.length; i++) arr.push(list[i]);
            return arr;
        }

        function inlineOf(node) { return inlineNodes(toArray(node.childNodes)); }

        var KNOWN_LANGS = {
            js: 1, jsx: 1, ts: 1, tsx: 1, javascript: 1, typescript: 1, java: 1, kotlin: 1,
            groovy: 1, scala: 1, python: 1, py: 1, go: 1, rust: 1, c: 1, cpp: 1, csharp: 1,
            cs: 1, php: 1, ruby: 1, swift: 1, dart: 1, xml: 1, html: 1, css: 1, scss: 1,
            less: 1, json: 1, yaml: 1, yml: 1, toml: 1, ini: 1, properties: 1, sql: 1,
            bash: 1, sh: 1, shell: 1, zsh: 1, powershell: 1, bat: 1, cmd: 1, dockerfile: 1,
            makefile: 1, nginx: 1, http: 1, diff: 1, markdown: 1, md: 1, text: 1,
            plaintext: 1, txt: 1, lua: 1, perl: 1, r: 1, matlab: 1, vue: 1, svelte: 1
        };

        // 归一化代码语言标识：清洗 CSDN 等平台的私有 class（如 code-snippet__js → js）
        function normalizeLang(lang) {
            if (!lang) return '';
            lang = lang.toLowerCase();
            if (KNOWN_LANGS[lang]) return lang;
            var parts = lang.split(/[^a-z0-9+#]+/).filter(function (p) { return !!p; });
            for (var pi = parts.length - 1; pi >= 0; pi--) {
                if (KNOWN_LANGS[parts[pi]]) return parts[pi];
            }
            return parts.length === 1 ? parts[0] : '';
        }

        function codeBlockMd(pre) {
            var codeEl = pre.querySelector('code') || pre;
            var cls = ((codeEl.getAttribute('class') || '') + ' ' + (pre.getAttribute('class') || ''));
            var lang = '';
            var m = cls.match(/language-([A-Za-z0-9#+_-]+)/) || cls.match(/(?:^|\s)lang-([A-Za-z0-9#+_-]+)/);
            if (m) lang = normalizeLang(m[1]);
            var codeText = (codeEl.textContent || '').replace(/\u00a0/g, ' ').replace(/\n+$/, '');
            // 代码内容本身含三反引号围栏时加长围栏，避免 Markdown 结构破坏
            var fence = FENCE;
            while (codeText.indexOf(fence) !== -1) fence += BT;
            return '\n' + fence + lang + '\n' + codeText + '\n' + fence + '\n';
        }

        function listMd(node, depth) {
            var ordered = node.tagName.toLowerCase() === 'ol';
            var out = '\n';
            var idx = 0;
            for (var i = 0; i < node.children.length; i++) {
                var item = node.children[i];
                if (item.tagName.toLowerCase() !== 'li') continue;
                idx++;
                var marker = ordered ? (idx + '. ') : '- ';
                var indent = new Array(depth + 1).join('  ');
                var inlineParts = [];
                var trailing = '';
                for (var j = 0; j < item.childNodes.length; j++) {
                    var lc = item.childNodes[j];
                    if (lc.nodeType === 1) {
                        var lt = lc.tagName.toLowerCase();
                        if (lt === 'ul' || lt === 'ol') { trailing += listMd(lc, depth + 1); continue; }
                        if (lt === 'pre') { trailing += codeBlockMd(lc); continue; }
                    }
                    inlineParts.push(lc);
                }
                var text = inlineNodes(inlineParts).replace(/\n+/g, ' ').trim();
                out += indent + marker + text + '\n';
                if (trailing) out += trailing.replace(/^\n+/, '');
            }
            return out;
        }

        function tableMd(node) {
            var rows = node.querySelectorAll('tr');
            if (!rows.length) return '';
            var out = '\n';
            for (var r = 0; r < rows.length; r++) {
                var cells = rows[r].children;
                var parts = [];
                for (var c = 0; c < cells.length; c++) {
                    parts.push(inlineOf(cells[c]).trim().replace(/\|/g, '\\|').replace(/\n+/g, ' '));
                }
                out += '| ' + parts.join(' | ') + ' |\n';
                if (r === 0) {
                    var sep = [];
                    for (var c2 = 0; c2 < cells.length; c2++) sep.push('---');
                    out += '| ' + sep.join(' | ') + ' |\n';
                }
            }
            return out;
        }

        function quoteMd(node) {
            var inner = blockChildren(node, 0).trim();
            if (!inner) return '';
            var lines = inner.split('\n');
            var out = '\n';
            for (var i = 0; i < lines.length; i++) out += '> ' + lines[i] + '\n';
            return out;
        }

        function blockChildren(node, depth) {
            var out = '';
            for (var i = 0; i < node.childNodes.length; i++) {
                var c = node.childNodes[i];
                if (c.nodeType === 3) {
                    var tv = (c.nodeValue || '').replace(/[ \t\r\n]+/g, ' ');
                    if (tv.trim()) out += tv;
                    continue;
                }
                if (c.nodeType !== 1) continue;
                out += blockOf(c, depth);
            }
            return out;
        }

        function blockOf(node, depth) {
            var tag = node.tagName.toLowerCase();
            var hm = tag.match(/^h([1-6])$/);
            if (hm) {
                var level = parseInt(hm[1], 10);
                return '\n' + new Array(level + 1).join('#') + ' ' + inlineOf(node).trim() + '\n';
            }
            if (tag === 'p') { var pt = inlineOf(node).trim(); return pt ? '\n' + pt + '\n' : ''; }
            if (tag === 'pre') return codeBlockMd(node);
            if (tag === 'ul' || tag === 'ol') return listMd(node, depth);
            if (tag === 'table') return tableMd(node);
            if (tag === 'blockquote') return quoteMd(node);
            if (tag === 'hr') return '\n---\n';
            if (tag === 'br') return '\n';
            if (tag === 'img') { var im = imageMd(node); return im ? '\n' + im + '\n' : ''; }
            if (tag === 'figcaption') { var fc = inlineOf(node).trim(); return fc ? '\n*' + fc + '*\n' : ''; }
            if (hasBlockChild(node)) return blockChildren(node, depth);
            if (BLOCK_TAGS[tag]) { var bt2 = inlineOf(node).trim(); return bt2 ? '\n' + bt2 + '\n' : ''; }
            return inlineNodes([node]);
        }

        var markdown = blockChildren(clone, 0).replace(/\n{3,}/g, '\n\n').trim();
        var title = (doc.title || '').trim();

        // ---------- 7. 访问限制检测（付费墙 / 登录墙 / 关注解锁） ----------
        // 真实案例：CSDN 付费文章仅渲染约 20% 正文并显示 "解锁文章" 按钮，
        // 静默保存会让用户误以为下载完整。检测到限制时仍保存可见部分，但显著提醒。
        var restriction = '';
        try {
            var wallSel = '.hide-article-box, #btn-readmore, .article-hide-box, .pay-read, .pay-column-box, [class*="paywall"], [id*="paywall"], [class*="vip-mask"], [class*="unlock-box"]';
            var wallEl = null;
            try { wallEl = doc.querySelector(wallSel); } catch (e2) {}
            if (wallEl) restriction = '命中付费/解锁遮罩元素';
            var scanText = ((root.textContent) || '').slice(0, 200000);
            var wallRe = /(解锁文章|解锁全文|付费阅读|付费内容|购买本篇|开通.{0,4}(VIP|会员)|会员专享|会员可见|登录后(阅读|查看|复制|继续)|登录.{0,8}阅读全文|关注.{0,10}阅读全文|订阅后(阅读|查看)|sign in to (read|continue)|subscribe to (read|continue|unlock)|members?.only)/i;
            var wallMatch = scanText.match(wallRe);
            if (wallMatch) restriction = (restriction ? restriction + '；' : '') + '正文区域出现 "' + wallMatch[0] + '"';
        } catch (e3) {}

        var payload = JSON.stringify({
            ok: true,
            title: title,
            url: location.href,
            html: clone.innerHTML,
            markdown: markdown,
            images: images,
            restriction: restriction
        });
        window.__WEB_IDE_SAVE_PAGE__ = payload;
        return { ok: true, length: payload.length, title: title, imageCount: images.length };
    } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
    }
}`;

export function buildExtractionScript(selector?: string): string {
    return EXTRACT_SCRIPT_PART1 + JSON.stringify(selector || '') + EXTRACT_SCRIPT_PART2;
}

// ============================================================
// 服务端辅助函数
// ============================================================

/** 解析 Playwright MCP browser_evaluate 的返回文本，提取 "### Result" 段并反序列化 */
export function parseEvaluateResult(text: string): unknown {
    const m = text.match(/### Result\r?\n([\s\S]*?)(?=\r?\n### |$)/);
    if (!m) {
        throw new Error(`无法解析 browser_evaluate 返回结果: ${text.slice(0, 300)}`);
    }
    const raw = m[1].trim();
    if (raw === 'undefined' || raw === 'null' || raw === '') return null;
    try {
        return JSON.parse(raw);
    } catch {
        return raw;
    }
}

/** 文件名净化（Windows 保留字符 + 控制字符 + 长度限制） */
export function sanitizeFileName(name: string): string {
    const cleaned = String(name || '')
        .replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
        .replace(/[. ]+$/, '');
    return cleaned || 'webpage';
}

/** 输出目录越界防护（Path Traversal Guard） */
function resolveInsideWorkspace(workspaceRoot: string, relDir: string): string {
    const rootNorm = path.resolve(workspaceRoot);
    const resolved = path.resolve(rootNorm, relDir);
    if (resolved !== rootNorm && !resolved.startsWith(rootNorm + path.sep)) {
        throw new Error(`输出目录越界：'${relDir}' 不在工作区内`);
    }
    return resolved;
}

/** 生成不与已有文件冲突的基础文件名 */
function uniqueBaseName(outDirAbs: string, base: string): string {
    let candidate = base;
    for (let i = 2; i <= 99; i++) {
        const conflict = existsSync(path.join(outDirAbs, `${candidate}.md`))
            || existsSync(path.join(outDirAbs, `${candidate}.html`))
            || existsSync(path.join(outDirAbs, `${candidate}_files`));
        if (!conflict) return candidate;
        candidate = `${base}-${i}`;
    }
    return `${base}-${Date.now()}`;
}

const CONTENT_TYPE_EXT: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/jpg': '.jpg',
    'image/png': '.png',
    'image/gif': '.gif',
    'image/webp': '.webp',
    'image/svg+xml': '.svg',
    'image/avif': '.avif',
    'image/bmp': '.bmp',
    'image/x-icon': '.ico',
};

/** 根据魔数嗅探图片格式（比 content-type 更可靠） */
function sniffImageExt(buf: Buffer): string | null {
    if (buf.length < 12) return null;
    if (buf[0] === 0xff && buf[1] === 0xd8) return '.jpg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return '.png';
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return '.gif';
    if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') return '.webp';
    if (buf.subarray(4, 12).toString('ascii').startsWith('ftypavif')) return '.avif';
    return null;
}

function extFromUrl(url: string): string | null {
    const m = url.match(/\.(jpe?g|png|gif|webp|svg|avif|bmp|ico)(?=$|[?#])/i);
    if (!m) return null;
    const ext = m[1].toLowerCase();
    return ext === 'jpeg' ? '.jpg' : `.${ext}`;
}

function stripHash(url: string): string {
    const idx = url.indexOf('#');
    return idx >= 0 ? url.slice(0, idx) : url;
}

/** 并发下载正文图片，返回 docUrl → 本地文件名 映射 */
async function downloadImages(
    images: ExtractedImage[],
    pageUrl: string,
    assetDirAbs: string,
    stats: { total: number; downloaded: number; failed: number },
    warnings: string[],
): Promise<Map<string, string>> {
    const mapping = new Map<string, string>();
    const limited = images.slice(0, MAX_IMAGES);
    if (images.length > MAX_IMAGES) {
        warnings.push(`正文图片数量 ${images.length} 超过上限 ${MAX_IMAGES}，超出部分保留远程链接。`);
    }

    let totalBytes = 0;
    const queue = limited.map((img, idx) => ({ img, idx }));

    const worker = async () => {
        while (true) {
            const task = queue.shift();
            if (!task) return;
            const { img, idx } = task;
            try {
                const cleanUrl = stripHash(img.src);
                const controller = new AbortController();
                const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
                let resp: Response;
                try {
                    resp = await fetch(cleanUrl, {
                        headers: {
                            'User-Agent': BROWSER_UA,
                            Referer: pageUrl,
                            Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                        },
                        redirect: 'follow',
                        signal: controller.signal,
                    });
                } finally {
                    clearTimeout(timer);
                }
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                const buf = Buffer.from(await resp.arrayBuffer());
                if (buf.length === 0) throw new Error('空响应');
                if (buf.length > MAX_IMAGE_BYTES) throw new Error(`图片超过单张 ${Math.round(MAX_IMAGE_BYTES / 1024 / 1024)}MB 上限`);
                totalBytes += buf.length;
                if (totalBytes > MAX_TOTAL_IMAGE_BYTES) throw new Error('图片总量超限');

                const contentType = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
                const ext = sniffImageExt(buf) || CONTENT_TYPE_EXT[contentType] || extFromUrl(cleanUrl) || '.png';
                const name = `img-${String(idx + 1).padStart(3, '0')}${ext}`;
                await fs.writeFile(path.join(assetDirAbs, name), buf);
                mapping.set(img.src, name);
                stats.downloaded++;
            } catch (err: any) {
                stats.failed++;
                if (warnings.length < 15) {
                    warnings.push(`图片下载失败: ${img.src.slice(0, 120)} (${String(err?.message || err).slice(0, 120)})`);
                }
            }
        }
    };

    await Promise.all(Array.from({ length: IMAGE_CONCURRENCY }, worker));
    return mapping;
}

function beijingNow(): string {
    return new Intl.DateTimeFormat('zh-CN', {
        timeZone: 'Asia/Shanghai',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    }).format(new Date());
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** 生成离线可读的独立 HTML 文档 */
function buildStandaloneHtml(title: string, sourceUrl: string, savedAt: string, bodyHtml: string, restrictionNotice = ''): string {
    const safeTitle = escapeHtml(title);
    const safeUrl = escapeHtml(sourceUrl);
    const noticeHtml = restrictionNotice
        ? `\n<div style="color:#9a6700;font-weight:600;">⚠️ ${escapeHtml(restrictionNotice)}</div>`
        : '';
    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${safeTitle}</title>
<style>
body { max-width: 880px; margin: 0 auto; padding: 24px 16px 64px; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; line-height: 1.75; color: #24292f; }
.save-meta { font-size: 13px; color: #57606a; border-bottom: 1px solid #d0d7de; padding-bottom: 12px; margin-bottom: 24px; }
.save-meta a { color: #0969da; word-break: break-all; }
img { max-width: 100%; height: auto; }
pre { background: #f6f8fa; padding: 14px; border-radius: 6px; overflow-x: auto; font-size: 13.5px; line-height: 1.5; }
code { font-family: Consolas, "Courier New", monospace; background: #f0f1f2; padding: 1px 5px; border-radius: 4px; font-size: 0.92em; }
pre code { background: none; padding: 0; }
blockquote { border-left: 4px solid #d0d7de; margin: 12px 0; padding: 2px 16px; color: #57606a; }
table { border-collapse: collapse; margin: 12px 0; }
th, td { border: 1px solid #d0d7de; padding: 6px 12px; }
h1, h2, h3 { line-height: 1.35; }
</style>
</head>
<body>
<div class="save-meta">
<div><strong>${safeTitle}</strong></div>
<div>来源：<a href="${safeUrl}">${safeUrl}</a></div>
<div>保存时间：${savedAt}（由 save_webpage 工具保存）</div>${noticeHtml}
</div>
${bodyHtml}
</body>
</html>
`;
}

// ============================================================
// WebPageSaver 主流程
// ============================================================

export class WebPageSaver {
    static async save(
        adapter: BrowserMcpAdapter,
        userId: string,
        workspaceRoot: string,
        params: SaveWebpageParams,
    ): Promise<Record<string, unknown>> {
        const warnings: string[] = [];
        const format = params.format === 'markdown' || params.format === 'html' ? params.format : 'both';
        const includeImages = params.includeImages !== false;

        const evaluate = async (fn: string, timeoutMs = EVALUATE_TIMEOUT_MS): Promise<unknown> => {
            const res = await adapter.callNativeTool(userId, workspaceRoot, 'browser_evaluate', { function: fn }, timeoutMs);
            if (res.isError) {
                throw new Error(`browser_evaluate 失败: ${res.text.slice(0, 400)}`);
            }
            return parseEvaluateResult(res.text);
        };

        // 0. 参数校验（fail-fast：在导航/提取之前完成，避免无效的浏览器开销）
        // 保存路径由 Agent 显式指定，不提供硬编码默认目录
        const outDirRaw = typeof params.outputDir === 'string' ? params.outputDir.trim() : '';
        if (!outDirRaw) {
            return {
                status: 'error', step: 'params',
                message: "outputDir 为必填参数：请根据用户意图与工作区目录结构显式指定保存目录（相对工作区根路径，如 'articles'、'docs/refs'）。",
            };
        }
        let outDirAbs: string;
        try {
            outDirAbs = resolveInsideWorkspace(workspaceRoot, outDirRaw);
        } catch (err: any) {
            return { status: 'error', step: 'params', message: String(err?.message || err) };
        }

        try {
            // 1. 导航（可选：未提供 url 时保存浏览器当前页面）
            if (params.url && String(params.url).trim()) {
                const nav = await adapter.callNativeTool(
                    userId, workspaceRoot, 'browser_navigate',
                    { url: String(params.url).trim() }, NAVIGATE_TIMEOUT_MS,
                );
                if (nav.isError) {
                    return { status: 'error', step: 'navigate', message: `页面导航失败: ${nav.text.slice(0, 400)}` };
                }
            }

            // 2–5. 提取管线（等待 → 滚动 → 页内提取 → 分块取回）
            // 整体可重试：部分站点（如 CSDN）加载后触发客户端跳转销毁执行上下文，
            // 首次失败后等待页面稳定再重试一次即可成功。
            const waitSeconds = Math.min(Math.max(Number(params.waitSeconds) || 0, 0), 30);
            const runExtractionPipeline = async (): Promise<string> => {
                if (waitSeconds > 0) {
                    await evaluate(
                        `() => new Promise(function (r) { setTimeout(function () { r(true); }, ${waitSeconds * 1000}); })`,
                        (waitSeconds + 5) * 1000,
                    );
                }

                // 滚动触发懒加载图片
                if (includeImages) {
                    try { await evaluate(SCROLL_SCRIPT); } catch { warnings.push('懒加载滚动失败，部分图片可能未渲染真实地址。'); }
                }

                // 页内提取（payload 暂存 window，只返回精简元数据）
                const meta = await evaluate(buildExtractionScript(params.selector)) as
                    | { ok: true; length: number; title: string; imageCount: number }
                    | { ok: false; error: string }
                    | null;
                if (!meta || typeof meta !== 'object' || (meta as any).ok !== true) {
                    throw new Error(`正文提取失败: ${(meta as any)?.error || '未知原因'}。可尝试通过 selector 参数指定正文根元素。`);
                }
                const okMeta = meta as { ok: true; length: number; title: string; imageCount: number };
                if (okMeta.length > MAX_PAYLOAD_CHARS) {
                    try { await evaluate(CLEANUP_SCRIPT); } catch {}
                    throw new Error(`页面正文过大（${okMeta.length} 字符，上限 ${MAX_PAYLOAD_CHARS}）。请通过 selector 参数缩小正文范围。`);
                }

                // 分块取回 payload（每块 60KB，规避 MCP 单次响应体积限制）
                let payloadStr = '';
                for (let start = 0; start < okMeta.length; start += CHUNK_SIZE) {
                    const chunk = await evaluate(
                        `() => (window.${PAYLOAD_VAR} || '').slice(${start}, ${start + CHUNK_SIZE})`,
                    );
                    if (typeof chunk !== 'string') {
                        throw new Error(`分块取回失败（offset=${start}）：返回类型 ${typeof chunk}`);
                    }
                    payloadStr += chunk;
                }
                if (payloadStr.length !== okMeta.length) {
                    throw new Error(`payload 取回不完整（实际 ${payloadStr.length} / 预期 ${okMeta.length} 字符），页面可能在提取过程中发生了跳转。`);
                }
                return payloadStr;
            };

            let payloadStr: string;
            try {
                payloadStr = await runExtractionPipeline();
            } catch (err: any) {
                const msg = String(err?.message || err);
                if (!RETRYABLE_EXTRACT_RE.test(msg)) throw err;
                // 页面跳转/上下文销毁 → 等待稳定后重试一次
                console.warn(`${getTS()} [WebPageSaver] ⚠️ 提取中断（${msg.slice(0, 160)}），等待页面稳定后重试…`);
                warnings.push('首次提取因页面跳转中断，已自动重试。');
                await sleep(2_000);
                payloadStr = await runExtractionPipeline();
            }

            // 6. 清理页面暂存变量
            try { await evaluate(CLEANUP_SCRIPT); } catch {}

            const payload = JSON.parse(payloadStr) as ExtractedPayload;
            let { html, markdown } = payload;
            const title = payload.title || 'webpage';
            const sourceUrl = payload.url || params.url || '';

            // 访问限制（付费墙/登录墙）：不阻断保存，但在交付物与返回值中显著提醒
            const restrictionNotice = payload.restriction
                ? `页面疑似存在付费墙/登录限制（${payload.restriction}），已保存当前可见部分，内容可能不完整。如需全文，请用户在自己的浏览器中登录该网站（或开通相应会员）后阅读，或寻找其他免费转载来源。`
                : '';

            // 7. 准备输出目录与文件名（outDirAbs 已在参数校验阶段解析并通过越界防护）
            await fs.mkdir(outDirAbs, { recursive: true });
            const base = uniqueBaseName(outDirAbs, sanitizeFileName(params.fileName || title));
            const assetDirName = `${base}_files`;

            // 8. 下载图片并重写引用为相对路径
            const imageStats = { total: payload.images.length, downloaded: 0, failed: 0 };
            if (includeImages && payload.images.length > 0) {
                const assetDirAbs = path.join(outDirAbs, assetDirName);
                await fs.mkdir(assetDirAbs, { recursive: true });
                const mapping = await downloadImages(payload.images, sourceUrl, assetDirAbs, imageStats, warnings);
                let orphanCount = 0;
                for (const [docUrl, localName] of mapping) {
                    const rel = `${assetDirName}/${localName}`;
                    markdown = markdown.split(docUrl).join(rel);
                    html = html.split(docUrl).join(rel);
                    // innerHTML 序列化会把 & 编码为 &amp;，需要额外替换转义形态
                    const escaped = docUrl.replace(/&/g, '&amp;');
                    if (escaped !== docUrl) html = html.split(escaped).join(rel);
                    // 孤立图片清理：下载后未被正文任何形态引用的图片（如装饰小图标）直接删除
                    if (!markdown.includes(rel) && !html.includes(rel)) {
                        try {
                            await fs.unlink(path.join(assetDirAbs, localName));
                            imageStats.downloaded--;
                            orphanCount++;
                        } catch {}
                    }
                }
                if (orphanCount > 0) {
                    warnings.push(`已清理 ${orphanCount} 张未被正文引用的孤立图片。`);
                }
                // 全部图片都被清理时移除空资源目录
                if (imageStats.downloaded === 0) {
                    try { await fs.rmdir(assetDirAbs); } catch {}
                }
            }

            // 9. 落盘
            const savedAt = beijingNow();
            const savedFiles: Record<string, string> = {};
            const toRel = (p: string) => path.relative(workspaceRoot, p).split(path.sep).join('/');

            if (format !== 'html') {
                const mdPath = path.join(outDirAbs, `${base}.md`);
                const mdContent = [
                    `# ${title}`,
                    '',
                    `> 来源：${sourceUrl}`,
                    `> 保存时间：${savedAt}（由 save_webpage 工具保存）`,
                    ...(restrictionNotice ? [`> ⚠️ ${restrictionNotice}`] : []),
                    '',
                    '---',
                    '',
                    markdown,
                    '',
                ].join('\n');
                await fs.writeFile(mdPath, mdContent, 'utf-8');
                savedFiles.markdown = toRel(mdPath);
            }
            if (format !== 'markdown') {
                const htmlPath = path.join(outDirAbs, `${base}.html`);
                await fs.writeFile(htmlPath, buildStandaloneHtml(title, sourceUrl, savedAt, html, restrictionNotice), 'utf-8');
                savedFiles.html = toRel(htmlPath);
            }
            if (imageStats.downloaded > 0) {
                savedFiles.assetsDir = toRel(path.join(outDirAbs, assetDirName));
            }

            console.log(
                `${getTS()} [WebPageSaver] ✅ Saved "${title}" → ${Object.values(savedFiles).join(', ')} ` +
                `(images: ${imageStats.downloaded}/${imageStats.total})` +
                (restrictionNotice ? ' ⚠️ access-restricted' : ''),
            );

            return {
                status: 'success',
                title,
                sourceUrl,
                files: savedFiles,
                markdownChars: format !== 'html' ? markdown.length : undefined,
                htmlChars: format !== 'markdown' ? html.length : undefined,
                images: imageStats,
                accessRestricted: restrictionNotice ? true : undefined,
                restrictionNotice: restrictionNotice || undefined,
                warnings: warnings.length ? warnings : undefined,
            };
        } catch (err: any) {
            const message = String(err?.message || err);
            console.error(`${getTS()} [WebPageSaver] ❌ save failed: ${message}`);
            return { status: 'error', message: `网页保存失败: ${message}` };
        }
    }
}

// ============================================================
// ToolDefinition 构建
// ============================================================

export function buildSaveWebpageToolDefinition(
    adapter: BrowserMcpAdapter,
    userId: string,
    workspaceRoot: string,
): ToolDefinition {
    return {
        name: SAVE_WEBPAGE_TOOL_NAME,
        description:
            '【网页完整下载 · 服务端直接落盘】将指定 url（或浏览器当前页面）的正文完整保存为 Markdown + 独立 HTML 文件，' +
            '并自动下载正文图片到本地、把图片引用改写为相对路径。内容在服务端组装写盘，不占用对话上下文，' +
            '任意长度的长文都能无损保存；页面跳转导致的提取中断会自动重试。' +
            '⚠️ outputDir 为必填参数，保存位置由你根据用户意图显式指定。' +
            '需要"下载/保存/收藏网页文章（含图片）"时必须优先使用本工具；' +
            '禁止用全页截图或 browser_evaluate 手工分段拷贝 HTML 代替。' +
            '返回值含 `accessRestricted: true` 时表示页面存在付费墙/登录限制、仅保存了可见部分：' +
            '此时必须在回复中明确告知用户内容不完整及原因，并建议用户自行登录该网站阅读全文，不得隐瞒或模糊化表述。',
        parameters: {
            type: 'object',
            properties: {
                url: {
                    type: 'string',
                    description: '要保存的网页地址。省略则保存浏览器当前已打开的页面。',
                },
                outputDir: {
                    type: 'string',
                    description: "⚠️ 必填参数，不可省略！保存目录（相对工作区根路径，如 'articles'、'docs/refs'）。根据用户意图与工作区目录结构选择；不得指向工作区外，最终交付物禁止写入 .temp/。",
                },
                fileName: {
                    type: 'string',
                    description: '文件基础名（不含扩展名），默认取网页标题。',
                },
                selector: {
                    type: 'string',
                    description: '正文根元素 CSS 选择器。默认自动识别（article / #content_views / .markdown-body / #js_content 等常见容器）。自动识别失败或正文过大时使用。',
                },
                format: {
                    type: 'string',
                    enum: ['markdown', 'html', 'both'],
                    description: "输出格式，默认 'both'（同时生成 .md 与独立 .html）。",
                },
                includeImages: {
                    type: 'boolean',
                    description: '是否下载正文图片到本地并重写为相对路径，默认 true。',
                },
                waitSeconds: {
                    type: 'number',
                    description: '导航完成后的额外等待秒数（强动态渲染页面用），默认 0，最大 30。',
                },
            },
            required: ['outputDir'],
        },
        execute: async (params: SaveWebpageParams, context?: any) => {
            const resolvedUserId = context?.userId || userId;
            const wsRoot = context?.workspaceRoot || workspaceRoot;
            return await WebPageSaver.save(adapter, resolvedUserId, wsRoot, params || {});
        },
    };
}

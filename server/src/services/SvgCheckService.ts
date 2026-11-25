import * as fs from 'fs/promises';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import svgpath from 'svgpath';
import { svgPathBbox } from 'svg-path-bbox';
import { PathUtils } from '@/utils/PathUtils.js';
import { FileIO } from '@/utils/FileIO.js';

/**
 * SVG 边界检查器（静态几何校验，纯 JS，无原生依赖）
 *
 * 解决的问题：大模型生成 SVG 时最常见的缺陷是「元素画到 viewBox 外面」——
 * 文本被右边界裁掉、卡片伸到画布外、坐标写成负数、甚至写出 NaN。
 * 这些错误肉眼只有在渲染后才发现，纯文本 diff 无法暴露。
 *
 * 实现方式：
 *   1. fast-xml-parser 做 XML 良构校验（带行列号）并解析成有序 AST；
 *   2. 自实现 SVG transform 矩阵栈（matrix/translate/scale/rotate/skewX/skewY）；
 *   3. 基本图元用解析式求包围盒；path 先经 svgpath 应用 CTM，再用
 *      svg-path-bbox 求精确包围盒（含贝塞尔极值与圆弧）；
 *   4. 描边按 stroke-width/2 × 缩放外扩；<text> 用字宽启发式估算并标记 approximate；
 *   5. 支持 <use> 引用解析、嵌套 <svg> 视口映射、clip-path/mask 降级为警告。
 *
 * 精度说明：几何图元与 path 为精确值，文本为近似值（无字体引擎）。
 */

export type SvgBox = { x0: number; y0: number; x1: number; y1: number };
export type SvgBoxTuple = [number, number, number, number];

/** 仿射矩阵 [a, b, c, d, e, f]，与 SVG matrix(a b c d e f) 一致 */
type Matrix = [number, number, number, number, number, number];

export type SvgIssueSeverity = 'error' | 'warning';

export interface SvgCheckIssue {
    code: string;
    severity: SvgIssueSeverity;
    message: string;
    /** 形如 `text#legend` / `rect`，便于模型定位 */
    element?: string;
    /** 1-based 行号（若可定位） */
    line?: number;
    column?: number;
    bounds?: SvgBoxTuple;
    /** 溢出像素数（仅 overflow-* 类型） */
    overflow?: number;
    sides?: string[];
    /** 文本等启发式测量，值不精确 */
    approximate?: boolean;
    fix?: string;
}

export interface SvgCheckOptions {
    /** 允许的溢出容差（用户单位），默认 0.5 */
    tolerance?: number;
    /** 是否测量 <text>（近似），默认 true */
    includeText?: boolean;
    /** 是否把描边宽度计入边界，默认 true */
    includeStroke?: boolean;
    /** 最多返回的问题条数，默认 30 */
    maxIssues?: number;
}

export interface SvgCheckReport {
    status: 'ok' | 'warn' | 'error';
    viewBox: SvgBoxTuple | null;
    contentBBox: SvgBoxTuple | null;
    overflow: { left: number; top: number; right: number; bottom: number } | null;
    /** 已按 maxIssues 截断的问题列表 */
    issues: SvgCheckIssue[];
    /** 截断前的完整问题数 */
    totalIssues: number;
    errorCount: number;
    warningCount: number;
    stats: { elements: number; measured: number; skipped: number; approximate: number };
    /** 单行结论，供写文件反馈等紧凑场景使用 */
    summary: string;
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

// ─── 矩阵工具 ────────────────────────────────────────────

function multiplyMatrix(m: Matrix, n: Matrix): Matrix {
    return [
        m[0] * n[0] + m[2] * n[1],
        m[1] * n[0] + m[3] * n[1],
        m[0] * n[2] + m[2] * n[3],
        m[1] * n[2] + m[3] * n[3],
        m[0] * n[4] + m[2] * n[5] + m[4],
        m[1] * n[4] + m[3] * n[5] + m[5],
    ];
}

function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

/** 描边在用户空间的平均缩放系数（用于把 stroke-width 换算到用户单位） */
function averageScale(m: Matrix): number {
    const sx = Math.hypot(m[0], m[1]);
    const sy = Math.hypot(m[2], m[3]);
    const value = (sx + sy) / 2;
    return Number.isFinite(value) && value > 0 ? value : 1;
}

function isIdentity(m: Matrix): boolean {
    return m[0] === 1 && m[1] === 0 && m[2] === 0 && m[3] === 1 && m[4] === 0 && m[5] === 0;
}

// ─── transform 属性解析 ──────────────────────────────────

const TRANSFORM_FN_RE = /([a-zA-Z]+)\s*\(([^()]*)\)/g;

function parseTransform(value: string | undefined): Matrix {
    if (!value) return IDENTITY;
    let acc: Matrix = IDENTITY;
    const re = new RegExp(TRANSFORM_FN_RE.source, 'g');
    let match: RegExpExecArray | null;
    while ((match = re.exec(value)) !== null) {
        const name = match[1].toLowerCase();
        const args = match[2]
            .split(/[\s,]+/)
            .filter((token) => token.length > 0)
            .map(Number);
        if (args.length === 0 || args.some((n) => !Number.isFinite(n))) continue;

        let local: Matrix | null = null;
        switch (name) {
            case 'matrix':
                if (args.length >= 6) local = [args[0], args[1], args[2], args[3], args[4], args[5]];
                break;
            case 'translate':
                local = [1, 0, 0, 1, args[0], args[1] ?? 0];
                break;
            case 'scale':
                local = [args[0], 0, 0, args[1] ?? args[0], 0, 0];
                break;
            case 'rotate': {
                const rad = (args[0] * Math.PI) / 180;
                const cos = Math.cos(rad);
                const sin = Math.sin(rad);
                const rotate: Matrix = [cos, sin, -sin, cos, 0, 0];
                if (args.length >= 3) {
                    const cx = args[1];
                    const cy = args[2];
                    local = multiplyMatrix(multiplyMatrix([1, 0, 0, 1, cx, cy], rotate), [1, 0, 0, 1, -cx, -cy]);
                } else {
                    local = rotate;
                }
                break;
            }
            case 'skewx':
                local = [1, 0, Math.tan((args[0] * Math.PI) / 180), 1, 0, 0];
                break;
            case 'skewy':
                local = [1, Math.tan((args[0] * Math.PI) / 180), 0, 1, 0, 0];
                break;
            default:
                break;
        }
        if (local) acc = multiplyMatrix(acc, local);
    }
    return acc;
}

// ─── 长度 / 数值解析 ─────────────────────────────────────

const LENGTH_RE = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Z%]*)$/;

interface LengthContext {
    axis: 'x' | 'y' | 'diag';
    viewportWidth: number;
    viewportHeight: number;
    fontSize: number;
}

const UNIT_SCALE: Record<string, number> = {
    '': 1,
    px: 1,
    pt: 96 / 72,
    pc: 16,
    in: 96,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
    q: 96 / 101.6,
};

function parseLength(value: string | undefined, ctx: LengthContext): number | undefined {
    if (value == null) return undefined;
    const text = String(value).trim();
    if (!text) return undefined;
    const match = LENGTH_RE.exec(text);
    if (!match) return undefined;
    const num = Number(match[1]);
    if (!Number.isFinite(num)) return undefined;
    const unit = match[2].toLowerCase();
    if (unit === '%') {
        const base = ctx.axis === 'x'
            ? ctx.viewportWidth
            : ctx.axis === 'y'
                ? ctx.viewportHeight
                : Math.hypot(ctx.viewportWidth, ctx.viewportHeight) / Math.SQRT2;
        return Number.isFinite(base) ? (num / 100) * base : undefined;
    }
    if (unit === 'em') return num * ctx.fontSize;
    if (unit === 'ex') return num * ctx.fontSize * 0.5;
    if (unit === 'rem') return num * 16;
    const scale = UNIT_SCALE[unit];
    return scale == null ? undefined : num * scale;
}

function parsePointsList(value: string | undefined): Array<[number, number]> {
    if (!value) return [];
    const tokens = value.split(/[\s,]+/).filter((token) => token.length > 0).map(Number);
    const points: Array<[number, number]> = [];
    for (let i = 0; i + 1 < tokens.length; i += 2) {
        if (Number.isFinite(tokens[i]) && Number.isFinite(tokens[i + 1])) {
            points.push([tokens[i], tokens[i + 1]]);
        }
    }
    return points;
}

// ─── XML 解析 ────────────────────────────────────────────

interface SvgNode {
    tag: string;
    attrs: Record<string, string>;
    children: SvgNode[];
    text: string;
    line?: number;
    column?: number;
}

/** HTML 常用命名实体 → 数字实体（LLM 常误用 &nbsp; 等非 XML 实体） */
const HTML_ENTITY_MAP: Record<string, string> = {
    nbsp: '&#160;', ensp: '&#8194;', emsp: '&#8195;', thinsp: '&#8201;',
    copy: '&#169;', reg: '&#174;', trade: '&#8482;', hellip: '&#8230;',
    mdash: '&#8212;', ndash: '&#8211;', times: '&#215;', divide: '&#247;',
    plusmn: '&#177;', deg: '&#176;', middot: '&#183;', bull: '&#8226;',
    rarr: '&#8594;', larr: '&#8592;', uarr: '&#8593;', darr: '&#8595;',
    ldquo: '&#8220;', rdquo: '&#8221;', lsquo: '&#8216;', rsquo: '&#8217;',
    laquo: '&#171;', raquo: '&#187;', check: '&#10003;', cross: '&#10007;',
};

function desensitizeEntities(source: string): { text: string; count: number } {
    let count = 0;
    const text = source.replace(/&([a-zA-Z][a-zA-Z0-9]*);/g, (whole, name: string) => {
        const replacement = HTML_ENTITY_MAP[name.toLowerCase()];
        if (!replacement) return whole;
        count += 1;
        return replacement;
    });
    return { text, count };
}

/** 记录每个标签名在源文件中的出现行号，按文档顺序消费 */
function buildTagLineIndex(source: string): Map<string, Array<{ line: number; column: number }>> {
    // 先把注释与 CDATA 抹成等长空白，避免其中的假标签干扰定位
    const masked = source
        .replace(/<!--[\s\S]*?-->/g, (chunk) => chunk.replace(/[^\n]/g, ' '))
        .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (chunk) => chunk.replace(/[^\n]/g, ' '));

    const index = new Map<string, Array<{ line: number; column: number }>>();
    const re = /<([A-Za-z_][\w:.-]*)/g;
    let line = 1;
    let lineStart = 0;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(masked)) !== null) {
        for (let i = lastIndex; i < match.index; i += 1) {
            if (masked.charCodeAt(i) === 10) {
                line += 1;
                lineStart = i + 1;
            }
        }
        lastIndex = match.index;
        const rawTag = match[1];
        const tag = rawTag.includes(':') ? rawTag.slice(rawTag.indexOf(':') + 1) : rawTag;
        const list = index.get(tag);
        const entry = { line, column: match.index - lineStart + 1 };
        if (list) list.push(entry);
        else index.set(tag, [entry]);
    }
    return index;
}

function readAttr(node: SvgNode, ...names: string[]): string | undefined {
    for (const name of names) {
        const value = node.attrs[name];
        if (value !== undefined && value !== '') return value;
    }
    return undefined;
}

function parseStyleDeclarations(style: string | undefined): Record<string, string> {
    const result: Record<string, string> = {};
    if (!style) return result;
    for (const declaration of style.split(';')) {
        const idx = declaration.indexOf(':');
        if (idx <= 0) continue;
        const key = declaration.slice(0, idx).trim().toLowerCase();
        const value = declaration.slice(idx + 1).trim();
        if (key) result[key] = value;
    }
    return result;
}

// ─── 绘制样式（继承链） ──────────────────────────────────

interface PaintStyle {
    fill: string;
    stroke: string;
    strokeWidth: number;
    fillOpacity: number;
    strokeOpacity: number;
    opacity: number;
    fontSize: number;
    fontWeight: number;
    letterSpacing: number;
    textAnchor: 'start' | 'middle' | 'end';
    dominantBaseline: string;
    hidden: boolean;
    clipped: boolean;
}

const DEFAULT_STYLE: PaintStyle = {
    fill: '#000000',
    stroke: 'none',
    strokeWidth: 1,
    fillOpacity: 1,
    strokeOpacity: 1,
    opacity: 1,
    fontSize: 16,
    fontWeight: 400,
    letterSpacing: 0,
    textAnchor: 'start',
    dominantBaseline: 'alphabetic',
    hidden: false,
    clipped: false,
};

function resolveStyle(node: SvgNode, parent: PaintStyle, lengthCtx: LengthContext): PaintStyle {
    const declarations = parseStyleDeclarations(readAttr(node, 'style'));
    const lookup = (name: string): string | undefined => {
        const fromStyle = declarations[name];
        if (fromStyle !== undefined) return fromStyle;
        const fromAttr = node.attrs[name];
        return fromAttr === undefined || fromAttr === '' ? undefined : fromAttr;
    };

    const next: PaintStyle = { ...parent };

    const fontSizeRaw = lookup('font-size');
    if (fontSizeRaw != null) {
        const parsed = parseLength(fontSizeRaw, { ...lengthCtx, axis: 'diag' });
        if (parsed != null && parsed > 0) next.fontSize = parsed;
    }

    const innerCtx: LengthContext = { ...lengthCtx, fontSize: next.fontSize };

    const fill = lookup('fill');
    if (fill != null) next.fill = fill.trim().toLowerCase();
    const stroke = lookup('stroke');
    if (stroke != null) next.stroke = stroke.trim().toLowerCase();

    const strokeWidthRaw = lookup('stroke-width');
    if (strokeWidthRaw != null) {
        const parsed = parseLength(strokeWidthRaw, { ...innerCtx, axis: 'diag' });
        if (parsed != null && parsed >= 0) next.strokeWidth = parsed;
    }

    const fillOpacity = lookup('fill-opacity');
    if (fillOpacity != null && Number.isFinite(Number(fillOpacity))) next.fillOpacity = Number(fillOpacity);
    const strokeOpacity = lookup('stroke-opacity');
    if (strokeOpacity != null && Number.isFinite(Number(strokeOpacity))) next.strokeOpacity = Number(strokeOpacity);
    const opacity = lookup('opacity');
    if (opacity != null && Number.isFinite(Number(opacity))) next.opacity = Number(opacity);

    const fontWeight = lookup('font-weight');
    if (fontWeight != null) {
        const numeric = Number(fontWeight);
        next.fontWeight = Number.isFinite(numeric)
            ? numeric
            : /bold|bolder/i.test(fontWeight) ? 700 : 400;
    }

    const letterSpacing = lookup('letter-spacing');
    if (letterSpacing != null && letterSpacing !== 'normal') {
        const parsed = parseLength(letterSpacing, { ...innerCtx, axis: 'diag' });
        if (parsed != null) next.letterSpacing = parsed;
    }

    const anchor = lookup('text-anchor');
    if (anchor === 'middle' || anchor === 'end' || anchor === 'start') next.textAnchor = anchor;

    const baseline = lookup('dominant-baseline') ?? lookup('alignment-baseline');
    if (baseline) next.dominantBaseline = baseline.trim().toLowerCase();

    const display = lookup('display');
    const visibility = lookup('visibility');
    const invisible =
        display === 'none'
        || visibility === 'hidden'
        || visibility === 'collapse'
        || next.opacity === 0;
    if (invisible) next.hidden = true;

    // clip-path / mask 不属于继承属性，但会实际裁剪整个子树 → 溢出不构成视觉缺陷
    if (readAttr(node, 'clip-path') || readAttr(node, 'mask')) next.clipped = true;

    return next;
}

function paintsNothing(tag: string, style: PaintStyle): boolean {
    const noFill = style.fill === 'none' || style.fill === 'transparent' || style.fillOpacity === 0;
    const noStroke = style.stroke === 'none' || style.stroke === 'transparent'
        || style.strokeOpacity === 0 || style.strokeWidth <= 0;
    // <line> 没有可填充的面积，只有描边会绘制
    if (tag === 'line') return noStroke;
    return noFill && noStroke;
}

// ─── 几何计算 ────────────────────────────────────────────

function boxFromPoints(points: Array<[number, number]>): SvgBox | null {
    if (points.length === 0) return null;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of points) {
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
    }
    return { x0, y0, x1, y1 };
}

function transformBox(box: SvgBox, m: Matrix): SvgBox | null {
    const corners: Array<[number, number]> = [
        applyMatrix(m, box.x0, box.y0),
        applyMatrix(m, box.x1, box.y0),
        applyMatrix(m, box.x1, box.y1),
        applyMatrix(m, box.x0, box.y1),
    ];
    return boxFromPoints(corners);
}

/** 轴对齐椭圆经仿射变换后的精确包围盒 */
function transformEllipse(cx: number, cy: number, rx: number, ry: number, m: Matrix): SvgBox {
    const [tx, ty] = applyMatrix(m, cx, cy);
    const hx = Math.hypot(m[0] * rx, m[2] * ry);
    const hy = Math.hypot(m[1] * rx, m[3] * ry);
    return { x0: tx - hx, y0: ty - hy, x1: tx + hx, y1: ty + hy };
}

function expandForStroke(box: SvgBox, style: PaintStyle, m: Matrix): SvgBox {
    if (style.stroke === 'none' || style.stroke === 'transparent' || style.strokeWidth <= 0) return box;
    if (style.strokeOpacity === 0) return box;
    const half = (style.strokeWidth * averageScale(m)) / 2;
    if (!Number.isFinite(half) || half <= 0) return box;
    return { x0: box.x0 - half, y0: box.y0 - half, x1: box.x1 + half, y1: box.y1 + half };
}

function measurePathBox(d: string, m: Matrix): { box: SvgBox | null; error?: string; nonFinite?: boolean } {
    const trimmed = d.trim();
    if (!trimmed) return { box: null };
    try {
        const parsed = svgpath(trimmed);
        const parseError = (parsed as unknown as { err?: string }).err;
        if (parseError) return { box: null, error: parseError };
        const transformed = isIdentity(m)
            ? parsed.toString()
            : parsed.matrix([...m]).toString();
        // 1e999 这类字面量会被 svgpath 解析成 Infinity，渲染器整段丢弃
        if (/NaN|Infinity/i.test(transformed)) return { box: null, nonFinite: true };
        const [x0, y0, x1, y1] = svgPathBbox(transformed);
        const box = boxFromPoints([[x0, y0], [x1, y1]]);
        return { box };
    } catch (error: any) {
        return { box: null, error: error?.message || '路径解析失败' };
    }
}

// ─── 文本宽度估算 ────────────────────────────────────────

function isCJK(code: number): boolean {
    return (
        (code >= 0x1100 && code <= 0x115f)
        || (code >= 0x2e80 && code <= 0x303e)
        || (code >= 0x3041 && code <= 0x33ff)
        || (code >= 0x3400 && code <= 0x4dbf)
        || (code >= 0x4e00 && code <= 0x9fff)
        || (code >= 0xa000 && code <= 0xa4cf)
        || (code >= 0xac00 && code <= 0xd7a3)
        || (code >= 0xf900 && code <= 0xfaff)
        || (code >= 0xfe30 && code <= 0xfe4f)
        || (code >= 0xff00 && code <= 0xff60)
        || (code >= 0xffe0 && code <= 0xffe6)
        || (code >= 0x1f300 && code <= 0x1f9ff)
        || (code >= 0x20000 && code <= 0x2fa1f)
    );
}

const NARROW_CHARS = new Set(['i', 'l', 'I', 'j', 't', 'f', 'r', '1', '!', '.', ',', ':', ';', '|', "'", '`', '(', ')', '[', ']', '-', ' ']);
const WIDE_CHARS = new Set(['m', 'w', 'M', 'W', '@', '%']);

function charWidthFactor(ch: string): number {
    const code = ch.codePointAt(0) ?? 0;
    if (code === 0x20) return 0.3;
    if (isCJK(code)) return 1.0;
    if (NARROW_CHARS.has(ch)) return 0.32;
    if (WIDE_CHARS.has(ch)) return 0.86;
    if (ch >= 'A' && ch <= 'Z') return 0.68;
    if (ch >= '0' && ch <= '9') return 0.56;
    return 0.55;
}

function estimateTextWidth(text: string, style: PaintStyle): number {
    const chars = Array.from(text);
    if (chars.length === 0) return 0;
    let units = 0;
    for (const ch of chars) units += charWidthFactor(ch);
    const boldFactor = style.fontWeight >= 600 ? 1.05 : 1;
    return units * style.fontSize * boldFactor + style.letterSpacing * Math.max(0, chars.length - 1);
}

function textVerticalRange(style: PaintStyle, baselineY: number): [number, number] {
    const ascent = style.fontSize * 0.8;
    const descent = style.fontSize * 0.22;
    switch (style.dominantBaseline) {
        case 'middle':
        case 'central':
            return [baselineY - (ascent + descent) / 2, baselineY + (ascent + descent) / 2];
        case 'hanging':
        case 'text-top':
        case 'text-before-edge':
            return [baselineY, baselineY + ascent + descent];
        case 'ideographic':
        case 'text-bottom':
        case 'text-after-edge':
        case 'bottom':
            return [baselineY - (ascent + descent), baselineY];
        default:
            return [baselineY - ascent, baselineY + descent];
    }
}

interface TextRun {
    text: string;
    x?: number;
    y?: number;
    dx: number;
    dy: number;
}

function collectTextRuns(node: SvgNode, lengthCtx: LengthContext): TextRun[] {
    const ticks = (child: SvgNode): boolean => (
        readAttr(child, 'x') != null
        || readAttr(child, 'y') != null
        || readAttr(child, 'dx') != null
        || readAttr(child, 'dy') != null
    );

    const runs: TextRun[] = [];
    const rootRun: TextRun = {
        text: node.text,
        x: parseLength(readAttr(node, 'x'), { ...lengthCtx, axis: 'x' }),
        y: parseLength(readAttr(node, 'y'), { ...lengthCtx, axis: 'y' }),
        dx: parseLength(readAttr(node, 'dx'), { ...lengthCtx, axis: 'x' }) ?? 0,
        dy: parseLength(readAttr(node, 'dy'), { ...lengthCtx, axis: 'y' }) ?? 0,
    };

    const tspans = node.children.filter((child) => child.tag === 'tspan');
    const positioningTspans = tspans.filter(ticks);

    // 无定位 tspan：整段文本按一个 run 处理（文本是连续排布的）
    if (positioningTspans.length === 0) {
        if (rootRun.text.trim()) runs.push(rootRun);
        return runs;
    }

    if (rootRun.text.trim()) runs.push({ ...rootRun, dx: rootRun.dx, dy: rootRun.dy });
    for (const tspan of tspans) {
        runs.push({
            text: tspan.text,
            x: parseLength(readAttr(tspan, 'x'), { ...lengthCtx, axis: 'x' }),
            y: parseLength(readAttr(tspan, 'y'), { ...lengthCtx, axis: 'y' }),
            dx: parseLength(readAttr(tspan, 'dx'), { ...lengthCtx, axis: 'x' }) ?? 0,
            dy: parseLength(readAttr(tspan, 'dy'), { ...lengthCtx, axis: 'y' }) ?? 0,
        });
    }
    return runs;
}

function measureTextNode(node: SvgNode, m: Matrix, style: PaintStyle, lengthCtx: LengthContext): SvgBox | null {
    const runs = collectTextRuns(node, lengthCtx);
    if (runs.length === 0) return null;

    const points: Array<[number, number]> = [];
    let cursorX = 0;
    let cursorY = 0;
    let positioned = false;

    for (const run of runs) {
        if (run.x != null) {
            cursorX = run.x;
            positioned = true;
        }
        if (run.y != null) {
            cursorY = run.y;
            positioned = true;
        }
        cursorX += run.dx;
        cursorY += run.dy;

        const width = estimateTextWidth(run.text, style);
        let startX = cursorX;
        if (style.textAnchor === 'middle') startX = cursorX - width / 2;
        else if (style.textAnchor === 'end') startX = cursorX - width;

        const [top, bottom] = textVerticalRange(style, cursorY);
        points.push(
            applyMatrix(m, startX, top),
            applyMatrix(m, startX + width, top),
            applyMatrix(m, startX + width, bottom),
            applyMatrix(m, startX, bottom),
        );
        cursorX += width;
    }

    if (!positioned) return null;
    return boxFromPoints(points);
}

function parseViewBox(value: string | undefined): { x: number; y: number; width: number; height: number } | null {
    if (!value) return null;
    const nums = value.trim().split(/[\s,]+/).map(Number);
    if (nums.length < 4 || nums.some((n) => !Number.isFinite(n))) return null;
    if (nums[2] <= 0 || nums[3] <= 0) return null;
    return { x: nums[0], y: nums[1], width: nums[2], height: nums[3] };
}

const PAR_ALIGN: Record<string, number> = { min: 0, mid: 0.5, max: 1 };

function viewBoxToViewportMatrix(
    viewBox: { x: number; y: number; width: number; height: number },
    width: number,
    height: number,
    preserveAspectRatio: string | undefined,
): Matrix {
    const raw = (preserveAspectRatio || 'xMidYMid meet').trim();
    if (raw.startsWith('none')) {
        const sx = width / viewBox.width;
        const sy = height / viewBox.height;
        return [sx, 0, 0, sy, -viewBox.x * sx, -viewBox.y * sy];
    }
    const tokens = raw.split(/\s+/);
    const align = tokens[0] && PAR_ALIGN[tokens[0].slice(1, 4).toLowerCase()] != null ? tokens[0] : 'xMidYMid';
    const scaleMode = tokens[1] === 'slice' ? 'slice' : 'meet';
    const alignX = PAR_ALIGN[align.slice(1, 4).toLowerCase()] ?? 0.5;
    const alignY = PAR_ALIGN[align.slice(5, 8).toLowerCase()] ?? 0.5;

    const sx = width / viewBox.width;
    const sy = height / viewBox.height;
    const scale = scaleMode === 'slice' ? Math.max(sx, sy) : Math.min(sx, sy);
    const tx = alignX * (width - viewBox.width * scale);
    const ty = alignY * (height - viewBox.height * scale);
    return [scale, 0, 0, scale, tx - viewBox.x * scale, ty - viewBox.y * scale];
}

// ─── 检查器主体 ──────────────────────────────────────────

interface MeasuredBox {
    label: string;
    node: SvgNode;
    box: SvgBox;
    approximate: boolean;
    clipped: boolean;
    fontSize: number;
}

const NON_RENDERED_TAGS = new Set([
    'defs', 'symbol', 'clippath', 'mask', 'marker', 'pattern', 'lineargradient',
    'radialgradient', 'filter', 'style', 'title', 'desc', 'metadata', 'script',
    'cursor', 'font', 'font-face', 'animate', 'animatetransform', 'animatemotion',
    'set', 'view', 'color-profile', 'mpath', 'glyph', 'missing-glyph', 'solidcolor',
]);

const CONTAINER_TAGS = new Set(['g', 'a', 'switch']);

class SvgChecker {
    private readonly options: Required<SvgCheckOptions>;
    private readonly boxes: MeasuredBox[] = [];
    private readonly issues: SvgCheckIssue[] = [];
    private readonly idMap = new Map<string, SvgNode>();
    private readonly visiting = new Set<SvgNode>();
    private readonly tagLines: Map<string, Array<{ line: number; column: number }>>;
    private readonly tagCursors = new Map<string, number>();
    private elementCount = 0;
    private skippedCount = 0;

    constructor(
        private readonly source: string,
        options: SvgCheckOptions,
    ) {
        this.options = {
            tolerance: Math.max(0, options.tolerance ?? 0.5),
            includeText: options.includeText !== false,
            includeStroke: options.includeStroke !== false,
            maxIssues: Math.max(1, options.maxIssues ?? 30),
        };
        this.tagLines = buildTagLineIndex(source);
    }

    run(): SvgCheckReport {
        const tree = this.parse();
        if (!tree) {
            const parsedIssues = this.issues;
            return {
                status: 'error',
                viewBox: null,
                contentBBox: null,
                overflow: null,
                issues: parsedIssues,
                totalIssues: parsedIssues.length,
                errorCount: parsedIssues.filter((issue) => issue.severity === 'error').length,
                warningCount: parsedIssues.filter((issue) => issue.severity === 'warning').length,
                stats: { elements: 0, measured: 0, skipped: 0, approximate: 0 },
                summary: parsedIssues[0]?.message || 'SVG 解析失败',
            };
        }

        const root = tree.children.find((child) => child.tag === 'svg');
        if (!root) {
            this.pushIssue({
                code: 'no-svg-root',
                severity: 'error',
                message: '文档根元素不是 <svg>，无法按 SVG 画布校验边界。',
                fix: '把内容包裹在 <svg xmlns="http://www.w3.org/2000/svg" viewBox="..."> 中。',
            });
            return this.buildReport(null);
        }

        this.collectIds(tree.children);

        const parsedViewBox = parseViewBox(readAttr(root, 'viewBox'));
        const width = parseLength(readAttr(root, 'width'), { axis: 'x', viewportWidth: 0, viewportHeight: 0, fontSize: 16 });
        const height = parseLength(readAttr(root, 'height'), { axis: 'y', viewportWidth: 0, viewportHeight: 0, fontSize: 16 });

        let viewBox: { x: number; y: number; width: number; height: number } | null = parsedViewBox;
        if (!parsedViewBox) {
            if (width != null && height != null && width > 0 && height > 0) {
                viewBox = { x: 0, y: 0, width, height };
                this.pushIssue({
                    code: 'missing-viewbox',
                    severity: 'warning',
                    message: `缺少 viewBox，已按 width/height 推得画布 0 0 ${width} ${height}。`,
                    element: 'svg',
                    line: root.line,
                    fix: '显式声明 viewBox，避免不同容器尺寸下缩放不一致。',
                });
            } else {
                this.pushIssue({
                    code: 'missing-viewbox',
                    severity: 'warning',
                    message: '缺少可用的 viewBox（且 width/height 不是绝对长度），无法判定画布边界。',
                    element: 'svg',
                    line: root.line,
                    fix: '补充 viewBox="0 0 宽 高"。',
                });
            }
        }

        const canvasWidth = viewBox?.width ?? 300;
        const canvasHeight = viewBox?.height ?? 150;

        const baseCtx: LengthContext = {
            axis: 'x',
            viewportWidth: canvasWidth,
            viewportHeight: canvasHeight,
            fontSize: 16,
        };

        const rootTransform = multiplyMatrix(IDENTITY, parseTransform(readAttr(root, 'transform')));
        const rootStyle = resolveStyle(root, DEFAULT_STYLE, baseCtx);
        this.walkChildren(root, rootTransform, rootStyle, canvasWidth, canvasHeight);

        if (this.boxes.length === 0 && this.issues.length === 0) {
            this.pushIssue({
                code: 'empty-svg',
                severity: 'warning',
                message: '没有找到任何可绘制图元（path/rect/text...），画布为空。',
                element: 'svg',
                line: root.line,
                fix: '检查元素是否被 display:none、opacity:0 或未渲染的 <defs> 包裹。',
            });
        }

        this.analyzeBounds(viewBox);
        return this.buildReport(viewBox);
    }

    // ── 解析 ──────────────────────────────────────────────

    private parse(): { children: SvgNode[] } | null {
        const validation = XMLValidator.validate(this.source);
        if (validation !== true) {
            const err = (validation as { err?: { code?: string; msg?: string; line?: number; col?: number } }).err;
            const lenient = desensitizeEntities(this.source);
            if (lenient.count > 0 && XMLValidator.validate(lenient.text) === true) {
                this.pushIssue({
                    code: 'invalid-named-entity',
                    severity: 'warning',
                    message: `使用了 ${lenient.count} 处非 XML 命名实体（如 &nbsp;），独立 SVG 文件按 XML 规则会解析失败。`,
                    fix: '改用数字实体（如 &#160;）或直接使用字符本身。',
                });
                return this.parseWith(lenient.text);
            }
            this.pushIssue({
                code: 'xml-invalid',
                severity: 'error',
                message: `XML 良构性错误（第 ${err?.line ?? '?'} 行第 ${err?.col ?? '?'} 列）：${err?.msg || '解析失败'}`,
                line: err?.line,
                column: err?.col,
                fix: '补全/闭合标签，检查属性引号与非法字符。',
            });
            return null;
        }
        const result = this.parseWith(this.source);
        if (!result) {
            this.pushIssue({
                code: 'xml-invalid',
                severity: 'error',
                message: 'XML 解析结果为空，无法继续校验。',
            });
        }
        return result;
    }

    private parseWith(source: string): { children: SvgNode[] } | null {
        const parser = new XMLParser({
            ignoreAttributes: false,
            attributeNamePrefix: '',
            preserveOrder: true,
            parseTagValue: false,
            parseAttributeValue: false,
            trimValues: false,
            allowBooleanAttributes: true,
            ignoreDeclaration: true,
            ignorePiTags: true,
            commentPropName: '#comment',
            cdataPropName: '#cdata',
        });
        try {
            const parsed = parser.parse(source) as unknown[];
            return this.convertNodes(parsed);
        } catch {
            return null;
        }
    }

    private convertNodes(rawNodes: unknown[]): { children: SvgNode[]; text: string } {
        const children: SvgNode[] = [];
        let text = '';
        for (const raw of rawNodes) {
            const node = raw as Record<string, unknown>;
            const attrsRaw = node[':@'];
            const attrs: Record<string, string> = {};
            if (attrsRaw && typeof attrsRaw === 'object') {
                for (const [key, value] of Object.entries(attrsRaw as Record<string, unknown>)) {
                    attrs[key] = value == null ? '' : String(value);
                }
            }

            const tagKey = Object.keys(node).find((key) => key !== ':@' && !key.startsWith('#'));
            if (!tagKey) {
                // 文本 / CDATA 属于当前元素自身的内容
                const textValue = node['#text'] ?? node['#cdata'];
                if (typeof textValue === 'string') text += textValue;
                continue;
            }

            const tag = tagKey.includes(':') ? tagKey.slice(tagKey.indexOf(':') + 1) : tagKey;
            const childRaw = node[tagKey];
            const inner = Array.isArray(childRaw)
                ? this.convertNodes(childRaw)
                : { children: [], text: '' };
            const svgNode: SvgNode = { tag, attrs, children: inner.children, text: inner.text };
            this.assignPosition(svgNode);
            children.push(svgNode);
        }
        return { children, text };
    }

    private assignPosition(node: SvgNode): void {
        const entries = this.tagLines.get(node.tag);
        if (!entries) return;
        const cursor = this.tagCursors.get(node.tag) ?? 0;
        const entry = entries[cursor];
        if (!entry) return;
        this.tagCursors.set(node.tag, cursor + 1);
        node.line = entry.line;
        node.column = entry.column;
    }

    private collectIds(nodes: SvgNode[]): void {
        for (const node of nodes) {
            const id = node.attrs.id;
            if (id && !this.idMap.has(id)) this.idMap.set(id, node);
            if (node.children.length > 0) this.collectIds(node.children);
        }
    }

    // ── 遍历 ──────────────────────────────────────────────

    private walkChildren(
        parent: SvgNode,
        ctm: Matrix,
        style: PaintStyle,
        viewportWidth: number,
        viewportHeight: number,
    ): void {
        for (const child of parent.children) {
            this.walk(child, ctm, style, viewportWidth, viewportHeight);
        }
    }

    private walk(
        node: SvgNode,
        ctm: Matrix,
        parentStyle: PaintStyle,
        viewportWidth: number,
        viewportHeight: number,
    ): void {
        this.elementCount += 1;
        const tag = node.tag;
        if (NON_RENDERED_TAGS.has(tag.toLowerCase())) {
            this.skippedCount += 1;
            return;
        }

        const lengthCtx: LengthContext = {
            axis: 'x',
            viewportWidth,
            viewportHeight,
            fontSize: parentStyle.fontSize,
        };
        const style = resolveStyle(node, parentStyle, lengthCtx);
        if (style.hidden) {
            this.skippedCount += 1;
            return;
        }

        const localTransform = parseTransform(readAttr(node, 'transform'));
        const nodeCtm = isIdentity(localTransform) ? ctm : multiplyMatrix(ctm, localTransform);

        if (CONTAINER_TAGS.has(tag)) {
            this.walkChildren(node, nodeCtm, style, viewportWidth, viewportHeight);
            return;
        }

        if (tag === 'svg') {
            this.walkNestedSvg(node, nodeCtm, style, viewportWidth, viewportHeight);
            return;
        }

        if (tag === 'use') {
            this.walkUse(node, nodeCtm, style, viewportWidth, viewportHeight);
            return;
        }

        if (tag === 'text') {
            this.measureText(node, nodeCtm, style, lengthCtx);
            return;
        }

        if (tag === 'textpath') {
            this.pushIssue({
                code: 'unsupported-textpath',
                severity: 'warning',
                message: '<textPath> 沿路径排布，未参与边界测量。',
                element: this.labelOf(node),
                line: node.line,
                approximate: true,
            });
            return;
        }

        if (paintsNothing(tag, style) && tag !== 'image' && tag !== 'foreignobject') {
            this.skippedCount += 1;
            return;
        }

        const box = this.measureShape(node, nodeCtm, style, lengthCtx, viewportWidth, viewportHeight);
        if (box) {
            this.record(node, box, style, false, style.clipped);
        }
    }

    private walkNestedSvg(
        node: SvgNode,
        ctm: Matrix,
        style: PaintStyle,
        viewportWidth: number,
        viewportHeight: number,
    ): void {
        const lengthCtx: LengthContext = { axis: 'x', viewportWidth, viewportHeight, fontSize: style.fontSize };
        const x = parseLength(readAttr(node, 'x'), { ...lengthCtx, axis: 'x' }) ?? 0;
        const y = parseLength(readAttr(node, 'y'), { ...lengthCtx, axis: 'y' }) ?? 0;
        const width = parseLength(readAttr(node, 'width'), { ...lengthCtx, axis: 'x' }) ?? viewportWidth;
        const height = parseLength(readAttr(node, 'height'), { ...lengthCtx, axis: 'y' }) ?? viewportHeight;

        let nodeCtm = multiplyMatrix(ctm, [1, 0, 0, 1, x, y]);
        const innerViewBox = parseViewBox(readAttr(node, 'viewBox'));
        if (innerViewBox && width > 0 && height > 0) {
            nodeCtm = multiplyMatrix(
                nodeCtm,
                viewBoxToViewportMatrix(innerViewBox, width, height, readAttr(node, 'preserveAspectRatio')),
            );
        }

        // 嵌套 <svg> 自带视口裁剪，内部溢出不会破坏外层画布
        this.walkChildren(node, nodeCtm, { ...style, clipped: true }, width, height);
    }

    private walkUse(
        node: SvgNode,
        ctm: Matrix,
        style: PaintStyle,
        viewportWidth: number,
        viewportHeight: number,
    ): void {
        const href = readAttr(node, 'href', 'xlink:href');
        const targetId = href && href.startsWith('#') ? href.slice(1) : null;
        if (!targetId) {
            this.pushIssue({
                code: 'use-without-href',
                severity: 'warning',
                message: '<use> 缺少 href="#id"，不会渲染任何内容。',
                element: this.labelOf(node),
                line: node.line,
                fix: '写成 <use href="#元素id" x=".." y=".."/>。',
            });
            return;
        }
        const target = this.idMap.get(targetId);
        if (!target) {
            this.pushIssue({
                code: 'unresolved-use',
                severity: 'warning',
                message: `<use> 引用的 #${targetId} 不存在，该处会渲染为空白。`,
                element: this.labelOf(node),
                line: node.line,
                fix: '确认被引用元素有对应 id 且位于同一文档内。',
            });
            return;
        }
        if (this.visiting.has(target)) {
            this.pushIssue({
                code: 'cyclic-use',
                severity: 'warning',
                message: `#${targetId} 存在循环引用，已跳过。`,
                element: this.labelOf(node),
                line: node.line,
            });
            return;
        }

        const lengthCtx: LengthContext = { axis: 'x', viewportWidth, viewportHeight, fontSize: style.fontSize };
        const x = parseLength(readAttr(node, 'x'), { ...lengthCtx, axis: 'x' }) ?? 0;
        const y = parseLength(readAttr(node, 'y'), { ...lengthCtx, axis: 'y' }) ?? 0;
        let useCtm = multiplyMatrix(ctm, [1, 0, 0, 1, x, y]);

        if (target.tag === 'symbol') {
            const width = parseLength(readAttr(node, 'width'), { ...lengthCtx, axis: 'x' });
            const height = parseLength(readAttr(node, 'height'), { ...lengthCtx, axis: 'y' });
            const symbolViewBox = parseViewBox(readAttr(target, 'viewBox'));
            if (symbolViewBox && width && height) {
                useCtm = multiplyMatrix(
                    useCtm,
                    viewBoxToViewportMatrix(symbolViewBox, width, height, readAttr(target, 'preserveAspectRatio')),
                );
            }
            this.visiting.add(target);
            this.walkChildren(target, useCtm, style, width ?? viewportWidth, height ?? viewportHeight);
            this.visiting.delete(target);
            return;
        }

        this.visiting.add(target);
        this.walk(target, useCtm, style, viewportWidth, viewportHeight);
        this.visiting.delete(target);
    }

    private measureShape(
        node: SvgNode,
        ctm: Matrix,
        style: PaintStyle,
        lengthCtx: LengthContext,
        viewportWidth: number,
        viewportHeight: number,
    ): SvgBox | null {
        const ctx = { ...lengthCtx, viewportWidth, viewportHeight };
        const tag = node.tag;

        if (tag === 'path') {
            const d = readAttr(node, 'd');
            if (!d) {
                this.pushIssue({
                    code: 'missing-path-data',
                    severity: 'warning',
                    message: '<path> 缺少 d 属性，不会渲染。',
                    element: this.labelOf(node),
                    line: node.line,
                });
                return null;
            }
            const { box, error, nonFinite } = measurePathBox(d, ctm);
            if (nonFinite) {
                this.pushIssue({
                    code: 'invalid-coordinate',
                    severity: 'error',
                    message: `${this.labelOf(node)} 的路径坐标包含 NaN/Infinity，渲染器会整段丢弃。`,
                    element: this.labelOf(node),
                    line: node.line,
                    column: node.column,
                    fix: '检查数值字面量，避免指数溢出写法（如 1e999）或除零。',
                });
                return null;
            }
            if (error) {
                this.pushIssue({
                    code: 'invalid-path-data',
                    severity: 'error',
                    message: `路径数据无法解析：${error}`,
                    element: this.labelOf(node),
                    line: node.line,
                    fix: '检查 d 属性中的命令字母与参数个数是否配对。',
                });
                return null;
            }
            if (!box) return null;
            return this.applyStroke(box, style, ctm);
        }

        if (tag === 'rect') {
            const x = parseLength(readAttr(node, 'x'), { ...ctx, axis: 'x' }) ?? 0;
            const y = parseLength(readAttr(node, 'y'), { ...ctx, axis: 'y' }) ?? 0;
            const w = parseLength(readAttr(node, 'width'), { ...ctx, axis: 'x' });
            const h = parseLength(readAttr(node, 'height'), { ...ctx, axis: 'y' });
            if (w == null || h == null) {
                this.pushInvalidLength(node, 'rect 缺少有效的 width/height');
                return null;
            }
            if (w <= 0 || h <= 0) {
                this.pushZeroSize(node, 'rect', w, h);
                return null;
            }
            const box = transformBox({ x0: x, y0: y, x1: x + w, y1: y + h }, ctm);
            return box ? this.applyStroke(box, style, ctm) : null;
        }

        if (tag === 'circle' || tag === 'ellipse') {
            const cx = parseLength(readAttr(node, 'cx'), { ...ctx, axis: 'x' }) ?? 0;
            const cy = parseLength(readAttr(node, 'cy'), { ...ctx, axis: 'y' }) ?? 0;
            const rx = tag === 'circle'
                ? parseLength(readAttr(node, 'r'), { ...ctx, axis: 'diag' })
                : parseLength(readAttr(node, 'rx'), { ...ctx, axis: 'x' });
            const ry = tag === 'circle'
                ? rx
                : parseLength(readAttr(node, 'ry'), { ...ctx, axis: 'y' });
            if (rx == null || ry == null) {
                this.pushInvalidLength(node, `${tag} 缺少有效的半径`);
                return null;
            }
            if (rx <= 0 || ry <= 0) {
                this.pushZeroSize(node, tag, rx * 2, ry * 2);
                return null;
            }
            const box = transformEllipse(cx, cy, rx, ry, ctm);
            return this.applyStroke(box, style, ctm);
        }

        if (tag === 'line') {
            const x1 = parseLength(readAttr(node, 'x1'), { ...ctx, axis: 'x' }) ?? 0;
            const y1 = parseLength(readAttr(node, 'y1'), { ...ctx, axis: 'y' }) ?? 0;
            const x2 = parseLength(readAttr(node, 'x2'), { ...ctx, axis: 'x' }) ?? 0;
            const y2 = parseLength(readAttr(node, 'y2'), { ...ctx, axis: 'y' }) ?? 0;
            const box = boxFromPoints([applyMatrix(ctm, x1, y1), applyMatrix(ctm, x2, y2)]);
            if (!box) return null;
            if (x1 === x2 && y1 === y2) {
                this.pushZeroSize(node, 'line', 0, 0);
                return null;
            }
            return this.applyStroke(box, style, ctm);
        }

        if (tag === 'polyline' || tag === 'polygon') {
            const points = parsePointsList(readAttr(node, 'points'));
            if (points.length === 0) {
                this.pushIssue({
                    code: 'invalid-points',
                    severity: 'error',
                    message: `<${tag}> 的 points 属性为空或不是成对坐标。`,
                    element: this.labelOf(node),
                    line: node.line,
                    fix: '写成 points="x1,y1 x2,y2 ..."（坐标必须成对）。',
                });
                return null;
            }
            const box = boxFromPoints(points.map(([x, y]) => applyMatrix(ctm, x, y)));
            return box ? this.applyStroke(box, style, ctm) : null;
        }

        if (tag === 'image' || tag === 'foreignobject') {
            const x = parseLength(readAttr(node, 'x'), { ...ctx, axis: 'x' }) ?? 0;
            const y = parseLength(readAttr(node, 'y'), { ...ctx, axis: 'y' }) ?? 0;
            const w = parseLength(readAttr(node, 'width'), { ...ctx, axis: 'x' });
            const h = parseLength(readAttr(node, 'height'), { ...ctx, axis: 'y' });
            if (w == null || h == null || w <= 0 || h <= 0) {
                this.pushInvalidLength(node, `<${tag}> 缺少有效的 width/height`);
                return null;
            }
            return transformBox({ x0: x, y0: y, x1: x + w, y1: y + h }, ctm);
        }

        // 未知/未实现的绘制标签：只提示，不测量
        this.skippedCount += 1;
        return null;
    }

    private measureText(node: SvgNode, ctm: Matrix, style: PaintStyle, lengthCtx: LengthContext): void {
        if (!this.options.includeText) {
            this.skippedCount += 1;
            return;
        }
        if (paintsNothing('text', style)) {
            this.skippedCount += 1;
            return;
        }
        const box = measureTextNode(node, ctm, style, lengthCtx);
        if (!box) {
            this.pushIssue({
                code: 'text-without-position',
                severity: 'warning',
                message: '<text> 没有 x/y 坐标，位置不确定，已跳过测量。',
                element: this.labelOf(node),
                line: node.line,
                approximate: true,
            });
            return;
        }
        this.record(node, box, style, true, style.clipped);
    }

    private applyStroke(box: SvgBox, style: PaintStyle, ctm: Matrix): SvgBox {
        if (!this.options.includeStroke) return box;
        return expandForStroke(box, style, ctm);
    }

    private record(
        node: SvgNode,
        box: SvgBox,
        style: PaintStyle,
        approximate: boolean,
        clipped: boolean,
    ): void {
        if (![box.x0, box.y0, box.x1, box.y1].every((value) => Number.isFinite(value))) {
            this.pushIssue({
                code: 'invalid-coordinate',
                severity: 'error',
                message: `${this.labelOf(node)} 的坐标包含 NaN/Infinity，渲染器会整段丢弃。`,
                element: this.labelOf(node),
                line: node.line,
                fix: '检查数值字面量，避免除零或指数溢出写法（如 1e999）。',
            });
            return;
        }
        this.boxes.push({
            label: this.labelOf(node),
            node,
            box,
            approximate,
            clipped: clipped || style.clipped,
            fontSize: style.fontSize,
        });
    }

    // ── 溢出判定 ──────────────────────────────────────────

    private analyzeBounds(viewBox: { x: number; y: number; width: number; height: number } | null): void {
        if (!viewBox) return;
        const tolerance = this.options.tolerance;
        const right = viewBox.x + viewBox.width;
        const bottom = viewBox.y + viewBox.height;

        for (const measured of this.boxes) {
            const { box } = measured;
            // 文本宽度是估算值，留半行字高的容差，避免 1~2px 噪声误判为错误
            const slack = measured.approximate
                ? Math.max(tolerance, measured.fontSize * 0.5)
                : tolerance;
            const overLeft = viewBox.x - box.x0;
            const overTop = viewBox.y - box.y0;
            const overRight = box.x1 - right;
            const overBottom = box.y1 - bottom;

            const sides: string[] = [];
            if (overLeft > slack) sides.push('left');
            if (overTop > slack) sides.push('top');
            if (overRight > slack) sides.push('right');
            if (overBottom > slack) sides.push('bottom');
            if (sides.length === 0) continue;

            const maxOverflow = Math.max(overLeft, overTop, overRight, overBottom);
            const severity: SvgIssueSeverity = measured.clipped ? 'warning' : 'error';
            const sideNames: Record<string, string> = {
                left: '左', top: '上', right: '右', bottom: '下',
            };
            const detail = [
                overLeft > slack ? `左 +${overLeft.toFixed(1)}` : '',
                overTop > slack ? `上 +${overTop.toFixed(1)}` : '',
                overRight > slack ? `右 +${overRight.toFixed(1)}` : '',
                overBottom > slack ? `下 +${overBottom.toFixed(1)}` : '',
            ].filter(Boolean).join('，');

            this.pushIssue({
                code: 'overflow',
                severity,
                message: `${measured.label} 超出画布${sides.map((side) => sideNames[side]).join('/')}边界（${detail}）`
                    + (measured.clipped ? '；该元素在裁剪容器内，通常可忽略' : ''),
                element: measured.label,
                line: measured.node.line,
                column: measured.node.column,
                bounds: [box.x0, box.y0, box.x1, box.y1],
                overflow: Number(maxOverflow.toFixed(1)),
                sides,
                approximate: measured.approximate || undefined,
                fix: this.buildOverflowFix(measured, viewBox),
            });
        }
    }

    private buildOverflowFix(measured: MeasuredBox, viewBox: { x: number; y: number; width: number; height: number }): string {
        const box = measured.box;
        const right = viewBox.x + viewBox.width;
        const bottom = viewBox.y + viewBox.height;
        const overLeft = Math.max(0, viewBox.x - box.x0);
        const overRight = Math.max(0, box.x1 - right);
        const overTop = Math.max(0, viewBox.y - box.y0);
        const overBottom = Math.max(0, box.y1 - bottom);

        const moves: string[] = [];
        if (overLeft > 0 && overRight > 0) moves.push(`宽度收缩 ≥${Math.ceil(overLeft + overRight)}`);
        else if (overLeft > 0) moves.push(`右移 ≥${Math.ceil(overLeft)}`);
        else if (overRight > 0) moves.push(`左移或缩窄 ≥${Math.ceil(overRight)}`);

        if (overTop > 0 && overBottom > 0) moves.push(`高度收缩 ≥${Math.ceil(overTop + overBottom)}`);
        else if (overTop > 0) moves.push(`下移 ≥${Math.ceil(overTop)}`);
        else if (overBottom > 0) moves.push(`上移或缩短 ≥${Math.ceil(overBottom)}`);

        const newWidth = Math.ceil(Math.max(viewBox.width, box.x1 - viewBox.x));
        const newHeight = Math.ceil(Math.max(viewBox.height, box.y1 - viewBox.y));
        return `${moves.join('；')}；或把 viewBox 改为 "${viewBox.x} ${viewBox.y} ${newWidth} ${newHeight}" 以容纳它`;
    }

    // ── 报告 ──────────────────────────────────────────────

    private buildReport(viewBox: { x: number; y: number; width: number; height: number } | null): SvgCheckReport {
        const box = this.unionBox(this.boxes.map((item) => item.box));
        const overflow = box && viewBox
            ? {
                left: Math.max(0, viewBox.x - box.x0),
                top: Math.max(0, viewBox.y - box.y0),
                right: Math.max(0, box.x1 - (viewBox.x + viewBox.width)),
                bottom: Math.max(0, box.y1 - (viewBox.y + viewBox.height)),
            }
            : null;

        const severityRank: Record<SvgIssueSeverity, number> = { error: 0, warning: 1 };
        this.issues.sort((a, b) => {
            const bySeverity = severityRank[a.severity] - severityRank[b.severity];
            if (bySeverity !== 0) return bySeverity;
            return (b.overflow ?? 0) - (a.overflow ?? 0);
        });

        const errorCount = this.issues.filter((issue) => issue.severity === 'error').length;
        const warningCount = this.issues.length - errorCount;
        const status: SvgCheckReport['status'] = errorCount > 0 ? 'error' : this.issues.length > 0 ? 'warn' : 'ok';
        const issues = this.issues.slice(0, this.options.maxIssues);

        const stats = {
            elements: this.elementCount,
            measured: this.boxes.length,
            skipped: this.skippedCount,
            approximate: this.boxes.filter((item) => item.approximate).length,
        };

        return {
            status,
            viewBox: viewBox ? [viewBox.x, viewBox.y, viewBox.width, viewBox.height] : null,
            contentBBox: box ? [box.x0, box.y0, box.x1, box.y1] : null,
            overflow,
            issues,
            totalIssues: this.issues.length,
            errorCount,
            warningCount,
            stats,
            summary: this.buildSummary(status, viewBox, box, errorCount, stats),
        };
    }

    private buildSummary(
        status: SvgCheckReport['status'],
        viewBox: { x: number; y: number; width: number; height: number } | null,
        box: SvgBox | null,
        errorCount: number,
        stats: SvgCheckReport['stats'],
    ): string {
        const tag = status === 'error' ? 'FAIL' : status === 'warn' ? 'WARN' : 'OK';
        const parts = [`${tag}`];
        parts.push(viewBox ? `viewBox=${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}` : 'viewBox=缺失');
        if (box) parts.push(`content=${this.fmtBox(box)}`);
        if (errorCount > 0) parts.push(`${errorCount} 处越界`);
        else if (this.issues.length > 0) parts.push(`${this.issues.length} 条告警`);
        parts.push(`elements=${stats.elements}`);
        const firstIssue = this.issues.find((issue) => issue.severity === (errorCount > 0 ? 'error' : 'warning'));
        if (firstIssue) {
            const where = firstIssue.line ? `L${firstIssue.line} ` : '';
            parts.push(`${where}${firstIssue.message}`);
        }
        return parts.join(' | ');
    }

    private unionBox(boxes: SvgBox[]): SvgBox | null {
        if (boxes.length === 0) return null;
        let result = boxes[0];
        for (const box of boxes.slice(1)) {
            result = {
                x0: Math.min(result.x0, box.x0),
                y0: Math.min(result.y0, box.y0),
                x1: Math.max(result.x1, box.x1),
                y1: Math.max(result.y1, box.y1),
            };
        }
        return result;
    }

    private fmtBox(box: SvgBox): string {
        return `${round(box.x0)},${round(box.y0)} ${round(box.x1)},${round(box.y1)}`;
    }

    private labelOf(node: SvgNode): string {
        const id = node.attrs.id;
        return id ? `${node.tag}#${id}` : node.tag;
    }

    private pushIssue(issue: SvgCheckIssue): void {
        this.issues.push(issue);
    }

    private pushInvalidLength(node: SvgNode, message: string): void {
        this.pushIssue({
            code: 'invalid-length',
            severity: 'error',
            message,
            element: this.labelOf(node),
            line: node.line,
            column: node.column,
            fix: '改为无单位数值或 px / % 等可解析长度。',
        });
    }

    private pushZeroSize(node: SvgNode, tag: string, width: number, height: number): void {
        this.pushIssue({
            code: 'zero-size-element',
            severity: 'warning',
            message: `<${tag}> 尺寸为 0（${round(width)}×${round(height)}），不会渲染出可见内容。`,
            element: this.labelOf(node),
            line: node.line,
            column: node.column,
            fix: '给出正数的 width/height 或半径。',
        });
    }
}

function round(value: number): number {
    return Math.round(value * 100) / 100;
}

// ─── 对外 API ────────────────────────────────────────────

export class SvgCheckService {
    /** 校验内存中的 SVG 源码 */
    static checkSource(source: string, options: SvgCheckOptions = {}): SvgCheckReport {
        try {
            return new SvgChecker(String(source ?? ''), options).run();
        } catch (error: any) {
            const issues: SvgCheckIssue[] = [{
                code: 'checker-crash',
                severity: 'error',
                message: `SVG 检查器异常：${error?.message || error}`,
            }];
            return {
                status: 'error',
                viewBox: null,
                contentBBox: null,
                overflow: null,
                issues,
                totalIssues: 1,
                errorCount: 1,
                warningCount: 0,
                stats: { elements: 0, measured: 0, skipped: 0, approximate: 0 },
                summary: `FAIL | SVG 检查器异常：${error?.message || error}`,
            };
        }
    }

    /** 校验工作区内的 SVG 文件 */
    static async checkFile(
        workspaceRoot: string,
        relativePath: string,
        options: SvgCheckOptions = {},
    ): Promise<SvgCheckReport> {
        const fullPath = PathUtils.resolveReadPath(relativePath, workspaceRoot);
        const raw = await fs.readFile(fullPath);
        const { content } = FileIO.decodeBuffer(raw);
        return this.checkSource(content, options);
    }
}

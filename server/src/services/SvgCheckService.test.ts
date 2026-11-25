import { describe, expect, it } from 'vitest';
import { SvgCheckService } from './SvgCheckService.js';

const svg = (viewBox: string, body: string) =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${viewBox}">${body}</svg>`;

const codes = (report: ReturnType<typeof SvgCheckService.checkSource>) =>
    report.issues.map((issue) => issue.code);

describe('SvgCheckService — 边界判定', () => {
    it('全部元素在画布内时通过，并给出内容包围盒', () => {
        const report = SvgCheckService.checkSource(svg('0 0 100 100', '<rect x="10" y="20" width="40" height="30"/>'));

        expect(report.status).toBe('ok');
        expect(report.issues).toEqual([]);
        expect(report.viewBox).toEqual([0, 0, 100, 100]);
        expect(report.contentBBox).toEqual([10, 20, 50, 50]);
        expect(report.overflow).toEqual({ left: 0, top: 0, right: 0, bottom: 0 });
    });

    it('报告右边界溢出的像素值与修正建议', () => {
        const report = SvgCheckService.checkSource(svg('0 0 100 100', '<rect x="90" y="10" width="30" height="20"/>'));

        expect(report.status).toBe('error');
        const [issue] = report.issues;
        expect(issue.code).toBe('overflow');
        expect(issue.sides).toEqual(['right']);
        expect(issue.overflow).toBeCloseTo(20, 5);
        expect(issue.line).toBe(1);
        expect(issue.fix).toContain('≥20');
        expect(issue.fix).toContain('"0 0 120 100"');
    });

    it('把 stroke-width 的一半计入边界（贴边矩形加描边必然溢出）', () => {
        const plain = SvgCheckService.checkSource(svg('0 0 100 100', '<rect width="100" height="100"/>'));
        const stroked = SvgCheckService.checkSource(
            svg('0 0 100 100', '<rect width="100" height="100" fill="none" stroke="#000" stroke-width="4"/>'),
        );

        expect(plain.status).toBe('ok');
        expect(stroked.status).toBe('error');
        expect(stroked.issues[0].overflow).toBeCloseTo(2, 5);
        expect(stroked.issues[0].sides).toEqual(['left', 'top', 'right', 'bottom']);
    });

    it('先把 transform 应用到坐标再判定边界', () => {
        const inside = SvgCheckService.checkSource(svg(
            '0 0 100 100',
            '<g transform="translate(10 10)"><rect width="20" height="20"/></g>',
        ));
        const outside = SvgCheckService.checkSource(svg(
            '0 0 100 100',
            '<g transform="translate(90 10)"><rect width="20" height="20"/></g>',
        ));

        expect(inside.status).toBe('ok');
        expect(outside.status).toBe('error');
        expect(outside.issues[0].overflow).toBeCloseTo(10, 5);
    });

    it('旋转元素的包围盒取变换后角点，不误报', () => {
        const report = SvgCheckService.checkSource(svg(
            '0 0 100 100',
            '<rect x="40" y="40" width="20" height="20" transform="rotate(45 50 50)"/>',
        ));

        expect(report.status).toBe('ok');
        expect(report.contentBBox![0]).toBeCloseTo(50 - Math.sqrt(200), 4);
    });

    it('圆弧路径的包围盒包含弧顶', () => {
        const report = SvgCheckService.checkSource(svg(
            '0 0 100 100',
            '<path d="M10 50 A 40 40 0 0 1 90 50" fill="none" stroke="#000" stroke-width="2"/>',
        ));

        expect(report.status).toBe('ok');
        expect(report.contentBBox).toEqual([expect.closeTo(9, 5), expect.closeTo(9, 5), expect.closeTo(91, 5), expect.closeTo(51, 5)]);
    });

    it('非 0 0 起始的 viewBox 用绝对坐标比较', () => {
        const report = SvgCheckService.checkSource(svg('-50 -50 100 100', '<rect x="-60" y="0" width="10" height="10"/>'));

        expect(report.status).toBe('error');
        expect(report.issues[0].sides).toEqual(['left']);
        expect(report.issues[0].overflow).toBeCloseTo(10, 5);
    });
});

describe('SvgCheckService — 文本估算', () => {
    it('文本宽度超出画布时报告溢出并标记 approximate', () => {
        const report = SvgCheckService.checkSource(svg(
            '0 0 200 60',
            '<text x="10" y="30" font-size="20">This label is far too long for the canvas width</text>',
        ));

        expect(report.status).toBe('error');
        expect(report.issues[0].approximate).toBe(true);
        expect(report.issues[0].sides).toEqual(['right']);
        expect(report.stats.approximate).toBe(1);
    });

    it('估算容差内（不足半个字高）不报错', () => {
        const body = '<text x="97" y="30" font-size="16">i</text>';
        const report = SvgCheckService.checkSource(svg('0 0 100 60', body));

        // 估算溢出约 2px，未超过半字高（8px）容差
        expect(report.status).toBe('ok');
        expect(report.issues).toEqual([]);
        // 同样内容放宽到几何容差后仍不应报错（证明是文本估算容差在起作用）
        expect(SvgCheckService.checkSource(svg('0 0 100 60', body), { tolerance: 0.5 }).status).toBe('ok');
    });

    it('text-anchor=middle 以锚点为中心展开', () => {
        const report = SvgCheckService.checkSource(svg(
            '0 0 200 60',
            '<text x="100" y="30" font-size="20" text-anchor="middle">Centered</text>',
        ));

        const [x0, , x1] = report.contentBBox!;
        expect(100 - x0).toBeCloseTo(x1 - 100, 4);
    });

    it('把 tspan 的定位坐标纳入测量', () => {
        const report = SvgCheckService.checkSource(svg(
            '0 0 100 100',
            '<text x="10" y="20" font-size="10"><tspan x="10" y="20">a</tspan><tspan x="95" y="20">b</tspan></text>',
        ));

        expect(report.status).toBe('ok');
        expect(report.contentBBox![2]).toBeGreaterThan(95);
    });
});

describe('SvgCheckService — 结构与引用', () => {
    it('XML 不良构时返回 xml-invalid 并带行列号', () => {
        const report = SvgCheckService.checkSource('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><g></svg>');

        expect(report.status).toBe('error');
        expect(report.issues[0].code).toBe('xml-invalid');
        expect(report.issues[0].line).toBe(1);
    });

    it('解析 <use> 引用并在 x/y 偏移后判定边界', () => {
        const report = SvgCheckService.checkSource(svg(
            '0 0 100 100',
            '<defs><rect id="r" width="20" height="20"/></defs><use href="#r" x="90" y="10"/>',
        ));

        expect(report.status).toBe('error');
        expect(report.issues[0].element).toBe('rect#r');
        expect(report.issues[0].overflow).toBeCloseTo(10, 5);
    });

    it('<use> 引用不存在时给出 warning 而不是崩溃', () => {
        const report = SvgCheckService.checkSource(svg('0 0 100 100', '<use href="#missing" x="10" y="10"/>'));

        expect(report.status).toBe('warn');
        expect(codes(report)).toContain('unresolved-use');
    });

    it('裁剪容器内的越界降级为 warning', () => {
        const report = SvgCheckService.checkSource(svg(
            '0 0 100 100',
            '<clipPath id="c"><rect width="100" height="100"/></clipPath>'
            + '<g clip-path="url(#c)"><rect x="90" width="40" height="20"/></g>',
        ));

        expect(report.status).toBe('warn');
        expect(report.issues[0].severity).toBe('warning');
        expect(report.issues[0].message).toContain('裁剪');
    });

    it('opacity=0 的元素不参与测量', () => {
        const report = SvgCheckService.checkSource(svg(
            '0 0 100 100',
            '<rect x="500" y="500" width="20" height="20" opacity="0"/><rect x="10" y="10" width="10" height="10"/>',
        ));

        expect(report.status).toBe('ok');
        expect(report.stats.measured).toBe(1);
    });

    it('缺少 viewBox 时按 width/height 推定画布并告警', () => {
        const report = SvgCheckService.checkSource(
            '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><rect x="80" width="40" height="20"/></svg>',
        );

        expect(report.viewBox).toEqual([0, 0, 100, 50]);
        expect(codes(report)).toContain('missing-viewbox');
        expect(report.issues.some((issue) => issue.code === 'overflow')).toBe(true);
    });

    it('嵌套 <svg> 按内层 viewBox 缩放到外层坐标', () => {
        const report = SvgCheckService.checkSource(svg(
            '0 0 100 100',
            '<svg x="10" y="10" width="20" height="20" viewBox="0 0 10 10"><rect width="20" height="20"/></svg>',
        ));

        expect(report.status).toBe('ok');
        expect(report.contentBBox).toEqual([10, 10, 50, 50]);
    });

    it('路径含 NaN/Infinity 坐标时报 invalid-coordinate', () => {
        const report = SvgCheckService.checkSource(svg('0 0 100 100', '<path d="M1e999 0 L10 10"/>'));

        expect(report.status).toBe('error');
        expect(codes(report)).toContain('invalid-coordinate');
    });

    it('路径数据非法时报 invalid-path-data', () => {
        const report = SvgCheckService.checkSource(svg('0 0 100 100', '<path d="M0 0 L"/>'));

        expect(report.status).toBe('error');
        expect(codes(report)).toContain('invalid-path-data');
    });

    it('没有 <svg> 根元素时报 no-svg-root', () => {
        const report = SvgCheckService.checkSource('<html><body/></html>');

        expect(report.status).toBe('error');
        expect(codes(report)).toContain('no-svg-root');
    });

    it('只有描绘边才可见的 <line> 不会因 fill 被计入边界', () => {
        const report = SvgCheckService.checkSource(svg('0 0 100 100', '<line x1="-50" y1="0" x2="200" y2="0"/>'));

        expect(report.stats.measured).toBe(0);
        expect(codes(report)).toContain('empty-svg');
    });

    it('尊重 tolerance 选项', () => {
        const body = '<rect x="90" width="12" height="10"/>';
        expect(SvgCheckService.checkSource(svg('0 0 100 100', body), { tolerance: 0.5 }).status).toBe('error');
        expect(SvgCheckService.checkSource(svg('0 0 100 100', body), { tolerance: 3 }).status).toBe('ok');
    });

    it('限制返回的问题条数', () => {
        const body = Array.from({ length: 8 }, (_, i) => `<rect x="95" y="${i * 5}" width="20" height="4"/>`).join('');
        const report = SvgCheckService.checkSource(svg('0 0 100 100', body), { maxIssues: 3 });

        expect(report.issues).toHaveLength(3);
    });

    it('XML 声明与 DOCTYPE 不影响根元素定位与行号', () => {
        const source = [
            '<?xml version="1.0" encoding="UTF-8"?>',
            '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">',
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
            '  <rect x="95" width="20" height="10"/>',
            '</svg>',
        ].join('\n');
        const report = SvgCheckService.checkSource(source);

        expect(report.status).toBe('error');
        expect(report.issues[0].line).toBe(4);
        expect(report.issues[0].element).toBe('rect');
    });

    it('注释里的假标签不干扰行号定位', () => {
        const source = [
            '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">',
            '  <!-- <rect x="500" width="10" height="10"/> -->',
            '  <rect x="95" width="20" height="10"/>',
            '</svg>',
        ].join('\n');
        const report = SvgCheckService.checkSource(source);

        expect(report.status).toBe('error');
        expect(report.issues).toHaveLength(1);
        expect(report.issues[0].line).toBe(3);
    });
});

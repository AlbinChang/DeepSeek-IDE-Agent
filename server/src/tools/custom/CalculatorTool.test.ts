import { describe, expect, it } from 'vitest';
import { CalculatorTool } from './CalculatorTool.js';

// ═══════════════════════════════════════════════════════════
// 辅助：提取 execute 返回的 result 值
// ═══════════════════════════════════════════════════════════
async function calc(expression: string, variables?: Record<string, any>, timeout?: number) {
    return CalculatorTool.execute({ expression, variables: variables || {}, timeout });
}

// ═══════════════════════════════════════════════════════════
// 模式一：数学表达式模式（向后兼容）
// ═══════════════════════════════════════════════════════════
describe('calculate — 数学表达式模式', () => {
    it('基础四则运算', async () => {
        const r = await calc('1024 * 1024 / 20');
        expect(r.status).toBe('success');
        expect(r.mode).toBe('math-expression');
        expect(r.result).toBeCloseTo(52428.8, 1);
    });

    it('三角函数', async () => {
        const r = await calc('sin(45 deg) * 2');
        expect(r.status).toBe('success');
        expect(r.mode).toBe('math-expression');
        expect(r.result).toBeCloseTo(Math.SQRT2, 4);
    });

    it('带变量的表达式', async () => {
        const r = await calc('price * quantity * (1 - discount)', {
            price: 100,
            quantity: 5,
            discount: 0.1,
        });
        expect(r.status).toBe('success');
        expect(r.result).toBe(450);
        expect(r.metadata?.vars).toEqual(['price', 'quantity', 'discount']);
    });

    it('单位转换', async () => {
        const r = await calc('5 km to mile');
        expect(r.status).toBe('success');
        // mathjs 返回 Unit 对象，其数值 ≈ 3.10686
        expect(r.result?.toNumber?.('mile') ?? Number(r.result)).toBeCloseTo(3.10686, 3);
    });

    it('幂与开方', async () => {
        const r = await calc('sqrt(3^2 + 4^2)');
        expect(r.status).toBe('success');
        expect(r.result).toBe(5);
    });

    it('空表达式', async () => {
        const r = await calc('');
        expect(r.status).toBe('success');
        expect(r.result).toBeUndefined();
    });

    it('非法数学表达式', async () => {
        const r = await calc('1 / 0 + nonsense');
        expect(r.status).toBe('error');
        expect(r.error).toContain('数学表达式求值失败');
    });
});

// ═══════════════════════════════════════════════════════════
// 模式二：JS 脚本模式
// ═══════════════════════════════════════════════════════════
describe('calculate — JS 脚本模式', () => {
    it('单行表达式（带 return）', async () => {
        const r = await calc('return 2 + 3 * 4');
        expect(r.status).toBe('success');
        expect(r.mode).toBe('js-script');
        expect(r.result).toBe(14);
    });

    it('多行脚本 — 变量声明 + 循环 + 累加', async () => {
        const r = await calc(`
let total = 0;
for (let i = 1; i <= 10; i++) {
    total += i * i;
}
return total;
        `.trim());
        expect(r.status).toBe('success');
        expect(r.result).toBe(385); // 1²+2²+...+10²
    });

    it('尾表达式作为返回值（无显式 return）', async () => {
        // 无顶层 return 时，vm 返回最后一条语句的 completion value
        // 但 const 声明的 completion value 是 undefined
        // 所以需要显式 return 或用表达式结尾
        const r = await calc(`
let a = 10;
let b = 20;
a + b
        `.trim());
        expect(r.status).toBe('success');
        expect(r.result).toBe(30);
    });

    it('使用注入变量处理数组', async () => {
        const r = await calc(
            'return items.filter(x => x > threshold).length',
            { items: [1, 5, 10, 3, 8, 12], threshold: 5 },
        );
        expect(r.status).toBe('success');
        expect(r.result).toBe(3); // 10, 8, 12
    });

    it('使用注入变量进行对象变换', async () => {
        const r = await calc(
            'return Object.entries(data).map(([k, v]) => ({ key: k, doubled: v * 2 }))',
            { data: { a: 1, b: 2, c: 3 } },
        );
        expect(r.status).toBe('success');
        expect(r.result).toEqual([
            { key: 'a', doubled: 2 },
            { key: 'b', doubled: 4 },
            { key: 'c', doubled: 6 },
        ]);
    });

    it('字符串处理 — 正则匹配计数', async () => {
        const r = await calc(
            'return (text.match(/TODO/g) || []).length',
            { text: '# TODO: fix bug\n// TODO: refactor\n// DONE: test\n/* TODO: optimize */' },
        );
        expect(r.status).toBe('success');
        expect(r.result).toBe(3);
    });

    it('日期运算', async () => {
        const r = await calc(`
const d1 = new Date('2026-06-15');
const d2 = new Date('2026-05-31');
return Math.ceil((d1 - d2) / (1000 * 60 * 60 * 24));
        `.trim());
        expect(r.status).toBe('success');
        expect(r.result).toBe(15); // 6月15日 - 5月31日 = 15天
    });

    it('条件逻辑', async () => {
        const r = await calc(`
const score = 85;
if (score >= 90) return 'A';
if (score >= 80) return 'B';
if (score >= 70) return 'C';
return 'D';
        `.trim());
        expect(r.status).toBe('success');
        expect(r.result).toBe('B');
    });

    it('数组 reduce 统计', async () => {
        const r = await calc(
            'return values.reduce((a, b) => a + b, 0) / values.length',
            { values: [10, 20, 30, 40, 50] },
        );
        expect(r.status).toBe('success');
        expect(r.result).toBe(30);
    });

    it('Map 操作', async () => {
        const r = await calc(`
const m = new Map();
items.forEach((item, idx) => m.set(item, idx));
return [...m.entries()];
        `.trim(), { items: ['a', 'b', 'c'] });
        expect(r.status).toBe('success');
        expect(r.result).toEqual([['a', 0], ['b', 1], ['c', 2]]);
    });

    it('math.evaluate 高精度计算', async () => {
        const r = await calc('return math.evaluate("sin(30 deg)")');
        expect(r.status).toBe('success');
        expect(r.result).toBeCloseTo(0.5, 4);
    });

    it('math.unit 单位转换', async () => {
        const r = await calc(`
const u = math.unit(100, "cm");
return u.to("inch").value;
        `.trim());
        expect(r.status).toBe('success');
        expect(r.result).toBeCloseTo(39.3701, 2);
    });

    it('console.log 捕获', async () => {
        const r = await calc(`
console.log("step 1: start");
const x = items.reduce((a, b) => a + b, 0);
console.log("step 2: sum =", x);
return x;
        `.trim(), { items: [1, 2, 3] });
        expect(r.status).toBe('success');
        expect(r.result).toBe(6);
        expect(r.logs).toBeDefined();
        expect(r.logs!.length).toBeGreaterThanOrEqual(2);
        expect(r.logs![0]).toContain('step 1: start');
    });

    it('语法错误 — 缺少闭合括号', async () => {
        const r = await calc('return items.filter(x => x > 5');
        expect(r.status).toBe('error');
        expect(r.mode).toBe('js-script');
        expect(r.error).toContain('脚本执行失败');
    });

    it('引用未定义变量', async () => {
        const r = await calc('return undefinedVar + 1');
        expect(r.status).toBe('error');
    });

    it('超时保护', async () => {
        // 死循环应被超时机制终止
        const r = await calc(
            'while(true) {}',
            {},
            500, // 500ms 超时
        );
        expect(r.status).toBe('error');
        expect(r.error).toContain('超时');
    });
});

// ═══════════════════════════════════════════════════════════
// 模式自动检测
// ═══════════════════════════════════════════════════════════
describe('calculate — 模式自动检测', () => {
    it('单行纯数学 → 数学模式', async () => {
        const r = await calc('3.14 * 2');
        expect(r.mode).toBe('math-expression');
    });

    it('包含 return → 脚本模式', async () => {
        const r = await calc('return 42');
        expect(r.mode).toBe('js-script');
    });

    it('包含分号 → 脚本模式', async () => {
        const r = await calc('let x = 5; x * 2');
        expect(r.mode).toBe('js-script');
    });

    it('包含大括号 → 脚本模式', async () => {
        const r = await calc('if (true) { return 1; }');
        expect(r.mode).toBe('js-script');
    });

    it('多行 → 脚本模式', async () => {
        const r = await calc('const a = 1;\nconst b = 2;\na + b');
        expect(r.mode).toBe('js-script');
    });

    it('包含 for 关键字 → 脚本模式', async () => {
        const r = await calc('for (let i=0;i<3;i++) { } return 1');
        expect(r.mode).toBe('js-script');
    });

    it('包含 const 关键字 → 脚本模式', async () => {
        const r = await calc('const x = 42; return x');
        expect(r.mode).toBe('js-script');
    });
});

// ═══════════════════════════════════════════════════════════
// 安全隔离
// ═══════════════════════════════════════════════════════════
describe('calculate — 安全隔离', () => {
    it('require 不可用', async () => {
        const r = await calc('return typeof require');
        expect(r.status).toBe('success');
        expect(r.result).toBe('undefined');
    });

    it('process 不可用', async () => {
        const r = await calc('return typeof process');
        expect(r.status).toBe('success');
        expect(r.result).toBe('undefined');
    });

    it('fs 不可用', async () => {
        const r = await calc('return typeof fs');
        expect(r.status).toBe('success');
        expect(r.result).toBe('undefined');
    });

    it('setTimeout 不可用', async () => {
        const r = await calc('return typeof setTimeout');
        expect(r.status).toBe('success');
        expect(r.result).toBe('undefined');
    });

    it('Math 可用', async () => {
        const r = await calc('return Math.PI');
        expect(r.status).toBe('success');
        expect(r.result).toBeCloseTo(3.14159, 4);
    });

    it('JSON 可用', async () => {
        const r = await calc('return JSON.stringify({ a: 1 })');
        expect(r.status).toBe('success');
        expect(r.result).toBe('{"a":1}');
    });
});

// ═══════════════════════════════════════════════════════════
// 函数声明自动调用 & 无返回值提示
// ═══════════════════════════════════════════════════════════
describe('calculate — 函数声明自动调用与提示', () => {
    it('无参函数声明 → 自动调用并返回结果', async () => {
        const r = await calc(`
function computeAnswer() {
    const a = 20;
    const b = 22;
    return a + b;
}
        `.trim());
        expect(r.status).toBe('success');
        expect(r.result).toBe(42);
        expect(r.logs).toBeDefined();
        expect(r.logs!.some((l: string) => l.includes('自动调用无参函数 computeAnswer()'))).toBe(true);
    });

    it('多个无参函数 → 最后一个的返回值作为结果', async () => {
        const r = await calc(`
function first() { return 1; }
function second() { return 2; }
        `.trim());
        expect(r.status).toBe('success');
        expect(r.result).toBe(2);
    });

    it('带参函数 → 不自动调用，返回 no_value + hint', async () => {
        const r = await calc(`
function srgbToLinear(v) {
    v = v / 255;
    return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1/2.4) - 0.055;
}
        `.trim());
        expect(r.status).toBe('no_value');
        expect(r.result).toBeUndefined();
        expect(r.hint).toBeDefined();
        expect(r.hint).toContain('srgbToLinear');
        expect(r.hint).toContain('return srgbToLinear');
    });

    it('带参函数 + 显式调用 → 正常返回结果（不受自动调用影响）', async () => {
        const r = await calc(`
function double(x) { return x * 2; }
return double(21);
        `.trim());
        expect(r.status).toBe('success');
        expect(r.result).toBe(42);
    });

    it('函数声明 + 尾表达式调用 → vm completion value', async () => {
        const r = await calc(`
function triple(x) { return x * 3; }
triple(7)
        `.trim());
        expect(r.status).toBe('success');
        expect(r.result).toBe(21);
    });

    it('纯声明无函数 → 返回 no_value + 通用提示', async () => {
        const r = await calc('const a = 1; let b = 2;');
        expect(r.status).toBe('no_value');
        expect(r.result).toBeUndefined();
        expect(r.hint).toContain('return');
        expect(r.hint).toContain('表达式');
    });

    it('无参函数内部抛错 → 记录日志但不影响状态', async () => {
        const r = await calc(`
function badFunc() { throw new Error('oops'); }
function goodFunc() { return 'ok'; }
        `.trim());
        // badFunc 自动调用失败，goodFunc 自动调用成功
        expect(r.status).toBe('success');
        expect(r.result).toBe('ok');
        expect(r.logs).toBeDefined();
        expect(r.logs!.some((l: string) => l.includes('badFunc() 失败'))).toBe(true);
    });
});

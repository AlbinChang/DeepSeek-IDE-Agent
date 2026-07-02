import { ToolDefinition } from '@/services/ToolManager.js';
import * as vm from 'vm';
import * as math from 'mathjs';

// ─── 安全常量 ────────────────────────────────────────────
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 30000;

// ─── 模式检测：判断是否为简单数学表达式 ─────────────────
const JS_KEYWORD_PATTERN = /\b(?:const|let|var|function|return|if|for|while|switch|try|catch|class|import|export|async|await|yield|throw|new|delete|typeof|instanceof|void|this)\b/;
const JS_SYNTAX_PATTERN = /[{};]|=>|\/\/|\/\*/;

function isSimpleMathExpression(code: string): boolean {
    const trimmed = code.trim();
    if (!trimmed) return true;
    // 多行 → 脚本模式
    if (trimmed.includes('\n')) return false;
    // 包含 JS 关键字或语法结构 → 脚本模式
    return !JS_KEYWORD_PATTERN.test(trimmed) && !JS_SYNTAX_PATTERN.test(trimmed);
}

// ─── 函数声明检测与自动调用 ──────────────────────────────

/** 匹配 function name(params) { ... } 形式的声明，提取函数名和参数个数 */
const FUNC_DECL_PATTERN = /function\s+(\w+)\s*\(([^)]*)\)/g;

interface FuncDeclInfo {
    name: string;
    paramCount: number;
}

function extractFunctionDeclarations(script: string): FuncDeclInfo[] {
    const funcs: FuncDeclInfo[] = [];
    const seen = new Set<string>();
    let match: RegExpExecArray | null;
    // 重置 lastIndex（因为 pattern 带 g flag）
    FUNC_DECL_PATTERN.lastIndex = 0;
    while ((match = FUNC_DECL_PATTERN.exec(script)) !== null) {
        const name = match[1];
        if (seen.has(name)) continue;
        seen.add(name);
        const paramsStr = match[2].trim();
        const paramCount = paramsStr ? paramsStr.split(',').filter(p => p.trim()).length : 0;
        funcs.push({ name, paramCount });
    }
    return funcs;
}

/**
 * 为模型生成「函数已定义但未调用」的提示信息
 */
function buildFuncNotCalledHint(funcs: FuncDeclInfo[]): string {
    if (funcs.length === 0) return '';
    const names = funcs.map(f => `${f.name}(${f.paramCount > 0 ? '...' : ''})`).join('、');
    const noArg = funcs.filter(f => f.paramCount === 0);
    const withArg = funcs.filter(f => f.paramCount > 0);

    if (withArg.length > 0) {
        // 有带参函数：无法自动调用，引导模型显式调用
        return `脚本定义了函数 ${names}，但未调用任何函数因此无返回值。请在 expression 末尾添加函数调用并通过 return 返回结果。例如：return ${withArg[0].name}(<参数值>)`;
    }
    if (noArg.length > 0) {
        return `脚本定义了无参函数 ${names}，但未显式调用。工具已自动调用 ${noArg.map(f => f.name).join('、')} 并返回其结果。`;
    }
    return `脚本定义了函数 ${names}，但未调用任何函数因此无返回值。`;
}

// ─── 沙箱构造 ────────────────────────────────────────────

/**
 * 构造安全的 vm 沙箱上下文。
 * 仅暴露安全的全局 API + mathjs + 用户注入变量。
 * 刻意不暴露：require / process / fs / net / child_process / Buffer / setTimeout / setInterval 等。
 */
function createSandbox(
    variables: Record<string, any>,
    logs: string[],
): Record<string, any> {
    const sandbox: Record<string, any> = {
        // ── 用户变量（优先级最高，允许覆盖内置） ──
        ...variables,

        // ── 安全的标准 API ──
        console: {
            log: (...args: any[]) => {
                logs.push(args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
            },
            warn: (...args: any[]) => {
                logs.push('[warn] ' + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
            },
            error: (...args: any[]) => {
                logs.push('[error] ' + args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
            },
        },
        JSON: { stringify: JSON.stringify.bind(JSON), parse: JSON.parse.bind(JSON) },
        Math,
        Date,
        Number,
        String,
        Array,
        Object,
        Map,
        Set,
        RegExp,
        parseInt: Number.parseInt.bind(Number),
        parseFloat: Number.parseFloat.bind(Number),
        isNaN: Number.isNaN.bind(Number),
        isFinite: Number.isFinite.bind(Number),
        Infinity,
        NaN,

        // ── mathjs 桥接（精确数学运算 + 单位转换） ──
        math: {
            evaluate: (expr: string, vars?: Record<string, any>) =>
                math.evaluate(expr, { ...variables, ...(vars || {}) }),
            unit: (value: number, unitName: string) => {
                try {
                    const u = math.unit(value, unitName);
                    // 返回单位对象的字符串表示 + 数值，避免跨 vm 上下文 Unit 对象不可用
                    return {
                        value: u.toNumber(unitName),
                        unit: unitName,
                        toString: () => u.toString(),
                        toNumber: (targetUnit: string) => u.toNumber(targetUnit),
                        to: (targetUnit: string) => {
                            const converted = u.toNumber(targetUnit);
                            return { value: converted, unit: targetUnit, toString: () => `${converted} ${targetUnit}` };
                        },
                    };
                } catch {
                    return null;
                }
            },
        },

        // ── 结果捕获槽位 ──
        __result__: undefined as any,
    };

    return vm.createContext(sandbox);
}

// ─── 脚本包装 ────────────────────────────────────────────

/**
 * 检测脚本是否在顶层使用了 return 语句。
 * 只有被函数体包裹后才能使用 return，否则 vm 会抛 SyntaxError。
 */
const TOP_LEVEL_RETURN_PATTERN = /(^|\n)\s*return\b/;

function hasTopLevelReturn(script: string): boolean {
    return TOP_LEVEL_RETURN_PATTERN.test(script);
}

/**
 * 智能包装用户脚本：
 * - 若脚本在顶层使用了 return → 包装在 IIFE 中，通过 __result__ 捕获返回值
 * - 若脚本无顶层 return → 直接追加 `__result__ =` 前缀，捕获最后一个表达式的值
 *
 * 示例：
 *   "return 2 + 3"     → "__result__ = (() => { return 2 + 3 })();"
 *   "const a=1; a+2"   → "const a=1; __result__ = a+2"
 *   "let s=0;\nfor..."  → vm 会返回最后一条语句的值（通常是 undefined），
 *                         此时用户应使用 return 或尾部表达式
 */
function executeAndCapture(script: string, sandbox: Record<string, any>, timeout: number, logs: string[]): any {
    const trimmed = script.trim();
    if (!trimmed) {
        sandbox.__result__ = undefined;
        return;
    }

    if (hasTopLevelReturn(trimmed)) {
        // 顶层 return → 函数包装为 IIFE，通过 __result__ 捕获返回值
        const wrapped = `__result__ = (() => { ${trimmed} })();`;
        vm.runInContext(wrapped, sandbox, { timeout, displayErrors: true });

        // IIFE 内定义的函数在其闭包中，外部不可见。
        // 如果 IIFE 无返回值（可能因为 return 在嵌套函数体内而非真正顶层），
        // 则重新直接执行脚本，使函数声明提升为沙箱全局，供后续自动调用逻辑使用。
        if (sandbox.__result__ === undefined) {
            const funcs = extractFunctionDeclarations(trimmed);
            if (funcs.length > 0) {
                vm.runInContext(trimmed, sandbox, { timeout, displayErrors: true });
            }
        }
    } else {
        // 无顶层 return → 直接执行，让 vm 返回最后一条语句的 completion value
        const result = vm.runInContext(trimmed, sandbox, { timeout, displayErrors: true });
        // vm.runInContext 返回最后一条语句的值（completion value）
        // 但对于 const/let/function 声明语句，completion value 是 undefined
        sandbox.__result__ = result;
    }

    // ── 统一自动调用：如果结果仍为 undefined 且脚本定义了无参函数，自动调用 ──
    if (sandbox.__result__ === undefined) {
        const funcs = extractFunctionDeclarations(trimmed);
        const noArgFuncs = funcs.filter(f => f.paramCount === 0);

        if (noArgFuncs.length > 0) {
            // 自动逐个调用所有无参函数，最后一个函数的返回值作为最终结果
            for (const fn of noArgFuncs) {
                try {
                    sandbox.__result__ = vm.runInContext(
                        `${fn.name}()`,
                        sandbox,
                        { timeout, displayErrors: true },
                    );
                    logs.push(`[calculate] 自动调用无参函数 ${fn.name}() → ${JSON.stringify(sandbox.__result__)}`);
                } catch (callErr: any) {
                    logs.push(`[calculate] 自动调用 ${fn.name}() 失败: ${callErr.message}`);
                    // 继续尝试下一个无参函数
                }
            }
        }
    }
}

// ─── Tool Definition ─────────────────────────────────────

/**
 * JS 脚本执行器 (JavaScript Script Executor)
 *
 * 从纯数学计算工具升级为通用 JS 脚本执行器。
 *
 * 模式一（表达式模式）：简单单行数学表达式如 "1024 * 1024 / 20" 或 "sin(45 deg) + 1"
 *   → 使用 mathjs 引擎高精度求值，完全向后兼容。
 *
 * 模式二（脚本模式）：多行或包含 JS 语法的代码
 *   → 在 Node.js vm 沙箱中以函数体形式执行，支持变量、循环、条件、函数、数组/对象操作等。
 *   → 使用 return 或让最后一个表达式作为返回值。
 *
 * 安全约束：
 *   - vm 沙箱隔离，无 require / process / fs / net / child_process 等危险 API
 *   - 超时保护（默认 10s，最大 30s）
 *   - console.log/warn/error 的输出被捕获并返回在 logs 字段中
 */
export const CalculatorTool: ToolDefinition = {
    name: 'calculate',
    description: `⚠️ expression 为必填参数，不可省略！JS 脚本执行器。当你需要精确计算、批量数据处理或多步逻辑推导时，用此工具代替脑中推算。

【应使用此工具的场景】
• 精确数值计算 — 大数乘除、浮点运算、百分比、比例、三角函数
  例: "1024 * 1024 / 20" | "sin(45 deg) * 2" | "sqrt(3^2 + 4^2)"
• 批量数据处理 — 对数组/列表进行过滤、排序、统计、分组、变换
  将数据通过 variables 传入，脚本中用 filter/map/reduce/sort 处理
  例: variables={items:[1,5,10,3,8]} expression="return items.filter(x=>x>5).length"
• 多步骤逻辑推导 — 条件判断、循环累加、分支决策等无法一步心算的逻辑
  编写 JS 脚本，用 if/for/while 精确控制流程
• 单位/进制换算 — 公里↔英里、摄氏度↔华氏度、字节↔KB/MB/GB、二进制↔十进制↔十六进制
  例: "5 km to mile" | "1024 MB to GB" | "0xFF to number"
• 字符串模式分析 — 正则匹配计数、子串查找、模式提取
  例: variables={text:"TODO: fix\nDONE: test\nTODO: refactor"} expression="return (text.match(/TODO/g)||[]).length"
• 日期时间运算 — 时间差、日期偏移、天数统计
  例: "return Math.ceil((new Date('2026-06-15') - new Date('2026-05-31')) / 86400000)"

【不应使用此工具的情况】
• 简单心算（个位数加减、10*2 等）→ 直接在脑中完成，无需工具调用
• 文件读写、终端命令 → 使用 read_file / write_file / run_terminal
• 网络请求、网页操作 → 使用 browser 系列工具
• 需要持久化结果 → 先用 calculate 算出结果，再用 write_file 写入文件

【两种执行模式（自动检测，无需手动指定）】
模式一：表达式模式 — 单行纯数学表达式（无 JS 关键字/分号/大括号），使用 mathjs 引擎高精度求值
模式二：脚本模式 — 含 JS 语法结构或多行代码，在 Node.js vm 安全沙箱中完整执行

【脚本模式使用指南】
• variables 中注入的变量直接作为脚本顶层变量使用（优先级最高，可覆盖内置 API）
• 用 return 语句返回计算结果；若无 return，则以最后一个表达式值作为返回值
• 脚本内可调用 math.evaluate(expr) 进行高精度数学子运算
• 脚本内可调用 math.unit(value, "unit").to("targetUnit") 进行单位转换
• 用 console.log(...) 输出调试信息（会收集在返回结果的 logs 字段）
• 安全约束：沙箱仅含 JS 标准库 + mathjs 桥接；无 require/process/fs/net/setTimeout`,

    parameters: {
        type: 'object',
        properties: {
            expression: {
                type: 'string',
                description:
                    '待执行的 JS 代码或数学表达式。' +
                    '单行纯数学 → mathjs 求值（如 "1024*1024/20"、"sin(45 deg)*2"、"5 km to mile"）。' +
                    'JS 代码 → vm 沙箱执行，用 return 返回结果或将结果表达式放在末尾（如 "return items.filter(x=>x>5).length"、"let s=0; for(const n of nums)s+=n*n; return Math.sqrt(s)"）。',
            },
            variables: {
                type: 'object',
                description:
                    '注入脚本的变量。键值对会被提升为脚本顶层变量，可直接按变量名引用。' +
                    '典型用法：将前序工具返回的数据（文件内容解析结果、列表、统计数据等）作为 variables 传入。' +
                    '例：{ "items":[1,2,3], "threshold":100 } → 脚本中直接用 items、threshold。',
            },
            timeout: {
                type: 'number',
                description:
                    '超时毫秒数。默认 10000，最大 30000。超时后脚本被强制终止并返回错误。仅在脚本模式生效。',
            },
        },
        required: ['expression'],
    },

    execute: async ({ expression, variables = {}, timeout }: {
        expression: string;
        variables?: Record<string, any>;
        timeout?: number;
    }) => {
        const effectiveTimeout = Math.min(
            typeof timeout === 'number' && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
            MAX_TIMEOUT_MS,
        );

        // ═══ 模式一：简单数学表达式（向后兼容） ═══
        if (isSimpleMathExpression(expression)) {
            try {
                const result = math.evaluate(expression, variables);
                return {
                    result,
                    status: 'success',
                    type: typeof result,
                    mode: 'math-expression',
                    metadata: {
                        formula: expression,
                        vars: Object.keys(variables),
                    },
                };
            } catch (e: any) {
                return {
                    error: `数学表达式求值失败: ${e.message}`,
                    status: 'error',
                    mode: 'math-expression',
                };
            }
        }

        // ═══ 模式二：JS 脚本沙箱执行 ═══
        const logs: string[] = [];
        let sandbox: Record<string, any> | null = null;

        try {
            sandbox = createSandbox(variables, logs);

            executeAndCapture(expression, sandbox!, effectiveTimeout, logs);

            const result = sandbox!.__result__;
            const funcs = extractFunctionDeclarations(expression);
            const hasUncalledParamFuncs = funcs.some(f => f.paramCount > 0) && result === undefined;

            // 构建对 LLM 友好的状态和提示
            let status: string;
            let hint: string | undefined;

            if (result === undefined) {
                if (funcs.length > 0) {
                    // 函数声明场景：可能自动调用了无参函数，也可能有带参函数无法自动调用
                    const wasAutoCalled = funcs.some(f => f.paramCount === 0);
                    status = hasUncalledParamFuncs ? 'no_value' : (wasAutoCalled ? 'success' : 'no_value');
                    hint = buildFuncNotCalledHint(funcs);
                } else {
                    // 普通脚本无返回值（如纯声明、空循环等）
                    status = 'no_value';
                    hint = '脚本执行完成但未返回任何值。请确保：1) 使用 return 语句返回计算结果；2) 确保最后一个语句是表达式（非声明语句）。';
                }
            } else {
                status = 'success';
            }

            return {
                result,
                status,
                type: typeof result,
                mode: 'js-script',
                hint,
                logs: logs.length > 0 ? logs : undefined,
                metadata: {
                    codeLength: expression.length,
                    vars: Object.keys(variables),
                    timeout: effectiveTimeout,
                },
            };
        } catch (e: any) {
            // vm 超时异常以特定消息抛出
            const isTimeout =
                e.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT' ||
                /timed?[ -]?out/i.test(String(e.message || ''));

            return {
                error: isTimeout
                    ? `脚本执行超时（${effectiveTimeout}ms），请优化脚本逻辑或增大 timeout 参数（最大 ${MAX_TIMEOUT_MS}ms）。`
                    : `脚本执行失败: ${e.message}`,
                status: 'error',
                mode: 'js-script',
                logs: logs.length > 0 ? logs : undefined,
            };
        }
    },
};

/**
 * Workflow 表达式求值。
 *
 * 只支持白名单语法：路径、字面量、比较/布尔/算术运算、有限过滤器。
 * 明确禁止 eval / new Function / 任意 JS 执行。
 */

import { WorkflowError } from '@/workflow/errors.js';

const MAX_EXPRESSION_LENGTH = 4096;
const MAX_RESULT_CHARS = 256 * 1024;
const MAX_PARSE_STEPS = 2000;
const FORBIDDEN_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

export function isForbiddenPropertyKey(key: string): boolean {
    return FORBIDDEN_KEYS.has(key);
}

export class WorkflowExpressionError extends WorkflowError {
    constructor(message: string) {
        super(message, 'validation');
        this.name = 'WorkflowExpressionError';
    }
}

export interface WorkflowExpressionContext {
    inputs: Record<string, unknown>;
    env: Record<string, string | undefined>;
    workspace: string;
    run: { id: string; traceId: string };
    steps: Record<string, { status: string; output?: unknown; error?: unknown }>;
    context: Record<string, unknown>;
    /** for/try 等局部变量（以裸标识符访问） */
    vars?: Record<string, unknown>;
}

type Token =
    | { kind: 'number'; value: number }
    | { kind: 'string'; value: string }
    | { kind: 'ident'; value: string }
    | { kind: 'op'; value: string }
    | { kind: 'eof' };

function tokenize(source: string): Token[] {
    const tokens: Token[] = [];
    let index = 0;

    while (index < source.length) {
        const char = source[index];

        if (/\s/.test(char)) {
            index++;
            continue;
        }

        if (/[0-9]/.test(char) || (char === '.' && /[0-9]/.test(source[index + 1] || ''))) {
            const start = index;
            if (char === '.') index++;
            while (/[0-9]/.test(source[index] || '')) index++;
            if (source[index] === '.') {
                index++;
                while (/[0-9]/.test(source[index] || '')) index++;
            }
            tokens.push({ kind: 'number', value: Number(source.slice(start, index)) });
            continue;
        }

        if (char === '"' || char === "'") {
            const quote = char;
            index++;
            let value = '';
            while (index < source.length && source[index] !== quote) {
                const current = source[index];
                if (current === '\\') {
                    const next = source[index + 1];
                    index += 2;
                    switch (next) {
                        case 'n': value += '\n'; break;
                        case 'r': value += '\r'; break;
                        case 't': value += '\t'; break;
                        case '\\': value += '\\'; break;
                        case '"': value += '"'; break;
                        case "'": value += "'"; break;
                        default: value += next ?? '';
                    }
                    continue;
                }
                value += current;
                index++;
            }
            if (index >= source.length) {
                throw new WorkflowExpressionError('字符串字面量缺少结束引号');
            }
            index++;
            tokens.push({ kind: 'string', value });
            continue;
        }

        if (/[A-Za-z_$]/.test(char)) {
            const start = index;
            index++;
            while (/[A-Za-z0-9_$-]/.test(source[index] || '')) index++;
            tokens.push({ kind: 'ident', value: source.slice(start, index) });
            continue;
        }

        const twoChar = source.slice(index, index + 2);
        if (['||', '&&', '==', '!=', '>=', '<=', '=>'].includes(twoChar)) {
            tokens.push({ kind: 'op', value: twoChar });
            index += 2;
            continue;
        }

        if ('()[].,|!<>+-*/%'.includes(char)) {
            tokens.push({ kind: 'op', value: char });
            index++;
            continue;
        }

        throw new WorkflowExpressionError(`不支持的表达式字符: ${char}`);
    }

    tokens.push({ kind: 'eof' });
    return tokens;
}

function isForbiddenKey(key: string): boolean {
    return FORBIDDEN_KEYS.has(key);
}

function readProperty(value: unknown, key: string | number): unknown {
    if (value === null || value === undefined) return undefined;
    if (typeof key === 'string' && isForbiddenKey(key)) return undefined;
    if (typeof value !== 'object' && typeof value !== 'string') return undefined;
    return (value as any)[key];
}

function toNumber(value: unknown): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'boolean') return value ? 1 : 0;
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
        return Number(value);
    }
    return Number.NaN;
}

function comparable(value: unknown): unknown {
    if (typeof value === 'string' && value.trim() !== '' && !Number.isNaN(Number(value))) {
        return Number(value);
    }
    return value;
}

function truthy(value: unknown): boolean {
    return Boolean(value);
}

function assertResultSize(value: unknown): void {
    if (typeof value === 'string' && value.length > MAX_RESULT_CHARS) {
        throw new WorkflowExpressionError(`表达式结果超过 ${MAX_RESULT_CHARS} 字符上限`);
    }
    if (value && typeof value === 'object') {
        try {
            const serialized = JSON.stringify(value);
            if (serialized.length > MAX_RESULT_CHARS) {
                throw new WorkflowExpressionError(`表达式结果超过 ${MAX_RESULT_CHARS} 字符上限`);
            }
        } catch (error) {
            if (error instanceof WorkflowExpressionError) throw error;
        }
    }
}

export function stringifyValue(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

class ExpressionParser {
    private position = 0;
    private steps = 0;

    constructor(
        private readonly tokens: Token[],
        private readonly ctx: WorkflowExpressionContext,
    ) {}

    public parse(): unknown {
        const value = this.parseOr();
        if (this.peek().kind !== 'eof') {
            const token = this.peek();
            throw new WorkflowExpressionError(`表达式存在多余内容: ${token.kind === 'eof' ? 'EOF' : String(token.value)}`);
        }
        assertResultSize(value);
        return value;
    }

    private peek(offset = 0): Token {
        return this.tokens[Math.min(this.position + offset, this.tokens.length - 1)];
    }

    private next(): Token {
        this.steps++;
        if (this.steps > MAX_PARSE_STEPS) {
            throw new WorkflowExpressionError('表达式过于复杂');
        }
        const token = this.peek();
        this.position++;
        return token;
    }

    private matchOp(value: string): boolean {
        const token = this.peek();
        if (token.kind === 'op' && token.value === value) {
            this.position++;
            return true;
        }
        return false;
    }

    private expectOp(value: string): void {
        if (!this.matchOp(value)) {
            throw new WorkflowExpressionError(`表达式缺少 "${value}"`);
        }
    }

    private parseOr(): unknown {
        let left = this.parseAnd();
        while (this.matchOp('||')) {
            const right = this.parseAnd();
            left = truthy(left) || truthy(right);
        }
        return left;
    }

    private parseAnd(): unknown {
        let left = this.parseEquality();
        while (this.matchOp('&&')) {
            const right = this.parseEquality();
            left = truthy(left) && truthy(right);
        }
        return left;
    }

    private parseEquality(): unknown {
        let left = this.parseComparison();
        while (true) {
            if (this.matchOp('==')) {
                left = left == this.parseComparison(); // eslint-disable-line eqeqeq
            } else if (this.matchOp('!=')) {
                left = left != this.parseComparison(); // eslint-disable-line eqeqeq
            } else {
                return left;
            }
        }
    }

    private parseComparison(): unknown {
        let left = this.parseAdditive();
        while (true) {
            if (this.matchOp('>')) {
                const right = comparable(this.parseAdditive());
                left = (comparable(left) as any) > (right as any);
            } else if (this.matchOp('<')) {
                const right = comparable(this.parseAdditive());
                left = (comparable(left) as any) < (right as any);
            } else if (this.matchOp('>=')) {
                const right = comparable(this.parseAdditive());
                left = (comparable(left) as any) >= (right as any);
            } else if (this.matchOp('<=')) {
                const right = comparable(this.parseAdditive());
                left = (comparable(left) as any) <= (right as any);
            } else {
                return left;
            }
        }
    }

    private parseAdditive(): unknown {
        let left = this.parseMultiplicative();
        while (true) {
            if (this.matchOp('+')) {
                const right = this.parseMultiplicative();
                left = (typeof left === 'string' || typeof right === 'string')
                    ? `${stringifyValue(left)}${stringifyValue(right)}`
                    : toNumber(left) + toNumber(right);
            } else if (this.matchOp('-')) {
                left = toNumber(left) - toNumber(this.parseMultiplicative());
            } else {
                return left;
            }
        }
    }

    private parseMultiplicative(): unknown {
        let left = this.parseUnary();
        while (true) {
            if (this.matchOp('*')) {
                left = toNumber(left) * toNumber(this.parseUnary());
            } else if (this.matchOp('/')) {
                left = toNumber(left) / toNumber(this.parseUnary());
            } else if (this.matchOp('%')) {
                left = toNumber(left) % toNumber(this.parseUnary());
            } else {
                return left;
            }
        }
    }

    private parseUnary(): unknown {
        if (this.matchOp('!')) {
            return !truthy(this.parseUnary());
        }
        if (this.matchOp('-')) {
            return -toNumber(this.parseUnary());
        }
        return this.parsePostfix();
    }

    private parsePostfix(): unknown {
        let value = this.parsePrimary();
        while (true) {
            if (this.matchOp('.')) {
                const token = this.next();
                if (token.kind === 'op' && token.value === '[') {
                    const key = this.parseOr();
                    this.expectOp(']');
                    value = readProperty(value, key as string | number);
                    continue;
                }
                if (token.kind !== 'ident') {
                    throw new WorkflowExpressionError('"." 后必须是属性名');
                }
                value = readProperty(value, token.value);
                continue;
            }
            if (this.matchOp('[')) {
                const key = this.parseOr();
                this.expectOp(']');
                value = readProperty(value, key as string | number);
                continue;
            }
            if (this.matchOp('|')) {
                value = this.applyFilter(value);
                continue;
            }
            return value;
        }
    }

    private parsePrimary(): unknown {
        const token = this.next();
        if (token.kind === 'number') return token.value;
        if (token.kind === 'string') return token.value;

        if (token.kind === 'ident') {
            if (token.value === 'true') return true;
            if (token.value === 'false') return false;
            if (token.value === 'null' || token.value === 'undefined') return null;

            if (this.ctx.vars && Object.prototype.hasOwnProperty.call(this.ctx.vars, token.value)) {
                return this.ctx.vars[token.value];
            }
            switch (token.value) {
                case 'inputs': return this.ctx.inputs;
                case 'env': return this.ctx.env;
                case 'workspace': return this.ctx.workspace;
                case 'run': return this.ctx.run;
                case 'steps': return this.ctx.steps;
                case 'context': return this.ctx.context;
                default: return readProperty(this.ctx.context, token.value);
            }
        }

        if (token.kind === 'op' && token.value === '.') {
            let value: unknown = this.ctx;
            const next = this.peek();
            if (next.kind === 'ident') {
                this.next();
                value = readProperty(value, next.value);
            } else if (next.kind === 'op' && next.value === '[') {
                this.next();
                const key = this.parseOr();
                this.expectOp(']');
                value = readProperty(value, key as string | number);
            }
            return value;
        }

        if (token.kind === 'op' && token.value === '(') {
            const value = this.parseOr();
            this.expectOp(')');
            return value;
        }

        if (token.kind === 'op' && token.value === '[') {
            const values: unknown[] = [];
            if (!this.matchOp(']')) {
                do {
                    values.push(this.parseOr());
                } while (this.matchOp(','));
                this.expectOp(']');
            }
            return values;
        }

        throw new WorkflowExpressionError(`无法解析的表达式片段: ${token.kind === 'eof' ? 'EOF' : String((token as any).value)}`);
    }

    private applyFilter(input: unknown): unknown {
        const token = this.next();
        if (token.kind !== 'ident') {
            throw new WorkflowExpressionError('过滤器名称无效');
        }
        const args: unknown[] = [];
        if (this.matchOp('(')) {
            if (!this.matchOp(')')) {
                do {
                    args.push(this.parseOr());
                } while (this.matchOp(','));
                this.expectOp(')');
            }
        }

        switch (token.value) {
            case 'default':
                return input === undefined || input === null ? args[0] : input;
            case 'json':
                return stringifyValue(input);
            case 'join':
                return Array.isArray(input)
                    ? input.map(stringifyValue).join(args.length > 0 ? stringifyValue(args[0]) : ',')
                    : stringifyValue(input);
            case 'upper':
                return stringifyValue(input).toUpperCase();
            case 'lower':
                return stringifyValue(input).toLowerCase();
            case 'length':
                if (Array.isArray(input) || typeof input === 'string') return input.length;
                if (input && typeof input === 'object') return Object.keys(input).length;
                return 0;
            case 'keys':
                return input && typeof input === 'object' ? Object.keys(input) : [];
            case 'string':
                return stringifyValue(input);
            case 'number':
                return toNumber(input);
            case 'boolean':
                return truthy(input);
            default:
                throw new WorkflowExpressionError(`不支持的过滤器: ${token.value}`);
        }
    }
}

export function evaluateExpression(expression: string, ctx: WorkflowExpressionContext): unknown {
    const source = String(expression ?? '').trim();
    if (!source) throw new WorkflowExpressionError('表达式为空');
    if (source.length > MAX_EXPRESSION_LENGTH) {
        throw new WorkflowExpressionError(`表达式超过 ${MAX_EXPRESSION_LENGTH} 字符上限`);
    }
    const tokens = tokenize(source);
    return new ExpressionParser(tokens, ctx).parse();
}

/**
 * 解析字符串模板：
 * - 整个字符串只有一个 `${...}` → 返回表达式原始类型；
 * - 否则把 `${...}` 替换为字符串。
 */
export function resolveTemplate(template: string, ctx: WorkflowExpressionContext): unknown {
    const trimmed = template.trim();
    if (
        trimmed.startsWith('${')
        && trimmed.endsWith('}')
        && !trimmed.slice(2, -1).includes('${')
        && trimmed.indexOf('}', 2) === trimmed.length - 1
    ) {
        return evaluateExpression(trimmed.slice(2, -1), ctx);
    }
    return template.replace(/\$\{([\s\S]*?)\}/g, (_match, expression: string) => {
        return stringifyValue(evaluateExpression(expression, ctx));
    });
}

/** 递归解析对象/数组中的所有字符串 */
export function resolveDeep(value: unknown, ctx: WorkflowExpressionContext, depth = 0): any {
    if (depth > 20) {
        throw new WorkflowExpressionError('模板嵌套层级过深');
    }
    if (typeof value === 'string') return resolveTemplate(value, ctx);
    if (Array.isArray(value)) return value.map((item) => resolveDeep(item, ctx, depth + 1));
    if (value && typeof value === 'object') {
        const result: Record<string, unknown> = Object.create(null);
        for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
            if (isForbiddenPropertyKey(key)) continue;
            result[key] = resolveDeep(entry, ctx, depth + 1);
        }
        return result;
    }
    return value;
}

/**
 * 解析 duration：支持毫秒数、对象（seconds/minutes/hours/milliseconds/days）与 PT30S 形式。
 */
export function parseDurationMs(input: unknown): number | undefined {
    if (input === undefined || input === null) return undefined;
    if (typeof input === 'number' && Number.isFinite(input)) return Math.max(0, Math.floor(input));
    if (typeof input === 'string') {
        const trimmed = input.trim();
        if (!trimmed) return undefined;
        if (/^\d+$/.test(trimmed)) return Number(trimmed);
        const simple = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)$/i);
        if (simple) {
            const value = Number(simple[1]);
            const unit = simple[2].toLowerCase();
            const factor = unit === 'ms' ? 1 : unit === 's' ? 1000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
            return Math.floor(value * factor);
        }
        const iso = trimmed.match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
        if (iso) {
            const days = Number(iso[1] || 0);
            const hours = Number(iso[2] || 0);
            const minutes = Number(iso[3] || 0);
            const seconds = Number(iso[4] || 0);
            return Math.floor(((days * 24 + hours) * 60 + minutes) * 60_000 + seconds * 1000);
        }
        return undefined;
    }
    if (typeof input === 'object') {
        const record = input as Record<string, unknown>;
        const units: Array<[string, number]> = [
            ['days', 86_400_000],
            ['hours', 3_600_000],
            ['minutes', 60_000],
            ['seconds', 1000],
            ['milliseconds', 1],
        ];
        let total = 0;
        let found = false;
        for (const [key, factor] of units) {
            const raw = record[key];
            if (raw === undefined) continue;
            const value = Number(raw);
            if (!Number.isFinite(value) || value < 0) return undefined;
            total += value * factor;
            found = true;
        }
        return found ? Math.floor(total) : undefined;
    }
    return undefined;
}

/**
 * 属性规范的共享约束与「属性谓词 → SQL」编译器。
 *
 * 属性 key 只允许扁平标识符（不含点/引号），因此可以安全地嵌入 JSON path；
 * 所有比较值一律走参数绑定，避免注入。
 */
import { DUCKDB_ERROR_CODES, DuckDbToolError } from './duckdbProtocol.js';
import { jsonListParam } from './sqlGuard.js';

export const ATTR_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
export const ATTR_TYPES = ['string', 'number', 'boolean', 'date', 'json'] as const;
export const ATTR_OPS = [
    'eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'contains', 'starts_with', 'exists', 'in',
] as const;
export const ATTR_SCOPES = ['node', 'edge'] as const;

export type AttrType = typeof ATTR_TYPES[number];
export type AttrOp = typeof ATTR_OPS[number];
export type AttrScope = typeof ATTR_SCOPES[number];

export interface AttrPredicate {
    key: string;
    op: AttrOp;
    value?: unknown;
}

export type SqlParam = string | number | boolean | null;

export function assertAttrKey(value: unknown, label = '属性 key'): string {
    const key = typeof value === 'string' ? value.trim() : '';
    if (!ATTR_KEY_PATTERN.test(key)) {
        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.invalidRequest,
            `${label} 非法：${JSON.stringify(value)}。只允许字母/数字/下划线，以字母或下划线开头，1-64 字符；不支持嵌套路径。`,
        );
    }
    return key;
}

export function assertAttrType(value: unknown): AttrType {
    const type = String(value || '').trim().toLowerCase();
    if (!(ATTR_TYPES as readonly string[]).includes(type)) {
        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.invalidRequest,
            `属性类型只支持 ${ATTR_TYPES.join(' / ')}。`,
        );
    }
    return type as AttrType;
}

export function assertAttrScope(value: unknown): AttrScope {
    const scope = String(value || '').trim().toLowerCase();
    if (!(ATTR_SCOPES as readonly string[]).includes(scope)) {
        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.invalidRequest,
            'scope 只支持 node / edge。',
        );
    }
    return scope as AttrScope;
}

/** 过滤条件：单个谓词对象或谓词数组（数组为 AND）。 */
export function normalizePredicates(value: unknown, label: string): AttrPredicate[] {
    if (value === undefined || value === null) return [];
    const list = Array.isArray(value) ? value : [value];
    if (list.length > 50) {
        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.limitExceeded,
            `${label} 最多 50 个条件，当前 ${list.length} 个。`,
        );
    }
    return list.map((item: any, index: number) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                `${label}[${index}] 必须是 {key,op,value} 对象。`,
            );
        }
        const key = assertAttrKey(item.key, `${label}[${index}].key`);
        const op = String(item.op || 'eq').trim().toLowerCase();
        if (!(ATTR_OPS as readonly string[]).includes(op)) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                `${label}[${index}].op 只支持 ${ATTR_OPS.join(' / ')}。`,
            );
        }
        if (op === 'exists' && item.value !== undefined && item.value !== null) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                `${label}[${index}] exists 不需要 value。`,
            );
        }
        if (op === 'in') {
            if (!Array.isArray(item.value) || !item.value.length) {
                throw new DuckDbToolError(
                    DUCKDB_ERROR_CODES.invalidRequest,
                    `${label}[${index}] in 需要非空数组 value。`,
                );
            }
            if (item.value.length > 200) {
                throw new DuckDbToolError(
                    DUCKDB_ERROR_CODES.limitExceeded,
                    `${label}[${index}] in 最多 200 个值。`,
                );
            }
        }
        if (['gt', 'gte', 'lt', 'lte'].includes(op) && !Number.isFinite(Number(item.value))) {
            throw new DuckDbToolError(
                DUCKDB_ERROR_CODES.invalidRequest,
                `${label}[${index}] ${op} 需要数字 value。`,
            );
        }
        return { key, op: op as AttrOp, value: item.value };
    });
}

/** propKeys：只返回指定属性，最多 20 个。 */
export function normalizePropKeys(value: unknown, label = 'propKeys'): string[] {
    if (value === undefined || value === null) return [];
    const list = Array.isArray(value) ? value : [value];
    if (list.length > 20) {
        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.limitExceeded,
            `${label} 最多 20 个属性。`,
        );
    }
    return list.map((item, index) => assertAttrKey(item, `${label}[${index}]`));
}

const jsonPath = (key: string) => `'$."${key}"'`;

/**
 * 将属性谓词编译成 SQL 片段，参数按出现顺序 push 到 params。
 * alias 必须指向含 props JSON 列的表（kg_nodes / kg_edges）。
 */
export function buildAttrPredicateSql(
    predicates: AttrPredicate[],
    alias: string,
    params: SqlParam[],
): string {
    if (!predicates.length) return '';
    const column = `${alias}.props`;
    const clauses = predicates.map((predicate) => {
        const path = jsonPath(predicate.key);
        switch (predicate.op) {
            case 'exists':
                return `json_exists(${column}, ${path})`;
            case 'eq':
                return buildEquality(`${column}`, path, predicate.value, params, false);
            case 'ne':
                return buildEquality(`${column}`, path, predicate.value, params, true);
            case 'gt':
            case 'gte':
            case 'lt':
            case 'lte': {
                params.push(Number(predicate.value));
                const operator = predicate.op === 'gt' ? '>'
                    : predicate.op === 'gte' ? '>='
                        : predicate.op === 'lt' ? '<' : '<=';
                return `TRY_CAST(json_extract_string(${column}, ${path}) AS DOUBLE) ${operator} ?`;
            }
            case 'contains':
                params.push(String(predicate.value ?? ''));
                return `contains(json_extract_string(${column}, ${path}), ?)`;
            case 'starts_with':
                params.push(String(predicate.value ?? ''));
                return `starts_with(json_extract_string(${column}, ${path}), ?)`;
            case 'in': {
                const values = predicate.value as unknown[];
                const numeric = values.every((value) => typeof value === 'number' || (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))));
                params.push(jsonListParam(values.map((value) => String(value))));
                if (numeric) {
                    return `TRY_CAST(json_extract_string(${column}, ${path}) AS DOUBLE) IN (SELECT CAST(json_extract_string(value, '$') AS DOUBLE) FROM json_each(?::JSON))`;
                }
                return `json_extract_string(${column}, ${path}) IN (SELECT json_extract_string(value, '$') FROM json_each(?::JSON))`;
            }
            default:
                return 'FALSE';
        }
    });
    return clauses.join(' AND ');
}

function buildEquality(
    column: string,
    path: string,
    value: unknown,
    params: SqlParam[],
    negate: boolean,
): string {
    const equals = (() => {
        if (value === null || value === undefined) {
            return `json_extract_string(${column}, ${path}) IS NULL`;
        }
        if (typeof value === 'number') {
            params.push(value);
            return `TRY_CAST(json_extract_string(${column}, ${path}) AS DOUBLE) = ?`;
        }
        if (typeof value === 'boolean') {
            params.push(value);
            return `TRY_CAST(json_extract_string(${column}, ${path}) AS BOOLEAN) = ?`;
        }
        params.push(String(value));
        return `json_extract_string(${column}, ${path}) = ?`;
    })();
    return negate ? `NOT (${equals})` : equals;
}

/**
 * DuckDB SQL 使用规范（唯一真值来源）。
 *
 * - 模型只能通过 kg_* 工具访问数据库；kg_query 仅允许单条只读语句。
 * - 禁止在查询里读写任意文件、装载扩展或改配置（这些能力只属于内部运维与
 *   专用导入/导出路径）。
 * - 所有写操作必须有结构化参数与显式工具，不接受自由 SQL。
 */
import { DUCKDB_ERROR_CODES, DuckDbToolError } from './duckdbProtocol.js';

/** 面向百万级图谱的默认预算；工具层与 Worker 层共同执行。 */
export const KG_LIMITS = {
    queryRowsDefault: 200,
    queryRowsMax: 2000,
    traverseNodesDefault: 200,
    traverseNodesMax: 2000,
    traverseEdgesDefault: 500,
    traverseEdgesMax: 5000,
    traverseDepthDefault: 2,
    traverseDepthMax: 10,
    pathDepthDefault: 4,
    pathDepthMax: 10,
    pathResultsDefault: 3,
    pathResultsMax: 20,
    upsertBatchMax: 5000,
    upsertChunkSize: 2000,
    analysisTopDefault: 20,
    analysisTopMax: 200,
    iterationsDefault: 20,
    iterationsMax: 100,
    importColumnsMax: 40,
    resultBytesDefault: 48 * 1024,
    resultBytesMax: 256 * 1024,
} as const;

/** 只读语句允许的前缀。 */
const READONLY_PREFIX = /^(select|with|describe|desc|summarize|explain|show|from|values|table)\b/i;

/** 任何位置出现都拒绝的写/管理关键字（词边界匹配）。 */
const FORBIDDEN_KEYWORDS = [
    'attach', 'detach', 'install', 'load', 'copy', 'export', 'import',
    'create', 'insert', 'update', 'delete', 'drop', 'alter', 'truncate',
    'pragma', 'set', 'reset', 'call', 'begin', 'commit', 'rollback',
    'checkpoint', 'vacuum', 'grant', 'revoke', 'merge',
] as const;

/** 可读文件/外部数据源的函数；只读 SQL 一律禁用。 */
const FORBIDDEN_FUNCTIONS = [
    'read_csv', 'read_csv_auto', 'read_json', 'read_json_auto', 'read_json_objects',
    'read_ndjson', 'read_ndjson_auto', 'read_parquet', 'read_text', 'read_blob',
    'parquet_scan', 'csv_scan', 'json_scan', 'glob', 'sqlite_scan', 'sqlite_attach',
    'iceberg_scan', 'delta_scan', 'postgres_scan', 'mysql_scan', 'st_read', 'st_readosm',
    'httpfs', 'read_xlsx', 'sniff_csv', 'load_extension', 'install_extension',
] as const;

/**
 * 除显式清单外，再按前缀兜底，避免 DuckDB 新增文件函数（read_、parquet_、sqlite_ 等前缀）绕过策略。
 * 这些前缀不会命中常用 SQL 函数（replace/least/starts_with 等）。
 */
const FORBIDDEN_FUNCTION_PATTERN = new RegExp(
    `\\b(?:(?:${FORBIDDEN_FUNCTIONS.join('|')})|read_[a-z0-9_]+|parquet_[a-z0-9_]+`
    + `|sqlite_[a-z0-9_]+|iceberg_[a-z0-9_]+|delta_[a-z0-9_]+|postgres_[a-z0-9_]+`
    + `|mysql_[a-z0-9_]+|st_[a-z0-9_]+)\\s*\\(`,
    'i',
);
const FORBIDDEN_KEYWORD_PATTERN = new RegExp(`\\b(?:${FORBIDDEN_KEYWORDS.join('|')})\\b`, 'i');

/**
 * 去掉注释并把字符串/引用标识符的内容抹空，避免数据里的关键字或分号干扰策略判断。
 * 保留引号本身，便于识别 `FROM 'file.csv'` 这类 replacement scan。
 */
export function sanitizeSqlForPolicy(sql: string): string {
    let out = '';
    let i = 0;
    const n = sql.length;
    while (i < n) {
        const ch = sql[i];
        const next = sql[i + 1];

        if (ch === '-' && next === '-') {
            while (i < n && sql[i] !== '\n') i++;
            out += ' ';
            continue;
        }
        if (ch === '/' && next === '*') {
            i += 2;
            while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
            i = Math.min(i + 2, n);
            out += ' ';
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            const quote = ch;
            out += quote;
            i++;
            while (i < n) {
                if (sql[i] === quote) {
                    if (sql[i + 1] === quote) {
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                i++;
            }
            out += quote;
            continue;
        }
        out += ch;
        i++;
    }
    return out;
}

/** 按顶层分号拆分；返回去掉首尾空白的非空语句。 */
export function splitSqlStatements(sql: string): string[] {
    const statements: string[] = [];
    let current = '';
    let i = 0;
    const n = sql.length;
    while (i < n) {
        const ch = sql[i];
        const next = sql[i + 1];
        if (ch === '-' && next === '-') {
            while (i < n && sql[i] !== '\n') {
                current += sql[i];
                i++;
            }
            continue;
        }
        if (ch === '/' && next === '*') {
            current += ch + next;
            i += 2;
            while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) {
                current += sql[i];
                i++;
            }
            if (i < n) {
                current += '*/';
                i += 2;
            }
            continue;
        }
        if (ch === "'" || ch === '"' || ch === '`') {
            const quote = ch;
            current += ch;
            i++;
            while (i < n) {
                current += sql[i];
                if (sql[i] === quote) {
                    if (sql[i + 1] === quote) {
                        current += sql[i + 1];
                        i += 2;
                        continue;
                    }
                    i++;
                    break;
                }
                i++;
            }
            continue;
        }
        if (ch === ';') {
            statements.push(current);
            current = '';
            i++;
            continue;
        }
        current += ch;
        i++;
    }
    statements.push(current);
    return statements.map((statement) => statement.trim()).filter(Boolean);
}

export interface ReadOnlySqlCheck {
    /** 去掉尾部空语句后的可执行 SQL（保留注释与字符串原样）。 */
    sql: string;
}

/**
 * 校验用户 SQL：单条、只读、无文件/扩展/配置访问。
 * 不通过时抛出 SQL_REJECTED，消息直接反馈给模型。
 */
export function assertReadOnlySql(rawSql: string): ReadOnlySqlCheck {
    const text = typeof rawSql === 'string' ? rawSql.trim() : '';
    if (!text) {
        throw new DuckDbToolError(DUCKDB_ERROR_CODES.sqlRejected, 'kg_query 需要非空的 sql 参数。');
    }

    const statements = splitSqlStatements(text);
    if (statements.length !== 1) {
        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.sqlRejected,
            `只允许单条只读 SQL，当前包含 ${statements.length} 条语句。请拆分后逐条调用。`,
        );
    }

    const sql = statements[0];
    const policy = sanitizeSqlForPolicy(sql);

    if (!READONLY_PREFIX.test(policy.trim())) {
        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.sqlRejected,
            'kg_query 仅支持 SELECT / WITH / DESCRIBE / SUMMARIZE / EXPLAIN 等只读查询；写操作请用 kg_upsert / kg_delete / kg_import。',
        );
    }

    const keyword = policy.match(FORBIDDEN_KEYWORD_PATTERN);
    if (keyword) {
        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.sqlRejected,
            `只读查询禁止出现 ${keyword[0].toUpperCase()}。写数据请用 kg_upsert / kg_delete / kg_import；改配置请用 kg_admin。`,
        );
    }

    const fn = policy.match(FORBIDDEN_FUNCTION_PATTERN);
    if (fn) {
        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.sqlRejected,
            `只读查询禁止调用文件/外部数据函数 ${fn[0].replace(/\s*\($/, '')}()。导入文件请用 kg_import。`,
        );
    }

    if (/\b(?:from|join)\s+'/i.test(policy)) {
        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.sqlRejected,
            '只读查询禁止直接扫描文件路径；请先 kg_import 入库再查询。',
        );
    }

    return { sql };
}

/** 仅允许简单标识符，避免导入列名注入。 */
export function assertSafeIdentifier(name: string, label: string): string {
    const value = typeof name === 'string' ? name.trim() : '';
    if (!/^[A-Za-z_][A-Za-z0-9_$]*$/.test(value)) {
        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.sqlRejected,
            `${label} 不是合法列名：${JSON.stringify(name)}。列名只能包含字母、数字、下划线和 $，且不能以数字开头。`,
        );
    }
    return value;
}

export function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const num = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.trunc(num)));
}

export function normalizeStringArray(value: unknown, label: string, maxItems = 500): string[] {
    if (value === undefined || value === null) return [];
    const list = Array.isArray(value) ? value : [value];
    if (list.length > maxItems) {
        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.limitExceeded,
            `${label} 最多 ${maxItems} 项，当前 ${list.length} 项。`,
        );
    }
    const result: string[] = [];
    for (const item of list) {
        if (typeof item !== 'string' || !item.trim()) {
            throw new DuckDbToolError(DUCKDB_ERROR_CODES.invalidRequest, `${label} 只能包含非空字符串。`);
        }
        result.push(item.trim());
    }
    return result;
}

export function jsonListParam(values: string[]): string {
    return JSON.stringify(values);
}

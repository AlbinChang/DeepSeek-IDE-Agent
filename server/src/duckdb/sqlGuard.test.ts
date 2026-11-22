import { describe, expect, it } from 'vitest';

import { assertReadOnlySql, sanitizeSqlForPolicy, splitSqlStatements, clampInt, normalizeStringArray } from '@/duckdb/sqlGuard.js';

describe('duckdb sql guard', () => {
    it('accepts single read-only statements', () => {
        expect(assertReadOnlySql('SELECT * FROM kg_nodes LIMIT 5').sql)
            .toBe('SELECT * FROM kg_nodes LIMIT 5');
        expect(assertReadOnlySql('WITH x AS (SELECT 1) SELECT * FROM x;').sql)
            .toBe('WITH x AS (SELECT 1) SELECT * FROM x');
        expect(assertReadOnlySql('  describe kg_edges  ').sql).toBe('describe kg_edges');
    });

    it('rejects multiple statements', () => {
        expect(() => assertReadOnlySql('SELECT 1; SELECT 2')).toThrow(/单条只读 SQL/);
        expect(() => assertReadOnlySql('SELECT 1;')).not.toThrow();
    });

    it('rejects write and management statements', () => {
        for (const sql of [
            'DELETE FROM kg_nodes',
            'INSERT INTO kg_nodes VALUES (1)',
            'DROP TABLE kg_edges',
            'PRAGMA database_size',
            'ATTACH \'other.db\'',
            'SET threads = 1',
            'COPY (SELECT 1) TO \'x.csv\'',
            'LOAD httpfs',
        ]) {
            expect(() => assertReadOnlySql(sql), sql).toThrow(/只读|禁止/);
        }
    });

    it('rejects file and external scans even inside a SELECT', () => {
        expect(() => assertReadOnlySql("SELECT * FROM read_csv_auto('x.csv')"))
            .toThrow(/文件\/外部数据函数/);
        expect(() => assertReadOnlySql('SELECT * FROM glob(\'**/*.csv\')'))
            .toThrow(/文件\/外部数据函数/);
        expect(() => assertReadOnlySql("SELECT * FROM 'x.parquet'"))
            .toThrow(/禁止直接扫描文件路径/);
    });

    it('ignores keywords that only appear inside strings or comments', () => {
        expect(() => assertReadOnlySql("SELECT 'delete from users' AS s")).not.toThrow();
        expect(() => assertReadOnlySql('SELECT 1 -- drop table x\n')).not.toThrow();
        expect(() => assertReadOnlySql('SELECT replace(name, \'a\', \'b\') FROM kg_nodes')).not.toThrow();
    });

    it('sanitizes comments and string contents', () => {
        expect(sanitizeSqlForPolicy("SELECT 'a;b' -- x;y\nFROM t")).not.toContain('a;b');
        expect(splitSqlStatements("SELECT ';' AS s; SELECT 2")).toHaveLength(2);
    });

    it('clamps numeric budgets and validates string lists', () => {
        expect(clampInt('50', 1, 2000, 200)).toBe(50);
        expect(clampInt(undefined, 1, 2000, 200)).toBe(200);
        expect(clampInt(99999, 1, 2000, 200)).toBe(2000);
        expect(normalizeStringArray('a', 'ids')).toEqual(['a']);
        expect(normalizeStringArray(['a', ' b '], 'ids')).toEqual(['a', 'b']);
        expect(() => normalizeStringArray([1], 'ids')).toThrow(/非空字符串/);
    });
});

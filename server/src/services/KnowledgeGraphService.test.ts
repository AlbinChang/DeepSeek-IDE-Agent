import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { KnowledgeGraphService } from '@/services/KnowledgeGraphService.js';
import { KnowledgeGraphTools } from '@/tools/KnowledgeGraphTools.js';

let tempRoot: string;

beforeAll(async () => {
    tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kg-tools-test-'));
    await fs.mkdir(path.join(tempRoot, '.duckdb'), { recursive: true });
});

afterAll(async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
});

describe('knowledge graph tool surface', () => {
    it('exposes the full atomic tool set with valid schemas', () => {
        const definitions = KnowledgeGraphTools.getDefinitions();
        expect(definitions.map((def) => def.name)).toEqual([
            'kg_admin',
            'kg_query',
            'kg_upsert',
            'kg_delete',
            'kg_traverse',
            'kg_path',
            'kg_analyze',
            'kg_import',
        ]);
        const requiredByTool = new Map<string, string[]>(
            definitions.map((def) => [def.name, ((def.parameters as any).required as string[]) || []]),
        );
        for (const def of definitions) {
            expect(def.description.length, def.name).toBeLessThanOrEqual(160);
            expect((def.parameters as any).type).toBe('object');
            expect(typeof (def.parameters as any).properties).toBe('object');
        }
        expect(requiredByTool.get('kg_query')).toEqual(['sql']);
        expect(requiredByTool.get('kg_traverse')).toEqual(['startIds']);
        expect(requiredByTool.get('kg_path')).toEqual(['from', 'to']);
        expect(requiredByTool.get('kg_analyze')).toEqual(['algorithm']);
        expect(requiredByTool.get('kg_import')).toEqual(['target', 'path']);
    });

    it('refuses to touch the database file directly', async () => {
        const service = new KnowledgeGraphService(tempRoot);
        await expect(service.importData({ target: 'nodes', path: '.duckdb/kg.duckdb' }))
            .rejects.toMatchObject({ code: 'PATH_REJECTED' });
        await expect(service.importData({ target: 'nodes', path: '.duckdb/kg.duckdb.wal' }))
            .rejects.toMatchObject({ code: 'PATH_REJECTED' });
    });

    it('refuses paths outside the workspace', async () => {
        const service = new KnowledgeGraphService(tempRoot);
        await expect(service.importData({ target: 'nodes', path: '../outside.json' }))
            .rejects.toThrow(/SECURITY_VIOLATION|工作区/);
    });

    it('rejects an empty query before spawning a worker', async () => {
        const service = new KnowledgeGraphService(tempRoot);
        await expect(service.query({ sql: '   ' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
        await expect(service.analyze({ algorithm: 'nope' })).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    });
});

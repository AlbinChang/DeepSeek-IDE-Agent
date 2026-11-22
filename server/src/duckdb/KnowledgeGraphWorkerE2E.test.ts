import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { DuckDbProcessClient } from '@/duckdb/DuckDbProcessClient.js';
import { KnowledgeGraphService } from '@/services/KnowledgeGraphService.js';

let root: string;

beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'kg-worker-e2e-'));
    await fs.mkdir(path.join(root, '.duckdb'), { recursive: true });
});

afterAll(async () => {
    await DuckDbProcessClient.getInstance().closeWorkspace(root).catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

describe('knowledge graph worker end-to-end (multi-type graph)', () => {
    it('scopes identity/unique to rdfs:domain and keeps outputs compact', async () => {
        const service = new KnowledgeGraphService(root);
        const nodesPath = path.join(root, 'nodes.ndjson');
        await fs.writeFile(nodesPath, [
            { id: 'c1', type: 'company', props: { name: 'A', code: '600000' } },
            { id: 'c2', type: 'company', props: { name: 'B', code: '600001' } },
            { id: 'c3', type: 'company', props: { name: 'C' } },
            { id: 'i1', type: 'industry', props: { name: 'bank', code: '600000' } },
            { id: 'i2', type: 'industry', props: { name: 'steel', code: '600000' } },
            { id: 'p1', type: 'person', props: { name: 'X', code: '600000' } },
            { id: 'p2', type: 'person', props: { name: 'Y', code: '600000' } },
        ].map((row) => JSON.stringify(row)).join('\n'), 'utf8');
        const imported = await service.importData({ target: 'nodes', path: 'nodes.ndjson' });
        expect(imported).toContain('写入/更新 7 行');

        for (const name of ['company', 'industry', 'person']) {
            await service.vocab({ action: 'define', kind: 'class', name });
        }
        for (const name of ['belongs_to']) {
            await service.vocab({
                action: 'define', kind: 'property', name,
                domain: ['company'], range: ['industry'],
            });
        }
        const defined = await service.attrDefine({
            scope: 'node', key: 'code', type: 'string',
            unique: true, identity: true, domain: ['company'], confirm: true,
        });
        expect(defined).toContain('身份键索引已写入 2 行');

        const lint = await service.lint({});
        // 身份键统计收敛到 domain 内：只有 company.c3 真正缺键，industry/person 不计入
        expect(lint).toContain('identity_incomplete | 1');
        expect(lint).toContain('仅统计 company');
        // domain 外携带 code 的类型属于真实违规（声明 domain 后才可检出）
        expect(lint).toContain('attr_domain_violation | 4');
        expect(lint).not.toContain('attr_unique_duplicate');
        expect(lint.length).toBeLessThan(1200);

        const validate = await service.admin({ action: 'validate' });
        expect(validate).toContain('✅ 合规');
        expect(validate).toContain('语义门禁请跑 kg_lint');
        expect(validate.length).toBeLessThan(800);

        const status = await service.admin({ action: 'status' });
        expect(status).toContain('空闲回收');
        expect(status).toContain('DUCKDB_IDLE_TIMEOUT_MS');

        await expect(service.upsert({
            nodes: [{ id: 'c9', type: 'company', props: { name: 'D', code: '600000' } }],
        })).rejects.toThrow(/unique|身份键/);
        await expect(service.upsert({
            nodes: [{ id: 'p9', type: 'person', props: { name: 'Z', code: '700000' } }],
        })).rejects.toThrow(/属性域/);
    }, 120_000);
});

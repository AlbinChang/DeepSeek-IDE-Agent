import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { NeverMistakeTools } from '@/tools/NeverMistakeTools.js';

describe('NeverMistakeTools compact append result', () => {
    const tempDirs: string[] = [];

    afterEach(async () => {
        await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    });

    it('returns applied count and ids instead of echoing every stored rule', async () => {
        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'never-mistake-tools-'));
        tempDirs.push(workspaceRoot);
        const tools = new NeverMistakeTools(workspaceRoot);

        const result: any = await tools.appendRule({
            entries: [{ shouldNot: '重复旧做法', shouldDo: '改用新做法' }],
        }, {});

        expect(result.status).toBe('success');
        expect(result.applied).toBe(1);
        expect(result.total).toBe(1);
        expect(result.ids).toHaveLength(1);
        expect(result.records).toBeUndefined();
    });
});

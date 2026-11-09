import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { RuleService } from '@/services/RuleService.js';

describe('RuleService', () => {
    const tempDirs: string[] = [];

    const createWorkspace = async () => {
        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-ide-agent-rules-'));
        tempDirs.push(workspaceRoot);
        return workspaceRoot;
    };

    const writeWorkspaceFile = async (workspaceRoot: string, relativePath: string, content: string) => {
        const absolutePath = path.join(workspaceRoot, ...relativePath.split('/'));
        await fs.mkdir(path.dirname(absolutePath), { recursive: true });
        await fs.writeFile(absolutePath, content, 'utf8');
    };

    afterEach(async () => {
        RuleService.getInstance().clearCache();
        await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    });

    it('returns null when the workspace has no rule directory', async () => {
        const workspaceRoot = await createWorkspace();

        await expect(RuleService.getInstance().loadWorkspaceRules(workspaceRoot)).resolves.toBeNull();
    });

    it('loads the legacy .rules/rule.md convention', async () => {
        const workspaceRoot = await createWorkspace();
        await writeWorkspaceFile(workspaceRoot, '.rules/rule.md', '# Legacy rules\n');

        const result = await RuleService.getInstance().loadWorkspaceRules(workspaceRoot);

        expect(result).toMatchObject({
            ruleDirectory: '.rules',
            mainFileName: 'rule.md',
            mainRulePath: '.rules/rule.md',
            mainRule: '# Legacy rules\n',
            referencedRules: [],
        });
        expect(result?.error).toBeUndefined();
    });

    it('loads the .lingma/rules/project_rule.md convention', async () => {
        const workspaceRoot = await createWorkspace();
        await writeWorkspaceFile(workspaceRoot, '.lingma/rules/project_rule.md', '# Lingma rules\n');
        await writeWorkspaceFile(workspaceRoot, '.lingma/rules/api.md', '# API rules\n');

        const result = await RuleService.getInstance().loadWorkspaceRules(workspaceRoot);

        expect(result).toMatchObject({
            ruleDirectory: '.lingma/rules',
            mainFileName: 'project_rule.md',
            mainRulePath: '.lingma/rules/project_rule.md',
            mainRule: '# Lingma rules\n',
        });
        expect(result?.referencedRules.map((rule) => rule.name)).toEqual(['api.md']);
        expect(result?.referencedRules[0].content).toBe('# API rules\n');
    });

    it('prefers .rules/rule.md when both conventions exist', async () => {
        const workspaceRoot = await createWorkspace();
        await writeWorkspaceFile(workspaceRoot, '.rules/rule.md', '# Legacy rules\n');
        await writeWorkspaceFile(workspaceRoot, '.lingma/rules/project_rule.md', '# Lingma rules\n');

        const result = await RuleService.getInstance().loadWorkspaceRules(workspaceRoot);

        expect(result?.ruleDirectory).toBe('.rules');
        expect(result?.mainRule).toBe('# Legacy rules\n');
    });

    it('falls back to .lingma when .rules exists without rule.md', async () => {
        const workspaceRoot = await createWorkspace();
        await writeWorkspaceFile(workspaceRoot, '.rules/notes.md', '# Notes\n');
        await writeWorkspaceFile(workspaceRoot, '.lingma/rules/project_rule.md', '# Lingma rules\n');

        const result = await RuleService.getInstance().loadWorkspaceRules(workspaceRoot);

        expect(result?.ruleDirectory).toBe('.lingma/rules');
        expect(result?.error).toBeUndefined();
    });

    it('reports the missing main file when only the directory exists', async () => {
        const workspaceRoot = await createWorkspace();
        await writeWorkspaceFile(workspaceRoot, '.lingma/rules/api.md', '# API rules\n');

        const result = await RuleService.getInstance().loadWorkspaceRules(workspaceRoot);

        expect(result?.error).toContain('.lingma/rules');
        expect(result?.error).toContain('project_rule.md');
    });

    it('truncates oversized main rules', async () => {
        const workspaceRoot = await createWorkspace();
        await writeWorkspaceFile(workspaceRoot, '.lingma/rules/project_rule.md', 'a'.repeat(10050));

        const result = await RuleService.getInstance().loadWorkspaceRules(workspaceRoot);

        expect(result?.error).toContain('10000');
        expect(result?.mainRule).toContain('... (内容已截断)');
        expect(result!.mainRule.length).toBeLessThan(10050);
    });

    it('loads referenced sub rules from the rule directory', async () => {
        const workspaceRoot = await createWorkspace();
        await writeWorkspaceFile(
            workspaceRoot,
            '.lingma/rules/project_rule.md',
            '# Lingma rules\n\nSee [API rules](./api.md) and [include: DB](./db.md).\n',
        );
        await writeWorkspaceFile(workspaceRoot, '.lingma/rules/api.md', '# API rules\n');
        await writeWorkspaceFile(workspaceRoot, '.lingma/rules/db.md', '# DB rules\n');

        const result = await RuleService.getInstance().loadWorkspaceRules(workspaceRoot);

        expect(result?.referencedRules.map((rule) => rule.name)).toEqual(['api.md', 'db.md']);
    });

    it('rejects references escaping the rule directory', async () => {
        const workspaceRoot = await createWorkspace();
        await writeWorkspaceFile(workspaceRoot, '.rules/rule.md', '[escape](./../secret.md)\n');
        await writeWorkspaceFile(workspaceRoot, 'secret.md', '# Secret\n');

        const result = await RuleService.getInstance().loadWorkspaceRules(workspaceRoot);

        expect(result?.referencedRules).toEqual([]);
    });
});

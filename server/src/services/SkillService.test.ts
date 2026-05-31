import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SkillService } from '@/services/SkillService.js';

describe('SkillService', () => {
    const tempDirs: string[] = [];

    const createWorkspace = async () => {
        const workspaceRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'deepseek-ide-agent-skills-'));
        tempDirs.push(workspaceRoot);
        return workspaceRoot;
    };

    const writeSkill = async (workspaceRoot: string, relativeSkillPath: string, name: string, description: string) => {
        const absoluteSkillPath = path.join(workspaceRoot, ...relativeSkillPath.split('/'));
        await fs.mkdir(path.dirname(absoluteSkillPath), { recursive: true });
        await fs.writeFile(
            absoluteSkillPath,
            `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
            'utf8'
        );
    };

    afterEach(async () => {
        SkillService.getInstance().clearCache();
        await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    });

    it('loads skills from Claude, GitHub, agents, and legacy workspace paths', async () => {
        const workspaceRoot = await createWorkspace();
        await writeSkill(workspaceRoot, '.claude/skills/api-conventions/SKILL.md', 'api-conventions', 'REST API conventions');
        await writeSkill(workspaceRoot, '.github/skills/react-best-practices/SKILL.md', 'react-best-practices', 'React conventions');
        await writeSkill(workspaceRoot, '.agents/skills/team-workflow/SKILL.md', 'team-workflow', 'Team workflow');
        await writeSkill(workspaceRoot, '.skills/legacy-workflow/SKILL.md', 'legacy-workflow', 'Legacy workflow');

        const skills = await SkillService.getInstance().getSkills(workspaceRoot);

        expect(skills).toMatchObject([
            {
                name: 'api-conventions',
                description: 'REST API conventions',
                folderName: 'api-conventions',
                skillRoot: '.claude/skills',
                skillFilePath: '.claude/skills/api-conventions/SKILL.md',
            },
            {
                name: 'react-best-practices',
                description: 'React conventions',
                folderName: 'react-best-practices',
                skillRoot: '.github/skills',
                skillFilePath: '.github/skills/react-best-practices/SKILL.md',
            },
            {
                name: 'team-workflow',
                description: 'Team workflow',
                folderName: 'team-workflow',
                skillRoot: '.agents/skills',
                skillFilePath: '.agents/skills/team-workflow/SKILL.md',
            },
            {
                name: 'legacy-workflow',
                description: 'Legacy workflow',
                folderName: 'legacy-workflow',
                skillRoot: '.skills',
                skillFilePath: '.skills/legacy-workflow/SKILL.md',
            },
        ]);
    });

    it('keeps lowercase skill.md as a compatibility fallback', async () => {
        const workspaceRoot = await createWorkspace();
        await writeSkill(workspaceRoot, '.github/skills/lowercase-entry/skill.md', 'lowercase-entry', 'Lowercase entrypoint');

        const skills = await SkillService.getInstance().getSkills(workspaceRoot);

        expect(skills).toHaveLength(1);
        expect(skills[0].skillFilePath).toBe('.github/skills/lowercase-entry/skill.md');
    });
});
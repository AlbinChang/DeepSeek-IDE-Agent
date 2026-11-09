import { describe, expect, it } from 'vitest';

import {
    BuiltinSkillService,
    buildAutoLoadedSkills,
    buildBuiltinSkillIndex,
} from '@/services/BuiltinSkillService.js';

const EXPECTED_SKILLS = [
    'code-review',
    'doc-writing',
    'md-to-pdf',
    'ppt-design',
    'svg-diagram',
    'web-research',
];

describe('BuiltinSkillService', () => {
    it('loads every packaged skill with usable frontmatter metadata', async () => {
        BuiltinSkillService.getInstance().clearCache();
        const skills = await BuiltinSkillService.getInstance().listSkills();

        expect(skills.map((skill) => skill.name).sort()).toEqual(EXPECTED_SKILLS);

        for (const skill of skills) {
            expect(skill.description.length, skill.name).toBeGreaterThan(10);
            expect(skill.triggers.length, skill.name).toBeGreaterThan(0);
            expect(skill.content.length, skill.name).toBeGreaterThan(200);
            expect(skill.content.startsWith('---'), skill.name).toBe(false);
        }
    });

    it('builds a compact index that only lists names and descriptions', async () => {
        BuiltinSkillService.getInstance().clearCache();
        const index = await buildBuiltinSkillIndex();

        expect(index).toContain('read_skill');
        for (const name of EXPECTED_SKILLS) {
            expect(index).toContain(name);
        }
        // 索引必须保持轻量：完整规范只在命中场景通过 read_skill 拉取
        expect(index.length).toBeLessThan(2000);
    });

    it('matches only the skills that the instruction actually needs', async () => {
        BuiltinSkillService.getInstance().clearCache();

        const stockTask = await BuiltinSkillService.getInstance()
            .matchSkills('根据标准 联网搜索 更新 高价值股票代码.md');
        expect(stockTask.map((skill) => skill.name)).toContain('web-research');
        expect(stockTask.map((skill) => skill.name)).not.toContain('ppt-design');

        const pptTask = await BuiltinSkillService.getInstance()
            .matchSkills('帮我做一份 8 页的产品发布会幻灯片');
        expect(pptTask[0]?.name).toBe('ppt-design');

        const reviewTask = await BuiltinSkillService.getInstance()
            .matchSkills('请对 server/src 做一次代码检视');
        expect(reviewTask.map((skill) => skill.name)).toContain('code-review');

        const unrelated = await BuiltinSkillService.getInstance()
            .matchSkills('把这段文字翻译成英文');
        expect(unrelated).toEqual([]);
    });

    it('auto-loads matched skill bodies and stays empty for unrelated instructions', async () => {
        BuiltinSkillService.getInstance().clearCache();

        const loaded = await buildAutoLoadedSkills('写一份 Markdown 报告并导出 PDF');
        expect(loaded).toContain('已按需加载技能');
        expect(loaded).toContain('素材充分性优先');

        expect(await buildAutoLoadedSkills('1+1 等于几')).toBe('');
    });

    it('resolves skills by name case-insensitively', async () => {
        BuiltinSkillService.getInstance().clearCache();

        expect((await BuiltinSkillService.getInstance().getSkill('PPT-Design'))?.name).toBe('ppt-design');
        expect(await BuiltinSkillService.getInstance().getSkill('missing-skill')).toBeUndefined();
    });
});

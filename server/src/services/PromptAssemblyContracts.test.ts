import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function readSource(relativePath: string) {
    return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

async function readJson(relativePath: string) {
    return JSON.parse(await readSource(relativePath));
}

/**
 * 系统提示词装配契约：
 * - 专业任务长规范必须沉淀到内置技能，常驻提示词只保留索引与核心约束；
 * - main-agent.json 不再承载 PPT/SVG/文档/PDF/检索类的整段规范；
 * - 提示词总预算受控，避免再次膨胀。
 */
describe('system prompt assembly contracts', () => {
    it('keeps relocated specialist contracts out of the always-on agent config', async () => {
        const config = await readJson('config/main-agent.json');
        const keys = Object.keys(config.operation_guidelines);

        expect(keys.filter((key) => key.startsWith('ppt_'))).toEqual([]);
        expect(keys).not.toContain('diagram_and_visual_contract');
        expect(keys).not.toContain('node_md_to_pdf_contract');
        expect(keys).not.toContain('webpage_markdown_local_image_contract');
        expect(keys).not.toContain('knowledge_exploration_priority_contract');
        expect(keys).not.toContain('git_clone_mirror_priority_contract');
        expect(keys).not.toContain('markdown_doc_material_grounding_contract');
        expect(keys).not.toContain('browser_mcp_call_argument_contract');
        expect(keys).toContain('skill_usage_contract');
    });

    it('keeps the always-on guideline and tip budget small', async () => {
        const config = await readJson('config/main-agent.json');
        const textLength = (value: unknown) => (Array.isArray(value) ? value.join('') : String(value)).length;
        const guidelineChars = Object.values(config.operation_guidelines as Record<string, unknown>)
            .reduce((total, value) => total + textLength(value), 0);
        const tipChars = (config.important_tips as string[])
            .reduce((total, text) => total + text.length, 0);

        expect(Object.keys(config.operation_guidelines).length).toBeLessThanOrEqual(14);
        expect(guidelineChars).toBeLessThanOrEqual(3600);
        expect(tipChars).toBeLessThanOrEqual(1800);
    });

    it('routes professional guidance to the matching builtin skill', async () => {
        const ppt = await readSource('config/skills/ppt-design/SKILL.md');
        expect(ppt).toContain('960pt');
        expect(ppt).toContain('1280px');
        expect(ppt).toContain('逐页检查');
        expect(ppt).not.toContain('涉及 PPT/幻灯片任务时，');

        const svg = await readSource('config/skills/svg-diagram/SKILL.md');
        expect(svg).toContain('Mermaid');
        expect(svg).toContain('viewBox');

        const pdf = await readSource('config/skills/md-to-pdf/SKILL.md');
        expect(pdf).toContain('md-to-pdf');
        expect(pdf).toContain('乱码');

        const research = await readSource('config/skills/web-research/SKILL.md');
        expect(research).toContain('gitee.com/mirrors');
        expect(research).toContain('docs/images/');

        const review = await readSource('config/skills/code-review/SKILL.md');
        expect(review).toContain('P0');
        expect(review).toContain('问题清单');
    });

    it('routes java archive inspection to the jar skill instead of reading binaries', async () => {
        const jar = await readSource('config/skills/jar-analysis/SKILL.md');
        expect(jar).toContain('jar tf');
        expect(jar).toContain('jar xf');
        expect(jar).toContain('MANIFEST.MF');
        expect(jar).toContain('javap');

        const config = await readJson('config/main-agent.json');
        const tips = config.important_tips as string[];
        expect(tips.some((tip) => tip.includes('jar-analysis'))).toBe(true);
        expect(tips.some((tip) => tip.includes('read_file 直接读取'))).toBe(true);
    });

    it('registers a concise read_skill tool for on-demand retrieval', async () => {
        const source = await readSource('services/AgentService.ts');
        const toolIndex = source.indexOf("name: 'read_skill'");
        expect(toolIndex).toBeGreaterThanOrEqual(0);

        const descriptionIndex = source.indexOf('description:', toolIndex);
        const parametersIndex = source.indexOf('parameters:', descriptionIndex);
        const description = source.slice(descriptionIndex, parametersIndex);

        expect(description.length).toBeLessThanOrEqual(150);
        expect(source).toContain('buildBuiltinSkillIndex');
        expect(source).toContain('buildAutoLoadedSkills');
    });
});

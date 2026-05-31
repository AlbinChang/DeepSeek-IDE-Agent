import { SkillService } from './SkillService.js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = 'd:/deepseek-ide-agent/workspace';

async function testSkillLoading() {
    console.log('--- 开始测试 SkillService ---');
    const skillService = SkillService.getInstance();
    
    try {
        const skills = await skillService.getSkills(workspaceRoot);
        console.log('加载到的 Skills:', JSON.stringify(skills, null, 2));
        
        if (skills.length > 0) {
            console.log('✅ 测试成功：成功识别并解析了 Skill 元数据。');
        } else {
            console.log('❌ 测试失败：未找到 Skills，请检查 .claude/skills、.github/skills、.agents/skills、.skills 目录和 SKILL.md。');
        }
    } catch (err) {
        console.error('❌ 测试出错:', err);
    }
}

testSkillLoading();

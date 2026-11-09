/**
 * BuiltinSkillService — 内置专项技能（Skill）加载与检索
 *
 * 设计目标：
 * 1. 把「专业任务长规范」（PPT / SVG / 代码检视 / 文档 / PDF / 联网检索）从常驻系统提示词中
 *    下沉为按需加载的技能文件，系统提示词只保留极简索引。
 * 2. 技能文件随 Agent 一起分发（CONFIG_ROOT/skills/<name>/SKILL.md），无需用户工作区配置。
 * 3. 两种检索方式：
 *    - 服务端按用户指令关键词自动装配（matchSkills），命中即注入本轮提示词；
 *    - 模型主动调用 read_skill 工具拉取完整规范。
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { CONFIG_ROOT } from '@/utils/PathUtils.js';

export interface BuiltinSkill {
    /** 技能唯一名称（frontmatter name，缺省取目录名） */
    name: string;
    /** 一句话用途描述（供索引展示） */
    description: string;
    /** 命中关键词 */
    triggers: string[];
    /** SKILL.md 正文（已剥离 frontmatter） */
    content: string;
}

const FRONTMATTER_PATTERN = /^(?:\uFEFF)?\s*---\r?\n([\s\S]+?)\r?\n---\r?\n?/;
const CACHE_TTL = 10 * 1000;
const MAX_SKILLS = 50;
/** 单轮自动注入的技能数量与字符预算上限，避免再次膨胀提示词 */
const MAX_AUTO_LOADED_SKILLS = 2;
const MAX_AUTO_LOADED_CHARS = 12 * 1024;

export class BuiltinSkillService {
    private static instance: BuiltinSkillService;
    private cache: { skills: BuiltinSkill[]; timestamp: number } | null = null;

    public static getInstance(): BuiltinSkillService {
        if (!this.instance) {
            this.instance = new BuiltinSkillService();
        }
        return this.instance;
    }

    /** 内置技能根目录：随 CONFIG_ROOT 一起分发（dev: server/src/config/skills，打包后: resources/config/skills） */
    public get skillsRoot(): string {
        return path.join(CONFIG_ROOT, 'skills');
    }

    /** 列出全部内置技能（按名称排序，10 秒缓存） */
    public async listSkills(): Promise<BuiltinSkill[]> {
        const now = Date.now();
        if (this.cache && now - this.cache.timestamp < CACHE_TTL) {
            return this.cache.skills;
        }

        const skills = await this.loadSkills();
        this.cache = { skills, timestamp: now };
        return skills;
    }

    /** 按名称精确（忽略大小写）获取内置技能 */
    public async getSkill(name: string): Promise<BuiltinSkill | undefined> {
        const normalized = name.trim().toLowerCase();
        if (!normalized) return undefined;
        const skills = await this.listSkills();
        return skills.find((skill) => skill.name.toLowerCase() === normalized);
    }

    /**
     * 按用户指令匹配技能：命中关键词越多、越靠前。
     * 仅返回达到阈值的技能，且受数量预算限制。
     */
    public async matchSkills(instruction: string, limit = MAX_AUTO_LOADED_SKILLS): Promise<BuiltinSkill[]> {
        // 兼容多模态消息：非字符串输入统一转字符串后再匹配
        const text = typeof instruction === 'string' ? instruction.toLowerCase() : '';
        if (!text.trim()) return [];
        const skills = await this.listSkills();

        const scored = skills
            .map((skill) => ({ skill, score: countMatches(text, skill.triggers) }))
            .filter((entry) => entry.score > 0)
            .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name));

        return scored.slice(0, Math.max(0, limit)).map((entry) => entry.skill);
    }

    /** 清空缓存（技能文件变更后调用） */
    public clearCache(): void {
        this.cache = null;
    }

    private async loadSkills(): Promise<BuiltinSkill[]> {
        const root = this.skillsRoot;
        let entries: import('node:fs').Dirent[];
        try {
            entries = await fs.readdir(root, { withFileTypes: true });
        } catch {
            return [];
        }

        const folders = entries
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
            .sort((left, right) => left.localeCompare(right))
            .slice(0, MAX_SKILLS);

        const skills: BuiltinSkill[] = [];
        for (const folder of folders) {
            const skillFile = path.join(root, folder, 'SKILL.md');
            let raw: string;
            try {
                raw = await fs.readFile(skillFile, 'utf8');
            } catch {
                continue;
            }

            const { metadata, body } = splitFrontmatter(raw);
            const name = asTrimmedString(metadata?.name) || folder;
            const description = asTrimmedString(metadata?.description);
            if (!description) continue;

            skills.push({
                name,
                description,
                triggers: normalizeTriggers(metadata?.triggers),
                content: body.trim(),
            });
        }

        return skills;
    }
}

/** 构建技能索引提示词片段；无内置技能时返回空字符串 */
export async function buildBuiltinSkillIndex(): Promise<string> {
    const skills = await BuiltinSkillService.getInstance().listSkills();
    if (skills.length === 0) return '';

    return [
        '### 内置专项技能索引 (BUILT-IN SKILLS — 按需加载)',
        '下列技能内置了专业领域的完整规范。命中对应场景时，必须先调用 `read_skill("<name>")` 载入完整规范后再执行，禁止凭经验即兴发挥；未命中场景不要加载。',
        ...skills.map((skill) => `- **${skill.name}**: ${skill.description}`),
    ].join('\n');
}

/** 构建自动装配的技能正文片段；命中技能为空时返回空字符串 */
export async function buildAutoLoadedSkills(instruction: string): Promise<string> {
    const matched = await BuiltinSkillService.getInstance().matchSkills(instruction);
    if (matched.length === 0) return '';

    const blocks: string[] = [];
    let usedChars = 0;
    for (const skill of matched) {
        if (usedChars > 0 && usedChars + skill.content.length > MAX_AUTO_LOADED_CHARS) break;
        usedChars += skill.content.length;
        // 去掉技能正文的一级标题，避免与系统提示词的标题层级冲突（技能名已在段落标题中声明）
        const body = skill.content.replace(/^#[^\r\n]*(?:\r?\n)+/, '').trim();
        blocks.push(`### 已按需加载技能：${skill.name}\n\n${body}`);
    }

    return blocks.join('\n\n');
}

function splitFrontmatter(raw: string): { metadata: Record<string, any> | null; body: string } {
    const match = raw.match(FRONTMATTER_PATTERN);
    if (!match) return { metadata: null, body: raw };

    try {
        const parsed = yaml.load(match[1]);
        const metadata = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
            ? (parsed as Record<string, any>)
            : null;
        return { metadata, body: raw.slice(match[0].length) };
    } catch {
        return { metadata: null, body: raw };
    }
}

function normalizeTriggers(value: unknown): string[] {
    const raw = Array.isArray(value)
        ? value
        : typeof value === 'string'
            ? value.split(/[,，\s]+/)
            : [];
    return raw
        .map((item) => (typeof item === 'string' ? item.trim().toLowerCase() : ''))
        .filter((item) => item.length > 0);
}

function asTrimmedString(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
}

/** ASCII 关键词按词边界匹配，中文关键词按子串匹配，避免英文缩写误命中 */
function countMatches(text: string, triggers: string[]): number {
    let score = 0;
    for (const trigger of triggers) {
        if (/^[\x20-\x7e]+$/.test(trigger)) {
            const escaped = trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(text)) score += 2;
        } else if (text.includes(trigger)) {
            score += 1;
        }
    }
    return score;
}

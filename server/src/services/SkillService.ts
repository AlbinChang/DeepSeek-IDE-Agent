import fs from "fs/promises";
import path from "path";
import yaml from "js-yaml";
import { getBeijingLogTimePrefix } from "@/utils/TimeUtils.js";
import { WORKSPACE_SKILL_DIRECTORIES, type WorkspaceSkillDirectory } from "@/utils/WorkspaceSkillPaths.js";

export interface AgentSkill {
    name: string;        // 来自 YAML Frontmatter 的 name
    description: string; // 来自 YAML Frontmatter 的 description
    folderName: string;  // 实际目录名
    skillRoot: WorkspaceSkillDirectory; // 所属 workspace-relative skills 根路径
    skillFilePath: string; // SKILL.md 的 workspace-relative 路径
}

const getTS = () => getBeijingLogTimePrefix();

export class SkillService {
    private static instance: SkillService;
    private skillCache: Map<string, { skills: AgentSkill[], timestamp: number }> = new Map();
    private readonly CACHE_TTL = 10 * 1000; // 10 seconds
    private readonly MAX_SKILLS_PER_DIRECTORY = 50;

    public static getInstance(): SkillService {
        if (!this.instance) {
            this.instance = new SkillService();
        }
        return this.instance;
    }

    /**
     * 加载指定工作目录下的 skills
     */
    public async getSkills(workspaceRoot: string): Promise<AgentSkill[]> {
        const now = Date.now();
        const cached = this.skillCache.get(workspaceRoot);
        if (cached && (now - cached.timestamp < this.CACHE_TTL)) {
            return cached.skills;
        }

        const skills: AgentSkill[] = [];

        for (const skillDirectory of WORKSPACE_SKILL_DIRECTORIES) {
            const directorySkills = await this.loadSkillsFromDirectory(workspaceRoot, skillDirectory);
            skills.push(...directorySkills);
        }

        this.skillCache.set(workspaceRoot, { skills, timestamp: now });
        return skills;
    }

    private async loadSkillsFromDirectory(workspaceRoot: string, skillDirectory: WorkspaceSkillDirectory): Promise<AgentSkill[]> {
        const skillsDir = path.join(workspaceRoot, ...skillDirectory.split('/'));
        const skills: AgentSkill[] = [];

        try {
            const stats = await fs.stat(skillsDir);
            if (!stats.isDirectory()) return [];

            const entries = await fs.readdir(skillsDir, { withFileTypes: true });
            const skillFolders = entries
                .filter((entry) => entry.isDirectory())
                .sort((left, right) => left.name.localeCompare(right.name))
                .slice(0, this.MAX_SKILLS_PER_DIRECTORY);

            for (const folder of skillFolders) {
                const folderPath = path.join(skillsDir, folder.name);
                const targetSkillFile = await this.resolveSkillFile(folderPath);
                if (!targetSkillFile) continue;

                try {
                    const content = await this.readFrontmatter(targetSkillFile);
                    if (content) {
                        const metadata = this.parseFrontmatter(content);
                        const name = this.asTrimmedString(metadata?.name);
                        const description = this.asTrimmedString(metadata?.description);

                        if (name && description) {
                            skills.push({
                                name,
                                description,
                                folderName: folder.name,
                                skillRoot: skillDirectory,
                                skillFilePath: `${skillDirectory}/${folder.name}/${path.basename(targetSkillFile)}`
                            });
                        }
                    }
                } catch (err) {
                    console.error(`${getTS()} [SkillService] Error parsing skill in ${skillDirectory}/${folder.name}:`, err);
                }
            }
        } catch (err: any) {
            if (err.code !== 'ENOENT') {
                console.error(`${getTS()} [SkillService] Error reading ${skillDirectory} directory:`, err);
            }
        }

        return skills;
    }

    private async resolveSkillFile(folderPath: string): Promise<string | null> {
        let entries: import('fs').Dirent[];
        try {
            entries = await fs.readdir(folderPath, { withFileTypes: true });
        } catch {
            return null;
        }

        const fileNames = new Set(entries.filter((entry) => entry.isFile()).map((entry) => entry.name));
        for (const fileName of ["SKILL.md", "skill.md"]) {
            if (fileNames.has(fileName)) return path.join(folderPath, fileName);
        }

        const caseInsensitiveMatch = entries.find((entry) => (
            entry.isFile() && entry.name.toLowerCase() === 'skill.md'
        ));
        return caseInsensitiveMatch ? path.join(folderPath, caseInsensitiveMatch.name) : null;
    }

    /**
     * 仅读取文件头部的 frontmatter 部分
     */
    private async readFrontmatter(filePath: string): Promise<string | null> {
        try {
            const handle = await fs.open(filePath, 'r');
            try {
                const buffer = Buffer.alloc(4096); // 读取前 4KB 通常足够覆盖 frontmatter
                const { bytesRead } = await handle.read(buffer, 0, 4096, 0);

                const content = buffer.toString('utf8', 0, bytesRead);
                const match = content.match(/^(?:\uFEFF)?\s*---\r?\n([\s\S]+?)\r?\n---/);
                return match ? match[1] : null;
            } finally {
                await handle.close();
            }
        } catch (err) {
            return null;
        }
    }

    private parseFrontmatter(yamlContent: string): Record<string, unknown> | null {
        try {
            const metadata = yaml.load(yamlContent);
            if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
            return metadata as Record<string, unknown>;
        } catch (e) {
            return null;
        }
    }

    private asTrimmedString(value: unknown): string | null {
        if (typeof value !== 'string') return null;
        const trimmed = value.trim();
        return trimmed || null;
    }

    public clearCache(workspaceRoot?: string) {
        if (workspaceRoot) {
            this.skillCache.delete(workspaceRoot);
        } else {
            this.skillCache.clear();
        }
    }
}

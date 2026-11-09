import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { config as globalConfig } from '@/config/index.js';

export interface RuleReference {
    name: string;
    content: string;
}

export interface RuleResult {
    /** 命中的规范目录（workspace 相对路径） */
    ruleDirectory: string;
    /** 命中的主规范文件名 */
    mainFileName: string;
    /** 主规范文件（workspace 相对路径） */
    mainRulePath: string;
    mainRule: string;
    referencedRules: RuleReference[];
    error?: string;
}

interface RuleSource {
    directory: string;
    mainFileName: string;
    /** 是否把目录下其余 .md 视为按需加载的规范（多规则目录约定，如 .lingma/rules） */
    discoverSiblingRules?: boolean;
}

const DEFAULT_RULE_SOURCES: RuleSource[] = [
    { directory: '.rules', mainFileName: 'rule.md', discoverSiblingRules: false },
    { directory: '.lingma/rules', mainFileName: 'project_rule.md', discoverSiblingRules: true },
];

/**
 * 工程规范加载服务 (对齐 Project Rules 规范)
 * 职责：
 * 1. 按优先级探测工作区内的规范目录：.rules/rule.md、.lingma/rules/project_rule.md
 * 2. 读取并限制主规范字数 (10,000字)
 * 3. 解析主规范中引用的子规范，并列出多规则目录下的其他规范文件
 */
export class RuleService {
    private static instance: RuleService;
    private readonly MAX_LENGTH = globalConfig.rules.maxMainRuleLength || 10000;
    private readonly RULE_SOURCES: RuleSource[] = globalConfig.rules.sources?.length
        ? globalConfig.rules.sources
        : DEFAULT_RULE_SOURCES;
    private readonly MAX_REFERENCED_RULES = 50;
    private ruleCache = new Map<string, { result: RuleResult | null; timestamp: number }>();
    private readonly CACHE_TTL = 10 * 1000; // 10 seconds

    public static getInstance(): RuleService {
        if (!RuleService.instance) {
            RuleService.instance = new RuleService();
        }
        return RuleService.instance;
    }

    /**
     * 加载当前工作区的工程规范
     * @param workspaceRoot 工作区绝对路径
     */
    public async loadWorkspaceRules(workspaceRoot: string): Promise<RuleResult | null> {
        if (!workspaceRoot) return null;

        const now = Date.now();
        const cached = this.ruleCache.get(workspaceRoot);
        if (cached && (now - cached.timestamp < this.CACHE_TTL)) {
            return cached.result;
        }

        const result = await this.readWorkspaceRules(workspaceRoot);
        if (result) {
            this.ruleCache.set(workspaceRoot, { result, timestamp: now });
        }
        return result;
    }

    public clearCache(workspaceRoot?: string): void {
        if (workspaceRoot) {
            this.ruleCache.delete(workspaceRoot);
        } else {
            this.ruleCache.clear();
        }
    }

    private async readWorkspaceRules(workspaceRoot: string): Promise<RuleResult | null> {
        let missingMainFile: RuleSource | undefined;

        for (const source of this.RULE_SOURCES) {
            const rulesPath = path.join(workspaceRoot, ...source.directory.split('/'));
            if (!(await this.isDirectory(rulesPath))) continue;

            let mainContent: string;
            try {
                mainContent = await fs.readFile(path.join(rulesPath, source.mainFileName), 'utf-8');
            } catch {
                // 目录存在但主文件缺失：继续尝试下一种约定，全部失败后再统一提示
                missingMainFile ??= source;
                continue;
            }

            return this.buildResult(rulesPath, source, mainContent);
        }

        if (missingMainFile) {
            return {
                ruleDirectory: missingMainFile.directory,
                mainFileName: missingMainFile.mainFileName,
                mainRulePath: `${missingMainFile.directory}/${missingMainFile.mainFileName}`,
                mainRule: '',
                referencedRules: [],
                error: `检测到 ${missingMainFile.directory} 目录，但主文件 ${missingMainFile.mainFileName} 缺失。`
            };
        }

        // 规范目录不存在，静默跳过
        return null;
    }

    private async buildResult(rulesPath: string, source: RuleSource, rawContent: string): Promise<RuleResult> {
        let mainContent = rawContent;
        let error: string | undefined;

        // 检查字数限制
        if (mainContent.length > this.MAX_LENGTH) {
            error = `警告：${source.mainFileName} 内容超过 ${this.MAX_LENGTH} 字（当前 ${mainContent.length} 字），已被截断以防止上下文过载。`;
            mainContent = mainContent.slice(0, this.MAX_LENGTH) + '\n\n... (内容已截断)';
        }

        return {
            ruleDirectory: source.directory,
            mainFileName: source.mainFileName,
            mainRulePath: `${source.directory}/${source.mainFileName}`,
            mainRule: mainContent,
            referencedRules: await this.loadReferencedRules(rulesPath, source, mainContent),
            error
        };
    }

    private async loadReferencedRules(rulesPath: string, source: RuleSource, mainContent: string): Promise<RuleReference[]> {
        const referencedRules: RuleReference[] = [];
        const visitedFiles = new Set<string>([path.join(rulesPath, source.mainFileName)]);

        const addRuleFile = async (relativePath: string) => {
            if (referencedRules.length >= this.MAX_REFERENCED_RULES) return;

            const subRuleAbsolutePath = path.resolve(rulesPath, relativePath);

            // 防止循环引用及重复加载
            if (visitedFiles.has(subRuleAbsolutePath)) return;

            // 确保子文件就在规范目录下，防止路径穿越
            if (!this.isInsideDirectory(rulesPath, subRuleAbsolutePath)) {
                console.warn(`[RuleService] 试图跳出规范目录的引用被拒绝: ${relativePath}`);
                return;
            }

            try {
                const subContent = await fs.readFile(subRuleAbsolutePath, 'utf-8');
                referencedRules.push({
                    name: relativePath,
                    content: subContent
                });
                visitedFiles.add(subRuleAbsolutePath);
            } catch (err) {
                console.warn(`[RuleService] 无法加载引用的子规范 ${relativePath}:`, err);
            }
        };

        // 提取引用：[XXX](./sub-rule.md) 或 [include: XXX](./sub-rule.md)
        const refRegex = /\[(?:include:\s*)?.*?\]\(\.\/(.*?\.md)\)/g;
        let match: RegExpExecArray | null;
        while ((match = refRegex.exec(mainContent)) !== null) {
            await addRuleFile(match[1]);
        }

        if (source.discoverSiblingRules) {
            for (const fileName of await this.listMarkdownFiles(rulesPath)) {
                await addRuleFile(fileName);
            }
        }

        return referencedRules;
    }

    private async listMarkdownFiles(directory: string): Promise<string[]> {
        try {
            const entries = await fs.readdir(directory, { withFileTypes: true });
            return entries
                .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
                .map((entry) => entry.name)
                .sort((left, right) => left.localeCompare(right));
        } catch {
            return [];
        }
    }

    private async isDirectory(targetPath: string): Promise<boolean> {
        try {
            const stats = await fs.stat(targetPath);
            return stats.isDirectory();
        } catch {
            return false;
        }
    }

    private isInsideDirectory(directory: string, targetPath: string): boolean {
        const relative = path.relative(directory, targetPath);
        return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
    }
}
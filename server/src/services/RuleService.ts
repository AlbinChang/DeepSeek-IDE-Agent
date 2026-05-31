import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { config as globalConfig } from '@/config/index.js';

export interface RuleResult {
    mainRule: string;
    referencedRules: { name: string; content: string }[];
    error?: string;
}

/**
 * 工程规范加载服务 (对齐 Project Rules 规范)
 * 职责：
 * 1. 扫描工作区根目录下的 .rules/ 文件夹
 * 2. 读取并限制 rule.md 字数 (10,000字)
 * 3. 递归解析 rule.md 中引用的子规范
 */
export class RuleService {
    private static instance: RuleService;
    private readonly MAX_LENGTH = globalConfig.rules.maxMainRuleLength || 10000;
    private readonly RULES_DIR = globalConfig.rules.folderName || '.rules';
    private readonly MAIN_FILE = globalConfig.rules.mainFileName || 'rule.md';
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

        const rulesPath = path.join(workspaceRoot, this.RULES_DIR);
        const mainFilePath = path.join(rulesPath, this.MAIN_FILE);

        try {
            await fs.access(rulesPath);
        } catch {
            // .rules 目录不存在，静默跳过
            return null;
        }

        try {
            await fs.access(mainFilePath);
        } catch {
            return {
                mainRule: '',
                referencedRules: [],
                error: `检测到 ${this.RULES_DIR} 目录，但主文件 ${this.MAIN_FILE} 缺失。`
            };
        }

        let mainContent = await fs.readFile(mainFilePath, 'utf-8');
        let error: string | undefined;

        // 检查字数限制
        if (mainContent.length > this.MAX_LENGTH) {
            error = `警告：${this.MAIN_FILE} 内容超过 ${this.MAX_LENGTH} 字（当前 ${mainContent.length} 字），已被截断以防止上下文过载。`;
            mainContent = mainContent.slice(0, this.MAX_LENGTH) + '\n\n... (内容已截断)';
        }

        // 解析引用的子规范
        const referencedRules: { name: string; content: string }[] = [];
        const visitedFiles = new Set<string>([mainFilePath]);
        
        // 提取引用：[XXX](./sub-rule.md) 或 [include: XXX](./sub-rule.md)
        const refRegex = /\[(?:include:\s*)?.*?\]\(\.\/(.*?\.md)\)/g;
        let match;
        
        while ((match = refRegex.exec(mainContent)) !== null) {
            const subRuleRelativePath = match[1];
            const subRuleAbsolutePath = path.resolve(rulesPath, subRuleRelativePath);

            // 防止循环引用及重复加载
            if (visitedFiles.has(subRuleAbsolutePath)) continue;
            
            try {
                // 确保子文件就在 .rules 目录下，防止路径穿越
                if (!subRuleAbsolutePath.startsWith(rulesPath)) {
                    console.warn(`[RuleService] 试图跳出规范目录的引用被拒绝: ${subRuleRelativePath}`);
                    continue;
                }

                const subContent = await fs.readFile(subRuleAbsolutePath, 'utf-8');
                referencedRules.push({
                    name: subRuleRelativePath,
                    content: subContent
                });
                visitedFiles.add(subRuleAbsolutePath);
            } catch (err) {
                console.warn(`[RuleService] 无法加载引用的子规范 ${subRuleRelativePath}:`, err);
            }
        }

        const result: RuleResult = {
            mainRule: mainContent,
            referencedRules,
            error
        };
        this.ruleCache.set(workspaceRoot, { result, timestamp: now });
        return result;
    }
}

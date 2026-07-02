/**
 * SystemPromptBuilder — 系统提示词构建器
 *
 * 遵循 SOLID 原则：
 * - SRP：仅负责组装提示词片段，不承载环境检测、工具注册等职责
 * - OCP：通过 registerSection() 扩展，无需修改本类
 * - DIP：依赖 IPromptSection 抽象接口
 *
 * 架构设计：
 *   ┌─────────────────────────────────────────────┐
 *   │           SystemPromptBuilder               │
 *   │  (编排器 — 按 priority 分组排列片段)         │
 *   └────────────┬────────────────────────────────┘
 *                │ 依赖
 *   ┌────────────▼────────────────────────────────┐
 *   │         IPromptSection[]                    │
 *   │  (插件集合 — 每个片段独立维护)               │
 *   └─────────────────────────────────────────────┘
 *
 * 使用方式：
 *   const builder = new SystemPromptBuilder();
 *   builder.register(new RoleSection(config));
 *   builder.register(new CapabilitiesSection(config));
 *   // 可动态注册/注销片段
 *   const prompt = await builder.build(ctx);
 */

import type {
    IPromptSection,
    PromptBuildContext,
    PromptPriority,
} from '@/types/prompt.js';

/** 按 priority 分组的片段容器 */
type SectionGroup = Map<PromptPriority, IPromptSection[]>;

const PRIORITY_ORDER: PromptPriority[] = ['static', 'low-churn', 'dynamic'];

export class SystemPromptBuilder {
    /** 已注册的提示词片段（保持插入顺序） */
    private readonly sections: IPromptSection[] = [];

    /** 片段 ID 索引（用于快速查找和去重） */
    private readonly sectionIds: Set<string> = new Set();

    /**
     * 注册提示词片段（OCP 扩展点）。
     * 相同 id 的片段会覆盖旧值。
     */
    register(section: IPromptSection): this {
        if (this.sectionIds.has(section.id)) {
            // 覆盖已有片段（更新策略）
            const idx = this.sections.findIndex(s => s.id === section.id);
            if (idx >= 0) {
                this.sections[idx] = section;
            }
        } else {
            this.sectionIds.add(section.id);
            this.sections.push(section);
        }
        return this;
    }

    /** 批量注册 */
    registerAll(sections: IPromptSection[]): this {
        for (const s of sections) {
            this.register(s);
        }
        return this;
    }

    /** 注销指定片段 */
    unregister(sectionId: string): boolean {
        if (!this.sectionIds.has(sectionId)) return false;
        this.sectionIds.delete(sectionId);
        const idx = this.sections.findIndex(s => s.id === section.id);
        if (idx >= 0) {
            this.sections.splice(idx, 1);
        }
        return true;
    }

    /** 按优先级分组 */
    private groupByPriority(): SectionGroup {
        const groups: SectionGroup = new Map();
        for (const priority of PRIORITY_ORDER) {
            groups.set(priority, []);
        }
        for (const section of this.sections) {
            const list = groups.get(section.priority);
            if (list) {
                list.push(section);
            }
        }
        return groups;
    }

    /**
     * 构建完整的系统提示词。
     * 按 static → low-churn → dynamic 顺序排列片段，
     * 确保上游 KV Cache 能稳定命中 static 前缀。
     */
    async build(ctx: PromptBuildContext): Promise<string> {
        const groups = this.groupByPriority();
        const parts: string[] = [];

        for (const priority of PRIORITY_ORDER) {
            const sections = groups.get(priority) || [];
            for (const section of sections) {
                const content = await section.build(ctx);
                if (content) {
                    parts.push(content);
                }
            }
        }

        return parts.join('\n\n');
    }

    /** 获取已注册的片段数量 */
    get sectionCount(): number {
        return this.sections.length;
    }

    /** 列出所有已注册片段的 ID */
    get registeredIds(): string[] {
        return this.sections.map(s => s.id);
    }
}

import { MemoryService } from '@/services/MemoryService.js';

/**
 * 防重复犯错记忆工具集
 * 将"不要做什么 / 应该做什么"沉淀到 .memory/never_mistake_again.json
 *
 * 原子化设计：每个工具只做一件事。
 * - list_never_mistake_rules: 读取记忆清单
 * - append_never_mistake_rule: 追加或更新规则
 * - delete_never_mistake_rule: 删除失效规则
 *
 * 字段名已统一为标准名称，不再接受旧别名（entry/dontDo/doInstead）。
 */
export class NeverMistakeTools {
    constructor(private workspaceRoot: string) {}

    private guardBackgroundService(context: any) {
        if (context?.isBackgroundService) {
            throw new Error('权限越界：后台服务不可直接操作防重复犯错记忆。');
        }
    }

    private normalizeEntries(raw: any): any[] {
        if (!raw) return [];
        return Array.isArray(raw) ? raw : [raw];
    }

    // ─── 原子操作实现 ───────────────────────────────────────

    async listRules(context: any) {
        this.guardBackgroundService(context);
        return await MemoryService.getNeverMistakeRules(this.workspaceRoot);
    }

    async appendRule(params: any, context: any) {
        this.guardBackgroundService(context);
        const normalizedEntries = this.normalizeEntries(params.entries);
        if (normalizedEntries.length === 0) {
            throw new Error('append_never_mistake_rule 需要提供 entries 数组');
        }

        const prepared = normalizedEntries.map((entry: any, index: number) => {
            const shouldNot = String(entry?.shouldNot ?? '').trim();
            const shouldDo = String(entry?.shouldDo ?? '').trim();

            if (!shouldNot || !shouldDo) {
                throw new Error(`entries[${index}] 缺少 shouldNot 或 shouldDo`);
            }

            return { shouldNot, shouldDo };
        });

        const records = await MemoryService.appendNeverMistakeRules(this.workspaceRoot, prepared);
        return {
            status: 'success',
            total: records.length,
            records
        };
    }

    async deleteRule(params: any, context: any) {
        this.guardBackgroundService(context);
        // 原子化：统一使用 ids 参数（接受字符串或数组），不再接受 id 单数形式
        const rawIds = params.ids;
        const ids: string[] = !rawIds ? [] : Array.isArray(rawIds) ? rawIds : [rawIds];
        if (ids.length === 0) {
            throw new Error('delete_never_mistake_rule 需要提供 ids（规则 ID 字符串或字符串数组）');
        }
        return await MemoryService.deleteNeverMistakeRules(this.workspaceRoot, ids);
    }

    // ─── 原子工具定义 ───────────────────────────────────────

    static getDefinitions() {
        return [
            {
                name: 'list_never_mistake_rules',
                description: '读取防重复犯错记忆清单（.memory/never_mistake_again.json）。默认不要重复调用，系统提示词已注入最新快照。仅例外场景（如怀疑快照过期）时使用。',
                parameters: {
                    type: 'object',
                    properties: {},
                    required: []
                }
            },
            {
                name: 'append_never_mistake_rule',
                description: '⚠️ entries 为必填参数，不可省略！追加或更新防重复犯错规则。每条必须同时包含 shouldNot（不应该做什么）和 shouldDo（应该做什么）。最多保留 20 条，溢出时自动淘汰最旧记录。工具调用自愈时必须使用此工具沉淀失败模式。',
                parameters: {
                    type: 'object',
                    properties: {
                        entries: {
                            type: 'array',
                            description: '规则数组。每条必须包含 shouldNot 与 shouldDo。',
                            items: {
                                type: 'object',
                                properties: {
                                    shouldNot: { type: 'string', description: '不应该做什么（禁止行为）。概括失败模式而非引用具体文件路径。' },
                                    shouldDo: { type: 'string', description: '应该做什么（已验证正确的替代做法）。' }
                                },
                                required: ['shouldNot', 'shouldDo']
                            }
                        }
                    },
                    required: ['entries']
                }
            },
            {
                name: 'delete_never_mistake_rule',
                description: '⚠️ ids 为必填参数，不可省略！删除过时或错误的防重复犯错规则。通过 ids 参数传入一个或多个规则 ID。',
                parameters: {
                    type: 'object',
                    properties: {
                        ids: {
                            description: '待删除的规则 ID。可以是单个 ID 字符串或 ID 字符串数组。',
                            anyOf: [
                                { type: 'string' },
                                { type: 'array', items: { type: 'string' } }
                            ]
                        }
                    },
                    required: ['ids']
                }
            }
        ];
    }
}

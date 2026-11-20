import { MemoryService } from '@/services/MemoryService.js';

/**
 * 用户偏好记忆工具集
 *
 * 将用户明确表达或 Agent 推断出的偏好沉淀到 .memory/user_preferences.json。
 * 每条偏好由「北京时间 + 偏好类型 + 偏好内容」唯一标识；
 * 时间越近置信度越高（半衰期 30 天衰减模型），最多保留 200 条。
 *
 * 原子化设计：每个工具只做一件事。
 * - list_user_preferences: 读取偏好清单
 * - upsert_user_preference: 新增或刷新偏好
 * - delete_user_preference: 删除过期或错误的偏好
 */
export class UserPreferenceTools {
    constructor(private workspaceRoot: string) {}

    private guardBackgroundService(context: any) {
        if (context?.isBackgroundService) {
            throw new Error('权限越界：后台服务不可直接操作用户偏好记忆。');
        }
    }

    // ─── 原子操作实现 ───────────────────────────────────────

    async listPreferences(params: any, context: any) {
        this.guardBackgroundService(context);
        const limit = typeof params?.limit === 'number' ? params.limit : 50;
        const minConfidence = typeof params?.minConfidence === 'number' ? params.minConfidence : 0;
        const records = await MemoryService.getUserPreferencesWithConfidence(this.workspaceRoot);
        const filtered = records
            .filter(r => r.confidence >= minConfidence)
            .slice(0, Math.min(limit, 200));
        return {
            status: 'success',
            total: records.length,
            returned: filtered.length,
            records: filtered,
        };
    }

    async upsertPreference(params: any, context: any) {
        this.guardBackgroundService(context);
        const type = String(params?.type || '').trim();
        const content = String(params?.content || '').trim();
        if (!type) throw new Error('upsert_user_preference 需要提供 type（偏好类型）');
        if (!content) throw new Error('upsert_user_preference 需要提供 content（偏好内容）');

        const source: 'explicit' | 'inferred' =
            params?.source === 'inferred' ? 'inferred' : 'explicit';

        // 原子化：统一使用 conflictIds 参数（接受字符串或数组），不再接受 conflictId 单数形式
        const rawConflictIds = params.conflictIds;
        const conflictIds: string[] = !rawConflictIds
            ? []
            : Array.isArray(rawConflictIds)
                ? rawConflictIds.filter((id: any) => typeof id === 'string')
                : (typeof rawConflictIds === 'string' ? [rawConflictIds] : []);

        const result = await MemoryService.upsertUserPreference(this.workspaceRoot, type, content, source, conflictIds);
        return {
            status: 'success',
            operation: result.status,
            record: result.record,
            displacedCount: result.displaced.length,
            displaced: result.displaced,
            total: result.total,
        };
    }

    async deletePreference(params: any, context: any) {
        this.guardBackgroundService(context);
        // 原子化：统一使用 ids 参数（接受字符串或数组），不再接受 id 单数形式
        const rawIds = params.ids;
        const ids: string[] = !rawIds ? [] : Array.isArray(rawIds) ? rawIds : [rawIds];
        if (ids.length === 0) {
            throw new Error('delete_user_preference 需要提供 ids（偏好 ID 字符串或字符串数组）');
        }
        return await MemoryService.deleteUserPreferences(this.workspaceRoot, ids);
    }

    // ─── 原子工具定义 ───────────────────────────────────────

    static getDefinitions() {
        return [
            {
                name: 'list_user_preferences',
                description: '读取已保存的用户偏好，按置信度降序返回。',
                parameters: {
                    type: 'object',
                    properties: {
                        limit: {
                            type: 'number',
                            description: '返回条数，默认 50，最大 200',
                        },
                        minConfidence: {
                            type: 'number',
                            description: '最低置信度 0.0-1.0，默认 0',
                        },
                    },
                    required: [],
                }
            },
            {
                name: 'upsert_user_preference',
                description: '新增或更新用户偏好。',
                parameters: {
                    type: 'object',
                    properties: {
                        type: {
                            type: 'string',
                            description: '偏好类型标签（英文短词），如 model/style/language/behavior/timezone/format/tool/domain'
                        },
                        content: {
                            type: 'string',
                            description: '希望 Agent 遵循的偏好内容。',
                        },
                        source: {
                            type: 'string',
                            enum: ['explicit', 'inferred'],
                            description: 'explicit=用户明说，inferred=Agent 推断；默认 explicit。',
                        },
                        conflictIds: {
                            description: '需淘汰的冲突记录 ID。',
                            anyOf: [
                                { type: 'string' },
                                { type: 'array', items: { type: 'string' } }
                            ]
                        },
                    },
                    required: ['type', 'content'],
                }
            },
            {
                name: 'delete_user_preference',
                description: '删除指定的用户偏好记录。',
                parameters: {
                    type: 'object',
                    properties: {
                        ids: {
                            description: '待删除的偏好 ID。可以是单个 ID 字符串或 ID 字符串数组。',
                            anyOf: [
                                { type: 'string' },
                                { type: 'array', items: { type: 'string' } }
                            ]
                        },
                    },
                    required: ['ids'],
                }
            },
        ];
    }
}

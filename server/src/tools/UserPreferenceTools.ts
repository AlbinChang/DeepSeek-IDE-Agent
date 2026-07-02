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
                description: [
                    '读取用户偏好清单（.memory/user_preferences.json），按置信度倒序排列。',
                    '系统提示词会自动注入高置信度偏好快照，默认不要重复调用，已有快照可直接参考。',
                ].join(' '),
                parameters: {
                    type: 'object',
                    properties: {
                        limit: {
                            type: 'number',
                            description: '返回最多条数，默认 50，最大 200。',
                        },
                        minConfidence: {
                            type: 'number',
                            description: '最低置信度过滤（0.0-1.0），默认 0（返回全部）。',
                        },
                    },
                    required: [],
                }
            },
            {
                name: 'upsert_user_preference',
                description: [
                    '⚠️ type 和 content 为必填参数，不可省略！新增或刷新用户偏好。每条偏好必须同时包含 type（偏好类型，如 model/style/language/behavior/timezone/format）和 content（偏好内容描述）。',
                    '冲突淘汰策略：当新偏好与已有偏好矛盾时，先调用 list_user_preferences 获取冲突项 ID，再通过 conflictIds 参数显式传入需淘汰的旧偏好 ID。',
                    '每当用户明确表达偏好（如"我不喜欢 emoji"、"用北京时间"、"优先用 DeepSeek"）时，必须立即调用 upsert 记录。',
                ].join(' '),
                parameters: {
                    type: 'object',
                    properties: {
                        type: {
                            type: 'string',
                            description: [
                                '偏好类型标签（自由分类，建议使用英文或中文短词）。',
                                '推荐分类参考：model（模型选择）/ style（输出风格）/ language（语言/语种）/ behavior（行为习惯）/ timezone（时区）/ format（格式规范）/ tool（工具偏好）/ domain（领域偏好）',
                            ].join(' ')
                        },
                        content: {
                            type: 'string',
                            description: '偏好内容描述，清晰表达用户希望 Agent 遵循的行为或风格。例如：「所有时间使用北京时间（Asia/Shanghai）」「禁止在回复中使用 emoji」',
                        },
                        source: {
                            type: 'string',
                            enum: ['explicit', 'inferred'],
                            description: '偏好来源：explicit=用户明确表达，inferred=Agent 从上下文推断。默认 explicit。',
                        },
                        conflictIds: {
                            description: '与新偏好冲突、需要同步淘汰的旧偏好 ID。可以是单个 ID 字符串或 ID 字符串数组。先用 list_user_preferences 获取冲突项 ID，再一并传入。',
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
                description: '⚠️ ids 为必填参数，不可省略！删除过期或错误的用户偏好。通过 ids 参数传入一个或多个偏好 ID。',
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

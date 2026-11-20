import { MemoryService } from '@/services/MemoryService.js';

/**
 * 主 Agent 历史最终回复记忆工具集
 *
 * 数据源：`.memory/user_instructs_reply.json`（由 MemoryService 在每轮对话结束时写入）。
 * 编号规则：`dialogIndex.replyIndex`，如 `11.2` = 第 11 次对话中主 Agent 的第 2 份最终回复。
 *
 * 原子化设计：每个工具只做一件事。
 * - list_main_agent_replies: 返回索引视图（含摘要），用于定位
 * - read_main_agent_reply: 按 id 读取完整回复正文
 *
 * 两个工具均为只读，主 Agent 与评估 Agent 共用。
 */
export class MainAgentReplyTools {
    private static readonly DEFAULT_LIST_LIMIT = 20;
    private static readonly MAX_LIST_LIMIT = 100;

    constructor(private workspaceRoot: string) {}

    async listReplies(params: any) {
        const rawLimit = Number(params?.limit);
        const limit = Number.isInteger(rawLimit) && rawLimit > 0
            ? Math.min(rawLimit, MainAgentReplyTools.MAX_LIST_LIMIT)
            : MainAgentReplyTools.DEFAULT_LIST_LIMIT;
        const rawDialogIndex = Number(params?.dialogIndex);
        const dialogIndex = Number.isInteger(rawDialogIndex) && rawDialogIndex > 0 ? rawDialogIndex : undefined;

        const entries = await MemoryService.getMainAgentReplyIndex(this.workspaceRoot, {
            dialogIndex,
            limit,
        });
        const currentDialogIndex = await MemoryService.getCurrentDialogIndex(this.workspaceRoot);
        return {
            currentDialogIndex,
            total: entries.length,
            entries,
            hint: entries.length === 0
                ? '当前工作区还没有主 Agent 回复记忆。'
                : '用 read_main_agent_reply 按 id 读取完整正文；id 形如 11.2（对话编号.回复序号）。',
        };
    }

    async readReply(params: any) {
        const id = String(params?.id ?? '').trim();
        if (!id) {
            throw new Error('read_main_agent_reply 需要提供 id，形如 "11.2"（对话编号.回复序号）');
        }
        if (!/^\d+\.\d+$/.test(id)) {
            throw new Error(`id 格式非法："${id}"。正确格式为「对话编号.回复序号」，例如 "11.2"。`);
        }

        const record = await MemoryService.getMainAgentReplyById(this.workspaceRoot, id);
        if (!record) {
            throw new Error(`未找到 id 为 "${id}" 的主 Agent 回复记忆。请先调用 list_main_agent_replies 获取有效 id。`);
        }
        return record;
    }

    // ─── 原子工具定义 ───────────────────────────────────────

    static getDefinitions() {
        return [
            {
                name: 'list_main_agent_replies',
                description: '列出主Agent历史最终回复索引（含摘要），编号如 11.2。',
                parameters: {
                    type: 'object',
                    properties: {
                        dialogIndex: {
                            type: 'integer',
                            description: '只看某次对话（如 11）；省略则按时间倒序取最近'
                        },
                        limit: {
                            type: 'integer',
                            description: `返回条数，默认 ${MainAgentReplyTools.DEFAULT_LIST_LIMIT}，最大 ${MainAgentReplyTools.MAX_LIST_LIMIT}`
                        }
                    },
                    required: []
                }
            },
            {
                name: 'read_main_agent_reply',
                description: '按 id 读取某条历史最终回复正文（id 形如 11.2）。',
                parameters: {
                    type: 'object',
                    properties: {
                        id: {
                            type: 'string',
                            description: '回复编号，如 "11.2"'
                        }
                    },
                    required: ['id']
                }
            }
        ];
    }
}

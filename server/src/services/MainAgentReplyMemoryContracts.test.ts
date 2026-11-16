import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

async function readSource(relativePath: string) {
    return readFile(new URL(`../${relativePath}`, import.meta.url), 'utf8');
}

/**
 * 主 Agent 回复记忆装配契约：
 * - 工具必须在 AgentService 注册，主 Agent 与评估 Agent 才能按需检索；
 * - 每轮主 Agent 最终回复必须在 AgentChatComponent 落盘，且带上对话编号；
 * - 系统提示词必须声明检索时机与禁止项，保证「按需利用」而非无差别加载。
 */
describe('main agent reply memory contracts', () => {
    it('registers the retrieval tools for both agents', async () => {
        const agentService = await readSource('services/AgentService.ts');
        expect(agentService).toContain('new MainAgentReplyTools(root)');
        expect(agentService).toContain("case 'list_main_agent_replies'");
        expect(agentService).toContain("case 'read_main_agent_reply'");

        const tools = await readSource('tools/MainAgentReplyTools.ts');
        expect(tools).toContain("name: 'list_main_agent_replies'");
        expect(tools).toContain("name: 'read_main_agent_reply'");
    });

    it('persists every main-agent loop reply against the dialog counter', async () => {
        const chat = await readSource('services/AgentChatComponent.ts');
        expect(chat).toContain('MemoryService.recordUserInstruction(');
        expect(chat).toContain('{ resume: Boolean(resumeRequest) }');
        expect(chat).toContain('MemoryService.recordMainAgentReply(root, dialogIndex');
    });

    it('states when to retrieve history and forbids unconditional loading', async () => {
        const agentService = await readSource('services/AgentService.ts');
        expect(agentService).toContain('MAIN AGENT REPLY MEMORY');
        expect(agentService).toContain('list_main_agent_replies');
        expect(agentService).toContain('read_main_agent_reply');
        expect(agentService).toContain('每轮无差别加载历史回复');
    });

    it('tells the evaluator how to cross-check previous main-agent replies', async () => {
        const evaluator = JSON.parse(await readSource('config/evaluator-agent.json'));
        const tips = evaluator.important_tips as string[];
        expect(tips.some((tip) => tip.includes('user_instructs_reply.json'))).toBe(true);
        expect(tips.some((tip) => tip.includes('read_main_agent_reply'))).toBe(true);
    });
});

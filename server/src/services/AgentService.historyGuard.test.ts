import { afterEach, describe, expect, it, vi } from 'vitest';

import { AgentService } from '@/services/AgentService.js';

describe('AgentService session history guard', () => {
    const service = AgentService.getInstance();
    const userId = 'history-guard-user';
    const root = 'D:/history-guard-workspace';

    afterEach(() => {
        service.clearSessionHistory(userId, root);
        vi.restoreAllMocks();
    });

    it('drops assistant turns whose body is control-token garbage and their tool results', () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        service.updateSessionHistory(userId, [
            { role: 'system', content: 'system prompt' },
            { role: 'user', content: '检查代码' },
            {
                role: 'assistant',
                content: '<|begin_of_sentence|>####异常输出<|end_of_sentence|>',
                tool_calls: [{ id: 'call-1', type: 'function', function: { name: 'list_files', arguments: '{}' } }],
            },
            { role: 'tool', tool_call_id: 'call-1', content: '{"files":[]}' },
            { role: 'assistant', content: '正常回答' },
        ], root);

        const history = service.getSessionHistory(userId, root);
        expect(history.map((message) => message.role)).toEqual(['system', 'user', 'assistant']);
        expect(history[2].content).toBe('正常回答');
        expect(service.getSessionHistory(userId, root)).toHaveLength(3);
    });

    it('keeps normal conversations and quoted control tokens untouched', () => {
        const original = [
            { role: 'user', content: '解释 BOS' },
            { role: 'assistant', content: '"`<|begin_of_sentence|>` 是 ERNIE 的 BOS 标记。"' },
            { role: 'assistant', content: '普通说明：模型工作正常。' },
        ];
        service.updateSessionHistory(userId, original, root);
        expect(service.getSessionHistory(userId, root)).toEqual(original);
    });
});

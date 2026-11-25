import { describe, expect, it } from 'vitest';
import {
    buildFinalizedRow,
    messagePersistSignature,
    selectMessagesToPersist,
    type PersistableChatMessage,
} from '../../../client/src/services/chatHistorySnapshot.js';

/**
 * 回归用例：修复「第二轮对话重启后 UI 内容丢失」。
 *
 * 根因是旧实现只落库「最后一条 assistant 消息」，一旦消息列表末尾出现非 assistant
 * 元素（提示气泡 / 错误气泡 / 用户下一条指令），正在产出的回复就再也写不进 IndexedDB。
 * 这些用例锁定「按消息粒度做指纹差异落库」的契约。
 */

const assistant = (overrides: Partial<PersistableChatMessage> = {}): PersistableChatMessage => ({
    id: 'a1',
    role: 'assistant',
    content: '',
    parts: [],
    timestamp: 1000,
    ...overrides,
});

const user = (overrides: Partial<PersistableChatMessage> = {}): PersistableChatMessage => ({
    id: 'u1',
    role: 'user',
    content: '继续',
    parts: [],
    timestamp: 900,
    ...overrides,
});

const options = (signatures = new Map<string, string>()) => ({
    workspaceRoot: 'D:\\ws',
    workspaceKey: 'd:/ws',
    signatures,
});

describe('聊天消息落库决策', () => {
    it('内容未变化时重复调用不会重复落库', () => {
        const signatures = new Map<string, string>();
        const message = assistant({ content: '第一段' });

        const first = selectMessagesToPersist([message], options(signatures));
        const second = selectMessagesToPersist([message], options(signatures));

        expect(first.rows).toHaveLength(1);
        expect(second.rows).toHaveLength(0);
    });

    it('assistant 消息不是最后一条时仍会落库（回归：第二轮内容丢失）', () => {
        const signatures = new Map<string, string>();
        const messages = [
            user(),
            assistant({ content: '第二轮回复' }),
            { id: 'notice-1', role: 'notice', content: '提示', parts: [], timestamp: 1100 },
        ];

        const { rows } = selectMessagesToPersist(messages as any, options(signatures));

        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe('a1');
        expect(rows[0].content).toBe('第二轮回复');
        expect(rows[0].workspaceKey).toBe('d:/ws');
    });

    it('历史中多条 assistant 消息各自按指纹落库', () => {
        const signatures = new Map<string, string>();
        const messages = [
            assistant({ id: 'a1', content: '旧回复' }),
            user({ id: 'u2', timestamp: 2000 }),
            assistant({ id: 'a2', content: '新回复', timestamp: 2001 }),
        ];

        const first = selectMessagesToPersist(messages, options(signatures));
        expect(first.rows.map((row) => row.id)).toEqual(['a1', 'a2']);

        messages[2] = assistant({ id: 'a2', content: '新回复（流式追加）', timestamp: 2001 });
        const second = selectMessagesToPersist(messages, options(signatures));
        expect(second.rows.map((row) => row.id)).toEqual(['a2']);
    });

    it('跳过从 IndexedDB 恢复的消息，避免二次清洗导致内容退化', () => {
        const signatures = new Map<string, string>();
        const restored = assistant({ id: 'restored', content: '恢复的内容' });

        const { rows } = selectMessagesToPersist([restored], {
            ...options(signatures),
            skipIds: new Set(['restored']),
        });

        expect(rows).toHaveLength(0);
        expect(signatures.has('restored')).toBe(false);
    });

    it('用户消息由即时写入负责，不在此重复落库', () => {
        const { rows } = selectMessagesToPersist([user()], options());
        expect(rows).toHaveLength(0);
    });

    it('isFinal 翻转会标记需要立即 flush', () => {
        const signatures = new Map<string, string>();
        const streaming = assistant({ content: '半截' });
        expect(selectMessagesToPersist([streaming], options(signatures)).finalized).toBe(false);

        const done = assistant({ content: '半截 + 结论', isFinal: true });
        const result = selectMessagesToPersist([done], options(signatures));

        expect(result.finalized).toBe(true);
        expect(result.rows[0].isFinal).toBe(true);
    });

    it('已移出列表的消息不再占用指纹', () => {
        const signatures = new Map<string, string>();
        selectMessagesToPersist([assistant({ id: 'gone' }), assistant({ id: 'live' })], options(signatures));
        selectMessagesToPersist([assistant({ id: 'live' })], options(signatures));

        expect(signatures.has('gone')).toBe(false);
        expect(signatures.has('live')).toBe(true);
    });

    it('尾部落库快照强制 isFinal 并补齐工作区信息', () => {
        const row = buildFinalizedRow(assistant({ content: '最终答复' }), 'D:\\ws', 'd:/ws');

        expect(row).toMatchObject({
            id: 'a1',
            role: 'assistant',
            content: '最终答复',
            workspaceRoot: 'D:\\ws',
            workspaceKey: 'd:/ws',
            isFinal: true,
        });
    });

    it('指纹能区分正文增长与 parts 增长', () => {
        const base = assistant({ content: 'abc' });
        const longerContent = assistant({ content: 'abcd' });
        const longerParts = assistant({ content: 'abc', parts: [{ id: 'p1', content: 'x' }] });

        expect(messagePersistSignature(base)).not.toBe(messagePersistSignature(longerContent));
        expect(messagePersistSignature(base)).not.toBe(messagePersistSignature(longerParts));
    });
});

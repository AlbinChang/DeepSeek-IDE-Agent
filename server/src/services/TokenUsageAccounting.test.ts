import { describe, expect, it } from 'vitest';

import {
    createUsageRecorder,
    type UsageTotals,
} from '../../../client/src/services/tokenUsageAccounting.js';
/**
 * 回归用例：状态栏「今日」token 一直显示 0。
 *
 * 根因：旧实现把「本轮累计 usage」直接落库，且时间戳固定取**本轮开始时刻**。
 * 于是 23:45 开始、跑过零点的长任务，00:00 之后的全部用量都被记到前一天，
 * 第二天状态栏「今日」长时间是 0；同一轮里记录的 id 也固定，无法按日拆分。
 */

const totals = (input: number, output: number): UsageTotals => ({
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
});

describe('createUsageRecorder', () => {
    it('同一自然日内按增量累加，主键带日期', () => {
        const now = () => 1_000;
        const recorder = createUsageRecorder({ messageId: 'm1', workspaceRoot: 'D:\\ws', now, toDateKey: () => '2026-11-26' });

        const first = recorder.record(totals(100, 10));
        expect(first).toMatchObject({
            id: 'm1:2026-11-26',
            date: '2026-11-26',
            inputTokens: 100,
            outputTokens: 10,
            totalTokens: 110,
            deltaTotalTokens: 110,
            deltaOutputTokens: 10,
        });

        // 第二轮模型调用：累计值涨到 150 + 20
        const second = recorder.record(totals(150, 20));
        expect(second).toMatchObject({
            id: 'm1:2026-11-26',
            inputTokens: 150,
            outputTokens: 20,
            totalTokens: 170,
            deltaTotalTokens: 60,
            // 速率只按生成 token 增量计算（不含 prompt）
            deltaOutputTokens: 10,
        });
    });

    it('跨零点后拆成新的一天，只记当天增量', () => {
        let clock = Date.UTC(2026, 10, 25, 15, 45); // 北京 2026-11-25 23:45
        const recorder = createUsageRecorder({
            messageId: 'm2',
            workspaceRoot: 'D:\\ws',
            now: () => clock,
            toDateKey: (ts) => {
                const beijing = new Date(ts + 8 * 3600_000);
                const y = beijing.getUTCFullYear();
                const m = String(beijing.getUTCMonth() + 1).padStart(2, '0');
                const d = String(beijing.getUTCDate()).padStart(2, '0');
                return `${y}-${m}-${d}`;
            },
        });

        const beforeMidnight = recorder.record(totals(1000, 100));
        expect(beforeMidnight).toMatchObject({ id: 'm2:2026-11-25', totalTokens: 1100 });

        // 00:10，累计值继续增长
        clock = Date.UTC(2026, 10, 25, 16, 10);
        const afterMidnight = recorder.record(totals(1600, 200));
        expect(afterMidnight).toMatchObject({
            id: 'm2:2026-11-26',
            date: '2026-11-26',
            // 只包含零点之后新增的部分：input +600、output +100
            inputTokens: 600,
            outputTokens: 100,
            totalTokens: 700,
            deltaTotalTokens: 700,
            deltaOutputTokens: 100,
        });

        // 再跨回凌晨也仍然累加到 11-26 这一天
        clock = Date.UTC(2026, 10, 25, 16, 20);
        const later = recorder.record(totals(1700, 250));
        expect(later).toMatchObject({ id: 'm2:2026-11-26', totalTokens: 850, deltaTotalTokens: 150, deltaOutputTokens: 50 });
    });

    it('没有新增用量时不产生写入（重复/乱序事件不重复计数）', () => {
        const recorder = createUsageRecorder({ messageId: 'm3', workspaceRoot: 'D:\\ws', now: () => 1, toDateKey: () => '2026-11-26' });
        expect(recorder.record(totals(100, 10))).not.toBeNull();
        expect(recorder.record(totals(100, 10))).toBeNull();
        // 累计值回退（例如重试导致计数变少）也不写负数
        expect(recorder.record(totals(80, 5))).toBeNull();
    });

    it('零用量与非法值被忽略', () => {
        const recorder = createUsageRecorder({ messageId: 'm4', workspaceRoot: 'D:\\ws', now: () => 1, toDateKey: () => '2026-11-26' });
        expect(recorder.record(totals(0, 0))).toBeNull();
        expect(recorder.record({ inputTokens: Number.NaN, outputTokens: 0, totalTokens: 0 })).toBeNull();
    });

    it('暴露已落库累计值', () => {
        const recorder = createUsageRecorder({ messageId: 'm5', workspaceRoot: 'D:\\ws', now: () => 1, toDateKey: () => '2026-11-26' });
        expect(recorder.getPersisted()).toBeNull();
        recorder.record(totals(10, 2));
        expect(recorder.getPersisted()).toEqual({ inputTokens: 10, outputTokens: 2, totalTokens: 12 });
    });
});

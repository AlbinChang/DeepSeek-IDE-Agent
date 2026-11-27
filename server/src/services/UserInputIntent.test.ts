/**
 * UserInputIntent 测试套件
 *
 * 回归背景：2026-11-27「高潜力股票周报」交付回复里只有一句
 * 「是否把上游 quant 同步成 20/1.5%，需要你定。」，匹配用无界 `.*` 一路跨过正文，
 * 命中 1000 字外 mermaid 代码块里的「决定」，把已完成的多步交付误判成等待用户输入，
 * 于是在评估Agent 之前直接 return，评估迭代循环完全没跑。
 */
import { describe, expect, it } from 'vitest';
import { requiresUserInputOrDecision } from '@/services/UserInputIntent.js';

const DELIVERY_REPLY_WITH_OPTIONAL_DECISION = [
    '工作流已建成并端到端验证通过。',
    '',
    '## 一、先看这个必须由你决策的口径冲突',
    '所以我把阈值做成**每次从标准原文解析**，不读上游候选池 `pool_four.csv`（那是旧阈值筛的）。',
    '两份文件目前服务不同口径——是否把上游 `quant` 同步成 20/1.5%，需要你定。',
    '',
    '## 二、跑一次的产出',
    '- 门禁 47/47，负向演练 26/26（每条篡改都被精确拦住）',
    '',
    '## 三、流程图',
    '```mermaid',
    'stateDiagram-v2',
    '  [*] --> loss: PE<=0 或 归母净利<=0',
    '  final: 状态机（决定谁能进最终名单）',
    '```',
    '',
    '## 文件变更清单',
    '未改动 `高潜力股票标准.md` 任何脚本与数据。',
].join('\n');

describe('requiresUserInputOrDecision — 交付类回复不得误判', () => {
    it('带一句可选项决策 + 代码块内「决定」的交付回复判定为否', () => {
        expect(requiresUserInputOrDecision(DELIVERY_REPLY_WITH_OPTIONAL_DECISION)).toBe(false);
    });

    it('「是否…？」之后隔段出现「决定」不再触发跨段误判', () => {
        const reply = [
            '是否采用方案 A？',
            '',
            '方案对比见下表，两种都能跑通，我已经按方案 A 完成交付。',
            '最终由你决定后续是否推广。',
        ].join('\n');
        expect(requiresUserInputOrDecision(reply)).toBe(false);
    });

    it('围栏代码块内的请求词不算等待用户输入', () => {
        const reply = ['示例命令：', '```', '请提供 --token 参数', '```', '以上已全部执行完毕。'].join('\n');
        expect(requiresUserInputOrDecision(reply)).toBe(false);
    });
});

describe('requiresUserInputOrDecision — 真实诉求仍需识别', () => {
    it('同一句内的追问判定为是', () => {
        expect(requiresUserInputOrDecision('请问你希望封面用哪种配色，确认后我再继续渲染。')).toBe(true);
    });

    it('等待用户确认判定为是', () => {
        expect(requiresUserInputOrDecision('产物已生成，等待你确认后再发布。')).toBe(true);
    });

    it('直接索要素材判定为是', () => {
        expect(requiresUserInputOrDecision('请提供 DeepSeek API Key 后我再重跑一次。')).toBe(true);
    });

    it('英文直接索要判定为是', () => {
        expect(requiresUserInputOrDecision('Please provide the API key so I can continue.')).toBe(true);
    });

    it('含否定词时判定为否', () => {
        expect(requiresUserInputOrDecision('无需你提供任何素材，全部产物已生成。')).toBe(false);
    });
});

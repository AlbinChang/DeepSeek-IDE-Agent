import { describe, expect, it } from 'vitest';

import {
    DEFAULT_MAX_DEFERRED_PATHS,
    createRefreshGate,
} from '../../../client/src/services/refreshGate.js';

/**
 * 回归用例：Agent 运行时「右键菜单一弹出就消失」。
 *
 * 根因是目录树（Virtuoso 虚拟列表）刷新时会重新测量并调整滚动位置，
 * 而右键菜单靠全局 scroll 监听关闭 → 菜单在同一帧内被关掉。
 * FileTree 用这个闸门在菜单打开期间冻结刷新，关闭后合并补刷。
 */

describe('createRefreshGate', () => {
    it('未冻结时不拦截刷新', () => {
        const gate = createRefreshGate();
        expect(gate.isFrozen()).toBe(false);
        gate.defer('src');
        // 未冻结时记录没有意义：release 只应反映冻结期间的请求
        expect(gate.release()).toEqual(['src']);
        expect(gate.isFrozen()).toBe(false);
    });

    it('冻结期间的刷新被记账，解除后一次性返回且去重', () => {
        const gate = createRefreshGate();
        gate.freeze();
        expect(gate.isFrozen()).toBe(true);

        gate.defer('.');
        gate.defer('src');
        gate.defer('src');
        gate.defer('docs');
        expect(gate.pendingCount()).toBe(3);

        expect(gate.release()).toEqual(['.', 'src', 'docs']);
        expect(gate.isFrozen()).toBe(false);
        // 只返回一次，避免重复刷新
        expect(gate.release()).toEqual([]);
        expect(gate.pendingCount()).toBe(0);
    });

    it('队列满时退化为只保证根目录被补刷', () => {
        const gate = createRefreshGate(2);
        gate.freeze();
        gate.defer('a');
        gate.defer('b');
        gate.defer('c'); // 超限
        const pending = gate.release();
        expect(pending).toContain('.');
        expect(pending.length).toBeLessThanOrEqual(3);
    });

    it('空路径归一到根目录', () => {
        const gate = createRefreshGate();
        gate.freeze();
        gate.defer('');
        expect(gate.release()).toEqual(['.']);
    });

    it('默认上限是 8', () => {
        expect(DEFAULT_MAX_DEFERRED_PATHS).toBe(8);
    });
});

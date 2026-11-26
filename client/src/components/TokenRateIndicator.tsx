import React, { useSyncExternalStore } from 'react';
import { Zap } from 'lucide-react';
import { getTokenRateSnapshot, subscribeTokenRate } from '@/services/tokenRate';

/**
 * 状态栏 token 生成速率指示器（T/s）。
 *
 * 采样与通知都在 `@/services/tokenRate` 里按 1s 节拍异步完成，本组件只负责显示；
 * 通过 `useSyncExternalStore` 订阅，重渲染范围仅限本组件，不影响状态栏其余部分
 * 与主聊天渲染。
 */
const TokenRateIndicatorImpl: React.FC = () => {
    const rate = useSyncExternalStore(subscribeTokenRate, getTokenRateSnapshot, getTokenRateSnapshot);
    const active = rate > 0;

    return (
        <div
            className="flex items-center gap-2 border-l border-white/10 pl-4 h-[10px]"
            title={`模型生成速率：近 15 秒平均 ${rate.toLocaleString()} 输出 tokens/s（1 秒采样一次，不含 prompt）`}
        >
            <Zap size={9} className={active ? 'text-emerald-300' : 'text-white opacity-20'} />
            <div className="flex items-baseline gap-1">
                <span
                    className={`font-mono text-[8.5px] font-black tabular-nums transition-colors duration-300 ${
                        active ? 'text-emerald-300' : 'text-white/50'
                    }`}
                >
                    {rate.toLocaleString()}
                </span>
                <span className="text-[7.5px] font-black text-white opacity-60">T/s</span>
            </div>
        </div>
    );
};

export const TokenRateIndicator = React.memo(TokenRateIndicatorImpl);

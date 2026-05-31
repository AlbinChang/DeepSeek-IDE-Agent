import React, { useEffect, useState } from 'react';
import { AgentChat } from '@/components/AgentChat';
import { AgentProvider } from '@/providers/AgentContext';

/**
 * AgentChat 仿真测试组件
 * 模拟完整的 Provider 环境，用于验证 Stark Emerald 主题与 DeepSeek Reasoner 流式渲染
 */
export const AgentChatSimulator: React.FC = () => {
    const [isMounted, setIsMounted] = useState(false);

    useEffect(() => {
        // 确保 API Key 已注入 (在实际浏览器环境中通常由 SettingsModal 完成)
        // 此处模拟注入以便 useAgentWebSocket 能成功连接
        localStorage.setItem('agent-settings', JSON.stringify({
            providers: [{
                id: 'deepseek',
                name: 'DeepSeek',
                type: 'openai-compatible',
                modelId: 'deepseek-reasoner',
                apiKey: 'sk-0e5516abfb564c6685839e80e6cea2e9',
                baseURL: 'https://api.deepseek.com',
                enableThinking: true,
            }],
            activeProvider: 'deepseek',
            activeModel: 'deepseek-reasoner',
            locale: 'zh-CN'
        }));
        
        setIsMounted(true);
    }, []);

    if (!isMounted) return <div style={{ color: '#10b981' }}>Initializing Stark Emerald Environment...</div>;

    return (
        <AgentProvider>
            <div className="flex h-screen w-full bg-black overflow-hidden">
                <div className="w-[400px] border-r border-white/5 h-full overflow-hidden flex flex-col shadow-2xl">
                    <AgentChat />
                </div>
                <div className="flex-1 bg-[#050505] p-10 flex flex-col items-center justify-center text-center">
                    <div className="w-20 h-20 rounded-full bg-emerald-500/10 flex items-center justify-center mb-6 animate-pulse border border-emerald-500/20">
                        <div className="w-4 h-4 rounded-full bg-emerald-500 shadow-[0_0_15px_rgba(16,185,129,1)]" />
                    </div>
                    <h1 className="text-2xl font-black text-emerald-500 uppercase tracking-[0.3em] mb-4">
                        Stark Emerald Simulator
                    </h1>
                    <p className="text-xs text-white/40 uppercase tracking-widest max-w-sm leading-relaxed">
                        Testing DeepSeek Reasoner Real-time Waterfall Rendering & CoT Integration
                    </p>
                    <div className="mt-10 p-4 border border-white/5 bg-white/[0.02] rounded-md text-left font-mono text-[10px] text-emerald-500/60">
                        <p>// STATUS_LOG</p>
                        <p className="text-white/30">{">"} Protocol: SSE (EventSource)</p>
                        <p className="text-white/30">{">"} Endpoint: /api/chat/sse</p>
                        <p className="text-white/30">{">"} Model: deepseek-reasoner (REFACTORED)</p>
                    </div>
                </div>
            </div>
        </AgentProvider>
    );
};

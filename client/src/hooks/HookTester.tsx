import React, { useEffect, useState } from 'react';
import { useAgent } from '@/hooks/useAgent';

/**
 * 这是一个用于测试 useAgent Hook 的无头组件
 * 它已更新为支持 SSE (Server-Sent Events) 协议
 */
export const HookTester: React.FC = () => {
    const { messages, setInput, append, isLoading } = useAgent();
    const [testStarted, setTestStarted] = useState(false);

    useEffect(() => {
        if (!testStarted && !isLoading) {
            console.log('🧪 Hook Test: Starting auto-chat session via SSE...');
            setTestStarted(true);
            const content = '你好，请用一段复杂的逻辑推导证明你正在使用 DeepSeek Reasoner。';
            setInput(content);
            
            // 延迟发送以确保工作区环境就绪
            setTimeout(() => {
                append({ id: 'test-user-msg', role: 'user', content });
            }, 1000);
        }
    }, [testStarted, isLoading, append, setInput]);

    useEffect(() => {
        if (testStarted && !isLoading && messages.length > 1) {
            const lastMsg = messages[messages.length - 1];
            if (lastMsg.role === 'assistant' && (lastMsg.content || lastMsg.reasoning_content)) {
                console.log('✅ Hook Test: Received SSE response!');
                console.log('--- REASONING ---\n', lastMsg.reasoning_content || '(none)');
                console.log('--- CONTENT ---\n', lastMsg.content || '(none)');
            }
        }
    }, [messages, isLoading, testStarted]);

    return (
        <div style={{ padding: '20px', background: '#000', color: '#0f0', fontFamily: 'monospace' }}>
            <h2>Hook Test Monitor (SSE Protocol)</h2>
            <div>Status: {isLoading ? '⚡ STREAMING' : '⏳ READY/COMPLETE'}</div>
            <hr />
            <div style={{ maxHeight: '400px', overflowY: 'auto' }}>
                {messages.map((m: any, i: number) => (
                    <div key={i} style={{ marginBottom: '10px', borderLeft: '2px solid #333', paddingLeft: '10px' }}>
                        <strong>{m.role.toUpperCase()}:</strong>
                        {m.reasoning_content && (
                            <div style={{ color: '#666', fontStyle: 'italic', fontSize: '11px' }}>
                                [Thought]: {m.reasoning_content.substring(0, 100)}...
                            </div>
                        )}
                        <div>{m.content}</div>
                    </div>
                ))}
            </div>
        </div>
    );
};

import { useAgentSSE } from '@/hooks/useAgentSSE';

/**
 * 生产级 Agent Hook
 * 全面集成 SSE (Server-Sent Events) 协议，取代旧有 WebSockets 提供低延迟、高可靠的流式推理体验。
 */
export function useAgent() {
  const agent = useAgentSSE();
  
  return {
    ...agent,
    // 提供对齐旧版 API 的别名
    setInput: (val: string) => agent.handleInputChange({ target: { value: val } } as any),
  };
}
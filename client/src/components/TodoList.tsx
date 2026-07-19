import React, { useEffect } from 'react';
import { CheckCircle2, Circle, Clock } from 'lucide-react';
import axios from 'axios';
import { USER_ID, API_BASE, GATEWAY_EVENT } from '@/config';
import { useAgentContext, useTodoContext } from '@/providers/AgentContext';
import { electronBridge } from '@/services/electron-bridge';

export const TodoList: React.FC = () => {
    const { workspaceRoot } = useAgentContext();
    const { todos: contextTodos, setTodos: setContextTodos } = useTodoContext();

    const formatTodoId = (id: string) => {
        if (!id) return 'unknown';
        return id.length > 8 ? id.slice(0, 8) : id;
    };

    useEffect(() => {
        // 防御：工作空间切换时立即清空旧 todos，避免闪现上一个工作空间的任务
        setContextTodos([]);

        const fetchTodos = async () => {
            if (!workspaceRoot) return;
            // Electron 模式：跳过 HTTP 请求，依赖 GATEWAY_EVENT 接收 Agent 端推送
            if (electronBridge.isElectron) return;
            try {
                // 2026.03 解耦重构: 使用显式 root 路径拉取任务清单
                const res = await axios.get(`${API_BASE}/api/todos?userId=${USER_ID}&root=${encodeURIComponent(workspaceRoot)}`);
                setContextTodos(res.data);
            } catch (e) {
                console.error('Failed to fetch initial todos');
            }
        };

        fetchTodos();

        const handleSync = (e: any) => {
            // 仅处理 todo/update 类型的推送，防止其他 GATEWAY_EVENT 污染 todos 状态
            const detail = e?.detail;
            if (!detail) return;
            // 兼容 SSE annotation 格式: { method: 'todo/update', params: { todos: [...] } }
            if (detail.method === 'todo/update' && Array.isArray(detail.params?.todos)) {
                setContextTodos(detail.params.todos);
            }
            // 兼容旧格式: payload 直接是数组
            else if (Array.isArray(detail.payload)) {
                setContextTodos(detail.payload);
            }
        };

        window.addEventListener(GATEWAY_EVENT, handleSync);
        return () => window.removeEventListener(GATEWAY_EVENT, handleSync);
    }, [workspaceRoot]);

    // 防御：确保 contextTodos 是数组
    if (!Array.isArray(contextTodos) || contextTodos.length === 0) return null;

    // 2026.03 视窗高度优化：锁定 5 个任务的可视区域
    // 计算公式：Header(26px) + 5 * Task(15px) + Padding(8px) ≈ 109px
    return (
        <div className="px-2 py-1 border-b border-white/5 bg-[#000000] max-h-[109px] shrink-0 overflow-y-auto scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent select-none flex flex-col gap-0.5" data-testid="todo-list-container">
            <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-1.5">
                    <div className="w-1 h-1 rounded-full bg-white/40 animate-pulse" />
                    <span className="text-[7px] font-black text-white/40 uppercase tracking-[0.2em]">任务流水线 (MISSION_PIPELINE)</span>
                </div>
                <div className="text-[7px] text-white/40 font-mono font-bold bg-white/5 px-1 rounded flex items-center gap-1">
                    <span className="text-white/20 select-none">DONE:</span>
                    {contextTodos.filter(t => t.status === 'completed').length}/{contextTodos.length}
                </div>
            </div>
            <div className="flex flex-col gap-[1px]">
                {contextTodos.map(todo => (
                    <div 
                        key={todo.id} 
                        className={`flex items-center h-[14px] px-1 gap-2 transition-all duration-300 rounded-sm hover:bg-white/[0.02] ${
                            todo.status === 'in-progress' ? 'bg-white/[0.03] translate-x-0.5' : ''
                        }`}
                        data-testid={`todo-item-${todo.status}`}
                        title={`${todo.id} | ${todo.title}`}
                    >
                        <div className="shrink-0 flex items-center justify-center w-[10px]">
                            {todo.status === 'completed' ? (
                                <CheckCircle2 size={7} className="text-white/30" />
                            ) : todo.status === 'in-progress' ? (
                                <Clock size={7} className="text-white animate-spin" style={{ animationDuration: '3s' }} />
                            ) : (
                                <Circle size={7} className="text-white/10" />
                            )}
                        </div>
                        <div className="flex-1 min-w-0 flex items-center gap-2">
                            <span className="font-mono text-[6px] text-white/30 tracking-tighter shrink-0 border-r border-white/5 pr-2">
                                {formatTodoId(todo.id)}
                            </span>
                            <div className={`text-[8px] font-medium leading-none tracking-tight truncate ${
                                todo.status === 'completed' ? 'text-white/30 line-through decoration-white/10' : 
                                todo.status === 'in-progress' ? 'text-white font-bold' : 'text-white/50'
                            }`}>
                                {todo.title}
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    );
};
import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';

interface CompletionOptions {
    editor: monaco.editor.IStandaloneCodeEditor | null;
    debounce: number;
    providerId: string;
    modelId: string;
}

/**
 * 对应技术规范 4.5.1 & 20.0 节：LLM 补全系统
 * 桌面应用模式下通过 IPC 获取补全（当前简化实现，后续可接入 CompletionIPC）
 */
export function useInlineCompletions({ editor, debounce, providerId, modelId }: CompletionOptions) {
    const providerRef = useRef<monaco.IDisposable | null>(null);

    useEffect(() => {
        if (!editor) return;

        // 注册前先清理旧的 (强制单路补全对齐 4.5.1)
        if (providerRef.current) {
            providerRef.current.dispose();
        }

        const provider: monaco.languages.InlineCompletionsProvider = {
            provideInlineCompletions: async (_model, _position, _context, token) => {
                // 桌面应用模式：行内补全暂由 Agent 对话承载，后续接入 CompletionIPC
                return null;
            },
            freeInlineCompletions: () => {}
        };

        // 为Agent助手编程语言注册补全 (对齐 4.5.1)
        const languages = ['java', 'python', 'typescript', 'javascript', 'cpp', 'go'];
        const disposables = languages.map(lang => 
            monaco.languages.registerInlineCompletionsProvider(lang, provider)
        );
        
        providerRef.current = {
            dispose: () => disposables.forEach(d => d.dispose())
        };

        return () => providerRef.current?.dispose();
    }, [editor, debounce, providerId, modelId]);
}

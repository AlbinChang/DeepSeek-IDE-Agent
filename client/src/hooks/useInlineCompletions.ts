import { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import { WorkerManager } from '@/services/WorkerManager';

interface CompletionOptions {
    editor: monaco.editor.IStandaloneCodeEditor | null;
    debounce: number;
    providerId: string;
    modelId: string;
}

/**
 * 对应技术规范 4.5.1 & 20.0 节：LLM 补全系统
 * 采用 WebSocket (Worker Proxy) + Ghost Text 渲染
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
            provideInlineCompletions: async (model, position, _context, token) => {
                return new Promise((resolve) => {
                    const timeoutId = setTimeout(async () => {
                        if (token.isCancellationRequested) return resolve(null);

                        const requestId = `req-${Date.now()}`;
                        
                        // 获取上下文 (对齐 4.5.2 节：上下文截断)
                        const prefixLines = 10;
                        const suffixLines = 10;
                        
                        const prefix = model.getValueInRange({
                            startLineNumber: Math.max(1, position.lineNumber - prefixLines),
                            startColumn: 1,
                            endLineNumber: position.lineNumber,
                            endColumn: position.column
                        });
                        const suffix = model.getValueInRange({
                            startLineNumber: position.lineNumber,
                            startColumn: position.column,
                            endLineNumber: Math.min(model.getLineCount(), position.lineNumber + suffixLines),
                            endColumn: 1
                        });

                        let fullText = '';
                        const onDelta = (e: any) => {
                            if (e.detail.id === requestId) fullText += e.detail.text;
                        };
                        const onDone = (e: any) => {
                            if (e.detail.id === requestId) {
                                window.removeEventListener('ai:completion:delta', onDelta);
                                window.removeEventListener('ai:completion:done', onDone);
                                
                                resolve({
                                    items: [{
                                        insertText: fullText,
                                        range: new monaco.Range(
                                            position.lineNumber, 
                                            position.column, 
                                            position.lineNumber, 
                                            position.column
                                        )
                                    }]
                                });
                            }
                        };

                        window.addEventListener('ai:completion:delta', onDelta);
                        window.addEventListener('ai:completion:done', onDone);

                        // 通过 Worker 代理 (对齐 3.1 & 4.5.2 节) - Strict JSON-RPC 2.0
                        WorkerManager.send('completion-shared', {
                            jsonrpc: '2.0',
                            method: 'completion/request',
                            id: requestId,
                            params: {
                                prefix,
                                suffix,
                                provider: providerId,
                                model: modelId
                            }
                        });

                        token.onCancellationRequested(() => {
                            window.removeEventListener('ai:completion:delta', onDelta);
                            window.removeEventListener('ai:completion:done', onDone);
                            clearTimeout(timeoutId);
                            resolve(null);
                        });
                    }, debounce);
                });
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

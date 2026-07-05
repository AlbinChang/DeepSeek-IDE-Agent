import React, { useEffect } from 'react';
import { DiffEditor } from '@monaco-editor/react';
import { X, Check } from 'lucide-react';
import axios from 'axios';
import { API_BASE } from '@/config';

interface DiffModalProps {
    isOpen: boolean;
    onClose: () => void;
    onAccept: () => void;
    onReject: () => void;
    original: string;
    modified: string;
    fileName: string;
    toolCallId?: string; // 加入 toolCallId 用于心跳 (Section 15.1)
    isConflict?: boolean; 
    batchInfo?: {
        current: number;
        total: number;
        onNext: () => void;
    };
}

export const DiffModal: React.FC<DiffModalProps> = ({ 
    isOpen, onClose, onAccept, onReject, original, modified, fileName, toolCallId, isConflict, batchInfo
}) => {
    // 对齐 15.1 节：锁心跳机制 (Lock Heartbeat)
    // 当审阅窗口打开时，每 10 秒向后端发送一次心跳以维持文件锁
    useEffect(() => {
        let interval: any;
        if (isOpen && toolCallId) {
            interval = setInterval(async () => {
                try {
                    await axios.post(`${API_BASE}/api/lock/heartbeat`, {
                        path: fileName,
                        toolCallId
                    });
                } catch (e) {
                    console.warn('[DiffModal] Heartbeat failed:', e);
                }
            }, 10000); 
        }
        return () => clearInterval(interval);
    }, [isOpen, toolCallId, fileName]);

    if (!isOpen) return null;

    const getLanguage = (file: string) => {
        const ext = file.split('.').pop()?.toLowerCase();
        switch (ext) {
            case 'ts': case 'tsx': return 'typescript';
            case 'js': case 'jsx': return 'javascript';
            case 'java': return 'java';
            case 'py': return 'python';
            case 'json': return 'json';
            case 'html': return 'html';
            case 'css': return 'css';
            case 'pdf': return 'pdf';
            default: return 'plaintext';
        }
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 sm:p-8">
            <div className="bg-black border border-white/10 shadow-2xl w-full max-w-6xl h-full flex flex-col overflow-hidden relative ring-1 ring-white/10">
                {/* Header (Industrial) */}
                <div className="flex items-center justify-between h-[32px] px-4 border-b border-white/10 bg-black shrink-0">
                    <div className="flex items-center gap-4">
                        <div className="flex items-center gap-3">
                            <span className="text-[10px] font-black text-white uppercase tracking-[0.3em]">
                                {batchInfo ? `BATCH_REVIEW (${batchInfo.current + 1}/${batchInfo.total})` : 'FILE_COMMIT_REVIEW'}
                            </span>
                            <div className="w-[1px] h-3 bg-white/10" />
                            <span className="text-[9px] text-white/40 font-mono lower">{fileName}</span>
                            {isConflict && (
                                <span className="px-1.5 py-0.5 rounded-sm bg-white/10 text-white border border-white/20 text-[8px] font-black uppercase flex items-center gap-1.5 animate-pulse">
                                    <div className="w-1 h-1 bg-white rounded-full" /> 
                                    CONFLICT_RESOLVING (S21.0)
                                </span>
                            )}
                        </div>
                    </div>
                    <button onClick={onClose} className="p-1 hover:bg-white/10 rounded transition-colors text-white/40 group">
                        <X size={14} className="group-hover:text-white transition-colors" />
                    </button>
                </div>

                {/* Conflict Alert (Section 33.4) */}
                {isConflict && (
                    <div className="bg-white/5 border-b border-white/10 p-2 flex items-center justify-center gap-2 text-white/60 text-[9px] font-black uppercase tracking-widest">
                        WARN: 本地内容已在磁盘更新 :: 基准已重置为最新状态 (SYNC_REQUIRED)
                    </div>
                )}

                {/* Diff Editor Container */}
                <div className="flex-1 min-h-0 bg-black relative">
                    <DiffEditor
                        original={original}
                        modified={modified}
                        language={getLanguage(fileName)}
                        theme="vs-dark"
                        options={{
                            renderSideBySide: true,
                            readOnly: true,
                            fontSize: 12,
                            lineNumbers: 'on',
                            wordWrap: 'on',
                            minimap: { enabled: false },
                            scrollBeyondLastLine: false,
                            scrollbar: {
                                vertical: 'auto',
                                horizontal: 'auto',
                                useShadows: false,
                                verticalScrollbarSize: 8,
                                horizontalScrollbarSize: 8,
                            },
                        }}
                    />
                </div>

                {/* Side Labels (V3 Style) */}
                <div className="h-[20px] px-4 flex items-center justify-between border-y border-white/5 bg-[#050505]">
                    <div className="text-[8px] font-black text-white/20 uppercase tracking-[0.2em] w-1/2 text-center border-r border-white/5">CURRENT_ON_DISK</div>
                    <div className="text-[8px] font-black text-white/20 uppercase tracking-[0.2em] w-1/2 text-center">PROPOSED_CHANGES</div>
                </div>

                {/* Footer (Industrial) */}
                <div className="p-4 bg-black border-t border-white/10 flex justify-between items-center">
                    <div className="flex items-center gap-4">
                        {batchInfo && batchInfo.total > 1 && (
                            <button 
                                onClick={batchInfo.onNext}
                                className="px-4 py-1.5 border border-white/10 hover:border-white/40 hover:bg-white/5 rounded-sm text-[9px] font-black text-white/60 uppercase tracking-widest transition-all"
                            >
                                跳过：下一个文件 (SKIP_NEXT)
                            </button>
                        )}
                    </div>
                    
                    <div className="flex gap-3">
                        <button 
                            onClick={onReject}
                            className="px-6 py-2 bg-transparent hover:bg-white/5 text-white/40 hover:text-white rounded-sm text-[10px] font-black uppercase tracking-widest border border-white/10 transition-all flex items-center gap-2"
                        >
                            <X size={12} strokeWidth={3} /> 拒绝 (REJECT)
                        </button>
                        <button 
                            onClick={onAccept}
                            className="px-8 py-2 bg-white hover:bg-white/80 text-black rounded-sm text-[10px] font-black uppercase tracking-widest border border-transparent transition-all flex items-center gap-2 active:scale-95 shadow-[0_0_20px_rgba(255,255,255,0.15)]"
                        >
                            <Check size={12} strokeWidth={4} /> 接受应用 (APPLY_COMMIT)
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};

import React, { useEffect, useState } from 'react';
import { ExternalLink } from 'lucide-react';

interface MermaidProps {
    chart: string;
}

type MermaidRuntime = {
    initialize: (config: Record<string, unknown>) => void;
    render: (id: string, chart: string) => Promise<{ svg: string }>;
};

let mermaidRuntimePromise: Promise<MermaidRuntime> | null = null;
let mermaidInitialized = false;

const getMermaidRuntime = async (): Promise<MermaidRuntime> => {
    if (!mermaidRuntimePromise) {
        mermaidRuntimePromise = import('mermaid').then((mod) => {
            const runtime = ((mod as any).default || mod) as MermaidRuntime;
            if (!mermaidInitialized) {
                // 核心初始化逻辑仅执行一次，避免重复初始化带来的状态抖动。
                runtime.initialize({
                    startOnLoad: false,
                    theme: 'base',
                    themeVariables: {
                        primaryColor: '#000000',
                        primaryTextColor: '#FFFFFF',
                        primaryBorderColor: '#FFFFFF',
                        lineColor: '#FFFFFF',
                        secondaryColor: '#000000',
                        tertiaryColor: '#000000',
                        fontSize: '12px',
                        fontFamily: 'JetBrains Mono, Menlo, monospace',
                        nodeBorder: '#FFFFFF',
                        mainBkg: '#000000',
                        clusterBkg: '#000000',
                        clusterBorder: '#FFFFFF',
                        defaultLinkColor: '#FFFFFF',
                        titleColor: '#FFFFFF',
                        edgeLabelBackground: '#000000',
                    },
                    securityLevel: 'loose',
                });
                mermaidInitialized = true;
            }

            return runtime;
        });
    }

    return mermaidRuntimePromise;
};

/**
 * Mermaid 渲染组件 (终极修复版)
 * 深度分析：[ID 重复]、[Mermaid内部挂起]、[DOM未就绪就渲染] 是主要死因。
 */
export const Mermaid: React.FC<MermaidProps> = ({ chart }) => {
    const [svg, setSvg] = useState<string>('');
    const [renderError, setRenderError] = useState<string | null>(null);
    const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);

    useEffect(() => {
        let isCancelled = false;
        
        // 关键点 1: 延迟执行，避开 React 初始渲染的高峰期，确保基础 DOM 环境稳定
        const timer = setTimeout(async () => {
            if (!chart || isCancelled) return;
            
            try {
                // 关键点 2: 严格的 ID 隔离
                const uniqueId = `mermaid-svg-${Math.random().toString(36).substring(2, 11)}`;
                
                // 关键点 3: 对输入进行极端清洗（移除可能导致解析失败的多余空白或不可见字符）
                const processedChart = chart.trim()
                    .replace(/\r/g, '')
                    .replace(/\n\s*\n/g, '\n'); 

                // 关键点 4: 使用 mermaid.render 的异步调用
                const mermaid = await getMermaidRuntime();
                const { svg: renderedSvg } = await mermaid.render(uniqueId, processedChart);
                
                if (!isCancelled) {
                    setSvg(renderedSvg);
                    setRenderError(null);
                }
            } catch (err: any) {
                console.error('[Mermaid-Fatal] Rendering failed:', err);
                
                // 尝试最后的补救措施：如果第一次失败，可能是内部状态污染，强制清理重试并不现实，直接显示错误
                if (!isCancelled) {
                    setRenderError(err?.message || 'MERMAID_INTERNAL_TIMEOUT_OR_SYNTAX_ERROR');
                    setSvg('');
                }
            }
        }, 100); // 100ms 缓冲时间

        return () => {
            isCancelled = true;
            clearTimeout(timer);
        };
    }, [chart]);

    useEffect(() => {
        const closeContextMenu = () => setContextMenu(null);
        window.addEventListener('click', closeContextMenu);
        return () => window.removeEventListener('click', closeContextMenu);
    }, []);

    const handleContextMenu = (e: React.MouseEvent) => {
        if (!svg) return;
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY });
    };

    const openInNewTab = () => {
        if (!svg) return;
        setContextMenu(null);
        
        // 创建一个全屏查看、可缩放的 HTML 页面
        const htmlContent = `
            <!DOCTYPE html>
            <html>
            <head>
                <meta charset="UTF-8">
                <title>Mermaid Diagram Viewer</title>
                <style>
                    body { 
                        margin: 0; padding: 40px; 
                        background: #000000; color: white; 
                        display: block; 
                        text-align: center; /* 使用 text-align 而非 flex，避免超出屏幕时左侧被截断无法滚动 */
                        min-height: 100vh; overflow: auto;
                        font-family: JetBrains Mono, Menlo, monospace;
                    }
                    .container { 
                        background: #050505; 
                        border: 1px solid rgba(255,255,255,0.1); 
                        padding: 40px; 
                        border-radius: 8px; 
                        box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5); 
                        display: inline-block;
                        text-align: left;
                        min-width: fit-content; /* 允许容器被内部 SVG 撑开 */
                    }
                    /* 放弃 width: 100%，使用 auto 恢复 SVG 原生基于 viewBox 的无限缩放渲染比例 */
                    svg { 
                        width: auto !important; 
                        height: auto !important; 
                        max-width: none !important; 
                        min-width: 800px; /* 保证基础的可读初始宽度 */
                    }
                </style>
            </head>
            <body>
                <div class="container">
                    ${svg}
                </div>
            </body>
            </html>
        `;
        const blob = new Blob([htmlContent], { type: 'text/html;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        window.open(url, '_blank');
    };

    // 错误状态反馈
    if (renderError) {
        return (
            <div className="my-4 p-4 border border-red-500/20 bg-red-500/5 font-mono text-[9px] text-red-400/80 rounded-sm">
                <div className="font-bold mb-1 opacity-100 uppercase tracking-tighter border-b border-red-500/10 pb-1">渲染异常 (Rendering Fail)</div>
                <div className="opacity-70 mt-1 whitespace-pre-wrap leading-tight">{renderError}</div>
                <div className="mt-2 pt-2 border-t border-red-500/10 text-[7px] opacity-30 select-none">ID: AUTO_GENERATED_UUID</div>
            </div>
        );
    }

    return (
        <div 
            className="my-6 p-6 border border-white/5 bg-[#050505] rounded-sm flex justify-center items-center overflow-x-auto min-h-[120px] shadow-2xl relative cursor-context-menu hover:border-white/10 transition-colors group"
            onContextMenu={handleContextMenu}
            title="右键点击查看大图"
        >
            {svg ? (
                <div 
                    className="mermaid-svg-container w-full flex justify-center [&>svg]:max-w-full [&>svg]:h-auto transition-opacity duration-500 ease-in opacity-100"
                    dangerouslySetInnerHTML={{ __html: svg }} 
                />
            ) : (
                <div className="flex flex-col items-center gap-3">
                    <div className="w-4 h-4 border-2 border-white/10 border-t-white/60 rounded-full animate-spin"></div>
                    <div className="text-white/20 text-[8px] font-mono uppercase tracking-[0.5em] animate-pulse">
                        Engine_Calibrating...
                    </div>
                </div>
            )}
            
            {/* 上下文右键菜单 */}
            {contextMenu && (
                <div 
                    className="fixed z-[100] bg-[#121212] border border-white/10 shadow-2xl py-1 text-white text-[10px] min-w-[200px] font-medium"
                    style={{ top: Math.min(contextMenu.y, window.innerHeight - 60), left: Math.min(contextMenu.x, window.innerWidth - 220) }}
                >
                    <div 
                        className="px-3 py-2 hover:bg-white/10 cursor-pointer flex items-center justify-between gap-2 transition-colors"
                        onClick={(e) => {
                            e.stopPropagation();
                            openInNewTab();
                        }}
                    >
                        <div className="flex items-center gap-2">
                            <ExternalLink size={12} className="opacity-50" />
                            <span>在新标签页中查看 (Open in New Tab)</span>
                        </div>
                    </div>
                </div>
            )}
            
            {/* 顶角悬浮提示 */}
            <div className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity text-[8px] text-white/20 select-none">
                右键点击查看大图
            </div>
        </div>
    );
};

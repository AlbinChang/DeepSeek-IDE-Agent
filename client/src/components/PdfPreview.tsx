import React, { useEffect, useState, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { ZoomIn, ZoomOut, Loader2 } from 'lucide-react';

// 使用本地 npm 包内置的 worker（无需 CDN，国内环境无网络延迟）
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url
).toString();

interface PdfPreviewProps {
    base64: string;
}

interface PageState {
    pageNum: number;
    rendered: boolean;
    rendering: boolean;
    viewport?: pdfjsLib.PageViewport;
}

const PdfPreview: React.FC<PdfPreviewProps> = ({ base64 }) => {
    const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
    const [pageCount, setPageCount] = useState(0);
    const [scale, setScale] = useState(1.2);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [pageStates, setPageStates] = useState<PageState[]>([]);
    const containerRef = useRef<HTMLDivElement>(null);
    const canvasRefs = useRef<Map<number, HTMLCanvasElement>>(new Map());
    const observerRef = useRef<IntersectionObserver | null>(null);
    const renderedRef = useRef<Set<number>>(new Set());

    // 加载 PDF 文档
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        setPdfDoc(null);
        setPageCount(0);
        setPageStates([]);
        renderedRef.current.clear();
        canvasRefs.current.clear();

        const loadPdf = async () => {
            try {
                const binaryStr = atob(base64);
                const bytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                    bytes[i] = binaryStr.charCodeAt(i);
                }

                const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
                if (cancelled) return;

                setPdfDoc(doc);
                setPageCount(doc.numPages);

                // 预计算所有页面的 viewport
                const states: PageState[] = [];
                for (let i = 1; i <= doc.numPages; i++) {
                    const page = await doc.getPage(i);
                    states.push({
                        pageNum: i,
                        rendered: false,
                        rendering: false,
                        viewport: page.getViewport({ scale }),
                    });
                    page.cleanup();
                }
                if (!cancelled) {
                    setPageStates(states);
                    setLoading(false);
                }
            } catch (e: any) {
                if (!cancelled) {
                    setError(e.message || 'PDF 加载失败');
                    setLoading(false);
                }
            }
        };

        loadPdf();
        return () => { cancelled = true; };
    }, [base64]);

    // 渲染单个页面到对应 canvas
    const renderPageToCanvas = useCallback(async (
        pageNum: number,
        doc: pdfjsLib.PDFDocumentProxy,
        currentScale: number,
        canvas: HTMLCanvasElement
    ) => {
        if (renderedRef.current.has(pageNum)) return;

        setPageStates(prev =>
            prev.map(s => s.pageNum === pageNum ? { ...s, rendering: true } : s)
        );

        try {
            const page = await doc.getPage(pageNum);
            const viewport = page.getViewport({ scale: currentScale });

            const dpr = window.devicePixelRatio || 1;
            canvas.width = viewport.width * dpr;
            canvas.height = viewport.height * dpr;
            canvas.style.width = `${viewport.width}px`;
            canvas.style.height = `${viewport.height}px`;

            const ctx = canvas.getContext('2d')!;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

            await page.render({ canvasContext: ctx, viewport }).promise;
            page.cleanup();

            renderedRef.current.add(pageNum);
            setPageStates(prev =>
                prev.map(s => s.pageNum === pageNum ? { ...s, rendered: true, rendering: false } : s)
            );
        } catch (e: any) {
            if (e?.name !== 'RenderingCancelledException') {
                console.error(`Page ${pageNum} render error:`, e);
            }
            setPageStates(prev =>
                prev.map(s => s.pageNum === pageNum ? { ...s, rendering: false } : s)
            );
        }
    }, []);

    // IntersectionObserver: 懒渲染进入视口的页面
    useEffect(() => {
        if (!pdfDoc || pageStates.length === 0) return;

        // 断开旧的 observer
        if (observerRef.current) {
            observerRef.current.disconnect();
        }

        observerRef.current = new IntersectionObserver(
            (entries) => {
                for (const entry of entries) {
                    if (entry.isIntersecting) {
                        const pageNum = Number((entry.target as HTMLElement).dataset.pageNum);
                        const canvas = canvasRefs.current.get(pageNum);
                        if (canvas && !renderedRef.current.has(pageNum)) {
                            renderPageToCanvas(pageNum, pdfDoc, scale, canvas);
                        }
                    }
                }
            },
            { rootMargin: '200px' } // 提前 200px 开始渲染
        );

        // 观察所有页面占位元素
        const container = containerRef.current;
        if (container) {
            container.querySelectorAll('[data-page-num]').forEach(el => {
                observerRef.current?.observe(el);
            });
        }

        return () => {
            observerRef.current?.disconnect();
            observerRef.current = null;
        };
    }, [pdfDoc, pageStates, scale, renderPageToCanvas]);

    // 缩放变化时重新渲染
    useEffect(() => {
        if (!pdfDoc || pageStates.length === 0) return;
        renderedRef.current.clear();
        // 重新计算 viewport
        setPageStates(prev => {
            const updated = prev.map(s => ({
                ...s,
                rendered: false,
                rendering: false,
            }));
            // 异步更新 viewport
            (async () => {
                const newStates = [...updated];
                for (let i = 0; i < newStates.length; i++) {
                    const page = await pdfDoc.getPage(i + 1);
                    newStates[i] = { ...newStates[i], viewport: page.getViewport({ scale }) };
                    page.cleanup();
                }
                setPageStates(newStates);
            })();
            return updated;
        });
        // 清理已渲染的 canvas 尺寸
        canvasRefs.current.forEach(canvas => {
            canvas.width = 0;
            canvas.height = 0;
        });
    }, [scale]);

    const zoomIn = () => setScale(s => Math.min(3, s + 0.2));
    const zoomOut = () => setScale(s => Math.max(0.4, s - 0.2));

    if (loading) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3 bg-[#eef0f3] text-slate-500">
                <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
                <span className="text-[9pt]">正在加载 PDF...</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 bg-[#eef0f3] text-red-500/80">
                <span className="text-[9pt] font-medium">PDF 加载失败</span>
                <span className="text-[8pt] text-slate-500">{error}</span>
            </div>
        );
    }

    return (
        <div className="flex h-full flex-col bg-[#eef0f3] text-slate-700 select-none">
            {/* 工具栏 — 文件名由外层编辑器显示，这里只保留阅读控制 */}
            <div className="flex shrink-0 items-center justify-end border-b border-slate-200/80 bg-[#fafafa]/95 px-3 py-1.5 shadow-[0_1px_2px_rgba(15,23,42,0.05)]">
                <div className="flex items-center gap-2 rounded-md border border-slate-200 bg-white px-1.5 py-1 shadow-sm">
                    <button
                        onClick={zoomOut}
                        disabled={scale <= 0.4}
                        className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:opacity-30"
                        title="缩小"
                    >
                        <ZoomOut className="h-3.5 w-3.5" />
                    </button>
                    <span className="w-10 text-center text-[8pt] tabular-nums text-slate-500">{Math.round(scale * 100)}%</span>
                    <button
                        onClick={zoomIn}
                        disabled={scale >= 3}
                        className="rounded p-1 text-slate-500 transition-colors hover:bg-slate-100 hover:text-slate-800 disabled:opacity-30"
                        title="放大"
                    >
                        <ZoomIn className="h-3.5 w-3.5" />
                    </button>
                    <div className="h-4 w-px bg-slate-200" />
                    <span className="px-1 text-[8pt] tabular-nums text-slate-500">共 {pageCount} 页</span>
                </div>
            </div>

            {/* 垂直滚动所有页面 */}
            <div
                ref={containerRef}
                className="flex-1 overflow-auto bg-[#eef0f3]"
            >
                <div className="flex min-w-max flex-col items-center gap-6 px-8 py-6">
                    {pageStates.map((ps) => (
                        <div
                            key={ps.pageNum}
                            data-page-num={ps.pageNum}
                            className="flex flex-col items-center gap-2"
                        >
                            {/* 页间分隔 + 页码 */}
                            <span className="rounded-full bg-white/80 px-2 py-0.5 text-[8pt] tabular-nums text-slate-500 shadow-sm ring-1 ring-slate-200/80">
                                {ps.pageNum} / {pageCount}
                            </span>

                            {/* Canvas 占位容器（保持高度避免滚动跳动） */}
                            <div
                                className="relative overflow-hidden rounded-sm border border-slate-300/70 bg-white shadow-[0_14px_34px_rgba(15,23,42,0.18)]"
                                style={{
                                    width: ps.viewport ? `${ps.viewport.width}px` : '612px',
                                    height: ps.viewport ? `${ps.viewport.height}px` : '792px',
                                }}
                            >
                                {!ps.rendered && (
                                    <div className="absolute inset-0 flex items-center justify-center bg-white">
                                        {ps.rendering ? (
                                            <Loader2 className="h-4 w-4 animate-spin text-slate-300" />
                                        ) : (
                                            <span className="text-[8pt] text-slate-300">第 {ps.pageNum} 页</span>
                                        )}
                                    </div>
                                )}
                                <canvas
                                    ref={(el) => {
                                        if (el) canvasRefs.current.set(ps.pageNum, el);
                                        else canvasRefs.current.delete(ps.pageNum);
                                    }}
                                    className="bg-white"
                                    style={{ display: ps.rendered ? 'block' : 'none' }}
                                />
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        </div>
    );
};

export default PdfPreview;

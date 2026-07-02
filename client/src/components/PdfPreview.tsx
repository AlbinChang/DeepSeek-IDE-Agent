import React, { useEffect, useState, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { ChevronLeft, ChevronRight, ZoomIn, ZoomOut, Loader2 } from 'lucide-react';

// 使用官方 CDN worker（与 pdfjs-dist 版本匹配）
pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs`;

interface PdfPreviewProps {
    base64: string;
    fileName: string;
}

const PdfPreview: React.FC<PdfPreviewProps> = ({ base64, fileName }) => {
    const [pdfDoc, setPdfDoc] = useState<pdfjsLib.PDFDocumentProxy | null>(null);
    const [pageCount, setPageCount] = useState(0);
    const [currentPage, setCurrentPage] = useState(1);
    const [scale, setScale] = useState(1.2);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [rendering, setRendering] = useState(false);
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const renderTaskRef = useRef<any>(null);

    // 加载 PDF 文档
    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        setPdfDoc(null);
        setCurrentPage(1);

        const loadPdf = async () => {
            try {
                // base64 → Uint8Array
                const binaryStr = atob(base64);
                const bytes = new Uint8Array(binaryStr.length);
                for (let i = 0; i < binaryStr.length; i++) {
                    bytes[i] = binaryStr.charCodeAt(i);
                }

                const doc = await pdfjsLib.getDocument({ data: bytes }).promise;
                if (cancelled) return;

                setPdfDoc(doc);
                setPageCount(doc.numPages);
                setLoading(false);
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

    // 渲染当前页
    const renderPage = useCallback(async (pageNum: number, doc: pdfjsLib.PDFDocumentProxy, currentScale: number) => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        // 取消上一帧渲染任务
        if (renderTaskRef.current) {
            renderTaskRef.current.cancel();
            renderTaskRef.current = null;
        }

        setRendering(true);
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

            const renderTask = page.render({
                canvasContext: ctx,
                viewport,
            });
            renderTaskRef.current = renderTask;

            await renderTask.promise;
            renderTaskRef.current = null;
            setRendering(false);
        } catch (e: any) {
            if (e?.name !== 'RenderingCancelledException') {
                setError(e.message || '页面渲染失败');
            }
            setRendering(false);
        }
    }, []);

    useEffect(() => {
        if (pdfDoc) {
            renderPage(currentPage, pdfDoc, scale);
        }
    }, [pdfDoc, currentPage, scale, renderPage]);

    // 清理
    useEffect(() => {
        return () => {
            if (renderTaskRef.current) {
                renderTaskRef.current.cancel();
            }
        };
    }, []);

    const goToPrev = () => setCurrentPage(p => Math.max(1, p - 1));
    const goToNext = () => setCurrentPage(p => Math.min(pageCount, p + 1));
    const zoomIn = () => setScale(s => Math.min(3, s + 0.2));
    const zoomOut = () => setScale(s => Math.max(0.4, s - 0.2));

    if (loading) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-3 text-white/50">
                <Loader2 className="w-6 h-6 animate-spin text-emerald-500/60" />
                <span className="text-[9pt]">正在加载 PDF...</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="flex flex-col items-center justify-center h-full gap-2 text-red-400/70">
                <span className="text-[9pt] font-medium">PDF 加载失败</span>
                <span className="text-[8pt] text-white/30">{error}</span>
            </div>
        );
    }

    return (
        <div className="flex flex-col h-full bg-[#1a1a1a] select-none">
            {/* 工具栏 */}
            <div className="flex items-center justify-between px-3 py-1.5 border-b border-white/5 bg-white/[0.02] shrink-0">
                <span className="text-[9pt] text-white/50 font-medium truncate mr-2">{fileName}</span>
                <div className="flex items-center gap-1">
                    <button
                        onClick={zoomOut}
                        disabled={scale <= 0.4}
                        className="p-1 rounded hover:bg-white/10 disabled:opacity-30 transition-colors"
                        title="缩小"
                    >
                        <ZoomOut className="w-3.5 h-3.5 text-white/50" />
                    </button>
                    <span className="text-[8pt] text-white/40 w-10 text-center tabular-nums">{Math.round(scale * 100)}%</span>
                    <button
                        onClick={zoomIn}
                        disabled={scale >= 3}
                        className="p-1 rounded hover:bg-white/10 disabled:opacity-30 transition-colors"
                        title="放大"
                    >
                        <ZoomIn className="w-3.5 h-3.5 text-white/50" />
                    </button>
                    <div className="w-px h-4 bg-white/10 mx-1" />
                    <button
                        onClick={goToPrev}
                        disabled={currentPage <= 1}
                        className="p-1 rounded hover:bg-white/10 disabled:opacity-30 transition-colors"
                        title="上一页"
                    >
                        <ChevronLeft className="w-3.5 h-3.5 text-white/50" />
                    </button>
                    <span className="text-[8pt] text-white/40 tabular-nums min-w-[48px] text-center">
                        {currentPage} / {pageCount}
                    </span>
                    <button
                        onClick={goToNext}
                        disabled={currentPage >= pageCount}
                        className="p-1 rounded hover:bg-white/10 disabled:opacity-30 transition-colors"
                        title="下一页"
                    >
                        <ChevronRight className="w-3.5 h-3.5 text-white/50" />
                    </button>
                </div>
            </div>

            {/* PDF 画布 */}
            <div className="flex-1 overflow-auto flex justify-center bg-[#0d0d0d]">
                <div className="relative py-4">
                    {rendering && (
                        <div className="absolute top-2 left-1/2 -translate-x-1/2 z-10 flex items-center gap-1.5 bg-black/60 backdrop-blur-sm px-2.5 py-1 rounded-full border border-white/10">
                            <Loader2 className="w-3 h-3 animate-spin text-emerald-500/60" />
                            <span className="text-[8pt] text-white/40">渲染中</span>
                        </div>
                    )}
                    <canvas
                        ref={canvasRef}
                        className="shadow-lg shadow-black/30"
                    />
                </div>
            </div>
        </div>
    );
};

export default PdfPreview;

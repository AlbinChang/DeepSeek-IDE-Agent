import React, { useEffect, useState, useRef, useMemo } from 'react';
import { Loader2, AlertTriangle } from 'lucide-react';

interface PdfPreviewProps {
    base64: string;
}

/**
 * PDF 预览组件 — 通过 Blob URL + iframe 委托给浏览器原生 PDF 阅读器渲染。
 *
 * 相比 pdf.js canvas/text-layer 方案的优势：
 * - 原生文字选择/复制（浏览器 PDF 阅读器内置支持）
 * - 原生缩放、搜索、页码导航、打印
 * - 零坐标对齐问题
 * - 极简代码，无第三方 PDF 渲染库依赖
 *
 * 注意：iframe 不使用 sandbox 属性，因为 Electron/Chromium 的
 * sandbox 会阻止内置 PDF 查看器扩展访问 blob: URL，导致
 * ERR_BLOCKED_BY_CLIENT。Blob 内容来自自有 base64 数据，无 XSS 风险。
 */
const PdfPreview: React.FC<PdfPreviewProps> = ({ base64 }) => {
    const [error, setError] = useState<string | null>(null);
    const [iframeReady, setIframeReady] = useState(false);
    const iframeRef = useRef<HTMLIFrameElement>(null);

    // 将 Base64 转换为 Blob URL（浏览器原生 PDF 阅读器可直接加载 Blob URL）
    const pdfUrl = useMemo(() => {
        try {
            const binaryStr = atob(base64);
            const bytes = new Uint8Array(binaryStr.length);
            for (let i = 0; i < binaryStr.length; i++) {
                bytes[i] = binaryStr.charCodeAt(i);
            }
            const blob = new Blob([bytes], { type: 'application/pdf' });
            return URL.createObjectURL(blob);
        } catch (e: any) {
            setError(e.message || 'PDF Base64 解码失败');
            return null;
        }
    }, [base64]);

    // 卸载时释放 Blob URL
    useEffect(() => {
        return () => {
            if (pdfUrl) {
                URL.revokeObjectURL(pdfUrl);
            }
        };
    }, [pdfUrl]);

    // base64 变化时重置加载状态
    useEffect(() => {
        setIframeReady(false);
        setError(null);
    }, [base64]);

    // 错误状态
    if (error) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-2 bg-[#eef0f3] text-red-500/80">
                <AlertTriangle className="h-5 w-5 text-red-400/70" />
                <span className="text-[9pt] font-medium">PDF 加载失败</span>
                <span className="max-w-[480px] break-words text-center text-[8pt] text-slate-500">{error}</span>
            </div>
        );
    }

    // 还未生成 URL（理论上不会发生，因为 useMemo 同步执行）
    if (!pdfUrl) {
        return (
            <div className="flex h-full flex-col items-center justify-center gap-3 bg-[#eef0f3] text-slate-500">
                <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
                <span className="text-[9pt]">正在准备 PDF...</span>
            </div>
        );
    }

    return (
        <div className="relative flex h-full flex-col bg-[#eef0f3]">
            {/* 初始加载遮罩 — iframe 内 PDF 阅读器就绪后隐藏 */}
            {!iframeReady && (
                <div className="absolute inset-0 z-10 flex items-center justify-center bg-[#eef0f3]">
                    <div className="flex flex-col items-center gap-2">
                        <Loader2 className="h-6 w-6 animate-spin text-slate-400" />
                        <span className="text-[9pt] text-slate-500">正在加载 PDF 阅读器...</span>
                    </div>
                </div>
            )}
            <iframe
                ref={iframeRef}
                src={pdfUrl}
                className="h-full w-full border-0 bg-white"
                title="PDF 预览"
                onLoad={() => setIframeReady(true)}
                onError={() => {
                    setError('PDF 预览加载失败（可能是浏览器不支持原生 PDF 阅读器）');
                }}
            />
        </div>
    );
};

export default PdfPreview;

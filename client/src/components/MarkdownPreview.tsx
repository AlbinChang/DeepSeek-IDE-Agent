import React, { Suspense, lazy, useState, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { LazySyntaxHighlighter } from './LazySyntaxHighlighter';
import { electronBridge } from '@/services/electron-bridge';

const Mermaid = lazy(() => import('@/components/Mermaid').then((mod) => ({ default: mod.Mermaid })));

interface MarkdownPreviewProps {
  content: string;
  /** 当前 Markdown 文件的路径（用于解析相对路径图片） */
  filePath?: string;
  /** 工作区根目录（用于解析相对路径图片） */
  workspaceRoot?: string | null;
}

const MARKDOWN_PREVIEW_CHAR_LIMIT = 200_000;

/**
 * 对应技术规范：Markdown 预览增强系统 (极简黑白版)
 * 移除所有彩色标题，锁定为黑白灰色调，仅通过字重和边框区分。
 */
export const MarkdownPreview: React.FC<MarkdownPreviewProps> = ({ content, filePath, workspaceRoot }) => {
  const previewContent = React.useMemo(() => {
    if (content.length <= MARKDOWN_PREVIEW_CHAR_LIMIT) return content;
    return `${content.slice(0, MARKDOWN_PREVIEW_CHAR_LIMIT)}\n\n> Markdown 预览内容过长，已截断渲染以避免页面内存溢出；原始字符数：${content.length.toLocaleString('zh-CN')}`;
  }, [content]);

  const normalizeExternalHref = (href?: string) => {
    const raw = String(href || '').trim();
    if (!raw) return '#';
    if (/^(https?:|mailto:|tel:)/i.test(raw)) return raw;
    if (raw.startsWith('/') || raw.startsWith('./') || raw.startsWith('../') || raw.startsWith('#')) return raw;
    return '#';
  };

  return (
    <div className="h-full w-full overflow-auto bg-[#0a0a0a] px-8 pb-8 pt-px font-sans scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent">
      <div className="markdown-body max-w-4xl mx-auto">
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          rehypePlugins={[rehypeRaw]}
          components={{
            // 覆盖代码块渲染逻辑 (黑白化处理)
            code({ node, inline, className, children, ...props }: any) {
              const match = /language-(\w+)/.exec(className || '');
              const language = match ? match[1] : '';

              if (!inline && language === 'mermaid') {
                return (
                  <Suspense fallback={<div className="my-4 p-4 border border-white/10 bg-black/30 text-[9px] text-white/50 font-mono">Loading Mermaid...</div>}>
                    <Mermaid chart={String(children).replace(/\n$/, '')} />
                  </Suspense>
                );
              }

              return !inline && language ? (
                <LazySyntaxHighlighter
                  language={language}
                  PreTag="div"
                  className="rounded-sm border border-white/5 !bg-[#0f0f0f] !m-0 !mb-6 !p-4"
                  {...props}
                >
                  {String(children).replace(/\n$/, '')}
                </LazySyntaxHighlighter>
              ) : (
                <code className="bg-white/10 px-1.5 py-0.5 rounded-sm text-[0.85em] font-mono text-white/90" {...props}>
                  {children}
                </code>
              );
            },
            // 黑白简约风格标题
            h1: ({ children }) => <h1 className="text-xl font-black text-white border-b border-white/10 pb-3 mt-10 mb-6 uppercase tracking-[0.2em]">{children}</h1>,
            h2: ({ children }) => <h2 className="text-lg font-bold text-white/90 border-b border-white/5 pb-2 mt-8 mb-4 tracking-wider">{children}</h2>,
            h3: ({ children }) => <h3 className="text-md font-bold text-white/80 mt-6 mb-3 tracking-wide">{children}</h3>,
            // 极简表格
            table: ({ children }) => (
              <div className="overflow-x-auto mb-8 border border-white/10 rounded-sm">
                <table className="min-w-full border-collapse text-xs">
                  {children}
                </table>
              </div>
            ),
            th: ({ children }) => <th className="border-b border-white/10 px-4 py-3 bg-white/5 font-bold text-left text-white/60 uppercase tracking-tighter">{children}</th>,
            td: ({ children }) => <td className="border-b border-white/5 px-4 py-3 text-white/80 font-mono italic">{children}</td>,
            // 链接
            a: ({ href, children }) => (
              <a href={normalizeExternalHref(href)} target="_blank" rel="noopener noreferrer nofollow" className="text-white underline decoration-white/20 hover:decoration-white/60 transition-all">
                {children}
              </a>
            ),
            // 图片渲染（支持外部URL、本地相对路径、加载失败回退）
            img: ({ src, alt }) => <MarkdownImage src={src} alt={alt} filePath={filePath} workspaceRoot={workspaceRoot} />,
            // 极简引用块
            blockquote: ({ children }) => (
              <blockquote className="border-l border-white/30 pl-6 py-2 my-6 bg-white/[0.02] text-white/50 italic font-serif">
                {children}
              </blockquote>
            ),
            // 列表
            li: ({ children }) => <li className="mb-2 text-white/80 list-disc ml-4">{children}</li>
          }}
        >
          {previewContent}
        </ReactMarkdown>
      </div>

      <style>{`
        .markdown-body {
          color: rgba(255, 255, 255, 0.7);
          font-size: 9pt;
          line-height: 1.8;
          font-family: "Inter", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        }
        
        .markdown-body p {
          margin-bottom: 20px;
        }

        .markdown-body strong {
          color: #fff;
          font-weight: 800;
        }

        /* 修复预览首屏顶部留白：首个元素不应再叠加标题 mt-* */
        .markdown-body > :first-child {
          margin-top: 0 !important;
        }

        /* 移除 Mermaid 本身可能自带的背景色，强制透明 */
        .mermaid {
          background: transparent !important;
        }
      `}</style>
    </div>
  );
};

// ── 图片渲染组件（处理加载失败、外部链接、暗色主题） ──

interface MarkdownImageProps {
  src?: string;
  alt?: string;
  filePath?: string;
  workspaceRoot?: string | null;
}

const MarkdownImage: React.FC<MarkdownImageProps> = ({ src, alt, filePath, workspaceRoot }) => {
  const [error, setError] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [resolvedSrc, setResolvedSrc] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);

  const rawSrc = String(src || '').trim();
  if (!rawSrc) {
    return <ImagePlaceholder reason="无图片来源" />;
  }

  // 外部 HTTP(S) 图片：正常加载
  const isExternal = /^https?:\/\//i.test(rawSrc);
  // Data URI：直接显示
  const isDataUri = rawSrc.startsWith('data:');

  // 本地相对路径：尝试通过 Electron IPC 读取文件并转为 data URI
  const isLocalRelative = !isExternal && !isDataUri;

  // 本地相对路径解析 effect
  useEffect(() => {
    if (!isLocalRelative) return;
    if (!workspaceRoot) {
      setError(true);
      return;
    }

    let cancelled = false;
    setResolving(true);

    const resolveAndLoad = async () => {
      try {
        // 解析相对路径：基于当前 MD 文件所在目录
        let absolutePath: string;
        if (filePath) {
          const mdDir = filePath.replace(/[/\\][^/\\]*$/, ''); // MD 文件所在目录
          absolutePath = mdDir ? `${mdDir}/${rawSrc}`.replace(/\/+/g, '/') : rawSrc;
        } else {
          absolutePath = rawSrc;
        }

        // 规范化路径（处理 ../ 等）
        const parts = absolutePath.split('/');
        const resolved: string[] = [];
        for (const part of parts) {
          if (part === '..') {
            resolved.pop();
          } else if (part !== '.' && part !== '') {
            resolved.push(part);
          }
        }
        const normalizedPath = resolved.join('/');

        if (!normalizedPath) {
          if (!cancelled) setError(true);
          return;
        }

        const result = await electronBridge.readFileBinary({
          filePath: normalizedPath,
          root: workspaceRoot,
        });

        if (cancelled) return;

        if (result?.success && result.base64) {
          const mime = result.mimeType || guessMimeFromExt(normalizedPath);
          setResolvedSrc(`data:${mime};base64,${result.base64}`);
          setResolving(false);
        } else {
          setError(true);
        }
      } catch {
        if (!cancelled) setError(true);
      }
    };

    resolveAndLoad();
    return () => { cancelled = true; };
  }, [isLocalRelative, rawSrc, filePath, workspaceRoot]);

  // 正在解析本地文件
  if (resolving) {
    return (
      <div className="my-4 flex items-center gap-2 rounded-sm border border-white/5 bg-white/[0.02] px-4 py-3">
        <div className="h-3 w-3 animate-pulse rounded-full bg-white/10" />
        <span className="text-[8pt] text-white/30">读取本地图片: {rawSrc}</span>
      </div>
    );
  }

  // 本地图片解析失败
  if (isLocalRelative && error) {
    return <ImagePlaceholder reason={`图片未找到: ${alt || rawSrc}`} />;
  }

  // 最终使用的 src
  const finalSrc = resolvedSrc || rawSrc;

  // 图片加载失败（外部 URL）
  if (error && !isLocalRelative) {
    return <ImagePlaceholder reason={alt || '图片加载失败'} />;
  }

  return (
    <span className={`my-4 block ${loaded ? '' : 'min-h-[60px]'}`}>
      {!loaded && (
        <div className="flex items-center gap-2 rounded-sm border border-white/5 bg-white/[0.02] px-4 py-3">
          <div className="h-3 w-3 animate-pulse rounded-full bg-white/10" />
          <span className="text-[8pt] text-white/30">加载图片中...</span>
        </div>
      )}
      <img
        src={finalSrc}
        alt={alt || ''}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
        className={`max-w-full rounded-sm ${loaded ? 'block' : 'hidden'}`}
        style={{ maxHeight: '400px', objectFit: 'contain' }}
        loading="lazy"
      />
    </span>
  );
};

const ImagePlaceholder: React.FC<{ reason: string }> = ({ reason }) => (
  <div className="my-4 flex items-center gap-3 rounded-sm border border-white/10 bg-white/[0.02] px-4 py-3">
    <svg className="h-5 w-5 shrink-0 text-white/25" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.5}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 15.75l5.159-5.159a2.25 2.25 0 013.182 0l5.159 5.159m-1.5-1.5l1.409-1.409a2.25 2.25 0 013.182 0l2.909 2.909M3.75 21h16.5A2.25 2.25 0 0022.5 18.75V5.25A2.25 2.25 0 0020.25 3H3.75A2.25 2.25 0 001.5 5.25v13.5A2.25 2.25 0 003.75 21z" />
    </svg>
    <span className="text-[9pt] text-white/35">{reason}</span>
  </div>
);

/** 根据文件扩展名猜测 MIME 类型（供本地图片 base64 内联使用） */
function guessMimeFromExt(filePath: string): string {
  const ext = filePath.split('.').pop()?.toLowerCase() || '';
  const mimeMap: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    bmp: 'image/bmp',
    ico: 'image/x-icon',
    tiff: 'image/tiff',
    tif: 'image/tiff',
  };
  return mimeMap[ext] || 'image/png';
}

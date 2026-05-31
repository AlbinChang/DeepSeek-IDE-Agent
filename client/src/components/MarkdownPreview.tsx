import React, { Suspense, lazy } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { LazySyntaxHighlighter } from './LazySyntaxHighlighter';

const Mermaid = lazy(() => import('@/components/Mermaid').then((mod) => ({ default: mod.Mermaid })));

interface MarkdownPreviewProps {
  content: string;
}

const MARKDOWN_PREVIEW_CHAR_LIMIT = 200_000;

/**
 * 对应技术规范：Markdown 预览增强系统 (极简黑白版)
 * 移除所有彩色标题，锁定为黑白灰色调，仅通过字重和边框区分。
 */
export const MarkdownPreview: React.FC<MarkdownPreviewProps> = ({ content }) => {
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

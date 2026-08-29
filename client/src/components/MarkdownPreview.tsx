import React, { Suspense, lazy, useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeRaw from 'rehype-raw';
import { Search, ChevronUp, ChevronDown, X } from 'lucide-react';
import { LazySyntaxHighlighter } from './LazySyntaxHighlighter';
import { electronBridge } from '@/services/electron-bridge';
import { resolveWorkspaceRelativePath } from '@/utils/markdownLinks';

const Mermaid = lazy(() => import('@/components/Mermaid').then((mod) => ({ default: mod.Mermaid })));

interface MarkdownPreviewProps {
  content: string;
  /** 当前 Markdown 文件的路径（用于解析相对路径图片） */
  filePath?: string;
  /** 工作区根目录（用于解析相对路径图片） */
  workspaceRoot?: string | null;
}

const MARKDOWN_PREVIEW_CHAR_LIMIT = 200_000;

// ── 阅读位置跨生命周期缓存（与 FileEditor 的 editorViewStateCache 同模式）──
// 背景：MarkdownPreview 在 FileEditor 中是「条件挂载」的（viewMode === 'preview' 才存在）。
// 用户切换到编辑视图 / 其他文件 / 其他预览类型时，整个子树被 React 卸载，滚动位置
// （scrollTop）作为纯 DOM 状态随之销毁；切回预览时重新挂载，scrollTop 归零 → 阅读位置丢失。
// 修复：
// 1. 以文件路径为键缓存 scrollTop；
// 2. 监听容器 onScroll 事件实时更新缓存，防止 unmount cleanup 时因 DOM 脱离文档而读出 0 覆盖正确缓存；
// 3. 用户切换文件或重新挂载时，先清空或恢复目标 scrollTop，避免未滚动的文档继承上一个文档的滚动偏移；
// 4. 内容高度随图片/Mermaid 异步加载而增长，用 ResizeObserver 持续校正 scrollTop 直至高度稳定。
const markdownPreviewScrollCache = new Map<string, number>();
// 内容稳定判定：ResizeObserver 观察期内 scrollHeight 连续 N 次不变，视为图片/Mermaid 已加载完成
const SCROLL_STABLE_COUNT = 2;
// 校正安全超时：超过该时长强制结束校正（兜底防泄漏）
const SCROLL_RESTORE_TIMEOUT_MS = 2500;

/**
 * 清除容器内所有查找高亮标签并恢复合并原始文本节点
 */
// ── 文本查找 Range 收集与高亮管理（基于 CSS Custom Highlight API，零 DOM 侵入，绝对不破坏 React DOM 树） ──

function clearHighlights() {
  if (typeof CSS !== 'undefined' && 'highlights' in CSS) {
    try {
      (CSS as any).highlights.delete('md-search-match');
      (CSS as any).highlights.delete('md-search-current');
    } catch {
      // 忽略清理异常
    }
  }
}

/**
 * 遍历并计算容器内所有匹配文本的 Range 对象（不修改任何真实 DOM 节点）
 */
function findMatchRanges(
  container: HTMLElement | null,
  query: string,
  options: { caseSensitive: boolean; wholeWord: boolean; isRegex: boolean }
): { ranges: Range[]; error: string | null } {
  if (!container || !query) {
    clearHighlights();
    return { ranges: [], error: null };
  }

  let regex: RegExp;
  try {
    const flags = options.caseSensitive ? 'g' : 'gi';
    if (options.isRegex) {
      regex = new RegExp(query, flags);
    } else {
      const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = options.wholeWord ? `\\b${escaped}\\b` : escaped;
      regex = new RegExp(pattern, flags);
    }
  } catch (err: any) {
    clearHighlights();
    return { ranges: [], error: err?.message || '无效的正则表达式' };
  }

  // 收集所有内容区文本节点（排除 find widget、style、script 等）
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (
        parent.closest('.markdown-find-widget') ||
        parent.tagName === 'STYLE' ||
        parent.tagName === 'SCRIPT'
      ) {
        return NodeFilter.FILTER_REJECT;
      }
      if (!node.nodeValue || node.nodeValue.length === 0) {
        return NodeFilter.FILTER_REJECT;
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  let currentTextNode = walker.nextNode();
  while (currentTextNode) {
    textNodes.push(currentTextNode as Text);
    currentTextNode = walker.nextNode();
  }

  const ranges: Range[] = [];

  for (const textNode of textNodes) {
    const text = textNode.nodeValue;
    if (!text) continue;

    regex.lastIndex = 0;
    let match: RegExpExecArray | null;

    while ((match = regex.exec(text)) !== null) {
      const matchText = match[0];
      // 防死循环（如 ^, $ 等零宽匹配）
      if (matchText.length === 0) {
        regex.lastIndex++;
        if (regex.lastIndex > text.length) break;
        continue;
      }

      try {
        const range = new Range();
        range.setStart(textNode, match.index);
        range.setEnd(textNode, match.index + matchText.length);
        ranges.push(range);
      } catch {
        // 忽略无效 range
      }
    }
  }

  return { ranges, error: null };
}

/**
 * 注册 / 更新 CSS.highlights 集合
 */
function updateHighlights(ranges: Range[], activeIndex: number) {
  if (typeof CSS === 'undefined' || !('highlights' in CSS) || typeof (globalThis as any).Highlight === 'undefined') {
    return;
  }

  try {
    const HighlightConstructor = (globalThis as any).Highlight;
    if (ranges.length > 0) {
      const allHighlight = new HighlightConstructor(...ranges);
      (CSS as any).highlights.set('md-search-match', allHighlight);
    } else {
      (CSS as any).highlights.delete('md-search-match');
    }

    if (activeIndex >= 0 && activeIndex < ranges.length) {
      const currentHighlight = new HighlightConstructor(ranges[activeIndex]);
      (CSS as any).highlights.set('md-search-current', currentHighlight);
    } else {
      (CSS as any).highlights.delete('md-search-current');
    }
  } catch (err) {
    console.warn('[MarkdownPreview] CSS Highlight error:', err);
  }
}

/**
 * 精准平滑滚动至匹配项中心
 */
function scrollToMatch(range: Range | undefined, scrollContainer: HTMLElement | null) {
  if (!range || !scrollContainer) return;

  try {
    const rangeRect = range.getBoundingClientRect();
    const containerRect = scrollContainer.getBoundingClientRect();

    if (rangeRect.height > 0) {
      const targetScrollTop =
        scrollContainer.scrollTop +
        (rangeRect.top - containerRect.top) -
        containerRect.height / 2;
      scrollContainer.scrollTo({
        top: Math.max(0, targetScrollTop),
        behavior: 'smooth',
      });
    } else {
      range.startContainer.parentElement?.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
        inline: 'nearest',
      });
    }
  } catch {
    range.startContainer.parentElement?.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest',
    });
  }
}

/**
 * 对应技术规范：Markdown 预览增强系统 (极简黑白版 + Ctrl+F 查找增强)
 * 移除所有彩色标题，锁定为黑白灰色调，仅通过字重和边框区分。
 */
export const MarkdownPreview: React.FC<MarkdownPreviewProps> = ({ content, filePath, workspaceRoot }) => {
  const previewContent = React.useMemo(() => {
    if (content.length <= MARKDOWN_PREVIEW_CHAR_LIMIT) return content;
    return `${content.slice(0, MARKDOWN_PREVIEW_CHAR_LIMIT)}\n\n> Markdown 预览内容过长，已截断渲染以避免页面内存溢出；原始字符数：${content.length.toLocaleString('zh-CN')}`;
  }, [content]);

  // ── 阅读位置保持（scroll 恢复）──
  // 卸载前保存、重挂载后恢复；因图片懒加载 / Mermaid 异步渲染导致内容高度持续增长，
  // 用 ResizeObserver 在内容稳定前反复校正 scrollTop，避免恢复到错误位置。
  const scrollContainerRef = useRef<HTMLDivElement | null>(null);
  const restoreTargetRef = useRef<number | null>(null);
  const restoreStableCountRef = useRef(0);
  const restoreRafRef = useRef<number | null>(null);
  const restoreObserverRef = useRef<ResizeObserver | null>(null);
  const restoreTimeoutRef = useRef<number | null>(null);
  const userInteractedRef = useRef(false);

  // ── 文本查找状态管理 (Ctrl+F) ──
  const contentContainerRef = useRef<HTMLDivElement | null>(null);
  const findInputRef = useRef<HTMLInputElement | null>(null);
  const rangesRef = useRef<Range[]>([]);

  const [isFindOpen, setIsFindOpen] = useState(false);
  const [findQuery, setFindQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [isRegex, setIsRegex] = useState(false);
  const [totalMatches, setTotalMatches] = useState(0);
  const [currentIndex, setCurrentIndex] = useState(-1);
  const [findError, setFindError] = useState<string | null>(null);

  // 容器实时滚动监听：用户主动滚动时立即更新缓存
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    // 若正处于自动恢复校正期间且用户未主动介入，不将中间瞬态写入缓存
    if (restoreTargetRef.current !== null && !userInteractedRef.current) return;
    const target = e.currentTarget;
    const key = filePath || '';
    if (key) {
      markdownPreviewScrollCache.set(key, target.scrollTop);
    }
  };

  // 监听用户主动交互（滚轮、拖动滚动条、触摸滑动），一旦用户主动操作立即停止自动恢复并记录位置
  const handleUserInteraction = () => {
    userInteractedRef.current = true;
    restoreTargetRef.current = null;
    if (restoreObserverRef.current) {
      restoreObserverRef.current.disconnect();
      restoreObserverRef.current = null;
    }
    if (restoreRafRef.current !== null) {
      cancelAnimationFrame(restoreRafRef.current);
      restoreRafRef.current = null;
    }
    const container = scrollContainerRef.current;
    const key = filePath || '';
    if (key && container) {
      markdownPreviewScrollCache.set(key, container.scrollTop);
    }
  };

  // 执行高亮匹配与定位
  const executeSearch = useCallback((query: string, options: { caseSensitive: boolean; wholeWord: boolean; isRegex: boolean }) => {
    const container = contentContainerRef.current;
    if (!container || !query) {
      clearHighlights();
      rangesRef.current = [];
      setTotalMatches(0);
      setCurrentIndex(-1);
      setFindError(null);
      return;
    }

    const { ranges, error } = findMatchRanges(container, query, options);
    rangesRef.current = ranges;
    setFindError(error);
    setTotalMatches(ranges.length);

    if (error || ranges.length === 0) {
      setCurrentIndex(-1);
      updateHighlights([], -1);
      return;
    }

    // 计算最接近当前视口的匹配项，避免跳跃
    const scrollContainer = scrollContainerRef.current;
    let initialIdx = 0;
    if (scrollContainer) {
      const containerTop = scrollContainer.getBoundingClientRect().top;
      for (let i = 0; i < ranges.length; i++) {
        const rect = ranges[i].getBoundingClientRect();
        if (rect.top >= containerTop - 10) {
          initialIdx = i;
          break;
        }
      }
    }

    setCurrentIndex(initialIdx);
    updateHighlights(ranges, initialIdx);
    scrollToMatch(ranges[initialIdx], scrollContainer);
  }, []);

  // 导航至下一个匹配项
  const goToNextMatch = useCallback(() => {
    const ranges = rangesRef.current;
    if (ranges.length === 0) return;
    setCurrentIndex((prev) => {
      const next = (prev + 1) % ranges.length;
      updateHighlights(ranges, next);
      scrollToMatch(ranges[next], scrollContainerRef.current);
      return next;
    });
  }, []);

  // 导航至上一个匹配项
  const goToPrevMatch = useCallback(() => {
    const ranges = rangesRef.current;
    if (ranges.length === 0) return;
    setCurrentIndex((prev) => {
      const next = (prev - 1 + ranges.length) % ranges.length;
      updateHighlights(ranges, next);
      scrollToMatch(ranges[next], scrollContainerRef.current);
      return next;
    });
  }, []);

  // 关闭查找栏并清理所有高亮
  const closeFind = useCallback(() => {
    setIsFindOpen(false);
    clearHighlights();
    rangesRef.current = [];
    setTotalMatches(0);
    setCurrentIndex(-1);
    setFindError(null);
  }, []);

  // 打开查找栏（支持带入选中文本）
  const openFind = useCallback((initialQuery?: string) => {
    setIsFindOpen(true);
    if (initialQuery !== undefined) {
      setFindQuery(initialQuery);
    }
    setTimeout(() => {
      findInputRef.current?.focus();
      findInputRef.current?.select();
    }, 0);
  }, []);

  // 当搜索条件改变或文档重新渲染时触发搜索
  useEffect(() => {
    if (isFindOpen) {
      executeSearch(findQuery, { caseSensitive, wholeWord, isRegex });
    } else {
      clearHighlights();
    }
  }, [isFindOpen, findQuery, caseSensitive, wholeWord, isRegex, executeSearch, previewContent]);

  // 组件卸载时彻底清除 DOM 高亮标签
  useEffect(() => {
    return () => {
      clearHighlights();
    };
  }, []);

  // 快捷键支持：Ctrl+F, F3, Shift+F3, Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isCtrlF = (e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F');
      const isF3 = e.key === 'F3';
      const isEscape = e.key === 'Escape';

      if (isCtrlF) {
        const activeEl = document.activeElement as HTMLElement | null;
        const isFindWidget = !!activeEl?.closest('.markdown-find-widget');
        const isInsidePreview = !!(scrollContainerRef.current && (scrollContainerRef.current.contains(activeEl) || activeEl === document.body));
        const isOtherInput = !!(
          activeEl &&
          !isFindWidget &&
          (activeEl instanceof HTMLInputElement || activeEl instanceof HTMLTextAreaElement || activeEl.isContentEditable)
        );

        if (!isOtherInput || isInsidePreview || isFindWidget) {
          e.preventDefault();
          e.stopPropagation();
          const selectedText = window.getSelection()?.toString()?.trim() || '';
          openFind(selectedText && selectedText.length < 200 ? selectedText : undefined);
        }
      } else if (isF3) {
        if (isFindOpen && rangesRef.current.length > 0) {
          e.preventDefault();
          if (e.shiftKey) {
            goToPrevMatch();
          } else {
            goToNextMatch();
          }
        }
      } else if (isEscape) {
        if (isFindOpen) {
          e.preventDefault();
          closeFind();
        }
      }
    };

    // 监听 UI 事件（如点击 Header 的 FIND 按钮）
    const handleFindEvent = () => {
      const selectedText = window.getSelection()?.toString()?.trim() || '';
      openFind(selectedText && selectedText.length < 200 ? selectedText : undefined);
    };

    window.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('ui:markdown:find', handleFindEvent);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('ui:markdown:find', handleFindEvent);
    };
  }, [isFindOpen, openFind, closeFind, goToNextMatch, goToPrevMatch]);

  // 处理查找输入框内部键盘事件
  const handleFindInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        goToPrevMatch();
      } else {
        goToNextMatch();
      }
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeFind();
    } else if (e.altKey && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      setCaseSensitive((prev) => !prev);
    } else if (e.altKey && e.key.toLowerCase() === 'w') {
      e.preventDefault();
      setWholeWord((prev) => !prev);
    } else if (e.altKey && e.key.toLowerCase() === 'r') {
      e.preventDefault();
      setIsRegex((prev) => !prev);
    }
  };

  // 卸载时保存当前阅读位置（key 为文件路径，React 先移除 DOM 节点后再执行 cleanup，
  // 此时需检查 container 仍在文档中且 scrollTop > 0，避免脱离文档返回 0 冲刷缓存）
  useEffect(() => {
    return () => {
      const key = filePath || '';
      const container = scrollContainerRef.current;
      if (key && container && container.isConnected && container.scrollTop > 0) {
        markdownPreviewScrollCache.set(key, container.scrollTop);
      }
    };
  }, [filePath]);

  // 挂载或 filePath/content 变化后恢复上次阅读位置，并在内容高度稳定前持续校正
  useEffect(() => {
    const container = scrollContainerRef.current;
    const key = filePath || '';
    const saved = key ? (markdownPreviewScrollCache.get(key) ?? 0) : 0;

    userInteractedRef.current = false;

    // 清理之前的观察器与定时器
    if (restoreObserverRef.current) {
      restoreObserverRef.current.disconnect();
      restoreObserverRef.current = null;
    }
    if (restoreRafRef.current !== null) {
      cancelAnimationFrame(restoreRafRef.current);
      restoreRafRef.current = null;
    }
    if (restoreTimeoutRef.current !== null) {
      window.clearTimeout(restoreTimeoutRef.current);
      restoreTimeoutRef.current = null;
    }

    if (!container) return;

    if (saved <= 0) {
      // 未曾记录滚动位置的新文件/未滚动文件：重置到顶部，避免残留上一个文件的滚动偏移
      container.scrollTop = 0;
      restoreTargetRef.current = null;
      return;
    }

    restoreTargetRef.current = saved;
    restoreStableCountRef.current = 0;
    container.scrollTop = saved;

    let lastHeight = container.scrollHeight;
    const applyRestore = () => {
      if (restoreTargetRef.current == null || !scrollContainerRef.current) return;
      scrollContainerRef.current.scrollTop = restoreTargetRef.current;
    };
    const scheduleApply = () => {
      if (restoreRafRef.current !== null) return;
      restoreRafRef.current = requestAnimationFrame(() => {
        restoreRafRef.current = null;
        applyRestore();
      });
    };

    // 内容高度随图片/Mermaid 异步加载而增长，直接设置 scrollTop 会被后续布局覆盖。
    // 监听高度变化：变化则重置稳定计数并重新校正；连续两次观察高度不变 → 内容已稳定 → 结束校正。
    const observer = new ResizeObserver(() => {
      if (restoreTargetRef.current == null) {
        observer.disconnect();
        restoreObserverRef.current = null;
        return;
      }

      const h = container.scrollHeight;
      const maxScroll = Math.max(0, container.scrollHeight - container.clientHeight);

      if (h !== lastHeight) {
        lastHeight = h;
        restoreStableCountRef.current = 0;
        scheduleApply();
      } else {
        if (maxScroll >= restoreTargetRef.current || h > 0) {
          restoreStableCountRef.current++;
        }
        if (restoreStableCountRef.current >= SCROLL_STABLE_COUNT) {
          restoreTargetRef.current = null;
          observer.disconnect();
          restoreObserverRef.current = null;
          return;
        }
        scheduleApply();
      }
    });
    restoreObserverRef.current = observer;
    observer.observe(container);

    // 安全兜底：无论高度是否稳定，超时后强制结束校正（防止观察器长期残留）
    restoreTimeoutRef.current = window.setTimeout(() => {
      if (restoreTargetRef.current !== null && scrollContainerRef.current) {
        applyRestore();
        restoreTargetRef.current = null;
      }
      if (restoreObserverRef.current) {
        restoreObserverRef.current.disconnect();
        restoreObserverRef.current = null;
      }
      restoreTimeoutRef.current = null;
    }, SCROLL_RESTORE_TIMEOUT_MS);

    return () => {
      if (restoreObserverRef.current) {
        restoreObserverRef.current.disconnect();
        restoreObserverRef.current = null;
      }
      if (restoreRafRef.current !== null) {
        cancelAnimationFrame(restoreRafRef.current);
        restoreRafRef.current = null;
      }
      if (restoreTimeoutRef.current !== null) {
        window.clearTimeout(restoreTimeoutRef.current);
        restoreTimeoutRef.current = null;
      }
    };
  }, [filePath, content]);

  return (
    <div className="relative h-full w-full overflow-hidden bg-[#0a0a0a]">
      {/* 浮动查找栏 (Ctrl+F) */}
      {isFindOpen && (
        <div
          className="markdown-find-widget absolute top-3 right-6 z-30 flex items-center gap-1 rounded-md border border-white/15 bg-[#141416]/95 p-1 shadow-2xl backdrop-blur-md select-none"
          role="search"
          aria-label="在 Markdown 预览中查找"
        >
          {/* 搜索输入与状态计数 */}
          <div
            className={`flex items-center gap-1.5 rounded bg-black/60 px-2 py-1 border transition-colors ${
              findError ? 'border-red-500/80' : 'border-white/10 focus-within:border-white/40'
            }`}
          >
            <Search className="h-3.5 w-3.5 text-white/40 shrink-0" />
            <input
              ref={findInputRef}
              type="text"
              value={findQuery}
              onChange={(e) => setFindQuery(e.target.value)}
              onKeyDown={handleFindInputKeyDown}
              placeholder="查找文本... (Enter 下一个)"
              className="w-36 bg-transparent text-xs text-white placeholder-white/30 outline-none font-sans"
              spellCheck={false}
            />
            <span
              className={`text-[10px] font-mono shrink-0 pl-1 ${
                findError
                  ? 'text-red-400 font-medium'
                  : findQuery && totalMatches === 0
                  ? 'text-amber-400 font-medium'
                  : 'text-white/45'
              }`}
            >
              {findError
                ? '正则错误'
                : !findQuery
                ? ''
                : totalMatches === 0
                ? '无结果'
                : `${currentIndex + 1}/${totalMatches}`}
            </span>
          </div>

          {/* 选项：区分大小写 Aa */}
          <button
            type="button"
            onClick={() => setCaseSensitive((prev) => !prev)}
            title="区分大小写 (Alt+C)"
            className={`flex h-6 w-6 items-center justify-center rounded text-[10px] font-mono font-bold transition-all ${
              caseSensitive
                ? 'bg-amber-500/25 text-amber-300 border border-amber-500/50'
                : 'text-white/40 hover:bg-white/10 hover:text-white border border-transparent'
            }`}
          >
            Aa
          </button>

          {/* 选项：全字匹配 \b */}
          <button
            type="button"
            onClick={() => setWholeWord((prev) => !prev)}
            title="全字匹配 (Alt+W)"
            className={`flex h-6 w-6 items-center justify-center rounded text-[10px] font-mono font-bold transition-all ${
              wholeWord
                ? 'bg-amber-500/25 text-amber-300 border border-amber-500/50'
                : 'text-white/40 hover:bg-white/10 hover:text-white border border-transparent'
            }`}
          >
            \b
          </button>

          {/* 选项：正则表达式 .* */}
          <button
            type="button"
            onClick={() => setIsRegex((prev) => !prev)}
            title="正则表达式 (Alt+R)"
            className={`flex h-6 w-6 items-center justify-center rounded text-[10px] font-mono font-bold transition-all ${
              isRegex
                ? 'bg-amber-500/25 text-amber-300 border border-amber-500/50'
                : 'text-white/40 hover:bg-white/10 hover:text-white border border-transparent'
            }`}
          >
            .*
          </button>

          <div className="h-4 w-[1px] bg-white/10 mx-0.5" />

          {/* 上一个匹配项 */}
          <button
            type="button"
            onClick={goToPrevMatch}
            disabled={totalMatches === 0}
            title="上一个匹配项 (Shift+Enter / Shift+F3)"
            className="flex h-6 w-6 items-center justify-center rounded text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-25 disabled:pointer-events-none transition-all"
          >
            <ChevronUp className="h-3.5 w-3.5" />
          </button>

          {/* 下一个匹配项 */}
          <button
            type="button"
            onClick={goToNextMatch}
            disabled={totalMatches === 0}
            title="下一个匹配项 (Enter / F3)"
            className="flex h-6 w-6 items-center justify-center rounded text-white/60 hover:bg-white/10 hover:text-white disabled:opacity-25 disabled:pointer-events-none transition-all"
          >
            <ChevronDown className="h-3.5 w-3.5" />
          </button>

          {/* 关闭查找栏 */}
          <button
            type="button"
            onClick={closeFind}
            title="关闭 (Escape)"
            className="flex h-6 w-6 items-center justify-center rounded text-white/40 hover:bg-white/10 hover:text-white transition-all ml-0.5"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* 可滚动预览内容容器 */}
      <div 
        ref={scrollContainerRef} 
        onScroll={handleScroll}
        onWheel={handleUserInteraction}
        onTouchMove={handleUserInteraction}
        onPointerDown={handleUserInteraction}
        className="h-full w-full overflow-auto px-8 pb-8 pt-px font-sans scrollbar-thin scrollbar-thumb-white/10 scrollbar-track-transparent"
      >
        <div ref={contentContainerRef} className="markdown-body max-w-4xl mx-auto">
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
              // 链接（区分外部 URL / 工作区相对链接 / 锚点）
              // 2026.08 修复：preview 中点击工作区内的 .md / 文件链接不再新开窗口，
              // 而是解析为工作区相对路径，并通过 ui:file:select 在当前窗口的编辑器中打开。
              a: ({ href, children }) => (
                <MarkdownLink href={href} filePath={filePath} workspaceRoot={workspaceRoot}>
                  {children}
                </MarkdownLink>
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

        /* CSS Custom Highlight API 高亮样式（原生渲染层绘制，零 DOM 侵入，完全避免破坏 React Virtual DOM 树） */
        ::highlight(md-search-match) {
          background-color: rgba(234, 179, 8, 0.45);
          color: #ffffff;
        }

        ::highlight(md-search-current) {
          background-color: #f59e0b;
          color: #000000;
        }
      `}</style>
    </div>
  );
};

// ── 链接渲染组件（区分外部 URL / 工作区相对链接 / 锚点） ──
// 2026.08 修复：preview 视图中点击工作区内的文件链接（如 docs/user/guide/python-sdk.md）时，
// 之前在 target=_blank 下新开窗口（裸相对路径甚至退化为 href="#"），
// 现改为解析为「相对于 workspaceRoot 的相对路径」，并通过 ui:file:select
// 事件在当前窗口的文件编辑器中打开；仅 http/https/mailto/tel 外部链接保持新窗口。

interface MarkdownLinkProps {
  href?: string;
  children?: React.ReactNode;
  filePath?: string;
  workspaceRoot?: string | null;
}

const MarkdownLink: React.FC<MarkdownLinkProps> = ({ href, children, filePath }) => {
  const raw = String(href || '').trim();
  const isExternal = /^(https?:|mailto:|tel:)/i.test(raw);

  const handleClick = (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (!raw || raw === '#') return;

    // 锚点：在当前预览内滚动定位（不再新开窗口）
    if (raw.startsWith('#')) {
      e.preventDefault();
      const id = raw.slice(1);
      if (id) {
        const target = document.getElementById(id);
        target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
      return;
    }

    // 工作区相对链接：解析路径 → 在当前窗口的编辑器中打开
    if (!isExternal) {
      e.preventDefault();
      const resolved = resolveWorkspaceRelativePath(raw, filePath);
      if (resolved) {
        console.log(`[MarkdownPreview] Opening workspace file from link: ${resolved}`);
        window.dispatchEvent(new CustomEvent('ui:file:select', { detail: resolved }));
      }
      return;
    }
    // 外部链接：保持默认行为（新窗口）
  };

  return (
    <a
      href={isExternal ? raw : raw.startsWith('#') ? raw : '#'}
      target={isExternal ? '_blank' : undefined}
      rel="noopener noreferrer nofollow"
      onClick={handleClick}
      className="text-white underline decoration-white/20 hover:decoration-white/60 transition-all"
    >
      {children}
    </a>
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

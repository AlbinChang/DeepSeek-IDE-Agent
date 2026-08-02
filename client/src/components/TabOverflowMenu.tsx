import React, { useEffect, useRef, useState } from 'react';
import {
  File, FileCode, FileJson, FileText, FileImage, FileArchive,
  Check, X,
} from 'lucide-react';
import { normalizeFilePath } from '@/utils/path';

interface TabOverflowMenuProps {
  /** 所有已打开文件的路径列表 */
  files: string[];
  /** 当前激活文件的索引 */
  activeIndex: number;
  /** 工作区根路径（用于展示相对路径） */
  workspaceRoot?: string | null;
  /** 选择某个文件（按索引） */
  onSelect: (index: number) => void;
  /** 关闭某个文件（按路径） */
  onClose: (filePath: string) => void;
  /** 关闭下拉菜单 */
  onDismiss: () => void;
}

/** 根据扩展名选择展示图标（与文件树视觉基调一致） */
const getFileIcon = (name: string) => {
  const lower = name.toLowerCase();
  if (/\.(md|markdown|txt|log|rtf|rst)$/.test(lower)) return FileText;
  if (/\.(json|ya?ml|toml|ini|conf|cfg|xml|env|lock|editorconfig)$/.test(lower)) return FileJson;
  if (/\.(png|jpe?g|gif|webp|bmp|svg|ico|avif)$/.test(lower)) return FileImage;
  if (/\.(zip|jar|war|ear|tar|gz|7z|rar)$/.test(lower)) return FileArchive;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|java|py|go|rs|c|cpp|h|hpp|cs|php|rb|kt|swift|sql|sh|bat|ps1|vue|svelte)$/.test(lower)) return FileCode;
  return File;
};

/**
 * 标签栏溢出展开菜单（对齐 VS Code 的 "..." 行为）
 * 当打开文件过多、Tab 无法全部展示时，允许用户从完整列表中快速选择/关闭文件。
 * 支持：鼠标悬停高亮、方向键 + Enter 键盘导航、Esc / 点击外部关闭。
 */
export const TabOverflowMenu: React.FC<TabOverflowMenuProps> = ({
  files,
  activeIndex,
  workspaceRoot,
  onSelect,
  onClose,
  onDismiss,
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const activeRowRef = useRef<HTMLDivElement | null>(null);
  const [highlightIndex, setHighlightIndex] = useState(activeIndex >= 0 ? activeIndex : 0);

  // 打开时自动滚动到当前激活文件所在行
  useEffect(() => {
    activeRowRef.current?.scrollIntoView({ block: 'nearest' });
  }, []);

  // 点击外部 / Esc 关闭 + 键盘导航
  useEffect(() => {
    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onDismiss();
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onDismiss();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        setHighlightIndex((i) => Math.min(i + 1, files.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        setHighlightIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        if (files[highlightIndex]) {
          onSelect(highlightIndex);
          onDismiss();
        }
      }
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [onDismiss, onSelect, files, highlightIndex]);

  return (
    <div
      ref={menuRef}
      role="listbox"
      aria-label="已打开的文件"
      data-testid="editor-tab-overflow-menu"
      className="absolute top-full right-0 z-50 mt-0.5 w-[300px] max-w-[85vw] bg-[#121212] border border-white/10 shadow-2xl py-1 text-white text-[10px] font-medium overflow-y-auto scrollbar-thin scrollbar-thumb-white/10"
      style={{ maxHeight: 'min(60vh, 440px)' }}
    >
      <div className="sticky top-0 z-10 px-3 py-1.5 bg-[#121212] border-b border-white/[0.06] text-[8px] font-black uppercase tracking-[0.25em] text-white/25 select-none">
        已打开文件 ({files.length})
      </div>
      {files.length === 0 && (
        <div className="px-3 py-4 text-center text-white/25 select-none">暂无打开的文件</div>
      )}
      {files.map((filePath, idx) => {
        const isActive = idx === activeIndex;
        const isHighlighted = idx === highlightIndex;
        const fileName = filePath.split(/[/\\]/).pop() || filePath;
        const relPath = normalizeFilePath(filePath, workspaceRoot) || filePath;
        const Icon = getFileIcon(fileName);
        return (
          <div
            key={filePath}
            ref={isActive ? activeRowRef : undefined}
            role="option"
            aria-selected={isActive}
            onClick={() => {
              onSelect(idx);
              onDismiss();
            }}
            onMouseEnter={() => setHighlightIndex(idx)}
            className={`flex items-center gap-2 px-3 py-1.5 cursor-pointer transition-colors select-none ${
              isActive ? 'bg-white/[0.07]' : isHighlighted ? 'bg-white/[0.04]' : ''
            }`}
            title={filePath}
          >
            <Icon size={11} className={`shrink-0 ${isActive ? 'text-white' : 'text-white/35'}`} />
            <span className="flex-1 min-w-0">
              <span className={`block truncate leading-tight ${isActive ? 'text-white' : 'text-white/70'}`}>
                {fileName}
              </span>
              <span className="block truncate leading-tight text-[8px] text-white/25">{relPath}</span>
            </span>
            {isActive && <Check size={10} className="shrink-0 text-white/80" />}
            <span
              onClick={(e) => {
                e.stopPropagation();
                onClose(filePath);
              }}
              className="flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-sm border border-transparent text-white/20 hover:border-white/10 hover:bg-white/10 hover:text-white/80 transition-colors"
              title="关闭 (Close)"
            >
              <X size={9} strokeWidth={2} />
            </span>
          </div>
        );
      })}
    </div>
  );
};

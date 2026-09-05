import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

export interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  children: React.ReactNode;
  className?: string;
  testId?: string;
}

export interface ContextMenuItemProps {
  icon?: React.ReactNode;
  label: React.ReactNode;
  shortcut?: string;
  danger?: boolean;
  disabled?: boolean;
  onClick: (e: React.MouseEvent) => void;
  testId?: string;
}

export const ContextMenuItem: React.FC<ContextMenuItemProps> = ({
  icon,
  label,
  shortcut,
  danger = false,
  disabled = false,
  onClick,
  testId,
}) => {
  return (
    <div
      role="menuitem"
      data-testid={testId}
      className={`px-3 py-1.5 flex items-center justify-between gap-3 select-none transition-colors text-[10.5px] font-medium ${
        disabled
          ? 'opacity-30 cursor-not-allowed'
          : danger
          ? 'text-red-400 hover:bg-red-500/20 active:bg-red-500/30 cursor-pointer'
          : 'text-white/85 hover:bg-white/10 active:bg-white/15 hover:text-white cursor-pointer'
      }`}
      onClick={(e) => {
        if (disabled) return;
        onClick(e);
      }}
    >
      <div className="flex items-center gap-2.5 truncate">
        {icon && (
          <span className={`flex-shrink-0 ${danger ? 'text-red-400' : 'text-white/50'}`}>
            {icon}
          </span>
        )}
        <span className="truncate">{label}</span>
      </div>
      {shortcut && (
        <span className="text-[9.5px] text-white/30 tracking-wider font-mono flex-shrink-0 ml-3">
          {shortcut}
        </span>
      )}
    </div>
  );
};

export const ContextMenuSeparator: React.FC = () => (
  <div className="border-t border-white/[0.08] my-1 mx-1" role="separator" />
);

/**
 * 具有智能自适应边界计算的全局右键菜单容器
 * 1. 采用 React Portal 挂载到 document.body，避免受父容器 overflow / transform 限制
 * 2. 挂载后通过 useLayoutEffect 同步精确测量 DOM 真实宽高
 * 3. 智能翻转（Flip）：当下侧或右侧空间不足时，自动向上 / 向左翻转弹出
 * 4. 极端窗口安全防护：配置 maxHeight 与 overflow-y，确保小屏幕下菜单项全量可滚、可点
 * 5. 全局生命周期治理：点击外部、按 Escape、滚动或窗口 resize 时自动关闭
 */
export const ContextMenu: React.FC<ContextMenuProps> = ({
  x,
  y,
  onClose,
  children,
  className = '',
  testId = 'context-menu',
}) => {
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [coords, setCoords] = useState<{ top: number; left: number; isReady: boolean }>({
    top: y,
    left: x,
    isReady: false,
  });

  // 测量真实 DOM 尺寸并自适应视口边界
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const winW = window.innerWidth;
    const winH = window.innerHeight;
    const PADDING = 8; // 安全边距

    let top = y;
    // 垂直方向检查：向下空间不足以容纳菜单高度时，智能翻转向上
    if (y + rect.height > winH - PADDING) {
      const flippedTop = y - rect.height;
      if (flippedTop >= PADDING) {
        top = flippedTop;
      } else {
        // 上下空间均紧迫时，贴底对齐并由 maxHeight/overflow-y 保护
        top = Math.max(PADDING, winH - rect.height - PADDING);
      }
    }

    let left = x;
    // 水平方向检查：向右空间不足以容纳菜单宽度时，智能翻转向左
    if (x + rect.width > winW - PADDING) {
      const flippedLeft = x - rect.width;
      if (flippedLeft >= PADDING) {
        left = flippedLeft;
      } else {
        left = Math.max(PADDING, winW - rect.width - PADDING);
      }
    }

    setCoords({
      top: Math.max(PADDING, Math.round(top)),
      left: Math.max(PADDING, Math.round(left)),
      isReady: true,
    });
  }, [x, y]);

  // 全局交互与关闭监听
  useEffect(() => {
    const handlePointerDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };

    const handleScroll = (e: Event) => {
      // 允许菜单自身内部滚动，只有外部容器滚动时才关闭菜单
      if (menuRef.current && menuRef.current.contains(e.target as Node)) {
        return;
      }
      onClose();
    };

    const handleBlur = () => {
      onClose();
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown, true);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', onClose);
    window.addEventListener('blur', handleBlur);

    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown, true);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', onClose);
      window.removeEventListener('blur', handleBlur);
    };
  }, [onClose]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      data-testid={testId}
      className={`fixed z-[9999] bg-[#141414]/95 backdrop-blur-md border border-white/10 rounded-md shadow-[0_12px_36px_rgba(0,0,0,0.65)] py-1 min-w-[180px] max-w-[280px] select-none overflow-y-auto scrollbar-thin scrollbar-thumb-white/15 ${className}`}
      style={{
        top: coords.top,
        left: coords.left,
        maxHeight: 'calc(100vh - 16px)',
        visibility: coords.isReady ? 'visible' : 'hidden',
        opacity: coords.isReady ? 1 : 0,
        transition: 'opacity 0.05s ease-out',
      }}
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        // 在菜单内部右键时避免被二次拦截或关闭
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      {children}
    </div>,
    document.body
  );
};

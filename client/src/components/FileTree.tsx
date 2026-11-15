import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Virtuoso } from 'react-virtuoso';
import { sortFileEntries } from '../../../server/src/utils/FileOrdering';
import { 
  File, Folder, ChevronRight, ChevronDown, 
  Loader2, Lock, FolderPlus, Compass, Copy, Trash2, AlertTriangle, Pencil, Clock, X, FolderOpen, Box, FilePlus
} from 'lucide-react';
import { switchWorkspace } from '@/services/WorkspaceSwitchService';
import { useAgentContext } from '@/providers/AgentContext';
import { GATEWAY_EVENT } from '@/config';
import { electronBridge } from '@/services/electron-bridge';
import { getRecentWorkspaces, removeRecentWorkspace, type RecentWorkspaceEntry } from '@/services/RecentWorkspaces';
import { ContextMenu, ContextMenuItem, ContextMenuSeparator } from '@/components/ContextMenu';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  isOpen?: boolean;
  lockedBy?: string | null;
  /** 若设置，表示此节点为 JAR/WAR/EAR 内部条目，值为宿主归档文件的真实路径 */
  jarBase?: string;
}

/** 判断文件名是否为支持的归档格式（JAR/WAR/EAR） */
const isArchiveFile = (fileName: string): boolean => {
  const lower = fileName.toLowerCase();
  return lower.endsWith('.jar') || lower.endsWith('.war') || lower.endsWith('.ear') || lower.endsWith('.zip');
};

/** 从 :: 路径中提取 JAR 内部路径 */
const extractJarInnerPath = (fullPath: string): string => {
  const idx = fullPath.indexOf('::');
  if (idx === -1) return '';
  let inner = fullPath.substring(idx + 2);
  // 去除尾部斜杠（目录条目）
  if (inner.endsWith('/')) inner = inner.slice(0, -1);
  return inner;
};

interface FileTreeProps {
  onFileSelect: (path: string) => void;
  activeFile: string;
  /** 侧边栏是否可见；隐藏时暂停轮询，避免后台刷新大仓库拖慢 Agent 事件流 */
  isVisible?: boolean;
}

const FILE_TREE_POLL_INTERVAL_MS = 15000;
const MAX_AUTO_REFRESH_PATHS = 25;
const AUTO_REFRESH_SKIP_SEGMENTS = new Set(['node_modules', '.git', 'dist', 'build', '.ide-agent']);

const shouldSkipAutoRefreshPath = (targetPath: string) => {
  const segments = targetPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments.some(segment => AUTO_REFRESH_SKIP_SEGMENTS.has(segment));
};

/** 目录优先；同组按自然名称顺序排列，包含中文章序号。 */
const sortFileNodes = (nodes: FileNode[]): FileNode[] => sortFileEntries(nodes);

const normalizePathForCompare = (value: string): string =>
  value.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

/** 按归一化路径查找已加载节点（跨 Windows/Unix 分隔符）。 */
const findNodeByNormalizedPath = (nodes: FileNode[], targetPath: string): FileNode | null => {
  const target = normalizePathForCompare(targetPath);
  for (const node of nodes) {
    if (normalizePathForCompare(node.path) === target) return node;
    if (node.children) {
      const found = findNodeByNormalizedPath(node.children, targetPath);
      if (found) return found;
    }
  }
  return null;
};

/** 只比较文件树结构字段；内容/展开状态变化不影响相等性。 */
const areNodeListsEqual = (left: FileNode[], right: FileNode[]): boolean => {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index++) {
    const a = left[index];
    const b = right[index];
    if (a.path !== b.path || a.name !== b.name || a.isDirectory !== b.isDirectory) return false;
  }
  return true;
};

export const FileTree: React.FC<FileTreeProps> = ({ onFileSelect, activeFile, isVisible = true }) => {
  const { workspaceRoot, setWorkspaceRoot } = useAgentContext();
  const [nodes, setNodes] = useState<FileNode[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isSwitchingWorkspace, setIsSwitchingWorkspace] = useState(false);
  const [isInitModalOpen, setIsInitModalOpen] = useState(false);
  const [initPathInput, setInitPathInput] = useState('');
  const [initError, setInitError] = useState<string | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; node: FileNode } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<{ node: FileNode } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<FileNode | null>(null);
  const [renameInput, setRenameInput] = useState('');
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);
  const [, setRecentWorkspaces] = useState<RecentWorkspaceEntry[]>([]);
  const pollInFlightRef = useRef(false);
  const pollAbortRef = useRef<AbortController | null>(null);
  /** 当前节点树的镜像引用（供 UI 事件回调读取最新展开状态，避免闭包过期） */
  const nodesRef = useRef<FileNode[]>([]);
  /** 各目录最近一次已知版本；命中时 file:list 只返回 unchanged，避免重复传输/重渲染 */
  const directoryVersionsRef = useRef<Map<string, string>>(new Map());
  /** 同目录刷新节流，避免轮询与 Agent 事件同时触发重复 IPC */
  const refreshStartedAtRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    nodesRef.current = nodes;
  }, [nodes]);

  // ── 新建文件/文件夹状态 ──
  const [newItem, setNewItem] = useState<{ type: 'file' | 'folder'; parentPath: string } | null>(null);
  const [newItemName, setNewItemName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  /** 空白区域右键菜单（仅含新建文件/文件夹） */
  const [emptyMenu, setEmptyMenu] = useState<{ x: number; y: number } | null>(null);

  // ── 拖拽移动状态 ──
  const [dragNodePath, setDragNodePath] = useState<string | null>(null);
  const [dragOverPath, setDragOverPath] = useState<string | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const dragCounterRef = useRef<Map<string, number>>(new Map()); // 处理嵌套元素的 dragenter/dragleave 冒泡

  const renderGlobalOverlay = (node: React.ReactNode) => {
    if (typeof document === 'undefined') return null;
    return createPortal(node, document.body);
  };

  useEffect(() => {
    const closeContextMenu = () => {
      setContextMenu(null);
      setEmptyMenu(null);
    };
    window.addEventListener('click', closeContextMenu);
    return () => window.removeEventListener('click', closeContextMenu);
  }, []);

  const handleContextMenu = (e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    setEmptyMenu(null);
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  };

  const handleDelete = async (node: FileNode) => {
    if (!workspaceRoot) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      const result = await electronBridge.deleteFile({ filePath: node.path, root: workspaceRoot });
      if (!result.success) throw new Error(result.error || 'Delete failed');
      setDeleteConfirm(null);
      // 如果删除的是当前激活文件，通知父组件清空编辑器
      if (!node.isDirectory && activeFile === node.path) {
        onFileSelect('');
      }
      // 刷新目录树
      refreshPath('.', false, true);
    } catch (e: any) {
      setDeleteError(e?.message || '删除失败');
    } finally {
      setIsDeleting(false);
    }
  };

  const handleRename = async () => {
    if (!workspaceRoot || !renameTarget || !renameInput.trim()) return;
    const trimmedName = renameInput.trim();
    // 名称未变更则直接关闭
    if (trimmedName === renameTarget.name) {
      setRenameTarget(null);
      setRenameInput('');
      return;
    }
    setIsRenaming(true);
    setRenameError(null);
    try {
      const parentDir = renameTarget.path.replace(/[/\\][^/\\]*$/, '');
      const fullNewPath = parentDir + '/' + trimmedName;
      const result = await electronBridge.renameFile({ oldPath: renameTarget.path, newPath: fullNewPath, root: workspaceRoot });
      if (!result.success) throw new Error(result.error || 'Rename failed');
      const newPath = result.newPath || fullNewPath;
      if (activeFile === renameTarget.path) {
        onFileSelect(newPath);
      }
      setRenameTarget(null);
      setRenameInput('');
      // 刷新目录树
      refreshPath('.', false, true);
    } catch (e: any) {
      setRenameError(e?.message || '重命名失败');
    } finally {
      setIsRenaming(false);
    }
  };

  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      // Optional: could show a brief toast/notification here
    } catch (err) {
      console.error('Failed to copy', err);
    }
  };

  // ── 新建文件/文件夹 (2026.08 新建文本文件功能) ──

  /** 计算节点所属的父目录路径（'.' 表示工作区根目录） */
  const getParentDirPath = (node: FileNode): string => {
    if (node.isDirectory) return node.path;
    return node.path.replace(/[/\\][^/\\]*$/, '') || '.';
  };

  /** 在指定目录下启动"新建"内联输入（对齐 VS Code 资源管理器行为） */
  const startNewItem = (type: 'file' | 'folder', parentPath: string) => {
    if (!workspaceRoot) return;
    setNewItem({ type, parentPath });
    setNewItemName('');
    setCreateError(null);
    // 目标为子目录时确保其展开，让内联输入行可见
    if (parentPath !== '.') {
      const parentNode = findNodeByPath(nodes, parentPath);
      if (parentNode && parentNode.isDirectory && !parentNode.isOpen) {
        toggleFolder(parentNode);
      }
    }
  };

  /** 执行新建文件/文件夹 */
  const handleCreateNewItem = async () => {
    if (!workspaceRoot || !newItem) return;
    const name = newItemName.trim();
    if (!name) {
      setCreateError('请输入名称');
      return;
    }
    if (/[\\/]/.test(name)) {
      setCreateError('名称不能包含路径分隔符 (\\ 或 /)');
      return;
    }
    if (/[\\/:*?"<>|]/.test(name)) {
      setCreateError('名称包含非法字符');
      return;
    }
    setIsCreating(true);
    setCreateError(null);
    try {
      const parentDir = newItem.parentPath === '.' ? '' : newItem.parentPath;
      const targetPath = parentDir ? `${parentDir}/${name}` : name;
      const result = await electronBridge.createFile({ filePath: targetPath, type: newItem.type, root: workspaceRoot });
      if (!result.success) throw new Error(result.error || '创建失败');
      // 刷新目录树
      refreshPath(parentDir || '.', false, true);
      // 文件创建成功后直接打开编辑器
      if (newItem.type === 'file') {
        onFileSelect(targetPath);
      }
      setNewItem(null);
      setNewItemName('');
    } catch (e: any) {
      setCreateError(e?.message || '创建失败');
    } finally {
      setIsCreating(false);
    }
  };

  /** 渲染新建内联输入行 */
  const renderNewItemInput = (depth: number) => {
    if (!newItem) return null;
    const isFolder = newItem.type === 'folder';
    return (
      <div
        style={{ paddingLeft: `${depth * 10 + 6}px` }}
        className="flex items-center gap-1.5 py-0.5 px-2 bg-[#3B82F6]/10 border-l border-[#3B82F6]/40"
      >
        {isFolder ? (
          <Folder size={11} className="text-[#3B82F6] shrink-0" />
        ) : (
          <File size={10} className="text-[#3B82F6] shrink-0" />
        )}
        <input
          autoFocus
          type="text"
          value={newItemName}
          onChange={(e) => {
            setNewItemName(e.target.value);
            setCreateError(null);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              handleCreateNewItem();
            } else if (e.key === 'Escape') {
              setNewItem(null);
              setNewItemName('');
              setCreateError(null);
            }
          }}
          disabled={isCreating}
          className="bg-transparent outline-none text-[10px] text-white w-full min-w-0 placeholder-white/25"
          placeholder={isFolder ? '新文件夹名称' : '新文件名 (如 notes.txt)'}
        />
        {isCreating && <Loader2 size={10} className="animate-spin text-[#3B82F6] shrink-0" />}
        {createError && (
          <span className="text-[9px] text-red-400 whitespace-nowrap" title={createError}>{createError}</span>
        )}
      </div>
    );
  };

  // ── 拖拽移动处理 ──

  /** 判断 targetPath 是否是 sourcePath 的子路径（防止将文件夹拖入自身或子文件夹） */
  const isDescendantOf = (sourcePath: string, targetPath: string): boolean => {
    const normalizedSource = sourcePath.replace(/\\/g, '/').replace(/\/$/, '');
    const normalizedTarget = targetPath.replace(/\\/g, '/').replace(/\/$/, '');
    if (normalizedSource === normalizedTarget) return true;
    return normalizedTarget.startsWith(normalizedSource + '/');
  };

  const handleDragStart = (e: React.DragEvent, node: FileNode) => {
    // JAR 内部条目不可拖拽
    if (isMoving || node.jarBase) return;
    e.dataTransfer.setData('text/plain', node.path);
    e.dataTransfer.effectAllowed = 'move';
    setDragNodePath(node.path);
    // 延迟设置拖拽样式，让浏览器捕获拖拽图像
    requestAnimationFrame(() => {
      const el = e.currentTarget as HTMLElement;
      el.style.opacity = '0.4';
    });
  };

  const handleDragEnd = (e: React.DragEvent) => {
    setDragNodePath(null);
    setDragOverPath(null);
    dragCounterRef.current.clear();
    // 恢复透明度
    const el = e.currentTarget as HTMLElement;
    el.style.opacity = '';
  };

  const handleDragOver = (e: React.DragEvent, node: FileNode) => {
    // JAR 内部目录不可作为拖放目标
    if (!node.isDirectory || node.jarBase) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';

    if (dragOverPath !== node.path) {
      setDragOverPath(node.path);
    }
  };

  const handleDragEnter = (e: React.DragEvent, node: FileNode) => {
    // JAR 内部目录不可作为拖放目标
    if (!node.isDirectory || node.jarBase) return;
    e.preventDefault();
    e.stopPropagation();
    // 使用计数器处理嵌套元素冒泡
    const count = (dragCounterRef.current.get(node.path) || 0) + 1;
    dragCounterRef.current.set(node.path, count);
    if (dragOverPath !== node.path) {
      setDragOverPath(node.path);
    }
  };

  const handleDragLeave = (e: React.DragEvent, node: FileNode) => {
    // JAR 内部目录不可作为拖放目标
    if (!node.isDirectory || node.jarBase) return;
    e.preventDefault();
    e.stopPropagation();
    const count = (dragCounterRef.current.get(node.path) || 1) - 1;
    dragCounterRef.current.set(node.path, count);
    if (count <= 0) {
      dragCounterRef.current.delete(node.path);
      if (dragOverPath === node.path) {
        setDragOverPath(null);
      }
    }
  };

  const handleDrop = async (e: React.DragEvent, targetNode: FileNode) => {
    e.preventDefault();
    e.stopPropagation();

    const sourcePath = e.dataTransfer.getData('text/plain');
    if (!sourcePath || !targetNode.isDirectory || !workspaceRoot) {
      setDragNodePath(null);
      setDragOverPath(null);
      dragCounterRef.current.clear();
      return;
    }

    // 不允许拖入自身或自身的子目录 / JAR 内部目录
    if (isDescendantOf(sourcePath, targetNode.path) || targetNode.jarBase) {
      console.warn('[FileTree] Cannot move into itself or a child directory');
      setDragNodePath(null);
      setDragOverPath(null);
      dragCounterRef.current.clear();
      return;
    }

    // 提取源文件名
    const sourceName = sourcePath.replace(/\\/g, '/').split('/').pop() || '';
    const newPath = targetNode.path.replace(/\\/g, '/').replace(/\/$/, '') + '/' + sourceName;

    // 目标已存在同名文件/目录
    const targetChildren = targetNode.children;
    if (targetChildren && targetChildren.some(c => c.name === sourceName)) {
      console.warn(`[FileTree] Target directory already contains "${sourceName}"`);
      setDragNodePath(null);
      setDragOverPath(null);
      dragCounterRef.current.clear();
      return;
    }

    setIsMoving(true);
    setDragNodePath(null);
    setDragOverPath(null);
    dragCounterRef.current.clear();

    try {
      const result = await electronBridge.renameFile({ oldPath: sourcePath, newPath, root: workspaceRoot });
      if (!result.success) throw new Error(result.error || 'Move failed');

      // 如果移动的是当前激活文件，更新路径
      if (activeFile === sourcePath) {
        onFileSelect(newPath);
      }

      // 刷新目录树
      refreshPath('.', false, true);
    } catch (e: any) {
      console.error('[FileTree] Move failed:', e);
    } finally {
      setIsMoving(false);
    }
  };

  const lastWorkspaceRef = useRef<string | null>(null);

  useEffect(() => {
    const workspaceChanged = lastWorkspaceRef.current !== workspaceRoot;
    lastWorkspaceRef.current = workspaceRoot;

    if (workspaceChanged) {
      directoryVersionsRef.current.clear();
      refreshStartedAtRef.current.clear();
      setNodes([]);
    }

    const collectOpenPaths = (): string[] => {
      const openPaths: string[] = [];
      const walk = (list: FileNode[]) => {
        for (const node of list) {
          if (openPaths.length >= MAX_AUTO_REFRESH_PATHS) return;
          if (node.jarBase) continue;
          if (node.isDirectory && node.isOpen && !shouldSkipAutoRefreshPath(node.path)) {
            openPaths.push(node.path);
          }
          if (node.children) walk(node.children);
        }
      };
      walk(nodesRef.current);
      return openPaths;
    };

    const refreshOpenPaths = (silent = true, force = false) => {
      for (const p of collectOpenPaths()) {
        void refreshPath(p, silent, force);
      }
    };

    // 对齐 36.1 节：共享单次 system-events 连接 (Section 15.0 Hot Reattach)
    // 不再单独开启 fs-watcher 连接，通过 UI 事件总线监听 App.tsx 已建立的信道，降低连接并发数 (Limit 6)
    const handleWsMessage = (e: any) => {
        const msg = e.detail;
        if (!msg) return;

        if (msg.type === 'system:ready' || msg.type === 'system:standby') {
            console.log(`[FileTree] Received ${msg.type}:`, msg.payload);
            // 对齐 3.4 节：后端是系统状态的唯一可信源 (Session Truth)
            if (msg.payload && msg.payload.initialized && msg.payload.workspaceRoot) {
                if (msg.payload.workspaceRoot !== workspaceRoot) {
                    setWorkspaceRoot(msg.payload.workspaceRoot);
                }
            } else if (msg.payload && !msg.payload.initialized) {
                // 对齐 3.4 节：后端处于就绪等待或显式清除状态
                if (workspaceRoot) {
                    console.log('[FileTree] Backend session cleared. Resetting UI to locked state.');
                    setWorkspaceRoot(null);
                    setNodes([]);
                }
            }
        }
    };

    const onRefreshRequest = () => {
      // 侧边栏隐藏时不做无意义的大仓库扫描；重新可见时会补一次刷新。
      if (!isVisible) return;
      void refreshPath('.', false, true);
      refreshOpenPaths(true, true);
    };

    const onFileChanged = (event: Event) => {
      if (!isVisible || !workspaceRoot) return;
      const detail = (event as CustomEvent).detail || {};
      const rawPath = typeof detail.path === 'string' ? detail.path : '';
      if (!rawPath) return;

      const absPath = typeof detail.absolutePath === 'string' ? detail.absolutePath : rawPath;
      const normalizedAbs = absPath.replace(/\\/g, '/');
      const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
      const relativePath = normalizedAbs.toLowerCase().startsWith(normalizedRoot.toLowerCase())
        ? normalizedAbs.slice(normalizedRoot.length).replace(/^\/+/, '')
        : rawPath.replace(/\\/g, '/').replace(/^\.\//, '');
      if (!relativePath) return;

      const parentPath = relativePath.includes('/')
        ? relativePath.slice(0, relativePath.lastIndexOf('/'))
        : '.';
      const absoluteParent = parentPath === '.'
        ? workspaceRoot
        : `${workspaceRoot.replace(/[\\/]+$/, '')}/${parentPath}`;
      if (parentPath === '.' || findNodeByNormalizedPath(nodesRef.current, absoluteParent)) {
        void refreshPath(parentPath, true);
      }
      if (detail.isDirectory && findNodeByNormalizedPath(nodesRef.current, relativePath)) {
        void refreshPath(relativePath, true);
      }
    };

    window.addEventListener(GATEWAY_EVENT, handleWsMessage);
    window.addEventListener('ui:file-tree:refresh', onRefreshRequest);
    window.addEventListener('ui:file:changed', onFileChanged);

    if (isVisible && (workspaceChanged || nodesRef.current.length === 0)) {
      void refreshPath('.');
    } else if (isVisible) {
      // 从搜索/源码管理等视图切回：用版本增量刷新已展开目录，而不是重新走一遍全量加载。
      void refreshPath('.', false, true);
      refreshOpenPaths(true, true);
    }

    // 轻量轮询作为兜底同步：串行执行、限制路径数，避免大目录/慢接口导致请求堆积和浏览器 OOM。
    // 15s + 版本命中时只 stat 目录，不再每 5s 重传/重渲染整棵树。
    const pollInterval = setInterval(() => {
      if (!workspaceRoot || !isVisible || document.visibilityState === 'hidden' || pollInFlightRef.current) return;

      const pathsToRefresh = ['.', ...collectOpenPaths()].slice(0, MAX_AUTO_REFRESH_PATHS);
      pollInFlightRef.current = true;
      pollAbortRef.current?.abort();
      const controller = new AbortController();
      pollAbortRef.current = controller;

      Promise.all(pathsToRefresh.map(async (p) => {
        try {
          const knownVersion = directoryVersionsRef.current.get(p);
          const result = await electronBridge.listFiles({
            dirPath: p,
            depth: 1,
            root: workspaceRoot,
            knownVersion,
          });
          if (result.success === false) return null;
          if (result.unchanged) return { path: p, unchanged: true as const };
          if (!Array.isArray(result.files)) return { path: p, unchanged: true as const };
          if (typeof result.version === 'string') {
            directoryVersionsRef.current.set(p, result.version);
          }
          const children = result.files.map((f: any) => ({
            name: f.name,
            path: f.path,
            isDirectory: f.isDirectory || f.type === 'directory',
          }));
          return { path: p, unchanged: false as const, children };
        } catch {
          return null;
        }
      })).then(results => {
        if (controller.signal.aborted) return;
        const changedResults = results.filter(
          (res): res is { path: string; unchanged: false; children: FileNode[] } =>
            !!res && res.unchanged === false,
        );
        if (changedResults.length === 0) return;

        setNodes(oldTree => {
          let nextTree = oldTree;
          // 【性能优化】预构建 path → node 索引，O(N) 一次构建，后续 O(1) 定位
          const nodeIndex = new Map<string, FileNode>();
          const buildIndex = (nodes: FileNode[]) => {
            for (const n of nodes) {
              nodeIndex.set(n.path, n);
              if (n.children) buildIndex(n.children);
            }
          };
          buildIndex(oldTree);

          for (const res of changedResults) {
            if (res.path === '.') {
              const merged = mergeNodes(nextTree, res.children);
              if (merged !== nextTree) nextTree = merged;
              continue;
            }
            const target = nodeIndex.get(res.path);
            if (!target) continue;
            const merged = mergeNodes(target.children || [], res.children);
            if (merged === target.children) continue;
            target.children = merged;
            // 触发 React 重渲染：只浅拷贝根链，保持其他节点引用稳定
            nextTree = nextTree === oldTree ? [...oldTree] : nextTree;
          }
          return nextTree;
        });
      }).finally(() => {
        if (pollAbortRef.current === controller) {
          pollAbortRef.current = null;
        }
        pollInFlightRef.current = false;
      });
    }, FILE_TREE_POLL_INTERVAL_MS);

    return () => {
        window.removeEventListener(GATEWAY_EVENT, handleWsMessage);
        window.removeEventListener('ui:file-tree:refresh', onRefreshRequest);
        window.removeEventListener('ui:file:changed', onFileChanged);
        pollAbortRef.current?.abort();
        pollAbortRef.current = null;
        pollInFlightRef.current = false;
        clearInterval(pollInterval);
    };
  }, [workspaceRoot, setWorkspaceRoot, isVisible]);

  const initWorkspace = async (path: string, forceRebind = false) => {
    if (isSwitchingWorkspace) return;
    const trimmedPath = path.trim();
    if (!trimmedPath) return;

    setIsLoading(true);
    setIsSwitchingWorkspace(true);
    setInitError(null);
    try {
        const result = await switchWorkspace(trimmedPath, workspaceRoot, { forceRebind });
        if (result.status === 'success') {
            setWorkspaceRoot(result.workspaceRoot);
            setIsInitModalOpen(false);
            setInitError(null);
            refreshPath('.', false, true);
        } else {
            // 对齐 3.4 节：失败时回退至锁定状态
            setWorkspaceRoot(null);
            setNodes([]);
        }
    } catch (e: any) {
        console.error('Failed to init workspace:', e);
        // 对齐 3.4 节：失败时回退至锁定状态，确保系统安全
        setWorkspaceRoot(null);
        setNodes([]);
        
        let errorMsg = e?.message || '未知错误';
        
        if (e.message === 'Network Error') {
          errorMsg = `工作区初始化失败：${e.message}。请确认工作区路径有效且可访问。`;
        }
        
        setInitError(errorMsg);
    } finally {
      setIsSwitchingWorkspace(false);
        setIsLoading(false);
    }
  };

  const refreshPath = async (parentPath: string, silent = false, force = false) => {
    if (!workspaceRoot) return;

    // 轮询与 Agent 事件可能在短时间内重复请求同一目录；非强制刷新时节流避免重复 IPC。
    const now = Date.now();
    const lastStartedAt = refreshStartedAtRef.current.get(parentPath) ?? 0;
    if (!force && now - lastStartedAt < 300) return;
    refreshStartedAtRef.current.set(parentPath, now);

    if (!silent && parentPath === '.') setIsLoading(true);
    try {
      const knownVersion = directoryVersionsRef.current.get(parentPath);
      const result = await electronBridge.listFiles({
        dirPath: parentPath,
        depth: 1,
        root: workspaceRoot,
        knownVersion,
      });
      if (result.success === false) throw new Error(result.error || 'List files failed');
      // 目录版本未变化：不重新传文件列表、不 setState，避免整棵树重渲染。
      if (result.unchanged) return;
      if (!Array.isArray(result.files)) return;
      if (typeof result.version === 'string') {
        directoryVersionsRef.current.set(parentPath, result.version);
      }

      const filesData = result.files.map((f: any) => ({
        name: f.name,
        path: f.path,
        isDirectory: f.isDirectory || f.type === 'directory',
      }));

      setNodes(prev => {
        if (parentPath === '.') {
          return mergeNodes(prev, filesData);
        }
        const target = findNodeInMutableTree(prev, parentPath);
        if (!target) return prev;
        const nextChildren = sortFileNodes(filesData);
        if (areNodeListsEqual(target.children || [], nextChildren)) return prev;
        target.children = nextChildren;
        // 只浅拷贝根数组触发渲染；未变化节点保持引用稳定，配合 memo 避免全树重绘。
        return [...prev];
      });
    } catch (error: any) {
      console.error(`Failed to refresh path ${parentPath}:`, error);
      if (parentPath === '.') {
          // 如果根目录加载失败，强制回退至锁定状态
          setWorkspaceRoot(null);
          setNodes([]);
          const errorMsg = error?.message || '未知错误';
          console.error(`Root directory load failed: ${errorMsg}`);
      }
    } finally {
      if (!silent) setIsLoading(false);
    }
  };

  const findNodeInMutableTree = (nodes: FileNode[], path: string): FileNode | null => {
    for (const node of nodes) {
      if (node.path === path) return node;
      if (node.children) {
        const found = findNodeInMutableTree(node.children, path);
        if (found) return found;
      }
    }
    return null;
  };

  const mergeNodes = (oldNodes: FileNode[], newNodes: FileNode[]): FileNode[] => {
    // 【性能优化】预构建 path → oldNode 的映射，O(N+M) 替代原 O(N×M) 的 find() 扫描
    const oldNodeByPath = new Map<string, FileNode>();
    for (const o of oldNodes) {
      oldNodeByPath.set(o.path, o);
    }

    let changed = oldNodes.length !== newNodes.length;
    const merged = newNodes.map((newNode, index) => {
      const oldNode = oldNodeByPath.get(newNode.path);
      if (!oldNode) {
        changed = true;
        return newNode;
      }
      if (oldNode.name !== newNode.name || oldNode.isDirectory !== newNode.isDirectory) {
        changed = true;
      }
      if (oldNodes[index]?.path !== newNode.path) {
        changed = true;
      }
      const sameStructure = oldNode.name === newNode.name && oldNode.isDirectory === newNode.isDirectory;
      // 结构未变化时复用旧节点引用（保留 isOpen/children，并避免整棵子树重渲染）。
      const next = sameStructure ? oldNode : { ...oldNode, ...newNode };
      if (next.isOpen && oldNode.children) {
        next.children = oldNode.children;
      }
      return next;
    });

    // 完全未变化时返回原数组引用，React 会跳过状态更新。
    if (!changed) return oldNodes;
    return sortFileNodes(merged);
  };

  const toggleFolder = async (node: FileNode) => {
    // ── JAR/WAR/EAR 归档文件：视为虚拟目录展开 ──
    const isArchive = isArchiveFile(node.name);

    if (!node.isDirectory && !isArchive) {
      onFileSelect(node.path);
      return;
    }

    const isNowOpen = !node.isOpen;

    setNodes(currentNodes => {
      const updateNode = (nodes: FileNode[]): FileNode[] => {
        let changed = false;
        const next = nodes.map(n => {
          if (n.path === node.path) {
            changed = true;
            return { ...n, isOpen: isNowOpen };
          }
          if (n.children) {
            const nextChildren = updateNode(n.children);
            if (nextChildren !== n.children) {
              changed = true;
              return { ...n, children: nextChildren };
            }
          }
          return n;
        });
        return changed ? next : nodes;
      };
      return updateNode(currentNodes);
    });

    // 修复「Agent 创建文件/目录后目录树不更新」问题：
    // 普通目录每次展开都强制重新拉取子项（此前仅在没有缓存子项时才拉取，
    // 导致 docs/ 目录已缓存子项时，Agent 新建的 docs/images 无法出现在目录树中）；
    // JAR/WAR/EAR 归档内部内容在运行期不变，保留「仅首次展开拉取」策略。
    const needsChildrenFetch =
      isNowOpen && ((node.jarBase || isArchive) ? (!node.children || node.children.length === 0) : true);
    if (needsChildrenFetch) {
      try {
        if (!workspaceRoot) {
          return;
        }
        let childData: any[];

        if (node.jarBase || isArchive) {
          // ── 归档文件内部目录（JAR/WAR/EAR/ZIP） ──
          const jarPath = node.jarBase || node.path;
          const innerPath = node.jarBase ? extractJarInnerPath(node.path) : '';
          const result = await electronBridge.listJarContents({ jarPath, innerPath, root: workspaceRoot });
          if (!result.success) throw new Error(result.error || 'Failed to list archive contents');
          childData = (result.files || []).map((f: any) => ({
            name: f.name,
            path: f.path,
            isDirectory: f.isDirectory || f.type === 'directory',
            jarBase: node.jarBase || node.path,
          }));
        } else {
          // ── 普通文件系统目录 ──
          const result = await electronBridge.listFiles({ dirPath: node.path, depth: 1, root: workspaceRoot });
          if (!result.success) throw new Error(result.error || 'Toggle failed');
          if (typeof result.version === 'string') {
            directoryVersionsRef.current.set(node.path, result.version);
          }
          childData = (result.files || []).map((f: any) => ({
            name: f.name, path: f.path,
            isDirectory: f.isDirectory || f.type === 'directory',
          }));
        }
        
        const sortedChildData = sortFileNodes(childData);
        setNodes(currentNodes => {
          const updateChildren = (nodes: FileNode[]): FileNode[] => {
            let changed = false;
            const next = nodes.map(n => {
              if (n.path === node.path) {
                changed = true;
                return { ...n, children: sortedChildData };
              }
              if (n.children) {
                const nextChildren = updateChildren(n.children);
                if (nextChildren !== n.children) {
                  changed = true;
                  return { ...n, children: nextChildren };
                }
              }
              return n;
            });
            return changed ? next : nodes;
          };
          return updateChildren(currentNodes);
        });
      } catch (e) {
        console.error(e);
        setNodes(currentNodes => {
          const revert = (nodes: FileNode[]): FileNode[] => {
            let changed = false;
            const next = nodes.map(n => {
              if (n.path === node.path) {
                changed = true;
                return { ...n, isOpen: false };
              }
              if (n.children) {
                const nextChildren = revert(n.children);
                if (nextChildren !== n.children) {
                  changed = true;
                  return { ...n, children: nextChildren };
                }
              }
              return n;
            });
            return changed ? next : nodes;
          };
          return revert(currentNodes);
        });
      }
    }
  };

  const findNodeByPath = (nodes: FileNode[], path: string): FileNode | null => {
    for (const node of nodes) {
      if (node.path === path) return node;
      if (node.children) {
        const found = findNodeByPath(node.children, path);
        if (found) return found;
      }
    }
    return null;
  };

  const renderNodeRow = (node: FileNode, depth: number = 0) => {
    const isActive = activeFile === node.path;
    const isDragging = dragNodePath === node.path;
    const isDragOver = dragOverPath === node.path && node.isDirectory;
    const isDropTarget = node.isDirectory && dragNodePath && !isDescendantOf(dragNodePath, node.path) && !isMoving;

    return (
      <div
        draggable
        onClick={() => toggleFolder(node)}
        onContextMenu={(e) => handleContextMenu(e, node)}
        onDragStart={(e) => handleDragStart(e, node)}
        onDragEnd={handleDragEnd}
        onDragOver={(e) => isDropTarget ? handleDragOver(e, node) : e.preventDefault()}
        onDragEnter={(e) => isDropTarget ? handleDragEnter(e, node) : undefined}
        onDragLeave={(e) => isDropTarget ? handleDragLeave(e, node) : undefined}
        onDrop={(e) => isDropTarget ? handleDrop(e, node) : undefined}
        data-testid={`file-node-${node.path}`}
        style={{ paddingLeft: `${depth * 10 + 6}px` }}
        className={`flex items-center gap-1.5 py-0.5 px-2 cursor-pointer transition-all duration-150 group ${
          isActive ? 'bg-white/10 text-white font-black' : 'hover:bg-white/5 text-white'
        } ${isDragOver ? 'bg-[#3B82F6]/20 ring-1 ring-[#3B82F6]/50' : ''} ${
          isDragging ? 'opacity-40' : ''
        }`}
      >
        <div className="flex items-center gap-1.5 min-w-0 flex-1">
          {node.isDirectory || isArchiveFile(node.name) ? (
            <>
              {(node.isDirectory || isArchiveFile(node.name)) && (
                node.isOpen ? <ChevronDown size={11} /> : <ChevronRight size={11} />
              )}
              {isArchiveFile(node.name) && !node.jarBase ? (
                <span title="归档文件 (JAR/WAR/EAR/ZIP)">
                  <Box size={11} className={`${node.isOpen ? 'text-amber-400' : 'text-amber-400/60 group-hover:text-amber-400'} shrink-0`} />
                </span>
              ) : (
                <Folder size={11} className={`${node.isOpen ? 'text-white' : 'text-white opacity-20 group-hover:opacity-100'} shrink-0 ${isDragOver ? 'text-[#3B82F6] opacity-100' : ''}`} />
              )}
            </>
          ) : (
            <>
              <File size={10} className={`${isActive ? 'text-white' : 'text-white opacity-20 group-hover:opacity-100'} shrink-0 ${node.jarBase ? 'text-amber-400/50' : ''}`} />
            </>
          )}
          <span className={`text-[10px] truncate tracking-tighter ${isActive ? 'translate-x-0.5 transition-transform' : 'opacity-40 group-hover:opacity-100'} ${isDragOver ? 'text-[#3B82F6] opacity-100' : ''}`}>
            {node.name}
          </span>
        </div>
      </div>
    );
  };

  // 将树扁平化为可见行，交给 Virtuoso 虚拟滚动：
  // 大仓库展开上万个节点时只渲染视口附近的行，避免整棵树 DOM/重排卡死 UI。
  type FileTreeRow =
    | { kind: 'node'; node: FileNode; depth: number }
    | { kind: 'new-item'; depth: number };

  const visibleRows = React.useMemo<FileTreeRow[]>(() => {
    const rows: FileTreeRow[] = [];
    const walk = (list: FileNode[], depth: number) => {
      for (const node of list) {
        rows.push({ kind: 'node', node, depth });
        if ((node.isDirectory || isArchiveFile(node.name)) && node.isOpen) {
          if (node.children) walk(node.children, depth + 1);
          if (newItem && newItem.parentPath === node.path && !node.jarBase) {
            rows.push({ kind: 'new-item', depth: depth + 1 });
          }
        }
      }
    };
    walk(nodes, 0);
    if (newItem && newItem.parentPath === '.') {
      rows.push({ kind: 'new-item', depth: 0 });
    }
    return rows;
  }, [nodes, newItem]);

  return (
    <div className="flex flex-col h-full bg-[#000000]" data-testid="file-tree-container">
      {/* Context Menu */}
      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          testId="file-tree-context-menu"
        >
          <ContextMenuItem
            icon={<Copy size={12} />}
            label="复制相对路径 (Relative)"
            onClick={() => {
              const relativePath = contextMenu.node.path.slice(workspaceRoot?.length || 0).replace(/^[\\\/]/, '');
              copyToClipboard(relativePath);
              setContextMenu(null);
            }}
          />
          <ContextMenuItem
            icon={<Copy size={12} />}
            label="复制绝对路径 (Absolute)"
            onClick={() => {
              copyToClipboard(contextMenu.node.path);
              setContextMenu(null);
            }}
          />
          {!contextMenu.node.jarBase && <ContextMenuSeparator />}
          {!contextMenu.node.jarBase && (
            <ContextMenuItem
              icon={<FilePlus size={12} />}
              label="新建文件"
              onClick={() => {
                startNewItem('file', getParentDirPath(contextMenu.node));
                setContextMenu(null);
              }}
            />
          )}
          {!contextMenu.node.jarBase && (
            <ContextMenuItem
              icon={<FolderPlus size={12} />}
              label="新建文件夹"
              onClick={() => {
                startNewItem('folder', getParentDirPath(contextMenu.node));
                setContextMenu(null);
              }}
            />
          )}
          {!contextMenu.node.jarBase && <ContextMenuSeparator />}
          {!contextMenu.node.jarBase && (
            <ContextMenuItem
              icon={<Folder size={12} />}
              label="在文件资源管理器中显示"
              onClick={() => {
                const targetPath = contextMenu.node.path;
                console.log(`[FileTree] revealInExplorer: path="${targetPath}"`);
                if (electronBridge.isElectron) {
                  electronBridge.revealInExplorer(targetPath).then(result => {
                    console.log(`[FileTree] revealInExplorer result:`, result);
                    if (!result.success) {
                      console.error(`[FileTree] revealInExplorer failed: ${result.error}`);
                    }
                  }).catch(err => {
                    console.error(`[FileTree] revealInExplorer error:`, err);
                  });
                }
                setContextMenu(null);
              }}
            />
          )}
          {!contextMenu.node.jarBase && (
            <ContextMenuItem
              icon={<Pencil size={12} />}
              label={`重命名${contextMenu.node.isDirectory ? '目录' : '文件'}`}
              onClick={() => {
                setRenameTarget(contextMenu.node);
                setRenameInput(contextMenu.node.name);
                setRenameError(null);
                setContextMenu(null);
              }}
            />
          )}
          {!contextMenu.node.jarBase && <ContextMenuSeparator />}
          {!contextMenu.node.jarBase && (
            <ContextMenuItem
              icon={<Trash2 size={12} />}
              label={`删除${contextMenu.node.isDirectory ? '目录' : '文件'}`}
              danger
              onClick={() => {
                setDeleteConfirm({ node: contextMenu.node });
                setDeleteError(null);
                setContextMenu(null);
              }}
            />
          )}
        </ContextMenu>
      )}

      {/* 空白区域右键菜单（新建文件/文件夹） */}
      {emptyMenu && (
        <ContextMenu
          x={emptyMenu.x}
          y={emptyMenu.y}
          onClose={() => setEmptyMenu(null)}
          testId="file-tree-empty-context-menu"
        >
          <ContextMenuItem
            icon={<FilePlus size={12} />}
            label="新建文件"
            onClick={() => {
              startNewItem('file', '.');
              setEmptyMenu(null);
            }}
          />
          <ContextMenuItem
            icon={<FolderPlus size={12} />}
            label="新建文件夹"
            onClick={() => {
              startNewItem('folder', '.');
              setEmptyMenu(null);
            }}
          />
        </ContextMenu>
      )}

      {/* 删除确认对话框 */}
      {deleteConfirm && (
        renderGlobalOverlay(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <div className="w-full max-w-xs bg-[#111] border border-white/10 shadow-2xl flex flex-col">
              <div className="p-5 flex flex-col gap-3">
                <div className="flex items-center gap-2 text-red-400">
                  <AlertTriangle size={14} />
                  <span className="text-[11px] font-black uppercase tracking-widest">确认删除</span>
                </div>
                <p className="text-[10px] text-white/60 leading-relaxed">
                  即将永久删除{deleteConfirm.node.isDirectory ? '目录（含所有子文件）' : '文件'}：
                </p>
                <div className="bg-white/5 border border-white/10 px-3 py-2 text-[10px] text-white font-mono break-all">
                  {deleteConfirm.node.name}
                </div>
                {deleteConfirm.node.isDirectory && (
                  <div className="text-[9px] text-red-400/80 bg-red-500/5 border border-red-500/10 px-2 py-1.5">
                    ⚠ 目录删除不可撤销，将递归删除其所有内容。
                  </div>
                )}
                {deleteError && (
                  <div className="text-[9px] text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-1.5 break-all">
                    错误: {deleteError}
                  </div>
                )}
              </div>
              <div className="flex border-t border-white/5">
                <button
                  onClick={() => { setDeleteConfirm(null); setDeleteError(null); }}
                  disabled={isDeleting}
                  className="flex-1 h-9 text-white/40 text-[9px] font-black uppercase tracking-widest hover:bg-white/5 disabled:opacity-30 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={() => handleDelete(deleteConfirm.node)}
                  disabled={isDeleting}
                  className="flex-1 h-9 bg-red-600 text-white text-[9px] font-black uppercase tracking-widest hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
                >
                  {isDeleting ? <><Loader2 size={10} className="animate-spin" /> 删除中...</> : '确认删除'}
                </button>
              </div>
            </div>
          </div>
        )
      )}

      {/* 重命名对话框 */}
      {renameTarget && (
        renderGlobalOverlay(
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
            <div className="w-full max-w-xs bg-[#111] border border-white/10 shadow-2xl flex flex-col">
              <div className="p-5 flex flex-col gap-3">
                <div className="flex items-center gap-2 text-blue-400">
                  <Pencil size={14} />
                  <span className="text-[11px] font-black uppercase tracking-widest">重命名</span>
                </div>
                <p className="text-[10px] text-white/60 leading-relaxed">
                  重命名{renameTarget.isDirectory ? '目录' : '文件'}：
                </p>
                <div className="bg-white/5 border border-white/10 px-3 py-2 text-[10px] text-white font-mono break-all opacity-60">
                  {renameTarget.name}
                </div>
                <input
                  autoFocus
                  type="text"
                  value={renameInput}
                  onChange={(e) => {
                    setRenameInput(e.target.value);
                    setRenameError(null);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !isRenaming) {
                      handleRename();
                    } else if (e.key === 'Escape') {
                      setRenameTarget(null);
                      setRenameInput('');
                      setRenameError(null);
                    }
                  }}
                  disabled={isRenaming}
                  className="bg-white/5 border border-white/10 h-10 px-3 text-[11px] text-white focus:outline-none focus:border-[#3B82F6] transition-colors"
                  placeholder={renameTarget.name}
                />
                {renameError && (
                  <div className="text-[9px] text-red-400 bg-red-500/10 border border-red-500/20 px-2 py-1.5 break-all">
                    错误: {renameError}
                  </div>
                )}
              </div>
              <div className="flex border-t border-white/5">
                <button
                  onClick={() => { setRenameTarget(null); setRenameInput(''); setRenameError(null); }}
                  disabled={isRenaming}
                  className="flex-1 h-9 text-white/40 text-[9px] font-black uppercase tracking-widest hover:bg-white/5 disabled:opacity-30 transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={handleRename}
                  disabled={isRenaming || !renameInput.trim() || renameInput.trim() === renameTarget.name}
                  className="flex-1 h-9 bg-[#3B82F6] text-white text-[9px] font-black uppercase tracking-widest hover:bg-blue-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors flex items-center justify-center gap-1.5"
                >
                  {isRenaming ? <><Loader2 size={10} className="animate-spin" /> 重命名...</> : '确认'}
                </button>
              </div>
            </div>
          </div>
        )
      )}

      {!workspaceRoot ? (
        <div className="flex-1 flex flex-col items-center justify-center p-6 gap-6" data-testid="workspace-lock-overlay">
          {/* 初始化失败的 Red Box (对齐粘贴图片 1 的显示样式) */}
          {initError && (
            renderGlobalOverlay(
              <div className="fixed inset-0 z-[9998] flex items-center justify-center bg-black/60 backdrop-blur-sm p-4">
                 <div className="w-full max-w-sm bg-white border-[3px] border-red-600 shadow-2xl flex flex-col scale-in-center">
                    <div className="p-6 text-center">
                      <div className="text-black text-[12px] font-black leading-relaxed uppercase tracking-tighter mb-4 border-b border-black/10 pb-2">
                          工作区初始化失败 (INIT_FAILED)
                      </div>
                      <div className="text-black/80 text-[10px] font-medium leading-relaxed mb-4">
                        无法加载或访问指定的目录。请检查路径拼写是否正确，且系统具备该路径的读写权限。
                      </div>
                      <div className="text-[10px] text-red-600 font-black bg-red-50 p-2 border border-red-100 break-all text-left">
                        ERROR_LOG: {initError}
                      </div>
                    </div>
                    <div className="flex flex-col">
                      <button 
                          onClick={() => {
                              setInitError(null);
                              setIsInitModalOpen(true);
                          }}
                          className="h-10 bg-black text-white text-[10px] font-black uppercase tracking-[0.2em] hover:bg-zinc-800 transition-colors border-t border-black/5"
                      >
                          重新输入路径
                      </button>
                      <button 
                          onClick={() => setInitError(null)}
                          className="h-10 bg-[#0066FF] text-white text-[10px] font-black uppercase tracking-[0.2em] hover:bg-blue-700 transition-colors"
                      >
                          忽略并关闭
                      </button>
                    </div>
                 </div>
              </div>
            )
          )}

          {/* 路径输入 Modal */}
          {isInitModalOpen && (
            renderGlobalOverlay(
              <div className="fixed inset-0 z-[9997] flex items-center justify-center bg-black/90 backdrop-blur-md p-4">
                <div className="w-full max-w-sm border border-white/10 bg-[#0A0A0A] p-6 flex flex-col gap-4">
                    <div className="text-[10px] font-black text-white/40 uppercase tracking-[0.3em]">初始化工作区</div>
                    <div className="flex flex-col gap-1.5">
                      <label className="text-[9px] text-white/20 uppercase tracking-widest">物理路径 (例如 D:/my-project)</label>
                      <input 
                        autoFocus
                        type="text" 
                        value={initPathInput}
                        onChange={(e) => setInitPathInput(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' && !isSwitchingWorkspace) {
                            initWorkspace(initPathInput);
                          }
                        }}
                        disabled={isSwitchingWorkspace}
                        className="bg-white/5 border border-white/10 h-10 px-3 text-[11px] text-white focus:outline-none focus:border-[#10B981] transition-colors"
                        placeholder="D:/my-project"
                      />
                    </div>

                    {/* 最近打开的工作区 */}
                    {(() => {
                      const recents = getRecentWorkspaces();
                      if (recents.length === 0) return null;
                      return (
                        <div>
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <Clock size={10} className="text-white/30" />
                            <span className="text-[8px] text-white/30 uppercase tracking-wider">最近打开</span>
                          </div>
                          <div className="max-h-[130px] overflow-y-auto space-y-0.5 custom-scrollbar-thin">
                            {recents.map((entry) => (
                              <div
                                key={entry.path}
                                className="flex items-center gap-1.5 px-2 py-1 rounded group hover:bg-white/5 cursor-pointer transition-colors"
                                onClick={() => setInitPathInput(entry.path)}
                                title={entry.path}
                              >
                                <FolderOpen size={11} className="text-white/25 shrink-0 group-hover:text-white/50 transition-colors" />
                                <span className="text-[10px] text-white/55 truncate flex-1 group-hover:text-white/75 transition-colors">
                                  {entry.path}
                                </span>
                                <button
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    removeRecentWorkspace(entry.path);
                                    setRecentWorkspaces(getRecentWorkspaces());
                                  }}
                                  className="opacity-0 group-hover:opacity-50 hover:!opacity-100 p-0.5 rounded hover:bg-white/10 transition-all shrink-0"
                                  title="移除"
                                >
                                  <X size={9} className="text-white/40" />
                                </button>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })()}

                    {electronBridge.isElectron && (
                      <button
                        onClick={() => {
                          electronBridge.selectWorkspace().then((selectedPath) => {
                            if (selectedPath) setInitPathInput(selectedPath);
                          }).catch(() => {});
                        }}
                        className="text-[9px] text-white/25 hover:text-white/50 transition-colors uppercase tracking-wider text-left"
                      >
                        📁 浏览文件夹...
                      </button>
                    )}
                    <div className="flex gap-2">
                      <button 
                        onClick={() => setIsInitModalOpen(false)}
                        disabled={isSwitchingWorkspace}
                        className="flex-1 h-9 border border-white/10 text-white/40 text-[9px] font-black uppercase tracking-widest hover:bg-white/5 disabled:opacity-30 disabled:cursor-not-allowed"
                      >
                        取消
                      </button>
                      <button 
                        onClick={() => initWorkspace(initPathInput)}
                        disabled={isSwitchingWorkspace}
                        className="flex-1 h-9 bg-[#10B981] text-black text-[9px] font-black uppercase tracking-widest hover:bg-emerald-400 disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {(isLoading || isSwitchingWorkspace) ? '正在初始化...' : '确定'}
                      </button>
                    </div>
                </div>
              </div>
            )
          )}

          <div className="p-4 rounded-full bg-white/[0.02] border border-white/5 animate-pulse">
            <Lock size={32} className="text-white opacity-20" />
          </div>
          <div className="flex flex-col items-center gap-2 text-center">
            <div className="text-[10px] font-black text-white/40 uppercase tracking-[0.3em]">工作区未激活 (LOCKED)</div>
            <div className="text-[8px] font-medium text-white/20 uppercase tracking-[0.1em] max-w-[180px]">请选择或创建一个本地目录以解锁 IDE Agent助手功能</div>
          </div>
          
          <div className="w-full flex flex-col gap-2 pt-4">
            <button 
              onClick={() => {
                if (isSwitchingWorkspace) return;
                setInitPathInput('');
                setInitError(null);
                setIsInitModalOpen(true);
              }}
              disabled={isSwitchingWorkspace}
              className="w-full h-9 bg-white text-black text-[9px] font-black uppercase tracking-widest hover:bg-emerald-500 transition-colors flex items-center justify-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
              data-testid="select-workspace-btn"
            >
              <Compass size={12} /> 初始化工作区
            </button>
            <button 
              onClick={() => {
                if (isSwitchingWorkspace) return;
                const name = prompt('请输入新项目路径 (例如 D:/test-new-project):');
                if (name) initWorkspace(name);
              }}
              disabled={isSwitchingWorkspace}
              className="w-full h-9 border border-white/10 text-white/60 text-[9px] font-black uppercase tracking-widest hover:bg-white/5 transition-colors flex items-center justify-center gap-2 underline underline-offset-4 disabled:opacity-30 disabled:cursor-not-allowed"
              data-testid="create-workspace-btn"
            >
              <FolderPlus size={12} /> 创建新工作区
            </button>
          </div>
        </div>
      ) : (
        <>
          {/* 文件操作工具栏 (新建文件/文件夹) */}
          <div className="flex items-center gap-1 px-2 py-1 border-b border-white/5 shrink-0 bg-[#0A0A0A]">
            <button
              onClick={() => startNewItem('file', '.')}
              className="p-1 hover:bg-white/10 rounded-sm transition-colors text-white/50 hover:text-white"
              title="新建文件 (New File)"
              data-testid="new-file-btn"
            >
              <FilePlus size={10} />
            </button>
            <button
              onClick={() => startNewItem('folder', '.')}
              className="p-1 hover:bg-white/10 rounded-sm transition-colors text-white/50 hover:text-white"
              title="新建文件夹 (New Folder)"
              data-testid="new-folder-btn"
            >
              <FolderPlus size={10} />
            </button>
            <span className="ml-1 text-[7.5px] uppercase tracking-[0.2em] text-white/20 font-black select-none">新建</span>
          </div>
          <div
            className="flex-1 min-h-0 overflow-hidden pt-2"
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setContextMenu(null);
              setEmptyMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            {isLoading && nodes.length === 0 ? (
              <div className="p-4 flex items-center gap-2 text-[10px] text-white uppercase font-black tracking-widest opacity-40">
                <Loader2 size={12} className="animate-spin" /> 正在加载 (LOADING)...
              </div>
            ) : (
              <Virtuoso
                style={{ height: '100%' }}
                data={visibleRows}
                computeItemKey={(_, row) => row.kind === 'node' ? row.node.path : `new-item:${row.depth}`}
                itemContent={(_, row) => row.kind === 'node'
                  ? renderNodeRow(row.node, row.depth)
                  : renderNewItemInput(row.depth)}
                components={{
                  EmptyPlaceholder: () => (
                    <div className="p-4 text-[11px] text-white/60 uppercase font-black tracking-[0.2em] italic text-center border-b border-white/5 mx-4 mt-8 py-4 bg-white/[0.02] shadow-inner">
                      <div className="opacity-20 mb-2">EMPTY_DIRECTORY_MIRROR</div>
                      <div className="underline decoration-white/20 underline-offset-8">未发现文件 (EMPTY_DIR)</div>
                    </div>
                  ),
                }}
              />
            )}
          </div>
        </>
      )}
    </div>
  );
};

import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { 
  File, Folder, ChevronRight, ChevronDown, 
  Loader2, Lock, FolderPlus, Compass, Copy, Trash2, AlertTriangle, Pencil, Clock, X, FolderOpen, Box
} from 'lucide-react';
import axios from 'axios';
import { switchWorkspace } from '@/services/WorkspaceSwitchService';
import { useAgentContext } from '@/providers/AgentContext';
import { API_BASE, GATEWAY_EVENT } from '@/config';
import { electronBridge } from '@/services/electron-bridge';
import { getRecentWorkspaces, removeRecentWorkspace, type RecentWorkspaceEntry } from '@/services/RecentWorkspaces';

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
}

const FILE_TREE_POLL_INTERVAL_MS = 5000;
const MAX_AUTO_REFRESH_PATHS = 25;
const AUTO_REFRESH_SKIP_SEGMENTS = new Set(['node_modules', '.git', 'dist', 'build', '.ide-agent']);

const shouldSkipAutoRefreshPath = (targetPath: string) => {
  const segments = targetPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return segments.some(segment => AUTO_REFRESH_SKIP_SEGMENTS.has(segment));
};

/** 目录在前，文件在后；同组内按名称字母序排列（忽略大小写） */
const sortFileNodes = (nodes: FileNode[]): FileNode[] => {
  return [...nodes].sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) {
      return a.isDirectory ? -1 : 1;
    }
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
};

export const FileTree: React.FC<FileTreeProps> = ({ onFileSelect, activeFile }) => {
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
    const closeContextMenu = () => setContextMenu(null);
    window.addEventListener('click', closeContextMenu);
    return () => window.removeEventListener('click', closeContextMenu);
  }, []);

  const handleContextMenu = (e: React.MouseEvent, node: FileNode) => {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY, node });
  };

  const handleDelete = async (node: FileNode) => {
    if (!workspaceRoot) return;
    setIsDeleting(true);
    setDeleteError(null);
    try {
      if (electronBridge.isElectron) {
        const result = await electronBridge.deleteFile({ filePath: node.path, root: workspaceRoot });
        if (!result.success) throw new Error(result.error || 'Delete failed');
      } else {
        await axios.post(`${API_BASE}/api/files/delete`, {
          path: node.path,
          root: workspaceRoot,
          recursive: node.isDirectory,
        });
      }
      setDeleteConfirm(null);
      // 如果删除的是当前激活文件，通知父组件清空编辑器
      if (!node.isDirectory && activeFile === node.path) {
        onFileSelect('');
      }
      // 刷新目录树
      refreshPath('.');
    } catch (e: any) {
      setDeleteError(e.response?.data?.error || e.message || '删除失败');
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
      let newPath: string;
      if (electronBridge.isElectron) {
        const parentDir = renameTarget.path.replace(/[/\\][^/\\]*$/, '');
        const fullNewPath = parentDir + '/' + trimmedName;
        const result = await electronBridge.renameFile({ oldPath: renameTarget.path, newPath: fullNewPath, root: workspaceRoot });
        if (!result.success) throw new Error(result.error || 'Rename failed');
        newPath = result.newPath || fullNewPath;
      } else {
        const res = await axios.post(`${API_BASE}/api/files/rename`, {
          path: renameTarget.path,
          newName: trimmedName,
          root: workspaceRoot,
        });
        newPath = res.data.newPath;
      }
      if (activeFile === renameTarget.path) {
        onFileSelect(newPath);
      }
      setRenameTarget(null);
      setRenameInput('');
      // 刷新目录树
      refreshPath('.');
    } catch (e: any) {
      setRenameError(e.response?.data?.error || e.message || '重命名失败');
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
      if (electronBridge.isElectron) {
        const result = await electronBridge.renameFile({ oldPath: sourcePath, newPath, root: workspaceRoot });
        if (!result.success) throw new Error(result.error || 'Move failed');
      } else {
        await axios.post(`${API_BASE}/api/files/rename`, {
          path: sourcePath,
          newPath,
          root: workspaceRoot,
          isMove: true,
        });
      }

      // 如果移动的是当前激活文件，更新路径
      if (activeFile === sourcePath) {
        onFileSelect(newPath);
      }

      // 刷新目录树
      refreshPath('.');
    } catch (e: any) {
      console.error('[FileTree] Move failed:', e);
    } finally {
      setIsMoving(false);
    }
  };

  useEffect(() => {
    if (workspaceRoot) {
      refreshPath('.');
    }

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

    const onRefreshRequest = () => refreshPath('.');
    window.addEventListener(GATEWAY_EVENT, handleWsMessage);
    window.addEventListener('ui:file-tree:refresh', onRefreshRequest);

    // 轻量轮询作为兜底同步：串行执行、限制路径数，避免大目录/慢接口导致请求堆积和浏览器 OOM。
    const pollInterval = setInterval(() => {
      if (!workspaceRoot || pollInFlightRef.current) return;
        
        setNodes(currentNodes => {
        const pathsToRefresh = ['.'];
            const findOpenPaths = (nodesList: FileNode[]) => {
                for (const node of nodesList) {
            // 跳过 JAR 内部节点（虚拟目录，不参与文件系统轮询）
            if (node.jarBase) continue;
            if (node.isDirectory && node.isOpen && !shouldSkipAutoRefreshPath(node.path)) {
                        pathsToRefresh.push(node.path);
              if (pathsToRefresh.length >= MAX_AUTO_REFRESH_PATHS) return;
                        if (node.children) {
                            findOpenPaths(node.children);
                if (pathsToRefresh.length >= MAX_AUTO_REFRESH_PATHS) return;
                        }
                    }
                }
            };
            findOpenPaths(currentNodes);

        pollInFlightRef.current = true;
        pollAbortRef.current?.abort();
        const controller = new AbortController();
        pollAbortRef.current = controller;
            
            // 异步并发去获取更新
        Promise.all(pathsToRefresh.slice(0, MAX_AUTO_REFRESH_PATHS).map(async p => {
                try {
                    let children: any[];
                    if (electronBridge.isElectron) {
                        const result = await electronBridge.listFiles({ dirPath: p, depth: 1, root: workspaceRoot! });
                        children = result.success ? (result.files || []).map((f: any) => ({
                            name: f.name, path: f.path,
                            isDirectory: f.isDirectory || f.type === 'directory',
                        })) : [];
                    } else {
                        const response = await axios.get(`${API_BASE}/api/files?path=${encodeURIComponent(p)}&root=${encodeURIComponent(workspaceRoot!)}`, { signal: controller.signal });
                        children = response.data;
                    }
                    return { path: p, children };
                } catch {
                    return null;
                }
            })).then(results => {
          if (controller.signal.aborted) return;
                setNodes(oldTree => {
                    let nextTree = oldTree;
                    // 【性能优化】预构建 path → node 索引，O(N) 一次构建，后续 O(1) 定位
                    // 替代原 O(P×N) 每路径递归遍历全树
                    const nodeIndex = new Map<string, FileNode>();
                    const buildIndex = (nodes: FileNode[]) => {
                        for (const n of nodes) {
                            nodeIndex.set(n.path, n);
                            if (n.children) buildIndex(n.children);
                        }
                    };
                    buildIndex(oldTree);

                    for (const res of results) {
                        if (!res) continue;
                        if (res.path === '.') {
                            nextTree = mergeNodes(nextTree, res.children);
                        } else {
                            const target = nodeIndex.get(res.path);
                            if (target) {
                                target.children = target.children ? mergeNodes(target.children, res.children) : res.children;
                                // 触发 React 重渲染：浅拷贝受影响的节点链
                                nextTree = [...nextTree];
                            }
                        }
                    }
                    return nextTree;
                });
                }).finally(() => {
                  if (pollAbortRef.current === controller) {
                    pollAbortRef.current = null;
                  }
                  pollInFlightRef.current = false;
            });

            return currentNodes; // 维持现状，等待 Promise 返回后触发更新
        });

            }, FILE_TREE_POLL_INTERVAL_MS);

    return () => {
        window.removeEventListener(GATEWAY_EVENT, handleWsMessage);
        window.removeEventListener('ui:file-tree:refresh', onRefreshRequest);
              pollAbortRef.current?.abort();
              pollAbortRef.current = null;
              pollInFlightRef.current = false;
        clearInterval(pollInterval);
    };
  }, [workspaceRoot, setWorkspaceRoot]);

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
            refreshPath('.');
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
        
        let errorMsg = e.response?.data?.error || e.message || '未知错误';
        
        // [对齐 43.1 节]: 针对 Network Error 提供明确的系统级诊断
        if (e.message === 'Network Error') {
          if (electronBridge.isElectron) {
            errorMsg = `工作区初始化失败：${e.message}。请确认工作区路径有效且可访问。`;
          } else {
            errorMsg = `无法连接至后端服务 (${API_BASE})。请确认 Node.js 后端程序已启动且网络通畅。`;
          }
        }
        
        setInitError(errorMsg);
    } finally {
      setIsSwitchingWorkspace(false);
        setIsLoading(false);
    }
  };

  const refreshPath = async (parentPath: string, silent = false) => {
    if (!workspaceRoot) return;
    if (!silent && parentPath === '.') setIsLoading(true);
    try {
      // 2026.03 解耦重构: 显式传递 root 路径，不再经过 AgentSession 校验 (绕过 412 错误)
      let filesData: any[];
      if (electronBridge.isElectron) {
        const result = await electronBridge.listFiles({ dirPath: parentPath, depth: 1, root: workspaceRoot });
        if (!result.success) throw new Error(result.error || 'List files failed');
        filesData = (result.files || []).map((f: any) => ({
          name: f.name,
          path: f.path,
          isDirectory: f.isDirectory || f.type === 'directory',
        }));
      } else {
        const response = await axios.get(`${API_BASE}/api/files?path=${encodeURIComponent(parentPath)}&root=${encodeURIComponent(workspaceRoot)}`);
        filesData = response.data;
      }

      setNodes(prev => {
        const next = [...prev];
        if (parentPath === '.') {
          return mergeNodes(prev, filesData);
        } else {
          const target = findNodeInMutableTree(next, parentPath);
          if (target) {
            target.children = sortFileNodes(filesData);
          }
          return next;
        }
      });
    } catch (error: any) {
      console.error(`Failed to refresh path ${parentPath}:`, error);
      // 特殊处理 412: Backend Session Expired / Workspace Not Initialized
      if (error.response?.status === 412 && workspaceRoot) {
          console.warn('[FileTree] Path access 412. Session might be expired. Retrying initialization...');
          initWorkspace(workspaceRoot, true);
      } else if (parentPath === '.') {
          // 如果根目录加载失败，强制回退至锁定状态
          setWorkspaceRoot(null);
          setNodes([]);
          const errorMsg = error.response?.data?.error || error.message || '未知错误';
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
    return sortFileNodes(newNodes.map(newNode => {
      const oldNode = oldNodeByPath.get(newNode.path);
      if (oldNode) {
        newNode.isOpen = oldNode.isOpen;
        newNode.jarBase = oldNode.jarBase; // 保留 JAR 内部节点标记
        // 如果是打开的且已经有子节点，保留它们（含 JAR 展开后的虚拟子节点）
        if (newNode.isOpen && oldNode.children) {
          newNode.children = oldNode.children;
        }
      }
      return newNode;
    }));
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
        return nodes.map(n => {
          if (n.path === node.path) {
            return { ...n, isOpen: isNowOpen };
          }
          if (n.children) {
            return { ...n, children: updateNode(n.children) };
          }
          return n;
        });
      };
      return updateNode(currentNodes);
    });

    if (isNowOpen && (!node.children || node.children.length === 0)) {
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
        } else if (electronBridge.isElectron) {
          // ── 普通文件系统目录 ──
          const result = await electronBridge.listFiles({ dirPath: node.path, depth: 1, root: workspaceRoot });
          if (!result.success) throw new Error(result.error || 'Toggle failed');
          childData = (result.files || []).map((f: any) => ({
            name: f.name, path: f.path,
            isDirectory: f.isDirectory || f.type === 'directory',
          }));
        } else {
          const res = await axios.get(
            `${API_BASE}/api/files?path=${encodeURIComponent(node.path)}&root=${encodeURIComponent(workspaceRoot)}`
          );
          childData = res.data;
        }
        
        const sortedChildData = sortFileNodes(childData);
        setNodes(currentNodes => {
          const updateChildren = (nodes: FileNode[]): FileNode[] => {
            return nodes.map(n => {
              if (n.path === node.path) {
                return { ...n, children: sortedChildData };
              }
              if (n.children) {
                return { ...n, children: updateChildren(n.children) };
              }
              return n;
            });
          };
          return updateChildren(currentNodes);
        });
      } catch (e) {
        console.error(e);
        setNodes(currentNodes => {
          const revert = (nodes: FileNode[]): FileNode[] => {
            return nodes.map(n => {
              if (n.path === node.path) {
                return { ...n, isOpen: false };
              }
              if (n.children) {
                return { ...n, children: revert(n.children) };
              }
              return n;
            });
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

  const renderNode = (node: FileNode, depth: number = 0) => {
    const isActive = activeFile === node.path;
    const isDragging = dragNodePath === node.path;
    const isDragOver = dragOverPath === node.path && node.isDirectory;
    const isDropTarget = node.isDirectory && dragNodePath && !isDescendantOf(dragNodePath, node.path) && !isMoving;

    return (
      <div key={node.path}>
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
        {(node.isDirectory || isArchiveFile(node.name)) && node.isOpen && node.children && (
          <div>
            {node.children.map(child => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col h-full bg-[#000000]" data-testid="file-tree-container">
      {/* Context Menu */}
      {contextMenu && (
        <div 
          className="fixed z-50 bg-[#121212] border border-white/10 shadow-2xl py-1 text-white text-[10px] min-w-[170px] font-medium"
          style={{ top: Math.min(contextMenu.y, window.innerHeight - 80), left: Math.min(contextMenu.x, window.innerWidth - 160) }}
        >
          <div 
            className="px-3 py-2 hover:bg-white/10 cursor-pointer flex items-center gap-2 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              const relativePath = contextMenu.node.path.slice(workspaceRoot?.length || 0).replace(/^[\\\/]/, '');
              copyToClipboard(relativePath);
              setContextMenu(null);
            }}
          >
            <Copy size={12} className="opacity-50" />
            <span>复制相对路径 (Relative)</span>
          </div>
          <div 
            className="px-3 py-2 hover:bg-white/10 cursor-pointer flex items-center gap-2 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              copyToClipboard(contextMenu.node.path);
              setContextMenu(null);
            }}
          >
            <Copy size={12} className="opacity-50" />
            <span>复制绝对路径 (Absolute)</span>
          </div>
          {!contextMenu.node.jarBase && (
          <div className="border-t border-white/5 my-1" />
          )}
          {!contextMenu.node.jarBase && (
          <div 
            className="px-3 py-2 hover:bg-white/10 cursor-pointer flex items-center gap-2 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
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
          >
            <Folder size={12} className="opacity-50" />
            <span>在文件资源管理器中显示</span>
          </div>
          )}
          {!contextMenu.node.jarBase && (
          <div 
            className="px-3 py-2 hover:bg-white/10 cursor-pointer flex items-center gap-2 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              setRenameTarget(contextMenu.node);
              setRenameInput(contextMenu.node.name);
              setRenameError(null);
              setContextMenu(null);
            }}
          >
            <Pencil size={12} className="opacity-50" />
            <span>重命名{contextMenu.node.isDirectory ? '目录' : '文件'}</span>
          </div>
          )}
          {!contextMenu.node.jarBase && (
          <div className="border-t border-white/5 my-1" />
          )}
          {!contextMenu.node.jarBase && (
          <div 
            className="px-3 py-2 hover:bg-red-500/20 cursor-pointer flex items-center gap-2 transition-colors text-red-400"
            onClick={(e) => {
              e.stopPropagation();
              setDeleteConfirm({ node: contextMenu.node });
              setDeleteError(null);
              setContextMenu(null);
            }}
          >
            <Trash2 size={12} />
            <span>删除{contextMenu.node.isDirectory ? '目录' : '文件'}</span>
          </div>
          )}
        </div>
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
        <div className="flex-1 overflow-y-auto py-2">
          {nodes.map(node => renderNode(node))}
          {nodes.length === 0 && !isLoading && (
            <div className="p-4 text-[11px] text-white/60 uppercase font-black tracking-[0.2em] italic text-center border-b border-white/5 mx-4 mt-8 py-4 bg-white/[0.02] shadow-inner">
              <div className="opacity-20 mb-2">EMPTY_DIRECTORY_MIRROR</div>
              <div className="underline decoration-white/20 underline-offset-8">未发现文件 (EMPTY_DIR)</div>
            </div>
          )}
          {isLoading && nodes.length === 0 && (
            <div className="p-4 flex items-center gap-2 text-[10px] text-white uppercase font-black tracking-widest opacity-40">
              <Loader2 size={12} className="animate-spin" /> 正在加载 (LOADING)...
            </div>
          )}
        </div>
      )}
    </div>
  );
};


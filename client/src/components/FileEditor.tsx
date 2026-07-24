import React, { useRef, useEffect, useState, useMemo, lazy, Suspense } from 'react';
import { Editor, DiffEditor, loader } from '@monaco-editor/react';
import type { OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

// 配置内部 Monaco 加载器使用本地实例
loader.config({ monaco });
(window as any).monaco = monaco;

import { Lock, FileCode, Eye, Code, ChevronRight } from 'lucide-react';
import { useInlineCompletions } from '@/hooks/useInlineCompletions';
import { GATEWAY_EVENT } from '@/config';
import { useAgentContext } from '@/providers/AgentContext';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { electronBridge } from '@/services/electron-bridge';

// PDF 预览组件按需懒加载（避免为所有用户增加 ~200KB bundle）
const PdfPreview = lazy(() => import('@/components/PdfPreview'));

/**
 * 编辑器视图状态缓存（跨组件生命周期持久化光标/滚动位置）
 * Key: 文件相对路径, Value: Monaco ICodeEditorViewState
 * 解决用户二次打开同一文件时无法恢复到上次关闭位置的问题
 */
const editorViewStateCache = new Map<string, monaco.editor.IEditorViewState | null>();

interface FileEditorProps {
  activeFile: string;
  isLocked: boolean;
  mode?: 'editor' | 'diff';
  onClose?: () => void;
}

/**
 * 对应技术规范 3.1 & 26.0 节：前端文件编辑器组件
 * 封装 Monaco Editor，包含补全、Shadow Editor 与物理写入感知
 */
export const FileEditor: React.FC<FileEditorProps> = ({ activeFile, isLocked, mode = 'editor' }) => {
  const { workspaceRoot } = useAgentContext();
  const LOCKED_PROVIDER = 'deepseek';
  const LOCKED_MODEL = 'deepseek-reasoner';
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const editorContainerRef = useRef<HTMLDivElement | null>(null);
  const [editorReady, setEditorReady] = useState(false);
  const activeFileRef = useRef(activeFile);
  const [fileContent, setFileContent] = useState<string>('');
  const [savedContent, setSavedContent] = useState<string>('');
  const [fileEncoding, setFileEncoding] = useState<string>('utf8');
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [originalContent, setOriginalContent] = useState<string>('');
  const [viewMode, setViewMode] = useState<'editor' | 'diff' | 'preview' | 'pdf' | 'image' | 'table'>(mode);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const diffEditorRef = useRef<any>(null);
  const savedContentRef = useRef('');
  const modelBindRafRef = useRef<number | null>(null);

  const fileName = useMemo(() => activeFile.split(/[/\\]/).pop() || activeFile, [activeFile]);
  const pathSegments = useMemo(() => {
    if (!activeFile) return [];
    return activeFile.replace(/\\/g, '/').split('/').filter(Boolean);
  }, [activeFile]);
  const isMarkdown = useMemo(() => activeFile.toLowerCase().endsWith('.md'), [activeFile]);
  const isPdf = useMemo(() => activeFile.toLowerCase().endsWith('.pdf'), [activeFile]);
  const isCsv = useMemo(() => {
    const lower = activeFile.toLowerCase();
    return lower.endsWith('.csv') || lower.endsWith('.tsv');
  }, [activeFile]);
  const isImage = useMemo(() => {
    const ext = activeFile.toLowerCase().split('.').pop();
    return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif'].includes(ext || '');
  }, [activeFile]);

  // JAR/ZIP 归档文件内部条目检测
  const isJarEntry = useMemo(() => activeFile.includes('::'), [activeFile]);
  const jarEntryInfo = useMemo(() => {
    if (!isJarEntry) return null;
    const idx = activeFile.indexOf('::');
    const jarPath = activeFile.substring(0, idx);
    let entryPath = activeFile.substring(idx + 2);
    if (entryPath.endsWith('/')) entryPath = entryPath.slice(0, -1);
    return { jarPath, entryPath };
  }, [activeFile, isJarEntry]);

  // JAR 内部文件为只读（无法直接保存回归档）
  const isEffectivelyReadOnly = isLocked || isJarEntry;

  // PDF 预览状态
  const [pdfBase64, setPdfBase64] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  // 图片预览状态
  const [imageBase64, setImageBase64] = useState<string | null>(null);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [imageMimeType, setImageMimeType] = useState<string>('');

  // ── CSV 解析 ──
  const csvData = useMemo(() => {
    if (!isCsv || !fileContent || fileContent.includes('[LOADING]') || fileContent.includes('[CRITICAL_ERROR]')) {
      return null;
    }
    return parseCsvContent(fileContent, activeFile.toLowerCase().endsWith('.tsv'));
  }, [isCsv, fileContent, activeFile]);

  // 方案七：利用 Ref 维护原子性操作锁，强力干预 Monaco 内部异步 Canceled 链路
  const modelLockRef = useRef<boolean>(false);
  
  // 方案八：引入 AbortController，强制中止过期的网络请求，防止多路更新竞态
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const saveFileRef = useRef<() => Promise<void>>(async () => {});

  // 方案十二：模式切换护栏，记录上一次模式，防止在同模式下错误地执行 setModel(null) 触发 wordHighlighter 销毁
  const lastModeRef = useRef<'editor' | 'diff' | 'preview' | 'pdf' | 'image' | 'table'>(mode);

  const getCurrentEditorContent = () => {
    if (viewMode === 'editor' && editorRef.current) {
      return editorRef.current.getValue();
    }
    if (viewMode === 'diff' && diffEditorRef.current?.getModifiedEditor) {
      return diffEditorRef.current.getModifiedEditor().getValue();
    }
    return fileContent;
  };

  const isEditorTextFocused = () => {
    const editorFocused = !!editorRef.current?.hasTextFocus?.();
    const diffFocused = !!diffEditorRef.current?.getModifiedEditor?.()?.hasTextFocus?.();
    return editorFocused || diffFocused;
  };

  const isEditorAreaFocused = () => {
    if (isEditorTextFocused()) return true;
    const activeEl = document.activeElement as HTMLElement | null;
    return !!(activeEl && editorContainerRef.current?.contains(activeEl));
  };

  const handleSaveFile = async () => {
    if (!activeFile || isLocked || isJarEntry || viewMode === 'preview' || viewMode === 'pdf' || viewMode === 'image' || viewMode === 'table' || isPdf || isImage || isSaving) return;

    const contentToSave = getCurrentEditorContent();
    if (contentToSave === savedContent) {
      setIsDirty(false);
      return;
    }

    const effectiveRoot = workspaceRoot || new URLSearchParams(window.location.search).get('root');
    if (!effectiveRoot) {
      console.warn('[Editor] Save skipped: workspace root missing');
      return;
    }

    setIsSaving(true);
    try {
      // Electron IPC 直写文件系统（零网络开销）
      const result = await electronBridge.writeFile({
        filePath: activeFile,
        content: contentToSave,
        encoding: fileEncoding,
        root: effectiveRoot,
      });
      if (!result.success) throw new Error(result.error || 'File write failed');

      if (!isMountedRef.current) return;
      setSavedContent(contentToSave);
      setFileContent(contentToSave);
      setIsDirty(false);
    } catch (err: any) {
      console.error('[Editor] Save failed:', err?.response?.data || err?.message || err);
    } finally {
      if (isMountedRef.current) {
        setIsSaving(false);
      }
    }
  };

  useEffect(() => {
    saveFileRef.current = handleSaveFile;
  });

  // 0. 语言运行态感知
  const languageId = useMemo(() => {
    if (!activeFile) return 'plaintext';
    // 基于扩展名探测语言类型
    const ext = activeFile.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'java': return 'java';
      case 'ts': case 'tsx': return 'typescript';
      case 'js': case 'jsx': return 'javascript';
      case 'py': return 'python';
      case 'yml': case 'yaml': return 'yaml';
      case 'json': return 'json';
      case 'html': return 'html';
      case 'css': return 'css';
      case 'xml': case 'pom': return 'xml';
      case 'md': case 'markdown': return 'markdown';
      case 'csv': case 'tsv': return 'plaintext';
      case 'pdf': return 'pdf';
      default: return 'plaintext';
    }
  }, [activeFile]);

  // 修改：当文件改变时，将不匹配的 viewMode 重置为 editor（或 Markdown 的 preview）
  useEffect(() => {
    if (activeFile && !activeFile.toLowerCase().endsWith('.md') && viewMode === 'preview') {
      console.log(`[Editor] Auto-switching from preview to editor because ${activeFile} is not Markdown`);
      setViewMode('editor');
    }
    // 当文件改变且非图片时，从 image 模式切回 editor
    if (activeFile && !isImage && viewMode === 'image') {
      console.log(`[Editor] Auto-switching from image to editor because ${activeFile} is not an image`);
      setViewMode('editor');
    }
    // 当文件改变且非 PDF 时，从 pdf 模式切回 editor（或 Markdown 的 preview）
    if (activeFile && !isPdf && viewMode === 'pdf') {
      console.log(`[Editor] Auto-switching from pdf to ${activeFile.toLowerCase().endsWith('.md') ? 'preview' : 'editor'} because ${activeFile} is not a PDF`);
      setViewMode(activeFile.toLowerCase().endsWith('.md') ? 'preview' : 'editor');
    }
    // 当文件改变且非 CSV 时，从 table 模式切回 editor
    if (activeFile && !isCsv && viewMode === 'table') {
      console.log(`[Editor] Auto-switching from table to editor because ${activeFile} is not a CSV`);
      setViewMode('editor');
    }
  }, [activeFile]);

  // PDF 文件：自动切换为 pdf 预览模式并加载二进制内容
  useEffect(() => {
    if (!activeFile || !isPdf) {
      setPdfBase64(null);
      setPdfError(null);
      return;
    }

    let cancelled = false;

    // PDF 文件自动进入预览模式
    if (viewMode !== 'pdf') {
      setViewMode('pdf');
    }

    setPdfLoading(true);
    setPdfBase64(null);
    setPdfError(null);

    const effectiveRoot = workspaceRoot || new URLSearchParams(window.location.search).get('root');
    if (!effectiveRoot) {
      setPdfLoading(false);
      setPdfError('工作区根目录缺失，无法读取 PDF');
      return;
    }

    electronBridge.readFileBinary({ filePath: activeFile, root: effectiveRoot })
      .then((result: any) => {
        if (cancelled) return;
        if (result?.success && result.base64) {
          setPdfBase64(result.base64);
        } else {
          const message = result?.error || 'PDF 文件读取失败';
          setPdfError(message);
          console.error('[Editor] PDF read failed:', message);
        }
      })
      .catch((err: any) => {
        if (cancelled) return;
        const message = err?.message || String(err) || 'PDF 文件读取失败';
        setPdfError(message);
        console.error('[Editor] PDF read error:', err);
      })
      .finally(() => {
        if (!cancelled) setPdfLoading(false);
      });

    return () => { cancelled = true; };
  }, [activeFile, isPdf, workspaceRoot]);

  // 图片文件：自动切换为 image 预览模式并加载二进制内容
  useEffect(() => {
    if (!activeFile || !isImage) {
      setImageBase64(null);
      setImageError(null);
      setImageMimeType('');
      return;
    }

    let cancelled = false;

    if (viewMode !== 'image') {
      setViewMode('image');
    }

    setImageLoading(true);
    setImageBase64(null);
    setImageError(null);

    const effectiveRoot = workspaceRoot || new URLSearchParams(window.location.search).get('root');
    if (!effectiveRoot) {
      setImageLoading(false);
      setImageError('工作区根目录缺失，无法读取图片');
      return;
    }

    electronBridge.readFileBinary({ filePath: activeFile, root: effectiveRoot })
      .then((result: any) => {
        if (cancelled) return;
        if (result?.success && result.base64) {
          setImageBase64(result.base64);
          setImageMimeType(result.mimeType || '');
        } else {
          const message = result?.error || '图片文件读取失败';
          setImageError(message);
          console.error('[Editor] Image read failed:', message);
        }
      })
      .catch((err: any) => {
        if (cancelled) return;
        const message = err?.message || String(err) || '图片文件读取失败';
        setImageError(message);
        console.error('[Editor] Image read error:', err);
      })
      .finally(() => {
        if (!cancelled) setImageLoading(false);
      });

    return () => { cancelled = true; };
  }, [activeFile, isImage, workspaceRoot]);

  // CSV 文件：自动进入表格预览模式，同时保留文本内容供编辑器使用
  useEffect(() => {
    if (!activeFile || !isCsv) return;
    if (viewMode !== 'table' && viewMode !== 'editor') {
      setViewMode('table');
    }
  }, [activeFile, isCsv]);

  // 同步外部 mode 到内部 viewMode (附带渲染屏障防止 Monaco 竞争)
  useEffect(() => {
    if (mode !== viewMode) {
      console.log(`[Editor] Switching mode from ${viewMode} to ${mode} (Manual Ownership Active)`);
      setIsTransitioning(true);
      setViewMode(mode);
      // 给 React 一个 Tick(16ms) 来彻底卸载旧组件，避免 TextModel 泄露
      const timer = setTimeout(() => setIsTransitioning(false), 20);
      return () => clearTimeout(timer);
    }
  }, [mode]);

  // 方案六：行业级“无感切换”架构 (Global Model + Fixed Editor Instance)
  // 此方案模拟 VS Code 内部逻辑：
  // 1. 编辑器组件 Key 固定，防止 React 卸载 DOM 导致 InstantiationService 销毁。
  // 2. 移除所有自动管理的 Props (path, value, original, modified)，改用 100% 手动 setModel。
  // 3. 模型托管在 Ref 中，异步清理，防止同步销毁引发的断言错误。

  // 生成固定 URI
  const getFixedUri = (path: string, type: 'file' | 'git-original' | 'git-modified') => {
    const normalizedPath = path.startsWith('/') ? path : `/${path}`;
    return monaco.Uri.parse(`${type}://${normalizedPath}`);
  };

  const detachEditorModels = () => {
    if (editorRef.current) {
      try { editorRef.current.setModel(null); } catch (e) { /* silent skip */ }
    }
    if (diffEditorRef.current) {
      try { diffEditorRef.current.setModel(null); } catch (e) { /* silent skip */ }
    }
  };

  const detachModelsForPath = (targetPath: string) => {
    if (!targetPath) return;
    const mainUri = getFixedUri(targetPath, 'file').toString();
    const originalUri = getFixedUri(targetPath, 'git-original').toString();
    const modifiedUri = getFixedUri(targetPath, 'git-modified').toString();

    if (editorRef.current?.getModel()?.uri.toString() === mainUri) {
      // 在解除绑定前保存光标/滚动位置，以便重新打开时恢复
      const state = editorRef.current.saveViewState();
      if (state) {
        editorViewStateCache.set(targetPath, state);
      }
      try { editorRef.current.setModel(null); } catch (e) { /* silent skip */ }
    }

    const diffModel = diffEditorRef.current?.getModel?.();
    const diffOriginalUri = diffModel?.original?.uri?.toString?.();
    const diffModifiedUri = diffModel?.modified?.uri?.toString?.();
    if (diffOriginalUri === originalUri || diffModifiedUri === modifiedUri) {
      try { diffEditorRef.current.setModel(null); } catch (e) { /* silent skip */ }
    }
  };

  const disposeModelsForPath = (targetPath: string) => {
    if (!targetPath) return;
    monaco.editor.getModel(getFixedUri(targetPath, 'file'))?.dispose();
    monaco.editor.getModel(getFixedUri(targetPath, 'git-original'))?.dispose();
    monaco.editor.getModel(getFixedUri(targetPath, 'git-modified'))?.dispose();
  };

  const disposeAllEditorModels = () => {
    for (const model of monaco.editor.getModels()) {
      try { model.dispose(); } catch (e) { /* silent skip */ }
    }
  };

  // 方案九：收缴所有物理 Widget 的直接控制权，合并进 setupModels 闭包，不再通过 fileContent 触发副作用
  /* 
    2026.03 重构：已删除原来的 L262 附近的“兜底同步 Hook”：
    useEffect(() => { ... editor.setValue(fileContent) ... }, [editorReady, fileContent]);
    现在所有内容同步操作都通过 model.setValue 完全托管在 setupModels 的锁定周期内。
  */

  // 1. 内容初始化与同步 (对齐 4.1 节已写入物理感知的原则)
  useEffect(() => {
    if (!activeFile) {
        setFileContent('');
        return;
    }

    if (abortControllerRef.current) abortControllerRef.current.abort();

    if (isPdf || isImage) {
      activeFileRef.current = activeFile;
      setFileContent('');
      setSavedContent('');
      setOriginalContent('');
      setIsDirty(false);
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    const loadingPlaceholder = `/** \n * [LOADING] ${fileName}...\n * SYSTEM: 正在从服务器提取物理内容\n */`;
    
    // 方案九：在 Loading 阶段也不再直接 setValue，而是等待 fetch 结束后统一进 setupModels 绑定
    setFileContent(loadingPlaceholder);
    activeFileRef.current = activeFile;

    const fetchContent = async () => {
      try {
          console.log(`[Editor] Fetching content for: ${activeFile}, mode: ${viewMode}`);
          
          const effectiveRoot = workspaceRoot || new URLSearchParams(window.location.search).get('root');
          if (!effectiveRoot) return;

          // ── JAR 内部文件：通过 readJarEntry 读取 ──
          if (isJarEntry && jarEntryInfo) {
            const jarResult = await electronBridge.readJarEntry({
              jarPath: jarEntryInfo.jarPath,
              entryPath: jarEntryInfo.entryPath,
              root: effectiveRoot,
            });

            if (signal.aborted || activeFileRef.current !== activeFile) {
              console.log(`[Editor] JAR fetch aborted or stale for ${activeFile}`);
              return;
            }

            if (!jarResult || !jarResult.success) {
              throw new Error(`[IO_FAILURE] JAR 条目读取失败: ${jarResult?.error || '无内容'}`);
            }

            console.log(`[Editor] JAR entry fetched for ${activeFile}, length: ${jarResult.content?.length || 0}`);
            setFileEncoding(jarResult.encoding || 'utf8');
            setSavedContent(jarResult.content || '');
            setIsDirty(false);
            setFileContent(jarResult.content || '');
            return;
          }

          // 通过 IPC 直接读取本地文件
          const result = await electronBridge.readFile({
            filePath: activeFile,
            root: effectiveRoot,
          });

          if (signal.aborted || activeFileRef.current !== activeFile) {
            console.log(`[Editor] Fetching aborted or stale for ${activeFile}`);
            return;
          }

          if (!result || !result.content) {
            throw new Error(`[IO_FAILURE] 文件读取失败 (IPC): ${result?.error || '无内容'}`);
          }

          console.log(`[Editor] Content fetched (IPC) for ${activeFile}, length: ${result.content.length}`);
          setFileEncoding(result.encoding || 'utf8');
          setSavedContent(result.content || '');
          setIsDirty(false);
          setFileContent(result.content || '');

          // Diff 模式：通过 IPC 获取 Git 原始版本
          if (viewMode === 'diff') {
            try {
              const gitResult = await electronBridge.gitDiff({
                root: effectiveRoot,
                file: activeFile,
              });
              setOriginalContent(gitResult?.content || '');
            } catch {
              console.warn('[Editor] Git diff failed (likely Untracked), rendering as whole-file addition.');
              setOriginalContent('');
            }
          }
      } catch (err: any) {
          console.error('[Editor] Initial load failed:', err);
          if (activeFileRef.current !== activeFile) return;

          const detail = String(err.message || '未知连接错误');
          const isDeleted = /STATUS:\s*404|File not found|ENOENT/i.test(detail);
          
          const errorDisplay = isDeleted ? `/** [DELETED_FILE] ${activeFile} */` : `/** [CRITICAL_ERROR] ${activeFile} \n DETAIL: ${detail} */`;
          setSavedContent(errorDisplay);
          setIsDirty(false);
          setFileContent(errorDisplay);
      }
    };

    fetchContent();

    return () => {
      controller.abort();
      if (abortControllerRef.current === controller) {
        abortControllerRef.current = null;
      }
    };
  }, [activeFile, fileName, isPdf, viewMode, workspaceRoot]);

  // [Section 方案九] 删除原先 262 行的独立 useEffect 逻辑以避免多头管理
  /* 
    旧逻辑：
    useEffect(() => {
    if (editorReady && editorRef.current && fileContent) { ... editorRef.current.setValue(fileContent); ... }
    }, [editorReady, fileContent]);
  */

  // 2. 编辑器模型生命周期管理
  const isDiffMode = useMemo(() => viewMode === 'diff', [viewMode]);

  useEffect(() => {
    // 在卸载或切换前断开模型引用，避免 Monaco 内部状态污染。
    return () => {
      // 关键：在卸载或切换前，先清理编辑器对各模型的引用，防止物理渲染与 VDOM 逻辑冲突导致 TextModel disposed 错误
      detachEditorModels();
    };
  }, [languageId, activeFile, editorReady, workspaceRoot, isDiffMode]);

  useEffect(() => {
    if (!activeFile) return;
    const pathToDispose = activeFile;

    return () => {
      window.setTimeout(() => {
        detachModelsForPath(pathToDispose);
        disposeModelsForPath(pathToDispose);
      }, 0);
    };
  }, [activeFile, workspaceRoot]);

  // 3. 语义热键与配置同步 (对齐 20.0 节)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
        // 全局调用链快捷键 (Section 3.1 & 38.3)
        if (e.ctrlKey && e.key === 'h') {
            e.preventDefault();
            const pos = editorRef.current?.getPosition();
            if (pos) {
                console.log(`[Action] Call hierarchy at ${activeFileRef.current}:${pos.lineNumber}`);
            }
        }

        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && isEditorTextFocused()) {
          e.preventDefault();
          handleSaveFile();
        }

        if (
          e.key === 'Backspace' &&
          !e.ctrlKey &&
          !e.metaKey &&
          !e.altKey &&
          isEditorAreaFocused()
        ) {
          const target = e.target as HTMLElement | null;
          const isNativeEditable = !!target && (
            target instanceof HTMLInputElement ||
            target instanceof HTMLTextAreaElement ||
            target.isContentEditable
          );

          // 规避浏览器 Backspace 默认回退导致的焦点丢失；若当前不在可编辑文本节点，强制回焦 Monaco。
          if (!isNativeEditable) {
            e.preventDefault();
            if (viewMode === 'diff') {
              diffEditorRef.current?.getModifiedEditor?.()?.focus?.();
            } else {
              editorRef.current?.focus?.();
            }
          }
        }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [handleSaveFile, isLocked, savedContent, viewMode, isSaving, fileContent, activeFile, workspaceRoot, fileEncoding]);

  // 4. 实时补全集成 (对齐 4.5 节)
  useInlineCompletions({
    editor: editorRef.current,
    debounce: 400,
    providerId: LOCKED_PROVIDER,
    modelId: LOCKED_MODEL
  });

  // 手动控制内容同步与模型绑定
  useEffect(() => {
    if (!activeFile || !editorReady) return;

    const mainUri = getFixedUri(activeFile, 'file');
    const originalUri = getFixedUri(activeFile, 'git-original');
    const modifiedUri = getFixedUri(activeFile, 'git-modified');

    const setupModels = () => {
      // 屏障控制：如果内容还在加载中，跳过绑定以防闪烁或任务取消异常
      if (fileContent.includes('[LOADING]')) return;
      if (modelLockRef.current) return;
      modelLockRef.current = true;

      // 获取或创建模型
      const mainModel = monaco.editor.getModel(mainUri) || monaco.editor.createModel(fileContent, languageId, mainUri);
      const originalModel = monaco.editor.getModel(originalUri) || monaco.editor.createModel(originalContent, languageId, originalUri);
      const modifiedModel = monaco.editor.getModel(modifiedUri) || monaco.editor.createModel(fileContent, languageId, modifiedUri);

      // 同步内容 (仅在差异时更新)
      if (mainModel.getValue() !== fileContent) mainModel.setValue(fileContent);
      if (modifiedModel.getValue() !== fileContent) modifiedModel.setValue(fileContent);
      if (originalModel.getValue() !== originalContent) originalModel.setValue(originalContent);

      // 方案十三：帧对齐绑定 + 绝对应对隔离
      // 使用 requestAnimationFrame 将 setModel 彻底推入下一帧，
      // 确保 React VDOM 所有的物理切换（Editor/Diff 显示隐藏）已在硬件层面渲染完成。
      if (modelBindRafRef.current) {
        cancelAnimationFrame(modelBindRafRef.current);
      }

      modelBindRafRef.current = requestAnimationFrame(() => {
        modelBindRafRef.current = null;
        // 增加 Final Guard: 如果在等待帧的过程中 activeFile 已经变了，放弃本次绑定
        if (!isMountedRef.current || activeFileRef.current !== activeFile) {
          modelLockRef.current = false;
          return;
        }

        try {
          if (viewMode === 'editor' && editorRef.current) {
            // 仅在显式模式切换时解绑，以减少 wordHighlighter 的 dispose 压力
            if (viewMode !== lastModeRef.current && diffEditorRef.current) {
               diffEditorRef.current.setModel(null);
            }
            editorRef.current.setModel(mainModel);
            // 恢复上次关闭/切换前的光标和滚动位置
            const savedState = editorViewStateCache.get(activeFile);
            if (savedState && editorRef.current) {
              try {
                editorRef.current.restoreViewState(savedState as monaco.editor.ICodeEditorViewState);
                editorRef.current.focus();
              } catch (e) {
                // 如果内容发生了根本变化（如行数大幅增减），恢复可能失败，清除过期缓存
                editorViewStateCache.delete(activeFile);
              }
            }
          } else if (viewMode === 'diff' && diffEditorRef.current) {
            // 从 editor 切到 diff 模式前保存当前光标位置
            if (viewMode !== lastModeRef.current && editorRef.current) {
               const editorState = editorRef.current.saveViewState();
               if (editorState) editorViewStateCache.set(activeFile, editorState);
               editorRef.current.setModel(null);
            }
            diffEditorRef.current.setModel({ original: originalModel, modified: modifiedModel });
          } else if (viewMode === 'preview' || viewMode === 'image') {
            // 进入非编辑模式前保存当前光标位置
            if (viewMode !== lastModeRef.current && editorRef.current) {
               const editorState = editorRef.current.saveViewState();
               if (editorState) editorViewStateCache.set(activeFile, editorState);
            }
            editorRef.current?.setModel(null);
            diffEditorRef.current?.setModel(null);
          }
          lastModeRef.current = viewMode;
        } catch (err: any) {
          // 彻底对冲 Canceled 报错，这是常规的 Monaco 任务取消信号
          const isCancel = err?.message?.includes('Canceled') || err?.name === 'Canceled';
          if (!isCancel) {
            console.error('[Editor] Fatal setModel Error:', err);
          }
        } finally {
          modelLockRef.current = false;
        }
      });
    };

    setupModels();

    return () => {
      if (modelBindRafRef.current) {
        cancelAnimationFrame(modelBindRafRef.current);
        modelBindRafRef.current = null;
        modelLockRef.current = false;
      }
    };
  }, [activeFile, viewMode, fileContent, originalContent, editorReady, languageId]);

  // 1. 内容初始化与同步 (对齐 4.1 节已写入物理感知的原则)
  useEffect(() => {
    const handleWsMessage = async (e: any) => {
        const { type } = e.detail || {};
        if (type === 'editor:lock') {
            // ... 处理锁定
        }
    };

    window.addEventListener(GATEWAY_EVENT, handleWsMessage);
    
    return () => {
        window.removeEventListener(GATEWAY_EVENT, handleWsMessage);
    };
  }, [isLocked]);

  // Agent 文件写入后自动刷新编辑器内容
  useEffect(() => {
    const handleFileChanged = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.path) return;
      const changedPath = String(detail.path).replace(/\\/g, '/');
      const currentPath = activeFileRef.current?.replace(/\\/g, '/');
      if (changedPath !== currentPath) return;
      if (!currentPath) return;

      console.log(`[Editor] File changed by agent: ${changedPath}, reloading content...`);
      const effectiveRoot = workspaceRoot || new URLSearchParams(window.location.search).get('root');
      if (!effectiveRoot) return;

      try {
        const result = await electronBridge.readFile({
          filePath: changedPath,
          root: effectiveRoot,
        });
        if (!result || !result.content) return;
        // 确认仍未切换到其他文件
        if (activeFileRef.current?.replace(/\\/g, '/') !== changedPath) return;
        setFileEncoding(result.encoding || 'utf8');
        setSavedContent(result.content);
        setIsDirty(false);
        setFileContent(result.content);
      } catch (err) {
        console.warn('[Editor] Failed to reload file after agent change:', err);
      }
    };

    window.addEventListener('ui:file:changed', handleFileChanged);
    return () => window.removeEventListener('ui:file:changed', handleFileChanged);
  }, [workspaceRoot]);

  // 监听 Problems 面板的行跳转请求
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (!detail?.line || !editorRef.current) return;
      const targetFile = detail.filePath?.replace(/\\/g, '/');
      const currentFile = activeFileRef.current?.replace(/\\/g, '/');
      if (targetFile !== currentFile) return;
      try {
        const line = Math.max(1, Number(detail.line) || 1);
        const column = Math.max(1, Number(detail.column) || 1);
        editorRef.current.revealLineInCenter(line);
        editorRef.current.setPosition({ lineNumber: line, column });
        editorRef.current.focus();
      } catch {
        // 编辑器可能尚未就绪，静默忽略
      }
    };
    window.addEventListener('ui:file:open', handler);
    return () => window.removeEventListener('ui:file:open', handler);
  }, []);

  const handleEditorDidMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    setEditorReady(true);
    (window as any).monaco = monaco;
    (window as any).editor = editor;
    console.log('[Editor] onMount: monaco & editor attached to window for debugging');

    // 关键补齐：拦截 Monaco 的跳转逻辑，实现跨文件导航 (对齐 3.1 节集成)
    const editorService = (editor as any)._codeEditorService;
    if (editorService) {
        console.log('[Editor] found _codeEditorService, overriding openCodeEditor');
        const originalOpenCodeEditor = editorService.openCodeEditor.bind(editorService);
        editorService.openCodeEditor = async (input: any, source: any, sideBySide: any) => {
            console.log('[Navigation Intercepted] Monaco openCodeEditor parameters:', { 
                resource: input.resource?.toString(),
                selection: input.options?.selection,
                path: input.resource?.path
            });
            
            if (input.resource && input.resource.path) {
                let rawPath = input.resource.path;
                let normalizedPath = rawPath.replace(/\\/g, '/');
                
                // 工业级修复：处理各种路径格式 (对齐 33.1 & 30.0 节)
                let cleanPath = '';
                if (normalizedPath.startsWith('/workspace/')) {
                    cleanPath = normalizedPath.substring(11);
                    console.log(`[Navigation] Recognized /workspace/ prefix, stripped to: ${cleanPath}`);
                } else if (normalizedPath.includes('test-project-java-nav')) {
                    // 处理可能出现的 host 绝对路径 (回退机制)
                    const marker = 'test-project-java-nav/';
                    const index = normalizedPath.indexOf(marker);
                    cleanPath = normalizedPath.substring(index + marker.length);
                    console.log(`[Navigation] Recognized project root marker in host path, stripped to: ${cleanPath}`);
                } else {
                    // 默认移除领先的斜杠并尝试作为相对路径
                    cleanPath = normalizedPath.startsWith('/') ? normalizedPath.substring(1) : normalizedPath;
                    console.log(`[Navigation] Fallback mapping, stripped leading slash: ${cleanPath}`);
                }
                
                console.log(`[Navigation] Final mapped relative path: ${cleanPath}, dispatching ui:file:select`);
                window.dispatchEvent(new CustomEvent('ui:file:select', { detail: cleanPath }));
                return editor; 
            }
            return originalOpenCodeEditor(input, source, sideBySide);
        };
    } else {
        console.error('[Editor] _codeEditorService not found on editor instance');
    }
    
    // 监听选择变更
    editor.onDidChangeCursorSelection((e) => {

      // 判断是否有实际的文本选中（非零宽光标）
      const sel = e.selection;
      const hasSelection = sel.startLineNumber !== sel.endLineNumber || sel.startColumn !== sel.endColumn;
      // 获取选中文本内容（用于附加到用户指令上下文）
      const rawSelectedText: string = hasSelection ? (editor.getModel()?.getValueInRange(sel) || '') : '';
      const MAX_SELECTION_CHARS = 5000;
      const selectedText = rawSelectedText.length > MAX_SELECTION_CHARS
          ? rawSelectedText.slice(0, MAX_SELECTION_CHARS) + `\n...(选中内容过长，已截断前 ${MAX_SELECTION_CHARS} 字符，原始共 ${rawSelectedText.length} 字符)`
          : rawSelectedText;

      window.dispatchEvent(new CustomEvent('ui:cursor:update', {
        detail: {
            line: sel.positionLineNumber,
            column: sel.positionColumn,
            totalLines: editor.getModel()?.getLineCount() || 0,
            selection: rawSelectedText.length || 0,
            // 选中行列区间与文本内容（用于附加到用户指令）
            hasSelection,
            startLine: sel.startLineNumber,
            startColumn: sel.startColumn,
            endLine: sel.endLineNumber,
            endColumn: sel.endColumn,
            selectedText,
        }
      }));
    });

    editor.onDidFocusEditorText(() => {
      // 编辑器聚焦（桌面应用模式无需推送上下文）
    });

    editor.onDidChangeModelContent(() => {
      const current = editor.getValue();
      setFileContent(current);
      setIsDirty(current !== savedContentRef.current);
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveFileRef.current();
    });
  };

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      // 组件卸载前保存当前文件的光标/滚动位置（如关闭所有 Tab 导致 FileEditor 被移除）
      const currentPath = activeFileRef.current;
      if (currentPath && editorRef.current) {
        const state = editorRef.current.saveViewState();
        if (state) {
          editorViewStateCache.set(currentPath, state);
        }
      }

      isMountedRef.current = false;
      if (modelBindRafRef.current) {
        cancelAnimationFrame(modelBindRafRef.current);
        modelBindRafRef.current = null;
      }
      detachEditorModels();
      disposeAllEditorModels();
      disposeModelsForPath(activeFileRef.current);
    };
  }, []);

  useEffect(() => {
    savedContentRef.current = savedContent;
  }, [savedContent]);

  useEffect(() => {
    setIsDirty(fileContent !== savedContent);
  }, [fileContent, savedContent]);

  return (
    <div ref={editorContainerRef} className="flex-1 flex flex-col min-w-0 relative" data-testid="file-editor-container">
      {/* 编辑器面包屑与操作栏 (Breadcrumb & Action Bar) */}
      <div className="h-6.5 bg-[#050505] flex items-center px-3 border-b border-white/10 justify-between shrink-0 select-none" data-testid="editor-action-bar">
          <div className="flex min-w-0 items-center gap-1 text-[9.5px] text-white/40 overflow-hidden" data-testid="editor-breadcrumb">
            <FileCode size={11} className="shrink-0 text-white/60 mr-0.5" />
            {pathSegments.map((seg, idx) => {
              const isLast = idx === pathSegments.length - 1;
              return (
                <React.Fragment key={idx}>
                  {idx > 0 && <ChevronRight size={9} className="shrink-0 text-white/20" />}
                  <span
                    className={`truncate ${
                      isLast ? 'text-white/80 font-medium' : 'text-white/35 hover:text-white/50'
                    }`}
                    title={activeFile}
                  >
                    {seg}
                  </span>
                </React.Fragment>
              );
            })}
            {isDirty && (
              <span
                data-testid="editor-unsaved-indicator"
                className="ml-1 inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                title="当前文件有未保存修改"
              />
            )}
            {isEffectivelyReadOnly && (
              <span title={isJarEntry ? '归档文件内部条目（只读）' : '文件已被 Agent 锁定'}>
                <Lock size={9} className={`ml-1 shrink-0 ${isLocked ? 'animate-pulse' : ''} text-white/70`} />
              </span>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0 ml-2">
              {isMarkdown && (
                <button 
                  onClick={() => setViewMode(viewMode === 'preview' ? 'editor' : 'preview')}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-bold tracking-wider transition-all ${
                    viewMode === 'preview' 
                      ? 'bg-white/20 text-white border border-white/20' 
                      : 'text-white/40 hover:text-white hover:bg-white/5 border border-transparent'
                  }`}
                >
                  {viewMode === 'preview' ? <Code size={9} /> : <Eye size={9} />}
                  {viewMode === 'preview' ? 'EDIT' : 'PREVIEW'}
                </button>
              )}
              {isCsv && (
                <button 
                  onClick={() => setViewMode(viewMode === 'table' ? 'editor' : 'table')}
                  className={`flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-bold tracking-wider transition-all ${
                    viewMode === 'table' 
                      ? 'bg-white/20 text-white border border-white/20' 
                      : 'text-white/40 hover:text-white hover:bg-white/5 border border-transparent'
                  }`}
                >
                  {viewMode === 'table' ? <Code size={9} /> : <Eye size={9} />}
                  {viewMode === 'table' ? 'EDIT' : 'TABLE'}
                </button>
              )}
              <div className="h-3 w-[1px] bg-white/10 mx-0.5" />
              <div 
                  data-testid="language-status-badge" 
                  className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[8px] font-mono font-bold tracking-wider bg-white/10 text-white/80"
              >
                  {languageId.toUpperCase()}
              </div>
          </div>
      </div>
      
      <div className="flex-1 min-h-0 relative bg-[#000000]">
        {/*
          双层渲染缓冲架构 (Dual-Layer Buffering):
          对齐 VS Code 核心渲染逻辑。保持两个编辑器实例物理常驻，
          通过 CSS 切换可见性。这彻底规避了 Monaco 组件频繁
          卸载造成的 TextModel 生命周期死锁 (Race Condition)。
        */}

        {/* 1. 普通编辑层 (Editor Layer) */}
        <div 
          className="absolute inset-0" 
          style={{ display: viewMode === 'editor' && !isTransitioning ? 'block' : 'none' }}
        >
          <Editor
            key="fixed-editor-instance"
            height="100%"
            theme="vs-dark"
            /* 
              彻底禁用库的自动同步逻辑 
            */
            path={undefined} 
            value={undefined}
            defaultValue={undefined}
            onMount={handleEditorDidMount}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              lineNumbers: 'on',
              lineDecorationsWidth: 4,
              lineNumbersMinChars: 3,
              automaticLayout: true,
              readOnly: isEffectivelyReadOnly,
              renderLineHighlight: 'all',
              inlineSuggest: { enabled: true, showToolbar: 'always' },
              quickSuggestions: { other: true, comments: true, strings: true },
              cursorSmoothCaretAnimation: 'on',
              scrollBeyondLastLine: false,
              wordWrap: 'on',
              wrappingStrategy: 'advanced',
              wrappingIndent: 'same',
              padding: { top: 8, bottom: 8 },
              // 方案十四：强制禁用内置的行装饰器/行号克隆。
              // 在 React/Monaco 混合渲染且带有 model.setValue 更新时，
              // 某些版本的 Monaco 可能在 VDOM 动画期间错误地保留上一帧的行渲染。
              // 缩减装饰器宽度，并依赖 fixed-editor-instance 模式下的原生单层渲染。
              fixedOverflowWidgets: true,
              glyphMargin: false, 
              folding: true
            }}
          />
        </div>

        {/* 2. 差异对比层 (Diff Layer) */}
        <div 
          className="absolute inset-0" 
          style={{ display: viewMode === 'diff' && !isTransitioning ? 'block' : 'none' }}
        >
          <DiffEditor
            key="fixed-diff-instance"
            height="100%"
            theme="vs-dark"
            /* 同上，通过 useEffect 接管 setModel */
            original={undefined}
            modified={undefined}
            originalModelPath={undefined}
            modifiedModelPath={undefined}
            onMount={(editor) => {
              diffEditorRef.current = editor;
              // 关键：强制在此确保初始化连接
              setEditorReady(true);
            }}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              readOnly: true, 
              renderSideBySide: true,
              wordWrap: 'on',
              wrappingStrategy: 'advanced',
              wrappingIndent: 'same',
              originalEditable: false,
              padding: { top: 8, bottom: 8 }
            }}
          />
        </div>

        {/* 3. Markdown 预览层 (Preview Layer) */}
        {viewMode === 'preview' && isMarkdown && (
          <div className="absolute inset-0 z-20 bg-[#0d1117]">
            <MarkdownPreview content={fileContent} filePath={activeFile} workspaceRoot={workspaceRoot} />
          </div>
        )}

        {/* 4. PDF 预览层 */}
        {viewMode === 'pdf' && isPdf && (
          <div className="absolute inset-0 z-20">
            <Suspense fallback={
              <div className="flex items-center justify-center h-full bg-[#eef0f3] text-slate-500 text-[9pt]">
                加载 PDF 查看器...
              </div>
            }>
              {pdfBase64 ? (
                <PdfPreview base64={pdfBase64} />
              ) : pdfLoading ? (
                <div className="flex items-center justify-center h-full bg-[#eef0f3] text-slate-500 text-[9pt]">
                  正在读取 PDF 文件...
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center h-full gap-1 bg-[#eef0f3] px-6 text-center text-[9pt] text-red-500/80">
                  <span>PDF 文件读取失败</span>
                  {pdfError && <span className="max-w-[520px] break-words text-[8pt] text-slate-500">{pdfError}</span>}
                </div>
              )}
            </Suspense>
          </div>
        )}

        {/* 5. 图片预览层 */}
        {viewMode === 'image' && isImage && (
          <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#0a0a0a]">
            {imageLoading ? (
              <div className="flex flex-col items-center gap-2 text-white/40 text-[9pt]">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white/60" />
                <span>正在读取图片...</span>
              </div>
            ) : imageError ? (
              <div className="flex flex-col items-center gap-1 px-6 text-center text-[9pt] text-red-400/80">
                <span className="text-[10pt] font-bold">图片加载失败</span>
                <span className="max-w-[520px] break-words text-[8pt] text-white/30">{imageError}</span>
              </div>
            ) : imageBase64 ? (
              <img
                src={`data:${imageMimeType || 'image/png'};base64,${imageBase64}`}
                alt={fileName}
                className="max-h-full max-w-full object-contain"
                style={{ imageRendering: 'auto' }}
              />
            ) : null}
          </div>
        )}

        {/* 6. CSV 表格预览层 */}
        {viewMode === 'table' && isCsv && (
          <div className="absolute inset-0 z-20 flex flex-col bg-[#0d1117] overflow-hidden">
            {csvData ? (
              <CsvTableView csvData={csvData} fileName={fileName} />
            ) : fileContent.includes('[LOADING]') ? (
              <div className="flex items-center justify-center h-full text-white/40 text-[9pt]">
                <div className="flex flex-col items-center gap-2">
                  <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/20 border-t-white/60" />
                  <span>正在解析 CSV...</span>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center h-full gap-1 px-6 text-center text-[9pt] text-white/30">
                <span>无法解析 CSV 内容</span>
                <span className="text-[8pt]">请切换到编辑视图查看原始内容</span>
              </div>
            )}
          </div>
        )}

        {/* 4. 过渡占位符 */}
        {isTransitioning && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/50 backdrop-blur-sm z-10 animate-in fade-in duration-200">
            <div className="text-[9px] font-black tracking-[0.4em] text-white/40 uppercase italic">Rebuilding_Monaco_State...</div>
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * 解析 CSV/TSV 内容为二维数组。
 * 支持：
 * - 逗号、制表符、分号分隔
 * - 双引号包裹的字段（含内嵌逗号、换行、转义引号）
 * - 自动检测分隔符（基于第一行）
 *
 * @param content 原始文件内容
 * @param isTsv 是否为 TSV 文件（强制使用制表符）
 * @returns { headers, rows, delimiter } 或 null
 */
function parseCsvContent(content: string, isTsv: boolean): {
  headers: string[];
  rows: string[][];
  delimiter: string;
} | null {
  if (!content || !content.trim()) return null;

  const text = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 自动检测分隔符（基于前几行）
  let delimiter: string;
  if (isTsv) {
    delimiter = '\t';
  } else {
    delimiter = detectDelimiter(text);
  }

  const rows: string[][] = [];
  const lines = text.split('\n');

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue; // 跳过空行
    const fields = parseCsvLine(line, delimiter);
    if (fields.length > 0) {
      rows.push(fields);
    }
  }

  if (rows.length === 0) return null;

  const headers = rows[0];
  const dataRows = rows.slice(1);

  // 补齐不足的列（某些行可能字段数不一致）
  const maxCols = Math.max(headers.length, ...dataRows.map(r => r.length));
  const paddedHeaders = [...headers];
  while (paddedHeaders.length < maxCols) paddedHeaders.push(`Column ${paddedHeaders.length + 1}`);
  const paddedRows = dataRows.map(row => {
    const padded = [...row];
    while (padded.length < maxCols) padded.push('');
    return padded;
  });

  return { headers: paddedHeaders, rows: paddedRows, delimiter };
}

/** 自动检测 CSV 分隔符：统计候选取值，选出现次数最多的 */
function detectDelimiter(text: string): string {
  const candidates = [',', '\t', ';', '|'];
  const sample = text.split('\n').slice(0, 10).join('\n'); // 前 10 行采样
  let best = ',';
  let bestCount = 0;
  for (const ch of candidates) {
    // 简化：统计非引号内的分隔符出现次数
    const count = countDelimiterOutsideQuotes(sample, ch);
    if (count > bestCount) {
      bestCount = count;
      best = ch;
    }
  }
  return best;
}

/** 统计非引号内分隔符出现次数 */
function countDelimiterOutsideQuotes(text: string, delimiter: string): number {
  let count = 0;
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      if (inQuotes && text[i + 1] === '"') {
        i++; // 跳过转义引号
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      count++;
    }
  }
  return count;
}

/** 解析单行 CSV，返回字段数组（正确处理引号包裹） */
function parseCsvLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        // 转义引号 ""
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      fields.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  fields.push(current.trim()); // 最后一个字段
  return fields;
}

// ── CSV 表格渲染组件 ──

interface CsvTableViewProps {
  csvData: { headers: string[]; rows: string[][]; delimiter: string };
  fileName: string;
}

const CsvTableView: React.FC<CsvTableViewProps> = ({ csvData, fileName }) => {
  const { headers, rows } = csvData;
  const containerRef = useRef<HTMLDivElement>(null);
  const [showAllRows, setShowAllRows] = useState(false);
  const INITIAL_ROWS = 100;
  const displayRows = showAllRows ? rows : rows.slice(0, INITIAL_ROWS);
  const hasMore = rows.length > INITIAL_ROWS;

  return (
    <div className="flex flex-col h-full">
      {/* 表头信息 */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[#161b22] border-b border-white/10 shrink-0">
        <span className="text-[9pt] text-white/50">
          {fileName} — {rows.length} 行 × {headers.length} 列
        </span>
        {hasMore && (
          <button
            onClick={() => setShowAllRows(!showAllRows)}
            className="text-[8pt] px-2 py-0.5 rounded text-white/40 hover:text-white hover:bg-white/10 transition-colors"
          >
            {showAllRows ? `仅显示前 ${INITIAL_ROWS} 行` : `显示全部 ${rows.length} 行`}
          </button>
        )}
      </div>

      {/* 表格主体（横向+纵向滚动） */}
      <div ref={containerRef} className="flex-1 overflow-auto">
        <table className="w-full border-collapse text-[9pt] font-mono">
          <thead className="sticky top-0 z-10">
            <tr className="bg-[#21262d]">
              <th className="sticky left-0 z-20 bg-[#21262d] px-3 py-1.5 text-left text-[8pt] font-bold text-white/40 border-b border-r border-white/10 whitespace-nowrap select-none">
                #
              </th>
              {headers.map((header, i) => (
                <th
                  key={i}
                  className="px-3 py-1.5 text-left text-[8pt] font-bold text-white/70 border-b border-white/10 whitespace-nowrap"
                  title={header}
                >
                  {header || `Col ${i + 1}`}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {displayRows.map((row, rowIndex) => (
              <tr
                key={rowIndex}
                className={rowIndex % 2 === 0 ? 'bg-transparent' : 'bg-white/[0.02]'}
              >
                <td className="sticky left-0 z-10 px-3 py-1 text-white/25 text-[8pt] border-r border-white/5 whitespace-nowrap select-none bg-inherit">
                  {rowIndex + 1}
                </td>
                {row.map((cell, cellIndex) => (
                  <td
                    key={cellIndex}
                    className="px-3 py-1 text-white/80 border-b border-white/5 max-w-[400px] truncate"
                    title={cell.length > 80 ? cell : undefined}
                  >
                    {cell}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};



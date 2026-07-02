import React, { useRef, useEffect, useState, useMemo, useCallback, lazy, Suspense } from 'react';
import { Editor, DiffEditor, loader } from '@monaco-editor/react';
import type { OnMount } from '@monaco-editor/react';
import * as monaco from 'monaco-editor';

// 配置内部 Monaco 加载器使用本地实例
loader.config({ monaco });
(window as any).monaco = monaco;

import { Lock, FileCode, Eye, Code, X } from 'lucide-react';
import { useInlineCompletions } from '@/hooks/useInlineCompletions';
import { GATEWAY_EVENT } from '@/config';
import { useAgentContext } from '@/providers/AgentContext';
import { MarkdownPreview } from '@/components/MarkdownPreview';
import { electronBridge } from '@/services/electron-bridge';

// PDF 预览组件按需懒加载（避免为所有用户增加 ~200KB bundle）
const PdfPreview = lazy(() => import('@/components/PdfPreview'));

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
export const FileEditor: React.FC<FileEditorProps> = ({ activeFile, isLocked, mode = 'editor', onClose }) => {
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
  const [viewMode, setViewMode] = useState<'editor' | 'diff' | 'preview' | 'pdf'>(mode);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const diffEditorRef = useRef<any>(null);
  const savedContentRef = useRef('');
  const modelBindRafRef = useRef<number | null>(null);

  const fileName = useMemo(() => activeFile.split(/[/\\]/).pop() || activeFile, [activeFile]);
  const isMarkdown = useMemo(() => activeFile.toLowerCase().endsWith('.md'), [activeFile]);
  const isPdf = useMemo(() => activeFile.toLowerCase().endsWith('.pdf'), [activeFile]);

  // PDF 预览状态
  const [pdfBase64, setPdfBase64] = useState<string | null>(null);
  const [pdfLoading, setPdfLoading] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);

  // 方案七：利用 Ref 维护原子性操作锁，强力干预 Monaco 内部异步 Canceled 链路
  const modelLockRef = useRef<boolean>(false);
  
  // 方案八：引入 AbortController，强制中止过期的网络请求，防止多路更新竞态
  const abortControllerRef = useRef<AbortController | null>(null);
  const isMountedRef = useRef(true);
  const saveFileRef = useRef<() => Promise<void>>(async () => {});

  // 方案十二：模式切换护栏，记录上一次模式，防止在同模式下错误地执行 setModel(null) 触发 wordHighlighter 销毁
  const lastModeRef = useRef<'editor' | 'diff' | 'preview' | 'pdf'>(mode);

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
    if (!activeFile || isLocked || viewMode === 'preview' || viewMode === 'pdf' || isPdf || isSaving) return;

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

  const handleCloseFile = useCallback(() => {
    if (!onClose || isSaving) return;

    if (isDirty && !window.confirm('当前文件有未保存修改，关闭后这些修改将丢失。确定关闭吗？')) {
      return;
    }

    detachEditorModels();
    disposeAllEditorModels();
    onClose();
  }, [isDirty, isSaving, onClose]);

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
      default: return 'plaintext';
    }
  }, [activeFile]);

  // 修改：当文件改变且非 Markdown 时速度重置为 editor 模式
  useEffect(() => {
    if (activeFile && !activeFile.toLowerCase().endsWith('.md') && viewMode === 'preview') {
      console.log(`[Editor] Auto-switching from preview to editor because ${activeFile} is not Markdown`);
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

    if (isPdf) {
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
          } else if (viewMode === 'diff' && diffEditorRef.current) {
            if (viewMode !== lastModeRef.current && editorRef.current) {
               editorRef.current.setModel(null);
            }
            diffEditorRef.current.setModel({ original: originalModel, modified: modifiedModel });
          } else if (viewMode === 'preview') {
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

      window.dispatchEvent(new CustomEvent('ui:cursor:update', {
        detail: {
            line: sel.positionLineNumber,
            column: sel.positionColumn,
            totalLines: editor.getModel()?.getLineCount() || 0,
            selection: editor.getModel()?.getValueInRange(sel).length || 0,
            // 选中行列区间（用于附加到用户指令）
            hasSelection,
            startLine: sel.startLineNumber,
            startColumn: sel.startColumn,
            endLine: sel.endLineNumber,
            endColumn: sel.endColumn,
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
      {/* 编辑器页签栏 (对齐 TECH_SPEC 26.0) */}
      <div className="h-8 bg-[#050505] flex items-center px-3 border-b border-white/15 justify-between" data-testid="editor-tab-bar">
          <div className="flex min-w-0 items-center gap-1.5 text-[10.5px] font-bold text-white/50" data-testid="editor-filename">
            <FileCode size={12} className="shrink-0 text-white/80" />
            <span className="truncate max-w-[260px]" title={activeFile}>{fileName}</span>
            {isDirty && (
              <span
                data-testid="editor-unsaved-indicator"
                className="inline-block h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400"
                title="当前文件有未保存修改"
              />
            )}
            {isLocked && <Lock size={10} className="ml-1 shrink-0 animate-pulse text-white" />}
            {onClose && (
              <button
                type="button"
                onClick={handleCloseFile}
                disabled={isSaving}
                aria-label={`关闭文件 ${fileName}`}
                title={isSaving ? '正在保存，暂不能关闭' : isDirty ? '关闭文件（有未保存修改）' : '关闭文件'}
                data-testid="editor-close-file-btn"
                className="ml-1 flex h-4 w-4 shrink-0 items-center justify-center rounded-sm border border-transparent text-white/35 transition-colors hover:border-white/10 hover:bg-white/10 hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
              >
                <X size={10} strokeWidth={2.4} />
              </button>
            )}
          </div>
          <div className="flex items-center gap-3">
              {isMarkdown && (
                <button 
                  onClick={() => setViewMode(viewMode === 'preview' ? 'editor' : 'preview')}
                  className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[8px] font-black tracking-widest transition-all ${
                    viewMode === 'preview' 
                      ? 'bg-white/20 text-white border border-white/20' 
                      : 'text-white/40 hover:text-white hover:bg-white/5 border border-transparent'
                  }`}
                >
                  {viewMode === 'preview' ? <Code size={10} /> : <Eye size={10} />}
                  {viewMode === 'preview' ? 'EDIT' : 'PREVIEW'}
                </button>
              )}
              <div className="h-4 w-[1px] bg-white/10 mx-0.5" />
              <div 
                  data-testid="language-status-badge" 
                  className="flex items-center gap-1 px-1.5 py-0 rounded text-[8px] font-black tracking-widest bg-white/10 text-white"
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
              readOnly: isLocked,
              renderLineHighlight: 'all',
              inlineSuggest: { enabled: true, showToolbar: 'always' },
              quickSuggestions: { other: true, comments: true, strings: true },
              cursorSmoothCaretAnimation: 'on',
              scrollBeyondLastLine: false,
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
              originalEditable: false,
              padding: { top: 8, bottom: 8 }
            }}
          />
        </div>

        {/* 3. Markdown 预览层 (Preview Layer) */}
        {viewMode === 'preview' && isMarkdown && (
          <div className="absolute inset-0 z-20 bg-[#0d1117]">
            <MarkdownPreview content={fileContent} />
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


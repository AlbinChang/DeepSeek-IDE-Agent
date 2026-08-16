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
import { isSameFilePath } from '@/utils/path';
import { resolveWorkspaceRelativePath } from '@/utils/markdownLinks';

// PDF 预览组件按需懒加载（避免为所有用户增加 ~200KB bundle）
const PdfPreview = lazy(() => import('@/components/PdfPreview'));

/**
 * 编辑器视图状态缓存（跨组件生命周期持久化光标/滚动位置）
 * Key: 文件相对路径, Value: Monaco ICodeEditorViewState
 * 解决用户二次打开同一文件时无法恢复到上次关闭位置的问题
 */
const editorViewStateCache = new Map<string, monaco.editor.IEditorViewState | null>();

/**
 * 文件内容内存缓存（跨 Tab 切换无感秒切，避免重复读取与重新渲染闪烁）
 * Key: 文件相对路径, Value: 文件文本内容
 */
const fileContentCache = new Map<string, string>();

/**
 * 文件已保存物理内容缓存（记录最后一次从磁盘读取或保存成功时的内容，用于准确计算 isDirty）
 */
const fileSavedContentCache = new Map<string, string>();

/**
 * 文件编码缓存
 */
const fileEncodingCache = new Map<string, string>();

/**
 * 文件视图模式缓存（跨文件切换保持各自的查看模式：如 md 的 preview、csv 的 table）
 * Key: 文件相对路径, Value: 'editor' | 'preview' | 'table' | 'pdf' | 'image' | 'diff'
 */
const fileViewModeCache = new Map<string, 'editor' | 'preview' | 'table' | 'pdf' | 'image' | 'diff'>();

function resolveTargetViewMode(
  filePath: string,
  externalMode: 'editor' | 'diff' = 'editor'
): 'editor' | 'diff' | 'preview' | 'pdf' | 'image' | 'table' {
  if (!filePath) return 'editor';
  if (externalMode === 'diff') return 'diff';

  const lower = filePath.toLowerCase();
  const ext = lower.split('.').pop() || '';

  if (lower.endsWith('.pdf')) return 'pdf';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'ico', 'tiff', 'tif'].includes(ext)) return 'image';

  const cached = fileViewModeCache.get(filePath);

  if (lower.endsWith('.md') || lower.endsWith('.markdown')) {
    if (cached === 'preview' || cached === 'editor') return cached;
    return 'editor';
  }

  if (lower.endsWith('.csv') || lower.endsWith('.tsv')) {
    if (cached === 'table' || cached === 'editor') return cached;
    return 'table';
  }

  return 'editor';
}

/**
 * 生成固定 URI（全局静态函数）
 */
function getFixedUri(path: string, type: 'file' | 'git-original' | 'git-modified') {
  const clean = path.replace(/\\/g, '/');
  const normalizedPath = clean.startsWith('/') ? clean : `/${clean}`;
  return monaco.Uri.parse(`${type}://${normalizedPath}`);
}

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
  const [prevActiveFile, setPrevActiveFile] = useState(activeFile);
  const [fileContent, setFileContent] = useState<string>(() => {
    if (!activeFile) return '';
    const mainUri = getFixedUri(activeFile, 'file');
    const existingModel = monaco.editor.getModel(mainUri);
    if (existingModel) return existingModel.getValue();
    return fileContentCache.get(activeFile) || '';
  });
  const [savedContent, setSavedContent] = useState<string>(() => {
    if (!activeFile) return '';
    return fileSavedContentCache.get(activeFile) || '';
  });
  const [fileEncoding, setFileEncoding] = useState<string>(() => {
    if (!activeFile) return 'utf8';
    return fileEncodingCache.get(activeFile) || 'utf8';
  });
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [originalContent, setOriginalContent] = useState<string>('');
  const [viewMode, setViewMode] = useState<'editor' | 'diff' | 'preview' | 'pdf' | 'image' | 'table'>(() =>
    resolveTargetViewMode(activeFile, mode)
  );

  // 关键：当 activeFile 切换时，在 render 阶段立即同步目标文件状态与 viewMode，
  // 彻底消除跨 Tab 切换时的 1 帧陈旧数据传递（解决 md 预览切回其他文件时的内容错乱）
  if (activeFile !== prevActiveFile) {
    setPrevActiveFile(activeFile);
    const targetViewMode = resolveTargetViewMode(activeFile, mode);
    setViewMode(targetViewMode);

    if (!activeFile) {
      setFileContent('');
      setSavedContent('');
      setFileEncoding('utf8');
      setIsDirty(false);
      setOriginalContent('');
    } else {
      const mainUri = getFixedUri(activeFile, 'file');
      const existingModel = monaco.editor.getModel(mainUri);
      const cachedContent = existingModel ? existingModel.getValue() : fileContentCache.get(activeFile);
      const cachedSaved = fileSavedContentCache.get(activeFile);
      const cachedEncoding = fileEncodingCache.get(activeFile) || 'utf8';

      if (cachedContent !== undefined) {
        setFileContent(cachedContent);
        const saved = cachedSaved ?? cachedContent;
        setSavedContent(saved);
        setFileEncoding(cachedEncoding);
        setIsDirty(cachedContent !== saved);
      } else {
        const initialFileName = activeFile.split(/[/\\]/).pop() || activeFile;
        const loadingPlaceholder = `/** \n * [LOADING] ${initialFileName}...\n * SYSTEM: 正在从服务器提取物理内容\n */`;
        setFileContent(loadingPlaceholder);
        setSavedContent('');
        setIsDirty(false);
      }
    }
  }

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

  // 方案十五：编辑器实例自愈（保证 Ctrl+F / 编辑 / 补全始终可用）
  // @monaco-editor/react 4.7 + React 19（含 StrictMode 双挂载 / HMR 时序）存在
  // "编辑器被销毁后不再重建" 的缺陷，会留下一个没有模型/视图的空壳编辑器
  // （症状：内容空白、Ctrl+F 无反应）。通过健康自检检测残废实例，并更换 key
  // 强制重挂载 <Editor> 组件，重建完整实例。
  const [editorInstanceKey, setEditorInstanceKey] = useState(0);
  // 重挂载次数上限：防止根因未消时无限重挂载导致的 React 渲染循环
  const editorRemountCountRef = useRef(0);
  const editorHealthTimerRef = useRef<number | null>(null);
  // Markdown 文件链接提供器（Ctrl+悬停手势 / Ctrl+点击打开文件的注册句柄）
  const markdownLinkProviderRef = useRef<monaco.IDisposable | null>(null);

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
      fileSavedContentCache.set(activeFile, contentToSave);
      fileContentCache.set(activeFile, contentToSave);
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

  // 同步外部 mode 与当前文件对应的 viewMode
  useEffect(() => {
    const targetMode = resolveTargetViewMode(activeFile, mode);
    if (targetMode !== viewMode) {
      console.log(`[Editor] Switching mode for ${activeFile} from ${viewMode} to ${targetMode}`);
      setViewMode(targetMode);
    }
  }, [activeFile, mode, viewMode]);

  const handleToggleMarkdownView = () => {
    const nextMode = viewMode === 'preview' ? 'editor' : 'preview';
    if (activeFile) {
      fileViewModeCache.set(activeFile, nextMode);
    }
    setViewMode(nextMode);
  };

  const handleToggleCsvView = () => {
    const nextMode = viewMode === 'table' ? 'editor' : 'table';
    if (activeFile) {
      fileViewModeCache.set(activeFile, nextMode);
    }
    setViewMode(nextMode);
  };

  // PDF 文件：加载二进制内容
  useEffect(() => {
    if (!activeFile || !isPdf) {
      setPdfBase64(null);
      setPdfError(null);
      return;
    }

    let cancelled = false;

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

  // 图片文件：加载二进制内容
  useEffect(() => {
    if (!activeFile || !isImage) {
      setImageBase64(null);
      setImageError(null);
      setImageMimeType('');
      return;
    }

    let cancelled = false;

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

  // 方案六：行业级“无感切换”架构 (Global Model + Fixed Editor Instance)
  // 此方案模拟 VS Code 内部逻辑：
  // 1. 编辑器组件 Key 固定，防止 React 卸载 DOM 导致 InstantiationService 销毁。
  // 2. 移除所有自动管理的 Props (path, value, original, modified)，改用 100% 手动 setModel。
  // 3. 模型托管在 Ref 中，异步清理，防止同步销毁引发的断言错误。

  const detachEditorModels = () => {
    if (editorRef.current) {
      const currentModel = editorRef.current.getModel();
      if (currentModel && activeFileRef.current) {
        const state = editorRef.current.saveViewState();
        if (state) {
          editorViewStateCache.set(activeFileRef.current, state);
        }
      }
      try { editorRef.current.setModel(null); } catch (e) { /* silent skip */ }
    }
    if (diffEditorRef.current) {
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
        setSavedContent('');
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

    // 在切换目标文件前，保存前一个文件的光标/滚动位置（根据当前 Model 真实路径精准缓存）
    const previousFile = activeFileRef.current;
    if (previousFile && previousFile !== activeFile && editorRef.current) {
      const curModel = editorRef.current.getModel();
      const curModelPath = curModel?.uri.scheme === 'file' ? curModel.uri.path.replace(/^\/+/, '') : previousFile;
      const state = editorRef.current.saveViewState();
      if (state && curModelPath) {
        editorViewStateCache.set(curModelPath, state);
      }
    }
    activeFileRef.current = activeFile;

    const mainUri = getFixedUri(activeFile, 'file');
    const existingModel = monaco.editor.getModel(mainUri);
    const cachedContent = existingModel ? existingModel.getValue() : fileContentCache.get(activeFile);

    // ── 内存缓存快速恢复（0ms 无感秒切）──
    // 当文件此前已打开过（Model 或 Cache 存在），直接复用内存状态，绝不设置 [LOADING] 占位符，
    // 避免重复从磁盘拉取导致的白屏/黑屏闪烁，同时完整保留未保存的编辑内容与光标/撤销栈。
    if (cachedContent !== undefined) {
      const saved = fileSavedContentCache.get(activeFile) ?? cachedContent;
      const encoding = fileEncodingCache.get(activeFile) || 'utf8';
      setFileEncoding(encoding);
      setSavedContent(saved);
      setFileContent(cachedContent);
      setIsDirty(cachedContent !== saved);

      if (viewMode === 'diff') {
        const effectiveRoot = workspaceRoot || new URLSearchParams(window.location.search).get('root');
        if (effectiveRoot) {
          electronBridge.gitDiff({ root: effectiveRoot, file: activeFile })
            .then((gitResult: any) => setOriginalContent(gitResult?.content || ''))
            .catch(() => setOriginalContent(''));
        }
      }
      return;
    }

    const controller = new AbortController();
    abortControllerRef.current = controller;
    const signal = controller.signal;

    const loadingPlaceholder = `/** \n * [LOADING] ${fileName}...\n * SYSTEM: 正在从服务器提取物理内容\n */`;
    setFileContent(loadingPlaceholder);

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
            const content = jarResult.content || '';
            const encoding = jarResult.encoding || 'utf8';
            fileContentCache.set(activeFile, content);
            fileSavedContentCache.set(activeFile, content);
            fileEncodingCache.set(activeFile, encoding);

            // 精准同步/创建对应 activeFile 的 Model
            const targetUri = getFixedUri(activeFile, 'file');
            let model = monaco.editor.getModel(targetUri);
            if (!model) {
              model = monaco.editor.createModel(content, languageId, targetUri);
            } else if (model.getValue() !== content) {
              model.setValue(content);
            }

            if (activeFileRef.current === activeFile) {
              setFileEncoding(encoding);
              setSavedContent(content);
              setIsDirty(false);
              setFileContent(content);
              if (editorRef.current && model && editorRef.current.getModel() !== model) {
                editorRef.current.setModel(model);
              }
            }
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

          // 空文件也属于合法内容（新建文件场景），仅当 success=false 或 content 非字符串时才视为失败
          if (!result || result.success === false || typeof result.content !== 'string') {
            throw new Error(`[IO_FAILURE] 文件读取失败 (IPC): ${result?.error || '无内容'}`);
          }

          console.log(`[Editor] Content fetched (IPC) for ${activeFile}, length: ${result.content.length}`);
          const content = result.content;
          const encoding = result.encoding || 'utf8';
          fileContentCache.set(activeFile, content);
          fileSavedContentCache.set(activeFile, content);
          fileEncodingCache.set(activeFile, encoding);

          // 精准同步/创建对应 activeFile 的 Model
          const targetUri = getFixedUri(activeFile, 'file');
          let model = monaco.editor.getModel(targetUri);
          if (!model) {
            model = monaco.editor.createModel(content, languageId, targetUri);
          } else if (model.getValue() !== content) {
            model.setValue(content);
          }

          if (activeFileRef.current === activeFile) {
            setFileEncoding(encoding);
            setSavedContent(content);
            setIsDirty(false);
            setFileContent(content);
            if (editorRef.current && model && editorRef.current.getModel() !== model) {
              editorRef.current.setModel(model);
            }
          }

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
  }, [activeFile, fileName, isPdf, isImage, viewMode, workspaceRoot, languageId]);

  // 监听 Tab 关闭事件，释放被关闭文件的模型与缓存（防内存泄漏）
  useEffect(() => {
    const handleFileClosed = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      const closedPath = detail?.filePath;
      if (!closedPath) return;
      disposeModelsForPath(closedPath);
      editorViewStateCache.delete(closedPath);
      fileContentCache.delete(closedPath);
      fileSavedContentCache.delete(closedPath);
      fileEncodingCache.delete(closedPath);
      fileViewModeCache.delete(closedPath);
    };
    window.addEventListener('ui:file:close', handleFileClosed);
    return () => window.removeEventListener('ui:file:close', handleFileClosed);
  }, []);

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
    const targetFile = activeFile;

    const mainUri = getFixedUri(targetFile, 'file');
    const originalUri = getFixedUri(targetFile, 'git-original');
    const modifiedUri = getFixedUri(targetFile, 'git-modified');

    const setupModels = () => {
      if (modelLockRef.current) return;
      modelLockRef.current = true;

      // 1. 获取或创建属于当前 targetFile 的 mainModel
      const cachedContent = fileContentCache.get(targetFile);
      const initialText = cachedContent !== undefined ? cachedContent : fileContent;
      let mainModel = monaco.editor.getModel(mainUri);
      if (!mainModel) {
        mainModel = monaco.editor.createModel(initialText, languageId, mainUri);
      }

      // 2. 获取或创建 originalModel 与 modifiedModel（用于 diff）
      let originalModel = monaco.editor.getModel(originalUri);
      if (!originalModel) {
        originalModel = monaco.editor.createModel(originalContent, languageId, originalUri);
      } else if (originalModel.getValue() !== originalContent) {
        originalModel.setValue(originalContent);
      }

      let modifiedModel = monaco.editor.getModel(modifiedUri);
      const modContent = mainModel.getValue();
      if (!modifiedModel) {
        modifiedModel = monaco.editor.createModel(modContent, languageId, modifiedUri);
      } else if (modifiedModel.getValue() !== modContent) {
        modifiedModel.setValue(modContent);
      }

      // 3. 方案十三：帧对齐绑定 + 绝对应对隔离
      // 使用 requestAnimationFrame 将 setModel 彻底推入下一帧，
      // 确保 React VDOM 所有的物理切换（Editor/Diff 显示隐藏）已在硬件层面渲染完成。
      if (modelBindRafRef.current) {
        cancelAnimationFrame(modelBindRafRef.current);
      }

      modelBindRafRef.current = requestAnimationFrame(() => {
        modelBindRafRef.current = null;
        // 增加 Final Guard: 如果在等待帧的过程中 activeFile 已经变了，放弃本次绑定
        if (!isMountedRef.current || activeFileRef.current !== targetFile) {
          modelLockRef.current = false;
          return;
        }

        try {
          if (viewMode === 'editor' && editorRef.current && mainModel) {
            // 仅在显式模式切换时解绑，以减少 wordHighlighter 的 dispose 压力
            if (viewMode !== lastModeRef.current && diffEditorRef.current) {
               diffEditorRef.current.setModel(null);
            }
            if (editorRef.current.getModel() !== mainModel) {
              editorRef.current.setModel(mainModel);
            }
            // 恢复上次关闭/切换前的光标和滚动位置
            const savedState = editorViewStateCache.get(targetFile);
            if (savedState && editorRef.current) {
              try {
                editorRef.current.restoreViewState(savedState as monaco.editor.ICodeEditorViewState);
                editorRef.current.focus();
              } catch (e) {
                // 如果内容发生了根本变化（如行数大幅增减），恢复可能失败，清除过期缓存
                editorViewStateCache.delete(targetFile);
              }
            }
          } else if (viewMode === 'diff' && diffEditorRef.current && originalModel && modifiedModel) {
            // 从 editor 切到 diff 模式前保存当前光标位置
            if (viewMode !== lastModeRef.current && editorRef.current) {
               const editorState = editorRef.current.saveViewState();
               if (editorState) editorViewStateCache.set(targetFile, editorState);
            }
            diffEditorRef.current.setModel({ original: originalModel, modified: modifiedModel });
          } else {
            // 进入非编辑模式（preview/pdf/image/table 等）前保存当前光标位置
            if (viewMode !== lastModeRef.current && editorRef.current && editorRef.current.getModel()) {
               const editorState = editorRef.current.saveViewState();
               if (editorState) {
                 const curModel = editorRef.current.getModel();
                 const curPath = curModel?.uri.scheme === 'file' ? curModel.uri.path.replace(/^\/+/, '') : targetFile;
                 if (curPath) editorViewStateCache.set(curPath, editorState);
               }
            }
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
  }, [activeFile, viewMode, originalContent, editorReady, languageId, editorInstanceKey]);

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

  // Agent 文件写入后自动刷新编辑器内容（全量模型与缓存同步）
  useEffect(() => {
    const handleFileChanged = async (e: Event) => {
      const detail = (e as CustomEvent).detail;
      // 兼容相对 path 与绝对 absolutePath（服务端 tool/result 注解同时携带两者）
      if (!detail?.path && !detail?.absolutePath) return;
      const effectiveRoot = workspaceRoot || new URLSearchParams(window.location.search).get('root');
      if (!effectiveRoot) return;

      const targetPath = String(detail.absolutePath || detail.path || '');
      if (!targetPath) return;

      console.log(`[Editor] File changed by agent: ${targetPath}, reloading content...`);
      try {
        const result = await electronBridge.readFile({
          filePath: targetPath,
          root: effectiveRoot,
        });

        // 处理文件被物理删除场景
        if (!result || result.success === false) {
          const errMsg = String(result?.error || '');
          if (/File not found|ENOENT/i.test(errMsg)) {
            // 清理缓存
            for (const key of Array.from(fileContentCache.keys())) {
              if (isSameFilePath(key, targetPath, effectiveRoot)) {
                fileContentCache.delete(key);
                fileSavedContentCache.delete(key);
                fileEncodingCache.delete(key);
                editorViewStateCache.delete(key);
              }
            }
            // 同步已存在的模型
            const allModels = monaco.editor.getModels();
            for (const model of allModels) {
              if (model.uri.scheme === 'file') {
                const modelPath = model.uri.path.replace(/^\/+/, '');
                if (isSameFilePath(modelPath, targetPath, effectiveRoot)) {
                  model.setValue(`/** [DELETED_FILE] ${targetPath} */`);
                }
              }
            }
            if (isSameFilePath(activeFileRef.current || '', targetPath, effectiveRoot)) {
              setFileContent(`/** [DELETED_FILE] ${targetPath} */`);
              setSavedContent(`/** [DELETED_FILE] ${targetPath} */`);
              setIsDirty(false);
            }
          }
          return;
        }

        if (typeof result.content !== 'string') return;
        const newContent = result.content;
        const encoding = result.encoding || 'utf8';

        // 1. 同步更新所有匹配的内存缓存项（无论是相对路径、绝对路径还是不同斜杠格式）
        for (const key of Array.from(fileContentCache.keys())) {
          if (isSameFilePath(key, targetPath, effectiveRoot)) {
            fileContentCache.set(key, newContent);
            fileSavedContentCache.set(key, newContent);
            fileEncodingCache.set(key, encoding);
          }
        }
        if (detail.path) {
          fileContentCache.set(detail.path, newContent);
          fileSavedContentCache.set(detail.path, newContent);
          fileEncodingCache.set(detail.path, encoding);
        }
        if (detail.absolutePath) {
          fileContentCache.set(detail.absolutePath, newContent);
          fileSavedContentCache.set(detail.absolutePath, newContent);
          fileEncodingCache.set(detail.absolutePath, encoding);
        }
        if (activeFileRef.current && isSameFilePath(activeFileRef.current, targetPath, effectiveRoot)) {
          fileContentCache.set(activeFileRef.current, newContent);
          fileSavedContentCache.set(activeFileRef.current, newContent);
          fileEncodingCache.set(activeFileRef.current, encoding);
        }

        // 2. 同步更新所有已存在的 Monaco 模型（覆盖当前激活和后台已打开的 Tab）
        const allModels = monaco.editor.getModels();
        for (const model of allModels) {
          if (model.uri.scheme === 'file') {
            const modelPath = model.uri.path.replace(/^\/+/, '');
            if (isSameFilePath(modelPath, targetPath, effectiveRoot)) {
              if (model.getValue() !== newContent) {
                model.setValue(newContent);
              }
            }
          }
        }

        // 3. 若变更的文件为当前正处于激活状态的文件，立即更新 React 状态与视图
        const currentActive = activeFileRef.current || '';
        if (isSameFilePath(currentActive, targetPath, effectiveRoot)) {
          // 确保当前编辑器绑定的模型内容最新
          const currentEditorModel = editorRef.current?.getModel();
          if (currentEditorModel && currentEditorModel.getValue() !== newContent) {
            currentEditorModel.setValue(newContent);
          }

          setFileEncoding(encoding);
          setSavedContent(newContent);
          setIsDirty(false);
          setFileContent(newContent);

          // Diff 模式下自动刷新 Git 差异对比
          if (viewMode === 'diff') {
            electronBridge.gitDiff({ root: effectiveRoot, file: currentActive })
              .then((gitResult: any) => setOriginalContent(gitResult?.content || ''))
              .catch(() => setOriginalContent(''));
          }
        }
      } catch (err) {
        console.warn('[Editor] Failed to reload file after agent change:', err);
      }
    };

    window.addEventListener('ui:file:changed', handleFileChanged);
    return () => window.removeEventListener('ui:file:changed', handleFileChanged);
  }, [workspaceRoot, viewMode]);

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

    // ── Markdown 文件链接提供器（2026.08：编辑模式下 Ctrl+悬停显示超链接手势、Ctrl+点击打开文件） ──
    // Monaco 默认仅检测 http(s)/mailto 等 URL；对于 `[text](docs/user/guide/python-sdk.md)` 这类
    // 工作区相对链接，需要自定义 LinkProvider 提供 range + file:// URI 才能被识别。
    // 完整链路：检测到链接（下划线）→ Ctrl/Cmd+悬停显示手型光标（isEnabled 检查 hasTriggerModifier）
    // → Ctrl/Cmd+点击 → LinkDetector.openLinkOccurrence → openerService.open(file://uri)
    // → EditorOpener → _codeEditorService.openCodeEditor（上方已重写）→ ui:file:select → 打开文件。
    if (markdownLinkProviderRef.current) {
        markdownLinkProviderRef.current.dispose();
        markdownLinkProviderRef.current = null;
    }
    try {
        markdownLinkProviderRef.current = monaco.languages.registerLinkProvider('markdown', {
            provideLinks: (model) => {
                const content = model.getValue();
                // 从模型 URI 推导当前 MD 文件的工作区相对路径（用于解析 ./ 与 ../）
                const sourceFilePath = model.uri?.scheme === 'file'
                    ? String(model.uri.path || '').replace(/^\/+/, '')
                    : '';
                const links: monaco.languages.ILink[] = [];
                // 匹配 [text](url)（URL 不含空格/换行；忽略 title 语法）
                const linkRegex = /\[([^\]]*)\]\(([^)\s]+)\)/g;
                let m: RegExpExecArray | null;
                while ((m = linkRegex.exec(content)) !== null) {
                    const rawUrl = (m[2] || '').trim();
                    if (!rawUrl || rawUrl.startsWith('#')) continue; // 空链接 / 锚点
                    if (/^(https?:|mailto:|tel:)/i.test(rawUrl)) continue; // 外部协议走默认行为
                    // URL 在内容中的偏移：'[' + text + '](' 之后
                    const urlStart = m.index + (m[1]?.length || 0) + 3;
                    const urlEnd = urlStart + rawUrl.length;
                    const resolved = resolveWorkspaceRelativePath(rawUrl, sourceFilePath);
                    if (!resolved) continue;
                    const start = model.getPositionAt(urlStart);
                    const end = model.getPositionAt(urlEnd);
                    links.push({
                        range: new monaco.Range(start.lineNumber, start.column, end.lineNumber, end.column),
                        url: monaco.Uri.parse(`file:///${resolved.replace(/\\/g, '/')}`),
                        tooltip: `打开文件: ${resolved}`,
                    });
                }
                return { links };
            },
        });
        console.log('[Editor] markdown link provider registered (Ctrl+hover → hand cursor, Ctrl+click → open file)');
    } catch (err) {
        console.warn('[Editor] markdown link provider registration failed:', err);
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
      const model = editor.getModel();
      if (!model) return;
      const modelUriPath = model.uri.scheme === 'file'
        ? model.uri.path.replace(/^\/+/, '')
        : '';
      const current = model.getValue();

      if (modelUriPath) {
        fileContentCache.set(modelUriPath, current);
      }

      if (modelUriPath && isSameFilePath(modelUriPath, activeFileRef.current, workspaceRoot)) {
        setFileContent(current);
        const saved = fileSavedContentCache.get(modelUriPath) ?? current;
        setIsDirty(current !== saved);
      }
    });

    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void saveFileRef.current();
    });

    // 显式绑定 Ctrl+F / Cmd+F → 打开查找组件（2026.08 修复：Ctrl+F 查找失效）
    // 兜底：即使 Monaco 默认键位因环境 / 其他插件被覆盖或丢失，也保证查找可用。
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => {
      const findAction = editor.getAction('actions.find');
      if (findAction) {
        void findAction.run();
      }
    });

    // 自愈重挂载 / 编辑器实例重建后，立即把当前文件模型绑定到新实例，
    // 保证内容显示与 Ctrl+F 立即可用（不依赖 setupModels 的 RAF 时序，
    // 修复 2026.08 发现的"重挂载后模型未绑定、编辑器空白"问题）。
    try {
      const bindPath = activeFileRef.current;
      if (bindPath) {
        const bindUri = getFixedUri(bindPath, 'file');
        const cached = fileContentCache.get(bindPath);
        let bindModel = monaco.editor.getModel(bindUri);
        if (!bindModel && cached && !cached.includes('[LOADING]') && !cached.includes('[CRITICAL_ERROR]')) {
          bindModel = monaco.editor.createModel(cached, languageId, bindUri);
        }
        if (bindModel && editor.getModel() !== bindModel) {
          editor.setModel(bindModel);
        }
      }
    } catch (err) {
      // 首帧内容未就绪等情况：跳过，后续由 setupModels 统一绑定
      console.warn('[Editor] onMount direct model bind skipped:', err);
    }
  };

  // 方案十五：编辑器健康自检（保证 Ctrl+F / 编辑始终可用）
  // 挂载完成且处于 editor 模式、文件内容就绪后，短暂延迟检查主编辑器是否处于
  // "已创建但已残废"（getDomNode 为空 = 无视图/无模型）状态；若残废则更换 key
  // 强制重挂载 <Editor>，重建完整实例。此检查仅在 editor 模式且内容已加载时
  // 生效，避免在 diff / preview / 模式切换过渡期误触发。
  const isEditorHealthy = () => {
    const ed = editorRef.current;
    try {
      return !!ed && typeof ed.getDomNode === 'function' && !!ed.getDomNode();
    } catch {
      return false;
    }
  };

  useEffect(() => {
    if (!editorReady) return;
    if (viewMode !== 'editor') return;
    if (!activeFile || fileContent.includes('[LOADING]') || fileContent.includes('[CRITICAL_ERROR]')) return;
    if (editorRemountCountRef.current >= 3) return; // 重挂载上限，防止死循环

    if (editorHealthTimerRef.current) {
      window.clearTimeout(editorHealthTimerRef.current);
    }
    editorHealthTimerRef.current = window.setTimeout(() => {
      editorHealthTimerRef.current = null;
      if (!isMountedRef.current) return;
      if (isEditorHealthy()) return;
      // 编辑器残废 → 强制重挂载（新的 key 会让 React 重建 <Editor> 组件，
      // 重置 @monaco-editor/react 内部的 "already created" 守卫）
      console.warn('[Editor] Detected unhealthy editor instance, force remount to restore editing / Ctrl+F');
      editorRemountCountRef.current += 1;
      setEditorInstanceKey(k => k + 1);
    }, 150);

    return () => {
      if (editorHealthTimerRef.current) {
        window.clearTimeout(editorHealthTimerRef.current);
        editorHealthTimerRef.current = null;
      }
    };
  }, [editorReady, editorInstanceKey, viewMode, activeFile, fileContent]);

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
      // 清理编辑器健康自检定时器
      if (editorHealthTimerRef.current) {
        window.clearTimeout(editorHealthTimerRef.current);
        editorHealthTimerRef.current = null;
      }
      // 注销 Markdown 链接提供器
      if (markdownLinkProviderRef.current) {
        try {
          markdownLinkProviderRef.current.dispose();
        } catch {
          /* silent */
        }
        markdownLinkProviderRef.current = null;
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
                  onClick={handleToggleMarkdownView}
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
                  onClick={handleToggleCsvView}
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
          style={{ display: viewMode === 'editor' ? 'block' : 'none' }}
        >
          <Editor
            key={`fixed-editor-instance-${editorInstanceKey}`}
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
              // 2026.08: 显式开启/配置查找组件，保证 Ctrl+F 稳定可用：
              // - autoFindInSelection: 多行选区时 Ctrl+F 自动开启"在选区中查找"
              // - seedSearchStringFromSelection: 从当前选中/光标处单词预填搜索词
              // - addExtraSpaceOnTop: 保持顶部空间稳定，避免查找栏弹出时内容跳动
              find: {
                addExtraSpaceOnTop: false,
                autoFindInSelection: 'multiline',
                seedSearchStringFromSelection: 'selection',
              },
              // 方案十四：强制禁用内置的行装饰器/行号克隆。
              // 在 React/Monaco 混合渲染且带有 model.setValue 更新时，
              // 某些版本的 Monaco 可能在 VDOM 动画期间错误地保留上一帧的行渲染。
              // 缩减装饰器宽度，并依赖 fixed-editor-instance 模式下的原生单层渲染。
              fixedOverflowWidgets: true,
              glyphMargin: false, 
              folding: true,
              // 2026.08: 显式开启链接检测（配合自定义 markdown LinkProvider，
              // 支持 [text](相对路径) 的 Ctrl+悬停手型光标与 Ctrl+点击打开文件）
              links: true
            }}
          />
        </div>

        {/* 2. 差异对比层 (Diff Layer) */}
        <div 
          className="absolute inset-0" 
          style={{ display: viewMode === 'diff' ? 'block' : 'none' }}
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



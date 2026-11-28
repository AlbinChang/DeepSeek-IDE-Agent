import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Box, Download, Grid3x3, Loader2, Pause, Play, RotateCcw } from 'lucide-react';
import { electronBridge } from '@/services/electron-bridge';
import { isSameFilePath } from '@/utils/path';
import {
    createPreview,
    SCENE3D_SCHEMA,
    type Scene3dPreviewHandle,
    type Scene3dSpec,
    type Scene3dStats,
} from '@/three/scene-runtime';

/**
 * 3D 预览：.glb / .gltf / .obj / .stl 模型与 .scene3d.json 声明式场景。
 * 渲染逻辑全部复用 @/three/scene-runtime，与服务端无头预渲染保持同一实现。
 */

type ModelKind = 'scene3d' | 'gltf' | 'glb' | 'obj' | 'stl';

interface Model3DPreviewProps {
    filePath: string;
    content: string;
    workspaceRoot?: string | null;
}

const MIME_BY_EXT: Record<string, string> = {
    bin: 'application/octet-stream',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    webp: 'image/webp',
    ktx2: 'image/ktx2',
    glb: 'model/gltf-binary',
    gltf: 'model/gltf+json',
};

function resolveKind(filePath: string): ModelKind | null {
    const lower = filePath.toLowerCase();
    if (lower.endsWith('.scene3d.json')) return 'scene3d';
    if (lower.endsWith('.glb')) return 'glb';
    if (lower.endsWith('.gltf')) return 'gltf';
    if (lower.endsWith('.obj')) return 'obj';
    if (lower.endsWith('.stl')) return 'stl';
    return null;
}

function joinWorkspacePath(baseDir: string, src: string): string {
    if (/^(?:[a-zA-Z]:[\\/]|\/|data:|https?:|blob:)/.test(src)) return src;
    const parts = `${baseDir}/${src}`.replace(/\\/g, '/').split('/');
    const output: string[] = [];
    for (const part of parts) {
        if (!part || part === '.') continue;
        if (part === '..') output.pop();
        else output.push(part);
    }
    return output.join('/');
}

function dirnameOf(filePath: string): string {
    const normalized = filePath.replace(/\\/g, '/');
    const index = normalized.lastIndexOf('/');
    return index >= 0 ? normalized.slice(0, index) : '';
}

function base64ToBlob(base64: string, mime: string): Blob {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new Blob([bytes], { type: mime });
}

function mimeOf(path: string): string {
    const ext = path.split('.').pop()?.toLowerCase() ?? '';
    return MIME_BY_EXT[ext] || 'application/octet-stream';
}

function formatNumber(value: number): string {
    return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(value);
}

function formatSize(size: [number, number, number]): string {
    return size.map((value) => value.toFixed(2)).join(' × ');
}

export const Model3DPreview: React.FC<Model3DPreviewProps> = ({ filePath, content, workspaceRoot }) => {
    const kind = useMemo(() => resolveKind(filePath), [filePath]);
    const isTextBased = kind !== null && kind !== 'glb' && kind !== 'stl';
    const contentPending = isTextBased && (!content || content.includes('[LOADING]') || content.includes('[CRITICAL_ERROR]'));
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const handleRef = useRef<Scene3dPreviewHandle | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [stats, setStats] = useState<Scene3dStats | null>(null);
    const [wireframe, setWireframe] = useState(false);
    const [gridVisible, setGridVisible] = useState(true);
    const [autoRotate, setAutoRotate] = useState(false);
    const [reloadToken, setReloadToken] = useState(0);

    const effectiveRoot = workspaceRoot || new URLSearchParams(window.location.search).get('root') || '';

    // 模型文件由 Agent 覆写时（尤其二进制模型）需要主动重载
    useEffect(() => {
        if (isTextBased) return;
        const onFileChanged = (event: Event) => {
            const detail = (event as CustomEvent).detail;
            const target = String(detail?.absolutePath || detail?.path || '');
            if (!target || !isSameFilePath(target, filePath, effectiveRoot)) return;
            setReloadToken((value) => value + 1);
        };
        window.addEventListener('ui:file:changed', onFileChanged);
        return () => window.removeEventListener('ui:file:changed', onFileChanged);
    }, [effectiveRoot, filePath, isTextBased]);

    useEffect(() => {
        if (!kind) return;
        if (contentPending) return;

        let cancelled = false;
        let handle: Scene3dPreviewHandle | null = null;
        const objectUrls: string[] = [];

        const blobUrl = (blob: Blob): string => {
            const url = URL.createObjectURL(blob);
            objectUrls.push(url);
            return url;
        };

        const readBinary = async (relativePath: string): Promise<Blob> => {
            const result = await electronBridge.readFileBinary({ filePath: relativePath, root: effectiveRoot });
            if (!result?.success || !result.base64) {
                throw new Error(result?.error || `读取文件失败: ${relativePath}`);
            }
            return base64ToBlob(result.base64, result.mimeType || mimeOf(relativePath));
        };

        const readText = async (relativePath: string): Promise<string> => {
            const result = await electronBridge.readFile({ filePath: relativePath, root: effectiveRoot });
            if (!result?.success || typeof result.content !== 'string') {
                throw new Error(result?.error || `读取文件失败: ${relativePath}`);
            }
            return result.content;
        };

        const resolveModelUrl = async (src: string): Promise<string> => {
            if (/^(?:data:|https?:|blob:)/.test(src)) return src;
            const absolute = joinWorkspacePath(dirnameOf(filePath), src);
            const extension = absolute.split('.').pop()?.toLowerCase() ?? '';
            if (extension === 'gltf') {
                const text = await readText(absolute);
                return blobUrl(new Blob([await inlineGltfResources(text, absolute)], { type: 'model/gltf+json' }));
            }
            if (extension === 'obj') {
                return blobUrl(new Blob([await readText(absolute)], { type: 'text/plain' }));
            }
            return blobUrl(await readBinary(absolute));
        };

        // .gltf 的外部 .bin/贴图先内联成 blob URL，避免 GLTFLoader 以 blob 基址解析相对路径失败
        const inlineGltfResources = async (text: string, absolute: string): Promise<string> => {
            const json = JSON.parse(text);
            const baseDir = dirnameOf(absolute) || dirnameOf(filePath);
            const inline = async (entry: { uri?: unknown } | undefined) => {
                if (!entry || typeof entry.uri !== 'string' || entry.uri.startsWith('data:')) return;
                const target = joinWorkspacePath(baseDir, entry.uri);
                entry.uri = blobUrl(await readBinary(target));
            };
            for (const buffer of json.buffers ?? []) await inline(buffer);
            for (const image of json.images ?? []) await inline(image);
            return JSON.stringify(json);
        };

        const buildSpec = async (): Promise<{ spec: Scene3dSpec; resolveUrl: (src: string) => string | Promise<string> }> => {
            if (kind === 'scene3d') {
                const spec = JSON.parse(content) as Scene3dSpec;
                if (!spec || !Array.isArray(spec.objects)) {
                    throw new Error('场景文件缺少 objects 数组（schema 应为 scene3d/v1）');
                }
                return { spec, resolveUrl: resolveModelUrl };
            }
            if (kind === 'glb' || kind === 'stl') {
                const url = blobUrl(await readBinary(filePath));
                return {
                    spec: modelSpec(filePath),
                    resolveUrl: (src) => (src === filePath ? url : resolveModelUrl(src)),
                };
            }
            if (kind === 'gltf') {
                const json = await inlineGltfResources(content, filePath);
                const url = blobUrl(new Blob([json], { type: 'model/gltf+json' }));
                return {
                    spec: modelSpec(filePath),
                    resolveUrl: (src) => (src === filePath ? url : resolveModelUrl(src)),
                };
            }
            // .obj 可能被编辑器读取上限截断，预览统一走二进制通道保证完整
            const url = blobUrl(await readBinary(filePath));
            return {
                spec: modelSpec(filePath),
                resolveUrl: (src) => (src === filePath ? url : resolveModelUrl(src)),
            };
        };

        const run = async () => {
            setLoading(true);
            setError(null);
            setStats(null);
            setWireframe(false);
            setGridVisible(true);
            setAutoRotate(false);
            try {
                const { spec, resolveUrl } = await buildSpec();
                if (cancelled || !canvasRef.current) return;
                const created = await createPreview(canvasRef.current, spec, {
                    interactive: true,
                    resolveUrl,
                });
                if (cancelled) {
                    created.dispose();
                    return;
                }
                handle = created;
                handleRef.current = created;
                setStats(created.stats());
                setLoading(false);
            } catch (err) {
                if (cancelled) return;
                console.error('[3D] preview failed', err);
                setError(err instanceof Error ? err.message : String(err));
                setLoading(false);
            }
        };

        void run();

        return () => {
            cancelled = true;
            handle?.dispose();
            handleRef.current = null;
            for (const url of objectUrls) URL.revokeObjectURL(url);
        };
    }, [content, contentPending, effectiveRoot, filePath, isTextBased, kind, reloadToken]);

    useEffect(() => {
        const element = containerRef.current;
        if (!element) return;
        const observer = new ResizeObserver(() => handleRef.current?.resize());
        observer.observe(element);
        return () => observer.disconnect();
    }, []);

    const handleReset = useCallback(() => handleRef.current?.resetView(), []);
    const handleToggleWireframe = useCallback(() => {
        setWireframe((value) => {
            handleRef.current?.setWireframe(!value);
            return !value;
        });
    }, []);
    const handleToggleGrid = useCallback(() => {
        setGridVisible((value) => {
            handleRef.current?.setGrid(!value);
            return !value;
        });
    }, []);
    const handleToggleRotate = useCallback(() => {
        setAutoRotate((value) => {
            handleRef.current?.setAutoRotate(!value);
            return !value;
        });
    }, []);
    const handleSnapshot = useCallback(() => {
        const dataUrl = handleRef.current?.snapshot();
        if (!dataUrl) return;
        const anchor = document.createElement('a');
        const stem = (filePath.split(/[/\\]/).pop() || 'preview').replace(/\.[^.]+$/, '');
        anchor.href = dataUrl;
        anchor.download = `${stem}-preview.png`;
        anchor.click();
    }, [filePath]);

    const toolbarButton = 'flex items-center gap-1 px-1.5 py-1 rounded text-[8px] font-mono font-bold tracking-wider border transition-colors';
    const toolbarIdle = 'bg-black/60 text-white/60 border-white/10 hover:text-white hover:border-white/30';
    const toolbarActive = 'bg-white/20 text-white border-white/40';
    const showLoading = loading || contentPending;

    return (
        <div className="absolute inset-0 z-20 flex flex-col bg-[#0a0a0a]" data-testid="model-3d-preview">
            <div ref={containerRef} className="relative flex-1 min-h-0 overflow-hidden">
                <canvas ref={canvasRef} className="block h-full w-full" />

                <div className="absolute right-2 top-2 flex items-center gap-1">
                    <button
                        type="button"
                        onClick={handleToggleGrid}
                        className={`${toolbarButton} ${gridVisible ? toolbarActive : toolbarIdle}`}
                        title="显示/隐藏地面网格"
                    >
                        <Grid3x3 size={9} />
                        GRID
                    </button>
                    <button
                        type="button"
                        onClick={handleToggleWireframe}
                        className={`${toolbarButton} ${wireframe ? toolbarActive : toolbarIdle}`}
                        title="线框模式"
                    >
                        <Box size={9} />
                        WIRE
                    </button>
                    <button
                        type="button"
                        onClick={handleToggleRotate}
                        className={`${toolbarButton} ${autoRotate ? toolbarActive : toolbarIdle}`}
                        title="自动旋转"
                    >
                        {autoRotate ? <Pause size={9} /> : <Play size={9} />}
                        SPIN
                    </button>
                    <button type="button" onClick={handleReset} className={`${toolbarButton} ${toolbarIdle}`} title="重置视角">
                        <RotateCcw size={9} />
                        RESET
                    </button>
                    <button type="button" onClick={handleSnapshot} className={`${toolbarButton} ${toolbarIdle}`} title="保存当前画面为 PNG">
                        <Download size={9} />
                        PNG
                    </button>
                </div>

                {stats && !showLoading && !error && (
                    <div className="pointer-events-none absolute bottom-2 left-2 rounded border border-white/10 bg-black/70 px-2 py-1 font-mono text-[8px] leading-4 text-white/50">
                        <div>
                            {kind?.toUpperCase()} · {formatNumber(stats.triangles)} tris · {stats.meshes} meshes · {stats.drawCalls} calls
                            {stats.animations > 0 ? ` · ${stats.animations} anim` : ''}
                        </div>
                        <div>
                            bounds {formatSize(stats.bounds.size)} · center {formatSize(stats.bounds.center)}
                        </div>
                    </div>
                )}

                {showLoading && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#0a0a0a]/80 text-white/50">
                        <Loader2 size={16} className="animate-spin" />
                        <span className="text-[9pt]">正在构建 3D 场景…</span>
                    </div>
                )}

                {error && (
                    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-[#0a0a0a]/90 px-8 text-center">
                        <AlertTriangle size={18} className="text-amber-400/80" />
                        <span className="text-[10pt] font-bold text-white/80">3D 预览失败</span>
                        <span className="max-w-[620px] break-words font-mono text-[8pt] text-white/40">{error}</span>
                    </div>
                )}
            </div>
        </div>
    );
};

function modelSpec(src: string): Scene3dSpec {
    return {
        schema: SCENE3D_SCHEMA,
        render: { grid: true, environment: 'studio' },
        objects: [{ type: 'model', src, castShadow: true, receiveShadow: true }],
    };
}

export default Model3DPreview;

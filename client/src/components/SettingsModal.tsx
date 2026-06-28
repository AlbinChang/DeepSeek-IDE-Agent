import React, { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useAgentContext } from '@/providers/AgentContext';
import type { ModelProviderConfig } from '@/providers/AgentContext';
import { X, Save, Cloud, Hammer, Globe, ChevronDown, Plus, Trash2, Loader2, ShieldCheck, AlertTriangle } from 'lucide-react';
import { USER_ID, API_BASE } from '@/config';
import { electronBridge } from '@/services/electron-bridge';

interface SettingsModalProps {
    isOpen: boolean;
    onClose: () => void;
}

type ConnectionTestState = {
    status: 'idle' | 'testing' | 'success' | 'error';
    message?: string;
    latencyMs?: number;
};

type EditableProviderConfig = ModelProviderConfig & {
    draftKey: string;
};

const createDraftKey = () => `provider-draft-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

const createDefaultProvider = (seed: number): ModelProviderConfig => ({
    id: `provider-${seed}`,
    name: `Provider ${seed}`,
    type: 'openai-compatible',
    modelId: 'deepseek-reasoner',
    apiKey: '',
    baseURL: 'https://api.deepseek.com',
    enableThinking: true,
    defaultReasoningEffort: 'high',
});

const normalizeProviderId = (raw: string, fallback: string): string => {
    const normalized = (raw || fallback)
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return normalized || fallback;
};

export const SettingsModal: React.FC<SettingsModalProps> = ({ isOpen, onClose }) => {
    const { settings, updateSettings, provider, locale, setLocale, setProvider, setModel, workspaceRoot } = useAgentContext();
    const [localProviders, setLocalProviders] = useState<EditableProviderConfig[]>([]);
    const [localLocale, setLocalLocale] = useState(locale);
    const [localActiveProvider, setLocalActiveProvider] = useState(provider);
    const [connectionTests, setConnectionTests] = useState<Record<string, ConnectionTestState>>({});

    useEffect(() => {
        if (settings) {
            const normalized: EditableProviderConfig[] = settings.providers.length > 0
                ? settings.providers.map((p, index) => {
                    const defaultReasoningEffort: 'high' | 'max' = p.defaultReasoningEffort === 'max' ? 'max' : 'high';
                    return {
                        ...createDefaultProvider(index + 1),
                        ...p,
                        draftKey: createDraftKey(),
                        id: normalizeProviderId(p.id || p.name || `provider-${index + 1}`, `provider-${index + 1}`),
                        type: 'openai-compatible' as const,
                        enableThinking: p.enableThinking !== false,
                        defaultReasoningEffort,
                    };
                })
                : [{ ...createDefaultProvider(1), draftKey: createDraftKey() }];

            setLocalProviders(normalized);
            setLocalLocale(settings.locale || 'zh-CN');
            setLocalActiveProvider(settings.activeProvider || normalized[0].id);
            setConnectionTests(
                normalized.reduce<Record<string, ConnectionTestState>>((acc, p) => {
                    acc[p.id] = { status: 'idle' };
                    return acc;
                }, {})
            );
        }
    }, [settings]);

    useEffect(() => {
        if (!isOpen) return;

        const body = document.body;
        const appRoot = document.getElementById('root');

        const prevOverflow = body.style.overflow;
        const prevTouchAction = body.style.touchAction;
        const prevRootPointerEvents = appRoot?.style.pointerEvents ?? '';

        body.style.overflow = 'hidden';
        body.style.touchAction = 'none';
        if (appRoot) {
            appRoot.style.pointerEvents = 'none';
            appRoot.setAttribute('aria-hidden', 'true');
        }

        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                onClose();
            }
        };
        window.addEventListener('keydown', handleKeyDown);

        return () => {
            body.style.overflow = prevOverflow;
            body.style.touchAction = prevTouchAction;
            if (appRoot) {
                appRoot.style.pointerEvents = prevRootPointerEvents;
                appRoot.removeAttribute('aria-hidden');
            }
            window.removeEventListener('keydown', handleKeyDown);
        };
    }, [isOpen, onClose]);

    if (!isOpen) return null;
    if (typeof document === 'undefined') return null;

    const handleUpdateProvider = (draftKey: string, updates: Partial<ModelProviderConfig>) => {
        const target = localProviders.find((p) => p.draftKey === draftKey);
        if (!target) return;

        const previousId = target.id;
        const nextId = typeof updates.id === 'string' ? updates.id : previousId;

        setLocalProviders((prev) => prev.map((p) => {
            if (p.draftKey !== draftKey) return p;
            return {
                ...p,
                ...updates,
                type: 'openai-compatible',
            };
        }));

        if (previousId !== nextId && localActiveProvider === previousId) {
            setLocalActiveProvider(nextId);
        }

        setConnectionTests((prev) => {
            const next = { ...prev };
            const previousState = next[previousId];
            delete next[previousId];
            next[nextId] = previousState?.status === 'success' ? { status: 'idle' } : (previousState || { status: 'idle' });
            return next;
        });
    };

    const handleAddProvider = () => {
        const next = createDefaultProvider(localProviders.length + 1);
        let finalId = next.id;
        let suffix = 2;
        while (localProviders.some(p => p.id === finalId)) {
            finalId = `${next.id}-${suffix++}`;
        }
        const providerToAdd = { ...next, draftKey: createDraftKey(), id: finalId, name: `Provider ${localProviders.length + 1}` };
        setLocalProviders([...localProviders, providerToAdd]);
        setConnectionTests((prev) => ({ ...prev, [providerToAdd.id]: { status: 'idle' } }));
        if (!localActiveProvider) {
            setLocalActiveProvider(providerToAdd.id);
        }
    };

    const handleRemoveProvider = (draftKey: string) => {
        const target = localProviders.find((p) => p.draftKey === draftKey);
        if (!target) return;
        const next = localProviders.filter(p => p.draftKey !== draftKey);
        if (next.length === 0) return;
        setLocalProviders(next);
        setConnectionTests((prev) => {
            const cloned = { ...prev };
            delete cloned[target.id];
            return cloned;
        });
        if (localActiveProvider === target.id) {
            setLocalActiveProvider(next[0].id);
        }
    };

    const handleTestConnection = async (providerConfig: ModelProviderConfig) => {
        const modelId = (providerConfig.modelId || '').trim();
        if (!modelId) {
            setConnectionTests((prev) => ({
                ...prev,
                [providerConfig.id]: { status: 'error', message: '请先填写模型 ID。' }
            }));
            return;
        }

        setConnectionTests((prev) => ({
            ...prev,
            [providerConfig.id]: { status: 'testing', message: '正在测试连接...' }
        }));

        try {
            if (electronBridge.isElectron) {
                // Electron IPC 测试连接（主进程直连 AI API）
                const result = await electronBridge.testConnection({
                    userId: USER_ID,
                    workspaceRoot: workspaceRoot || undefined,
                    provider: {
                        id: providerConfig.id,
                        name: providerConfig.name,
                        type: 'openai-compatible',
                        modelId: (providerConfig.modelId || '').trim(),
                        apiKey: (providerConfig.apiKey || '').trim(),
                        baseURL: (providerConfig.baseURL || '').trim(),
                        enableThinking: providerConfig.enableThinking !== false,
                        defaultReasoningEffort: providerConfig.defaultReasoningEffort === 'max' ? 'max' : 'high',
                    }
                });

                if (!result.success) {
                    throw new Error(result.error || '连接测试失败');
                }

                const latencyText = typeof result?.latencyMs === 'number' ? `（${result.latencyMs}ms）` : '';
                setConnectionTests((prev) => ({
                    ...prev,
                    [providerConfig.id]: {
                        status: 'success',
                        latencyMs: result?.latencyMs,
                        message: `连接成功 ${latencyText}`.trim()
                    }
                }));
            } else {
                const response = await fetch(`${API_BASE}/api/settings/test-connection`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: USER_ID,
                        workspaceRoot: workspaceRoot || undefined,
                        provider: {
                            id: providerConfig.id,
                            name: providerConfig.name,
                            type: 'openai-compatible',
                            modelId: (providerConfig.modelId || '').trim(),
                            apiKey: (providerConfig.apiKey || '').trim(),
                            baseURL: (providerConfig.baseURL || '').trim(),
                            enableThinking: providerConfig.enableThinking !== false,
                            defaultReasoningEffort: providerConfig.defaultReasoningEffort === 'max' ? 'max' : 'high',
                        }
                    })
                });

                const data = await response.json().catch(() => ({}));
                if (!response.ok || data?.status === 'error') {
                    throw new Error(data?.error || `连接测试失败 (HTTP ${response.status})`);
                }

                const latencyText = typeof data?.latencyMs === 'number' ? `（${data.latencyMs}ms）` : '';
                setConnectionTests((prev) => ({
                    ...prev,
                    [providerConfig.id]: {
                        status: 'success',
                        latencyMs: data?.latencyMs,
                        message: `连接成功 ${latencyText}`.trim()
                    }
                }));
            }
        } catch (error: any) {
            setConnectionTests((prev) => ({
                ...prev,
                [providerConfig.id]: {
                    status: 'error',
                    message: error?.message || '连接测试失败，请检查网关、密钥与模型 ID。'
                }
            }));
        }
    };

    const handleSave = async () => {
        if (localProviders.length === 0) return;

        const used = new Set<string>();
        const normalizedProviders = localProviders.map((p, index) => {
            const fallbackId = `provider-${index + 1}`;
            const baseId = normalizeProviderId(p.id || p.name || fallbackId, fallbackId);
            let uniqueId = baseId;
            let suffix = 2;
            while (used.has(uniqueId)) {
                uniqueId = `${baseId}-${suffix++}`;
            }
            used.add(uniqueId);

            const defaultReasoningEffort: 'high' | 'max' = p.defaultReasoningEffort === 'max' ? 'max' : 'high';

            return {
                ...p,
                id: uniqueId,
                name: (p.name || uniqueId).trim() || uniqueId,
                type: 'openai-compatible' as const,
                modelId: (p.modelId || '').trim(),
                apiKey: (p.apiKey || '').trim(),
                baseURL: (p.baseURL || '').trim(),
                enableThinking: p.enableThinking !== false,
                defaultReasoningEffort,
            };
        }).filter(p => p.modelId);

        if (normalizedProviders.length === 0) return;

        const activeProvider = normalizedProviders.find(p => p.id === localActiveProvider)?.id || normalizedProviders[0].id;
        const activeProviderConfig = normalizedProviders.find(p => p.id === activeProvider) || normalizedProviders[0];
        const activeModel = activeProviderConfig.modelId;

        await updateSettings({
            providers: normalizedProviders,
            locale: localLocale as any,
            activeProvider,
            activeModel
        });

        setProvider(activeProvider);
        setModel(activeModel);
        setLocale(localLocale);
        onClose();
    };

    const modalContent = (
        <div
            className="fixed inset-0 z-[2000] flex items-center justify-center bg-[#050505] p-4"
            role="dialog"
            aria-modal="true"
            aria-label="LLM 配置中心"
        >
            <div className="bg-[#020202] border border-white/10 rounded-sm shadow-2xl w-full max-w-4xl max-h-[90vh] flex flex-col overflow-hidden ring-1 ring-white/5">
                <div className="p-6 border-b border-white/5 flex items-center justify-between bg-[#050505] relative overflow-hidden group/header">
                    <div className="absolute inset-0 bg-gradient-to-r from-[#0088ff]/5 to-transparent opacity-0 group-hover/header:opacity-100 transition-opacity duration-700" />
                    <div className="flex items-center gap-3 font-black text-white uppercase tracking-[0.3em] text-[11px] relative z-10">
                        <div className="p-1 px-1.5 bg-white/5 rounded-sm">
                            <Hammer className="text-white opacity-60" size={13} strokeWidth={3} />
                        </div>
                        LLM 配置中心 (LLM_PROFILE_CENTER)
                    </div>
                    <button onClick={onClose} className="p-1.5 bg-white/5 hover:bg-white/10 rounded-sm transition-all text-white/40 hover:text-white relative z-10 active:scale-95">
                        <X size={16} strokeWidth={3} />
                    </button>
                    <div className="absolute bottom-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent" />
                </div>

                <div className="flex-1 overflow-y-auto p-8 pt-6 space-y-10 scrollbar-none custom-scrollbar">
                    <div className="p-4 bg-blue-500/5 border border-blue-500/20 rounded-sm">
                        <div className="flex items-center gap-3 mb-2">
                            <div className="w-2 h-2 rounded-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.6)] animate-pulse" />
                            <div className="text-[10px] font-black text-blue-400 uppercase tracking-[0.2em]">配置来源 (WORKSPACE_SCOPE)</div>
                        </div>
                        <div className="text-[11px] text-zinc-400 leading-relaxed font-mono">
                            当前配置将保存到工作空间的 <span className="text-blue-400 font-black">.llm</span> 目录。
                            你可以维护多个 LLM 节点，并选择当前激活的模型用于对话与工具执行。
                        </div>
                    </div>

                    <div className="space-y-6">
                        <div className="h-8 flex items-center gap-2.5 border-b border-white/5 pr-0.5">
                            <div className="p-1 px-1.5 bg-white/5 rounded-sm">
                                <Globe size={11} className="opacity-40" />
                            </div>
                            <div className="text-[10px] font-black text-white/40 uppercase tracking-[0.2em] leading-none">全局偏好设置 (PREFERENCES)</div>
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 pt-1">
                            <div className="space-y-2.5">
                                <div className="flex items-center justify-between mb-1">
                                    <label className="text-[9px] font-black text-white opacity-20 uppercase tracking-[0.15em]">界面语言 (UI_LOCALE)</label>
                                    <div className="h-[1px] flex-1 mx-4 bg-white/5" />
                                </div>
                                <div className="relative group/select">
                                    <select
                                        data-testid="settings-locale"
                                        value={localLocale}
                                        onChange={(e) => setLocalLocale(e.target.value)}
                                        className="w-full bg-[#050505] border border-white/10 rounded-sm p-3.5 text-[11px] text-white/90 outline-none focus:border-[#0088ff]/40 transition-all uppercase font-black appearance-none cursor-pointer pr-10 hover:border-white/20"
                                    >
                                        <option value="zh-CN">简体中文 (CHINESE_SIMP)</option>
                                        <option value="en-US">ENGLISH (INTERNATIONAL)</option>
                                    </select>
                                    <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none opacity-20 group-hover/select:opacity-60 transition-opacity">
                                        <ChevronDown size={14} strokeWidth={3} />
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>

                    <div className="space-y-6">
                        <div className="h-10 flex items-center justify-between border-b border-white/5 pr-0.5">
                            <div className="flex items-center gap-2.5 text-[10px] font-black text-white/40 uppercase tracking-[0.2em] leading-none">
                                <div className="p-1 px-1.5 bg-[#0088ff]/10 rounded-sm">
                                    <Cloud size={12} className="text-[#0088ff]" />
                                </div>
                                节点集群管理 (PROVIDER_STACK)
                            </div>
                            <button
                                type="button"
                                onClick={handleAddProvider}
                                className="h-8 px-3 bg-white/5 hover:bg-white/10 border border-white/10 text-[10px] text-white/70 hover:text-white rounded-sm uppercase tracking-[0.15em] font-black flex items-center gap-2 transition-all"
                            >
                                <Plus size={12} /> 新增节点
                            </button>
                        </div>

                        {localProviders.length > 0 && (
                            <div className="space-y-2">
                                <label className="text-[9px] font-black text-white opacity-20 uppercase tracking-[0.15em]">当前激活节点 (ACTIVE_PROVIDER)</label>
                                <div className="relative group/select max-w-md">
                                    <select
                                        data-testid="settings-active-provider"
                                        value={localActiveProvider}
                                        onChange={(e) => setLocalActiveProvider(e.target.value)}
                                        className="w-full bg-[#050505] border border-white/10 rounded-sm p-3 text-[11px] text-white/90 outline-none focus:border-[#0088ff]/40 transition-all font-black appearance-none cursor-pointer pr-10 hover:border-white/20"
                                    >
                                        {localProviders.map((p) => (
                                            <option key={p.id} value={p.id}>{p.name} ({p.modelId})</option>
                                        ))}
                                    </select>
                                    <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none opacity-20 group-hover/select:opacity-60 transition-opacity">
                                        <ChevronDown size={14} strokeWidth={3} />
                                    </div>
                                </div>
                            </div>
                        )}

                        <div className="space-y-6 pt-2">
                            {localProviders.map((p, index) => (
                                <div key={p.draftKey} className="p-6 rounded-sm border border-white/10 bg-[#050505]/60 backdrop-blur-sm space-y-6 relative group/provider hover:border-white/20 transition-all shadow-2xl ring-1 ring-white/5">
                                    {(() => {
                                        const testState = connectionTests[p.id] || { status: 'idle' as const };
                                        const isTesting = testState.status === 'testing';
                                        const isSuccess = testState.status === 'success';
                                        const isError = testState.status === 'error';
                                        return (
                                            <>
                                    <div className="flex items-center justify-between">
                                        <div className="text-[10px] font-black text-white/60 uppercase tracking-[0.2em]">节点 #{index + 1}</div>
                                        <div className="flex items-center gap-2">
                                            <button
                                                type="button"
                                                onClick={() => handleTestConnection(p)}
                                                disabled={isTesting}
                                                className="h-7 px-2.5 border border-[#0088ff]/30 text-[#66b8ff] hover:text-white hover:bg-[#0088ff]/15 rounded-sm text-[10px] uppercase tracking-[0.15em] font-black flex items-center gap-1.5 disabled:opacity-50 disabled:cursor-not-allowed"
                                            >
                                                {isTesting ? <Loader2 size={12} className="animate-spin" /> : <Cloud size={12} />}
                                                {isTesting ? '测试中' : '测试连接'}
                                            </button>

                                            {localProviders.length > 1 && (
                                                <button
                                                    type="button"
                                                    onClick={() => handleRemoveProvider(p.draftKey)}
                                                    className="h-7 px-2.5 border border-red-500/20 text-red-400/70 hover:text-red-300 hover:bg-red-500/10 rounded-sm text-[10px] uppercase tracking-[0.15em] font-black flex items-center gap-1.5"
                                                >
                                                    <Trash2 size={12} /> 删除
                                                </button>
                                            )}
                                        </div>
                                    </div>

                                    {(isSuccess || isError || isTesting) && (
                                        <div
                                            className={`px-3 py-2 rounded-sm border text-[10px] font-black tracking-[0.08em] flex items-center gap-2 ${
                                                isSuccess
                                                    ? 'bg-emerald-500/5 border-emerald-500/30 text-emerald-300'
                                                    : isError
                                                        ? 'bg-red-500/5 border-red-500/30 text-red-300'
                                                        : 'bg-white/5 border-white/15 text-white/70'
                                            }`}
                                        >
                                            {isSuccess && <ShieldCheck size={12} />}
                                            {isError && <AlertTriangle size={12} />}
                                            {isTesting && <Loader2 size={12} className="animate-spin" />}
                                            <span>{testState.message || (isTesting ? '正在测试连接...' : '')}</span>
                                        </div>
                                    )}

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-6">
                                        <div className="space-y-2">
                                            <label className="text-[9px] font-black text-white opacity-20 uppercase tracking-[0.15em]">节点名称 (ALIAS)</label>
                                            <input
                                                data-testid="settings-alias"
                                                value={p.name}
                                                onChange={(e) => handleUpdateProvider(p.draftKey, { name: e.target.value })}
                                                className="w-full bg-[#020202] border border-white/10 rounded-sm p-3 text-[11px] text-white/95 outline-none focus:border-[#0088ff]/50 font-black transition-all"
                                                placeholder="DeepSeek / OpenRouter / Custom"
                                            />
                                        </div>

                                        <div className="space-y-2">
                                            <label className="text-[9px] font-black text-white opacity-20 uppercase tracking-[0.15em]">Provider ID</label>
                                            <input
                                                value={p.id}
                                                onChange={(e) => handleUpdateProvider(p.draftKey, { id: e.target.value })}
                                                className="w-full bg-[#020202] border border-white/10 rounded-sm p-3 text-[11px] text-white/70 outline-none focus:border-[#0088ff]/50 font-mono transition-all"
                                                placeholder="provider-id"
                                            />
                                        </div>
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-6">
                                        <div className="space-y-2">
                                            <label className="text-[9px] font-black text-white opacity-20 uppercase tracking-[0.15em]">模型 ID (MODEL_ID)</label>
                                            <input
                                                data-testid="settings-model-id"
                                                value={p.modelId}
                                                onChange={(e) => handleUpdateProvider(p.draftKey, { modelId: e.target.value })}
                                                className="w-full bg-[#020202] border border-white/10 rounded-sm p-3 text-[11px] text-white/90 outline-none focus:border-[#0088ff]/50 font-mono transition-all"
                                                placeholder="deepseek-reasoner / gpt-4.1 / gemini-2.5-pro"
                                            />
                                            <div className="space-y-1.5">
                                                <label className="text-[9px] font-black text-white/20 uppercase tracking-[0.15em]">快速切换模型</label>
                                                <div className="relative group/select">
                                                    <select
                                                        value={p.modelId}
                                                        onChange={(e) => handleUpdateProvider(p.draftKey, { modelId: e.target.value })}
                                                        className="w-full bg-[#020202] border border-white/10 rounded-sm p-3 text-[11px] text-white/80 outline-none focus:border-[#0088ff]/40 transition-all font-mono appearance-none cursor-pointer pr-10"
                                                    >
                                                        {Array.from(new Set([
                                                            p.modelId,
                                                            'deepseek-chat',
                                                            'deepseek-reasoner',
                                                            'gpt-4.1',
                                                            'gpt-4o',
                                                            'gemini-2.5-pro'
                                                        ].filter(Boolean))).map((modelId) => (
                                                            <option key={modelId} value={modelId}>{modelId}</option>
                                                        ))}
                                                    </select>
                                                    <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none opacity-20 group-hover/select:opacity-60 transition-opacity">
                                                        <ChevronDown size={14} strokeWidth={3} />
                                                    </div>
                                                </div>
                                            </div>
                                        </div>

                                        <div className="space-y-2">
                                            <label className="text-[9px] font-black text-white opacity-20 uppercase tracking-[0.15em]">密钥授权 (API_KEY)</label>
                                            <input
                                                data-testid="settings-api-key"
                                                type="password"
                                                value={p.apiKey}
                                                onChange={(e) => handleUpdateProvider(p.draftKey, { apiKey: e.target.value })}
                                                className="w-full bg-[#020202] border border-white/10 rounded-sm p-3 text-[11px] text-white/70 outline-none focus:border-[#0088ff]/60 font-mono transition-all placeholder:opacity-30"
                                                placeholder="sk-..."
                                            />
                                        </div>
                                    </div>

                                    <div className="space-y-2">
                                        <label className="text-[9px] font-black text-white opacity-20 uppercase tracking-[0.15em]">网关地址 (BASE_URL)</label>
                                        <input
                                            data-testid="settings-base-url"
                                            value={p.baseURL || ''}
                                            onChange={(e) => handleUpdateProvider(p.draftKey, { baseURL: e.target.value })}
                                            className="w-full bg-[#020202] border border-white/10 rounded-sm p-3 text-[11px] text-white/70 outline-none focus:border-[#0088ff]/60 font-mono transition-all placeholder:opacity-30"
                                            placeholder="https://api.example.com/v1"
                                        />
                                    </div>

                                    <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-4">
                                        <label
                                            data-testid="settings-enable-thinking"
                                            className="flex items-center gap-3 p-4 bg-white/[0.01] border border-white/5 rounded-sm cursor-pointer"
                                        >
                                            <input
                                                type="checkbox"
                                                checked={p.enableThinking !== false}
                                                onChange={(e) => handleUpdateProvider(p.draftKey, { enableThinking: e.target.checked })}
                                                className="w-4 h-4 border border-white/20 bg-transparent text-[#0088ff] focus:ring-0 cursor-pointer rounded-[2px]"
                                            />
                                            <div className="flex flex-col gap-1">
                                                <span className="text-[10px] font-black text-white/70 uppercase tracking-[0.15em]">开启思考模式</span>
                                                <span className="text-[8px] text-white/25 uppercase tracking-tight font-bold">关闭后将不注入 thinking / reasoning 参数</span>
                                            </div>
                                        </label>

                                        <div className="space-y-2">
                                            <label className="text-[9px] font-black text-white opacity-20 uppercase tracking-[0.15em]">默认思考强度</label>
                                            <div className="relative group/select">
                                                <select
                                                    value={p.defaultReasoningEffort === 'max' ? 'max' : 'high'}
                                                    onChange={(e) => handleUpdateProvider(p.draftKey, { defaultReasoningEffort: e.target.value === 'max' ? 'max' : 'high' })}
                                                    disabled={p.enableThinking === false}
                                                    className="w-full bg-[#020202] border border-white/10 rounded-sm p-3 text-[11px] text-white/90 outline-none focus:border-[#0088ff]/40 transition-all font-black appearance-none cursor-pointer pr-10 disabled:opacity-40 disabled:cursor-not-allowed"
                                                >
                                                    <option value="high">HIGH (默认)</option>
                                                    <option value="max">MAX (更强推理)</option>
                                                </select>
                                                <div className="absolute right-4 top-1/2 -translate-y-1/2 pointer-events-none opacity-20 group-hover/select:opacity-60 transition-opacity">
                                                    <ChevronDown size={14} strokeWidth={3} />
                                                </div>
                                            </div>
                                        </div>
                                    </div>
                                            </>
                                        );
                                    })()}
                                </div>
                            ))}
                        </div>
                    </div>
                </div>

                <div className="p-7 border-t border-white/10 flex items-center justify-between gap-8 bg-[#050505] relative">
                    <div className="absolute top-0 left-0 w-full h-[1px] bg-gradient-to-r from-transparent via-white/5 to-transparent" />
                    <div className="text-[9px] text-white/30 font-black uppercase tracking-[0.2em]">
                        STORAGE: WORKSPACE/.LLM
                    </div>
                    <div className="flex items-center gap-4">
                        <button
                            onClick={onClose}
                            className="h-10 px-8 border border-white/10 hover:bg-white/5 hover:border-white/20 text-white/40 hover:text-white/80 text-[10px] font-black uppercase transition-all tracking-[0.2em] rounded-sm group/cancel active:scale-95"
                        >
                            <span className="group-hover/cancel:translate-x-[-2px] inline-block transition-transform duration-300">取消 (ABORT)</span>
                        </button>
                        <button
                            onClick={handleSave}
                            data-testid="settings-save"
                            className="h-10 px-10 bg-[#0088ff] hover:bg-[#0088ff]/80 text-white text-[10px] font-black rounded-sm flex items-center gap-3 shadow-[0_8px_30px_rgba(0,136,255,0.25)] hover:shadow-[0_8px_40px_rgba(0,136,255,0.4)] transition-all uppercase tracking-[0.3em] active:scale-95 active:shadow-none relative group/commit overflow-hidden"
                        >
                            <div className="absolute inset-x-0 bottom-0 h-0.5 bg-white/20 group-hover/commit:h-1 transition-all" />
                            <Save size={15} strokeWidth={3} /> 保存配置
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );

    return createPortal(modalContent, document.body);
};

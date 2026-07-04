import React, { createContext, useContext, useState, useEffect, useCallback } from 'react';
import type { ReactNode } from 'react';
import { USER_ID, API_BASE } from '@/config';
import { electronBridge } from '@/services/electron-bridge';
import { addRecentWorkspace } from '@/services/RecentWorkspaces';

/**
 * 前端诊断条目（与 electron.d.ts 中 DiagnosticEntry 对齐，
 * 额外携带文件路径和时间戳用于 Problems 面板展示）
 */
export interface ProblemEntry {
    filePath: string;       // 工作区相对路径
    line?: number;
    column?: number;
    message: string;
    severity: 'error' | 'warning' | 'info';
    code?: string;
    checker?: string;       // 检查器名称（如 "ts-program"、"json-parse"）
    timestamp: number;      // Date.now()
}

export interface ModelProviderConfig {
    id: string;
    name: string;
    type: 'openai-compatible';
    modelId: string;
    apiKey: string;
    baseURL?: string;
    enableThinking?: boolean;
    defaultReasoningEffort?: 'high' | 'max';
}

export interface UserSettings {
    providers: ModelProviderConfig[];
    activeProvider?: string;
    activeModel?: string;
    locale?: 'zh-CN' | 'en-US';
}

interface AgentContextType {
    provider: string;
    setProvider: (p: string) => void;
    model: string;
    setModel: (m: string) => void;
    locale: string;
    setLocale: (l: string) => void;
    settings: UserSettings | null;
    updateSettings: (newSettings: UserSettings) => Promise<void>;
    refreshSettings: () => Promise<void>;
    workspaceRoot: string | null;
    setWorkspaceRoot: (path: string | null) => void;
    todos: any[];
    setTodos: (todos: any[]) => void;
    /** 诊断问题列表（语法/类型检查结果，由文件写入后自动填充） */
    problems: DiagnosticEntry[];
    setProblems: (problems: DiagnosticEntry[]) => void;
    addProblems: (entries: DiagnosticEntry[]) => void;
    clearProblems: () => void;
}

const AgentContext = createContext<AgentContextType | undefined>(undefined);

export const AgentProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
    const DEFAULT_PROVIDER: ModelProviderConfig = {
        id: 'deepseek',
        name: 'DeepSeek',
        type: 'openai-compatible',
        modelId: 'deepseek-reasoner',
        apiKey: '',
        baseURL: 'https://api.deepseek.com',
        enableThinking: true,
        defaultReasoningEffort: 'high',
    };

    const normalizeProvider = (raw: Partial<ModelProviderConfig> | undefined, index: number): ModelProviderConfig => {
        const fallbackId = index === 0 ? DEFAULT_PROVIDER.id : `provider-${index + 1}`;
        const normalizedId = (raw?.id || raw?.name || fallbackId)
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '') || fallbackId;

        return {
            id: normalizedId,
            name: (raw?.name || normalizedId).trim() || normalizedId,
            type: 'openai-compatible',
            modelId: (raw?.modelId || DEFAULT_PROVIDER.modelId).trim() || DEFAULT_PROVIDER.modelId,
            apiKey: (raw?.apiKey || '').trim(),
            baseURL: (raw?.baseURL || DEFAULT_PROVIDER.baseURL || '').trim() || DEFAULT_PROVIDER.baseURL,
            enableThinking: raw?.enableThinking !== false,
            defaultReasoningEffort: raw?.defaultReasoningEffort === 'max' ? 'max' : 'high',
        };
    };

    const normalizeSettings = (raw: UserSettings | null | undefined): UserSettings => {
        const sourceProviders = Array.isArray(raw?.providers) && raw!.providers.length > 0
            ? raw!.providers
            : [DEFAULT_PROVIDER];

        const usedIds = new Set<string>();
        const providers = sourceProviders.map((p, index) => {
            const normalized = normalizeProvider(p, index);
            let finalId = normalized.id;
            let suffix = 2;
            while (usedIds.has(finalId)) {
                finalId = `${normalized.id}-${suffix++}`;
            }
            usedIds.add(finalId);
            return { ...normalized, id: finalId };
        });

        const requestedProvider = (raw?.activeProvider || '').trim().toLowerCase();
        const activeProvider = providers.find(p => p.id === requestedProvider)?.id || providers[0].id;
        const activeConfig = providers.find(p => p.id === activeProvider) || providers[0];
        const activeModel = (raw?.activeModel || activeConfig.modelId).trim() || activeConfig.modelId;

        return {
            providers,
            activeProvider,
            activeModel,
            locale: raw?.locale === 'en-US' ? 'en-US' : 'zh-CN',
        };
    };

    const readInitialSettings = (): UserSettings => {
        try {
            const saved = localStorage.getItem('agent-settings');
            return normalizeSettings(saved ? JSON.parse(saved) : null);
        } catch {
            return normalizeSettings(null);
        }
    };

    const [settings, setSettings] = useState<UserSettings>(readInitialSettings);

    // 状态管理：首屏从 LocalStorage 恢复 (对齐 9.0 节)
    const [provider, setProviderState] = useState(settings.activeProvider || settings.providers[0].id);
    const [model, setModelState] = useState(settings.activeModel || settings.providers[0].modelId);
    const [locale, setLocaleState] = useState(settings.locale || localStorage.getItem('agent-locale') || 'zh-CN');

    const [workspaceRoot, setWorkspaceRootState] = useState<string | null>(() => {
        // [E2E] 处理 Playwright 注入的固定路径
        if (typeof window !== 'undefined' && (window as any).__E2E_WORKSPACE_ROOT__) {
            return (window as any).__E2E_WORKSPACE_ROOT__;
        }

        // 对齐 15.0 节：URL 优先级最高 (Hot Reattach)
        const params = new URLSearchParams(typeof window !== 'undefined' ? window.location.search : '');
        const rootFromUrl = params.get('root');
        if (rootFromUrl) return rootFromUrl;
        
        return localStorage.getItem('agent-workspace-root');
    });
    const [todos, setTodos] = useState<any[]>([]);
    const [problems, setProblemsState] = useState<ProblemEntry[]>([]);

    const setProblems = useCallback((entries: ProblemEntry[]) => {
        setProblemsState(entries);
    }, []);

    const addProblems = useCallback((entries: ProblemEntry[]) => {
        setProblemsState(prev => {
            // 去重：同一文件的同一行同一消息只保留一条
            const existing = new Map<string, ProblemEntry>();
            for (const p of prev) {
                const key = `${p.filePath}:${p.line ?? 0}:${p.message}`;
                existing.set(key, p);
            }
            for (const e of entries) {
                const key = `${e.filePath}:${e.line ?? 0}:${e.message}`;
                existing.set(key, e); // 新条目覆盖旧的同位置条目
            }
            return Array.from(existing.values()).sort((a, b) => {
                // 错误优先，警告次之
                const sevOrder = { error: 0, warning: 1, info: 2 };
                return (sevOrder[a.severity] ?? 2) - (sevOrder[b.severity] ?? 2);
            });
        });
    }, []);

    const clearProblems = useCallback(() => {
        setProblemsState([]);
    }, []);

    const syncWorkspaceRootToUrl = useCallback((path: string | null) => {
        try {
            const url = new URL(window.location.href);
            if (path) {
                url.searchParams.set('root', path);
            } else {
                url.searchParams.delete('root');
            }
            window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
        } catch (e) {
            console.warn('[AgentContext] Failed to sync root query param:', e);
        }
    }, []);

    const setWorkspaceRoot = (path: string | null) => {
        const normalizedPath = path ? path.trim() : null;
        setWorkspaceRootState(normalizedPath);
        if (normalizedPath) {
            localStorage.setItem('agent-workspace-root', normalizedPath);
        } else {
            localStorage.removeItem('agent-workspace-root');
        }
        syncWorkspaceRootToUrl(normalizedPath);
    };

    // 统一的设置状态应用函数（Electron IPC 和 Web fetch 共用）
    const applySettingsState = (normalized: UserSettings) => {
        setSettings(normalized);
        setProviderState(normalized.activeProvider || normalized.providers[0]?.id || '');
        setModelState(normalized.activeModel || normalized.providers[0]?.modelId || '');
        if (normalized.locale) setLocaleState(normalized.locale);
        localStorage.setItem('agent-settings', JSON.stringify(normalized));
        localStorage.setItem('agent-provider', normalized.activeProvider || normalized.providers[0]?.id || '');
        localStorage.setItem('agent-model', normalized.activeModel || normalized.providers[0]?.modelId || '');
    };

    // 初始同步：从后端恢复配置 (对齐 6.1 节：后端持久化)
    useEffect(() => {
        const initSettings = async () => {
            try {
                if (electronBridge.isElectron) {
                    // Electron IPC 直读设置
                    const result = await electronBridge.getSettings(USER_ID);
                    if (result?.success && result?.settings?.providers?.length > 0) {
                        const normalized = normalizeSettings(result.settings);
                        applySettingsState(normalized);
                        console.log('[Settings] Restored via Electron IPC');
                    }
                } else {
                    const rootParam = workspaceRoot ? `&root=${encodeURIComponent(workspaceRoot)}` : '';
                    const res = await fetch(`${API_BASE}/api/settings?userId=${USER_ID}${rootParam}`);
                    if (res.ok && res.status !== 204) {
                        const data = await res.json();
                        if (data && data.providers && data.providers.length > 0) {
                            const normalized = normalizeSettings(data);
                            applySettingsState(normalized);
                            console.log('[Settings] Successfully restored from backend persistent store');
                        }
                    }
                }
            } catch (e) {
                console.warn('[Settings] Initial backend restore skipped:', e);
            }
        };
        initSettings();
    }, [workspaceRoot]);

    // 记录最近打开的工作区（仅在 workspaceRoot 有效时）
    useEffect(() => {
        if (workspaceRoot) {
            addRecentWorkspace(workspaceRoot);
        }
    }, [workspaceRoot]);

    // 同步配置到后端Agent助手服务
    const syncSettingsWithServer = useCallback(async (currentSettings: UserSettings) => {
        try {
            if (electronBridge.isElectron) {
                await electronBridge.syncSettings({
                    userId: USER_ID,
                    settings: currentSettings,
                    root: workspaceRoot || undefined,
                });
            } else {
                const res = await fetch(`${API_BASE}/api/settings/sync`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        userId: USER_ID,
                        workspaceRoot: workspaceRoot || undefined,
                        settings: currentSettings
                    })
                });
                const result = await res.json();
                console.log('[Settings] Database Sync Status:', result.status);
            }
        } catch (e) {
            console.error('[Settings] Persistence failed:', e);
        }
    }, [workspaceRoot]);

    // 触发同步
    useEffect(() => {
        if (settings) {
            syncSettingsWithServer(settings);
        }
    }, [settings, syncSettingsWithServer]);

    const refreshSettings = async () => {
        try {
            if (electronBridge.isElectron) {
                const result = await electronBridge.getSettings(USER_ID);
                if (result?.success && result?.settings?.providers?.length > 0) {
                    const normalized = normalizeSettings(result.settings);
                    applySettingsState(normalized);
                    console.log('[Settings] Refreshed via Electron IPC:', normalized);
                }
            } else {
                const rootParam = workspaceRoot ? `&root=${encodeURIComponent(workspaceRoot)}` : '';
                const res = await fetch(`${API_BASE}/api/settings?userId=${USER_ID}${rootParam}`);
                if (!res.ok || res.status === 204) return;
                const data = await res.json();
                const normalized = normalizeSettings(data);
                applySettingsState(normalized);
                console.log('[Settings] Current Workspace Config:', normalized);
            }
        } catch (e) {
            console.error('Failed to fetching settings:', e);
        }
    };

    const updateSettings = async (newSettings: UserSettings) => {
        try {
            const normalized = normalizeSettings(newSettings);
            // 1. 持久化到浏览器缓存 (User Cache)
            localStorage.setItem('agent-settings', JSON.stringify(normalized));
            localStorage.setItem('agent-provider', normalized.activeProvider || normalized.providers[0].id);
            localStorage.setItem('agent-model', normalized.activeModel || normalized.providers[0].modelId);
            setSettings(normalized);
            setProviderState(normalized.activeProvider || normalized.providers[0].id);
            setModelState(normalized.activeModel || normalized.providers[0].modelId);
        } catch (e) {
            console.error('Failed to update settings:', e);
        }
    };

    const setProvider = (p: string) => {
        setProviderState(p);
        localStorage.setItem('agent-provider', p);

        setSettings(prev => {
            const normalized = normalizeSettings(prev);
            const activeProvider = normalized.providers.find(item => item.id === p)?.id || normalized.providers[0].id;
            const activeModel = normalized.providers.find(item => item.id === activeProvider)?.modelId || normalized.providers[0].modelId;
            const next = normalizeSettings({ ...normalized, activeProvider, activeModel });
            localStorage.setItem('agent-settings', JSON.stringify(next));
            localStorage.setItem('agent-model', next.activeModel || activeModel);
            setModelState(next.activeModel || activeModel);
            return next;
        });
    };

    const setModel = (m: string) => {
        setModelState(m);
        localStorage.setItem('agent-model', m);

        setSettings(prev => {
            const normalized = normalizeSettings(prev);
            const activeProvider = normalized.activeProvider || normalized.providers[0].id;
            const providers = normalized.providers.map(item => item.id === activeProvider ? { ...item, modelId: m } : item);
            const next = normalizeSettings({ ...normalized, providers, activeModel: m });
            localStorage.setItem('agent-settings', JSON.stringify(next));
            return next;
        });
    };

    const setLocale = (l: string) => {
        setLocaleState(l);
        localStorage.setItem('agent-locale', l);
        setSettings(prev => normalizeSettings({ ...normalizeSettings(prev), locale: l === 'en-US' ? 'en-US' : 'zh-CN' }));
    };

    return (
        <AgentContext.Provider value={{
            provider, setProvider,
            model, setModel,
            locale, setLocale,
            settings, updateSettings, refreshSettings,
            workspaceRoot, setWorkspaceRoot,
            todos,
            setTodos,
            problems,
            setProblems,
            addProblems,
            clearProblems,
        }}>
            {children}
        </AgentContext.Provider>
    );
};

export const useAgentContext = () => {
    const context = useContext(AgentContext);
    if (!context) {
        throw new Error('useAgentContext must be used within an AgentProvider');
    }
    return context;
};


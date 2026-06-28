/**
 * Settings IPC Handler
 * 
 * 替换 REST /api/settings/* 路由。
 * 使用 electron-store 进行本地持久化 + 兼容 .llm/ 目录配置。
 */
import { IpcMain, IpcMainInvokeEvent } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { PROJECT_ROOT } from '../index.js';

// 简单 JSON 文件存储（替代 electron-store 的复杂依赖）
class JsonStore {
    private filePath: string;
    private data: Record<string, any>;

    constructor(name: string) {
        const storeDir = path.join(PROJECT_ROOT, '.electron-store');
        if (!fs.existsSync(storeDir)) {
            fs.mkdirSync(storeDir, { recursive: true });
        }
        this.filePath = path.join(storeDir, `${name}.json`);
        this.data = this.load();
    }

    private load(): Record<string, any> {
        try {
            if (fs.existsSync(this.filePath)) {
                return JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
            }
        } catch {}
        return {};
    }

    get(key: string): any {
        return this.data[key];
    }

    set(key: string, value: any): void {
        this.data[key] = value;
        this.save();
    }

    delete(key: string): void {
        delete this.data[key];
        this.save();
    }

    private save(): void {
        try {
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
        } catch (err) {
            console.error('[JsonStore] Failed to save:', err);
        }
    }
}

const settingsStore = new JsonStore('settings');

// 读取 .llm/users/<userId>/settings.json（兼容原有格式）
function loadUserLlmSettings(userId: string): any | null {
    const llmSettingsPath = path.join(PROJECT_ROOT, '.llm', 'users', userId, 'settings.json');
    try {
        if (fs.existsSync(llmSettingsPath)) {
            return JSON.parse(fs.readFileSync(llmSettingsPath, 'utf-8'));
        }
    } catch {}
    return null;
}

function saveUserLlmSettings(userId: string, settings: any): void {
    const dir = path.join(PROJECT_ROOT, '.llm', 'users', userId);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(
        path.join(dir, 'settings.json'),
        JSON.stringify(settings, null, 2),
        'utf-8'
    );
}

export function registerSettingsIpc(ipcMain: IpcMain) {
    
    // ── 获取设置 ──
    ipcMain.handle('settings:get', async (_event: IpcMainInvokeEvent, userId: string) => {
        try {
            // 优先读取 .llm 配置
            const llmSettings = loadUserLlmSettings(userId);
            
            // 合并 electron-store 中的设置
            const localSettings = settingsStore.get(`user:${userId}`) || {};
            
            return {
                success: true,
                settings: {
                    ...localSettings,
                    ...(llmSettings || {}),
                    // 标记配置来源
                    _hasLlmConfig: !!llmSettings,
                },
            };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── 保存设置 ──
    ipcMain.handle('settings:set', async (_event: IpcMainInvokeEvent, params: {
        userId: string;
        settings: any;
        root?: string;
    }) => {
        try {
            const { userId, settings, root } = params;
            
            // 保存到 electron-store
            const existing = settingsStore.get(`user:${userId}`) || {};
            const merged = { ...existing, ...settings };
            settingsStore.set(`user:${userId}`, merged);

            // 如果有 root，同步到 .llm 目录
            const targetRoot = root || PROJECT_ROOT;
            const llmPath = path.join(targetRoot, '.llm', 'users', userId, 'settings.json');
            
            if (fs.existsSync(path.dirname(llmPath)) || root) {
                saveUserLlmSettings(userId, merged);
            }

            return { success: true };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── 同步设置（兼容 Web 版的 /api/settings/sync） ──
    ipcMain.handle('settings:sync', async (_event: IpcMainInvokeEvent, params: {
        userId: string;
        settings: any;
        root?: string;
    }) => {
        try {
            const { userId, settings, root } = params;
            const targetRoot = root || PROJECT_ROOT;
            
            if (root) {
                saveUserLlmSettings(userId, settings);
                
                // 也更新本地缓存
                settingsStore.set(`user:${userId}`, settings);
                
                return {
                    success: true,
                    status: 'settings_synced',
                    root: targetRoot,
                };
            } else {
                // 无 root 时仅本地缓存
                settingsStore.set(`user:${userId}`, settings);
                return {
                    success: true,
                    status: 'memory_synced',
                };
            }
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── 获取所有 Provider 配置 ──
    ipcMain.handle('settings:providers', async (_event: IpcMainInvokeEvent, userId: string) => {
        try {
            const settings = settingsStore.get(`user:${userId}`) || {};
            const providers = settings.providers || [];
            
            return {
                success: true,
                providers,
                activeProvider: settings.activeProvider,
                activeModel: settings.activeModel,
            };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── 测试 Provider 连接 ──
    ipcMain.handle('settings:test-connection', async (_event: IpcMainInvokeEvent, params: {
        userId: string;
        workspaceRoot?: string;
        provider: {
            id: string;
            name: string;
            type: string;
            modelId: string;
            apiKey: string;
            baseURL: string;
            enableThinking?: boolean;
            defaultReasoningEffort?: string;
        };
    }) => {
        try {
            const { provider } = params;
            const apiKey = (provider.apiKey || '').trim();
            const baseURL = (provider.baseURL || '').trim();
            const modelId = (provider.modelId || '').trim();

            if (!apiKey || !baseURL || !modelId) {
                return { success: false, error: '缺少必要参数（apiKey/baseURL/modelId）' };
            }

            // 使用 openai SDK 测试连接
            const openai = await import('openai');
            const client = new openai.default({
                apiKey,
                baseURL,
                timeout: 15000,
                maxRetries: 0,
            });

            const startTime = Date.now();
            const response = await client.chat.completions.create({
                model: modelId,
                messages: [{ role: 'user', content: 'ping' }],
                max_tokens: 1,
            });
            const latencyMs = Date.now() - startTime;

            return {
                success: true,
                status: 'ok',
                latencyMs,
                model: response.model || modelId,
            };
        } catch (err: any) {
            return {
                success: false,
                status: 'error',
                error: err?.message || '连接测试失败',
            };
        }
    });

    console.log('[SettingsIPC] Settings IPC handlers registered');
}

import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * 对应技术规范 3.4 & 4.4 节：模型服务配置持久化 (Settings Persistence)
 * 支持在后端物理存储用户配置，确保跨设备/刷新后配置依然有效。
 */
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

export class SettingsService {
    private static readonly DEFAULT_PROVIDER_ID = 'deepseek';
    private static readonly DEFAULT_PROVIDER_NAME = 'DeepSeek';
    private static readonly CACHE_KEY_SEP = '|::|';

    public static getDefaultSettings(): UserSettings {
        const defaultModel = process.env.DEEPSEEK_MODEL || 'deepseek-reasoner';
        const defaultBaseURL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com';
        return {
            providers: [{
                id: this.DEFAULT_PROVIDER_ID,
                name: this.DEFAULT_PROVIDER_NAME,
                type: 'openai-compatible',
                modelId: defaultModel,
                apiKey: process.env.DEEPSEEK_API_KEY || '',
                baseURL: defaultBaseURL,
                enableThinking: true,
                defaultReasoningEffort: 'high',
            }],
            activeProvider: this.DEFAULT_PROVIDER_ID,
            activeModel: defaultModel,
            locale: 'zh-CN',
        };
    }

    private static normalizeProviderId(raw: string, fallback: string): string {
        const normalized = raw
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '-')
            .replace(/^-+|-+$/g, '');
        return normalized || fallback;
    }

    private static normalizeSettings(input?: Partial<UserSettings>): UserSettings {
        const defaults = this.getDefaultSettings();
        const sourceProviders = Array.isArray(input?.providers) && input!.providers.length > 0
            ? input!.providers
            : defaults.providers;

        const providers: ModelProviderConfig[] = [];
        const usedIds = new Set<string>();

        sourceProviders.forEach((rawProvider, index) => {
            const fallbackId = index === 0 ? this.DEFAULT_PROVIDER_ID : `provider-${index + 1}`;
            const candidateId = this.normalizeProviderId(rawProvider?.id || rawProvider?.name || fallbackId, fallbackId);
            let finalId = candidateId;
            let suffix = 2;
            while (usedIds.has(finalId)) {
                finalId = `${candidateId}-${suffix++}`;
            }
            usedIds.add(finalId);

            const modelId = (rawProvider?.modelId || defaults.providers[0].modelId || '').trim() || defaults.providers[0].modelId;
            const baseURL = (rawProvider?.baseURL || defaults.providers[0].baseURL || '').trim() || defaults.providers[0].baseURL;

            providers.push({
                id: finalId,
                name: (rawProvider?.name || finalId).trim() || finalId,
                type: 'openai-compatible',
                modelId,
                apiKey: (rawProvider?.apiKey || '').trim(),
                baseURL,
                enableThinking: rawProvider?.enableThinking !== false,
                defaultReasoningEffort: rawProvider?.defaultReasoningEffort === 'max' ? 'max' : 'high',
            });
        });

        const requestedActiveProvider = (input?.activeProvider || '').trim().toLowerCase();
        const activeProvider = providers.find(p => p.id === requestedActiveProvider)?.id || providers[0].id;
        const activeProviderConfig = providers.find(p => p.id === activeProvider) || providers[0];
        const activeModel = (input?.activeModel || '').trim() || activeProviderConfig.modelId;
        const locale = input?.locale === 'en-US' ? 'en-US' : 'zh-CN';

        return {
            providers,
            activeProvider,
            activeModel,
            locale,
        };
    }

    public static resolveActiveSelection(
        settings: UserSettings,
        preferredProviderId?: string,
        preferredModelId?: string,
    ): { provider: ModelProviderConfig; modelId: string } {
        const normalized = this.normalizeSettings(settings);
        const preferredProvider = (preferredProviderId || '').trim().toLowerCase();
        const activeProvider = normalized.providers.find(p => p.id === preferredProvider)
            || normalized.providers.find(p => p.id === normalized.activeProvider)
            || normalized.providers[0];
        const modelId = (preferredModelId || normalized.activeModel || activeProvider.modelId).trim() || activeProvider.modelId;
        return { provider: activeProvider, modelId };
    }

    private static makeStoreKey(workspaceRoot: string, userId: string): string {
        return `${path.resolve(workspaceRoot)}${this.CACHE_KEY_SEP}${userId}`;
    }

    private static isMaskedApiKey(raw: string | undefined): boolean {
        if (!raw) return false;
        const v = raw.trim();
        if (!v) return false;
        return /^sk-\*{3,}/.test(v) || /^\*+$/.test(v) || /\*{3,}/.test(v);
    }

    public static mergeWithExistingSecrets(existing: UserSettings, incoming: UserSettings): UserSettings {
        const prev = this.normalizeSettings(existing);
        const next = this.normalizeSettings(incoming);
        const prevById = new Map(prev.providers.map(p => [p.id, p]));

        const mergedProviders = next.providers.map((p) => {
            if (this.isMaskedApiKey(p.apiKey)) {
                const old = prevById.get(p.id);
                if (old?.apiKey) {
                    return { ...p, apiKey: old.apiKey };
                }
                return { ...p, apiKey: '' };
            }
            return p;
        });

        return this.normalizeSettings({ ...next, providers: mergedProviders });
    }

    // 内存缓存，提升读取性能
    private static memoryStore: Map<string, UserSettings> = new Map();
    private static transientStore: Map<string, UserSettings> = new Map();

    private static getSettingsPath(workspaceRoot: string, userId: string): string {
        return path.join(workspaceRoot, '.llm', 'users', userId, 'settings.json');
    }

    private static getLegacySettingsPath(workspaceRoot: string, userId: string): string {
        return path.join(workspaceRoot, '.ide-agent', 'users', userId, 'settings.json');
    }

    private static async writeSettingsFile(settingsPath: string, settings: UserSettings): Promise<void> {
        const settingsDir = path.dirname(settingsPath);
        await fs.mkdir(settingsDir, { recursive: true });
        await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    }

    /**
     * 获取用户配置 (优先内存，次之磁盘)
     * 配置读取优先级：内存缓存 -> 暂存缓存 -> .llm -> 旧路径(.ide-agent)迁移 -> 默认值
     */
    static async getSettings(workspaceRoot: string, userId: string = 'default-user'): Promise<UserSettings> {
        if (!workspaceRoot) {
            return this.transientStore.get(userId) || this.getDefaultSettings();
        }

        const storeKey = this.makeStoreKey(workspaceRoot, userId);
        const cached = this.memoryStore.get(storeKey);
        if (cached) return cached;

        const transient = this.transientStore.get(userId);
        if (transient) {
            this.memoryStore.set(storeKey, transient);
            return transient;
        }

        const settingsPath = this.getSettingsPath(workspaceRoot, userId);
        try {
            const raw = await fs.readFile(settingsPath, 'utf8');
            const parsed = JSON.parse(raw) as UserSettings;
            const normalized = this.normalizeSettings(parsed);
            this.memoryStore.set(storeKey, normalized);
            return normalized;
        } catch {
            // 兼容迁移：若旧路径存在则自动迁移到 .llm
            const legacyPath = this.getLegacySettingsPath(workspaceRoot, userId);
            try {
                const legacyRaw = await fs.readFile(legacyPath, 'utf8');
                const legacyParsed = JSON.parse(legacyRaw) as UserSettings;
                const migrated = this.normalizeSettings(legacyParsed);
                await this.writeSettingsFile(settingsPath, migrated);
                this.memoryStore.set(storeKey, migrated);
                return migrated;
            } catch {
                const defaults = this.getDefaultSettings();
                this.memoryStore.set(storeKey, defaults);
                return defaults;
            }
        }
    }

    /**
     * 持久化配置到磁盘
     */
    static async persistSettings(workspaceRoot: string, userId: string, settings: UserSettings): Promise<void> {
        if (!workspaceRoot) {
            console.warn(`[Settings] Cannot persist settings for user ${userId}: workspaceRoot missing`);
            return;
        }

        const normalized = this.normalizeSettings(settings);
        const settingsPath = this.getSettingsPath(workspaceRoot, userId);
        const storeKey = this.makeStoreKey(workspaceRoot, userId);

        try {
            await this.writeSettingsFile(settingsPath, normalized);
            this.memoryStore.set(storeKey, normalized);
            this.transientStore.set(userId, normalized);
            console.log(`[Settings] Successfully persisted settings for user ${userId} at ${settingsPath}`);
        } catch (e: any) {
            console.error(`[Settings] Failed to persist settings: ${e.message}`);
            throw e;
        }
    }

    /**
     * 更新瞬时配置 (同步调用，仅更新内存)
     */
    static updateTransientSettings(userId: string, settings: UserSettings): void {
        this.transientStore.set(userId, this.normalizeSettings(settings));
    }

    /**
     * 自动同步并持久化 (由 API 调用)
     */
    static async syncSettings(workspaceRoot: string, userId: string, settings: UserSettings): Promise<void> {
        await this.persistSettings(workspaceRoot, userId, settings);
    }

    /**
     * 当用户在 Workspace 未初始化时先保存了配置（仅写入 transientStore），
     * 后续一旦 Workspace 可用，调用该方法将暂存配置补持久化到 .llm。
     */
    static async flushTransientSettingsToWorkspace(workspaceRoot: string, userId: string): Promise<boolean> {
        if (!workspaceRoot) return false;

        const transient = this.transientStore.get(userId);
        if (!transient) return false;

        const normalizedTransient = this.normalizeSettings(transient);
        const settingsPath = this.getSettingsPath(workspaceRoot, userId);
        let toPersist = normalizedTransient;

        try {
            const raw = await fs.readFile(settingsPath, 'utf8');
            const existing = this.normalizeSettings(JSON.parse(raw) as UserSettings);
            toPersist = this.mergeWithExistingSecrets(existing, normalizedTransient);
        } catch {
            // 文件不存在或损坏时，直接使用 transient 作为初始持久化内容。
        }

        await this.persistSettings(workspaceRoot, userId, toPersist);
        return true;
    }

    /**
     * 清理不再活跃的用户内存配置
     */
    static cleanUp(activeUserIds: Set<string>): void {
        for (const userId of this.transientStore.keys()) {
            if (!activeUserIds.has(userId)) {
                this.transientStore.delete(userId);
            }
        }

        for (const userId of this.memoryStore.keys()) {
            const parts = userId.split(this.CACHE_KEY_SEP);
            const id = parts[parts.length - 1] || userId;
            if (!activeUserIds.has(id)) {
                this.memoryStore.delete(userId);
            }
        }
    }
}
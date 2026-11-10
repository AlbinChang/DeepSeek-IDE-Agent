import * as fs from 'fs';
import * as path from 'path';

import { AIProviderFactory } from '@/services/AIProviderFactory.js';
import { SettingsService, type ModelProviderConfig, type UserSettings } from '@/services/SettingsService.js';
import { PROJECT_ROOT } from '@/utils/PathUtils.js';

export interface ResolvedProviderConfig {
    providerConfig: ModelProviderConfig;
    provider: string;
    modelId: string;
}

export interface ProviderConfigResolveOptions {
    /** 覆盖项目根目录（测试用） */
    projectRoot?: string;
    /** 命中配置文件时的回调（用于调用方保留原有日志格式） */
    onLoaded?: (settingsPath: string) => void;
}

/**
 * Provider 配置解析（主进程 IPC / Worker / 测试共用）。
 *
 * 读取优先级（由高到低）：
 *   1. <workspaceRoot>/.llm/users/<userId>/settings.json  （工作区配置）
 *   2. <projectRoot>/.llm/users/<userId>/settings.json    （Electron 全局配置）
 *   3. <projectRoot>/.electron-store/settings.json        （settings:sync 总是写入这里）
 *   4. SettingsService.getDefaultSettings()               （环境变量兜底）
 *
 * 所有路径均绕过 SettingsService 内存缓存直接读盘，确保更新后的 key 立即生效。
 */
export class ProviderConfigResolver {
    public static getCandidatePaths(
        userId: string,
        root?: string,
        projectRoot: string = PROJECT_ROOT,
    ): string[] {
        const candidates: string[] = [];
        if (root) {
            candidates.push(path.join(root, '.llm', 'users', userId, 'settings.json'));
        }
        candidates.push(path.join(projectRoot, '.llm', 'users', userId, 'settings.json'));
        candidates.push(path.join(projectRoot, '.electron-store', 'settings.json'));
        return candidates;
    }

    public static resolveForUser(
        userId: string,
        root?: string,
        requestedProvider?: string,
        requestedModel?: string,
        options: ProviderConfigResolveOptions = {},
    ): ResolvedProviderConfig {
        let settings: UserSettings = SettingsService.getDefaultSettings();

        for (const candidatePath of this.getCandidatePaths(userId, root, options.projectRoot)) {
            try {
                if (!fs.existsSync(candidatePath)) continue;
                const raw = fs.readFileSync(candidatePath, 'utf-8');
                let parsed: any;
                try {
                    parsed = JSON.parse(raw);
                } catch {
                    continue;
                }

                // .electron-store 格式为 { "user:<userId>": { providers, ... } }
                const userData = parsed?.[`user:${userId}`] || parsed;
                if (userData && typeof userData === 'object' && userData.providers) {
                    settings = { ...settings, ...userData };
                    options.onLoaded?.(candidatePath);
                    break;
                }
            } catch {
                // 文件损坏或不可读，尝试下一个路径
            }
        }

        return AIProviderFactory.resolveSelection(
            settings.providers,
            settings.activeProvider,
            settings.activeModel,
            requestedProvider,
            requestedModel,
        );
    }
}

/**
 * Playwright MCP Worker 运行时装配。
 *
 * 把 BrowserMcpAdapter 的 Worker 启动器替换成 Electron utilityProcess 版本：
 * MCP Client 与它拉起的 Chrome 全部跑在独立进程里，卡死时连进程树一起杀掉重建，
 * 主进程只负责监督。
 */

import { app } from 'electron';
import { existsSync } from 'node:fs';
import * as path from 'node:path';

import { BrowserMcpAdapter } from '@/services/BrowserMcpAdapter.js';
import { UtilityProcessPlaywrightSpawner } from './utility-process-playwright-spawner.js';

/** 定位 playwrightMcpWorker.cjs（开发与打包两种布局） */
export function resolvePlaywrightWorkerEntry(): string | null {
    const candidates = app.isPackaged
        ? [
            path.join(process.resourcesPath, 'workers', 'playwrightMcpWorker.cjs'),
            path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', 'workers', 'playwrightMcpWorker.cjs'),
            path.join(app.getAppPath(), 'dist', 'workers', 'playwrightMcpWorker.cjs'),
        ]
        : [
            path.join(app.getAppPath(), 'dist', 'workers', 'playwrightMcpWorker.cjs'),
        ];
    return candidates.find((candidate) => existsSync(candidate)) || null;
}

let configured = false;

/** 注入 utilityProcess 版 Worker 启动器；找不到 bundle 时回退到 adapter 内置的 child_process 版本 */
export function configurePlaywrightWorkerRuntime(): void {
    if (configured) return;
    configured = true;

    const entry = resolvePlaywrightWorkerEntry();
    if (!entry) {
        console.warn(
            '[PlaywrightRuntime] playwrightMcpWorker.cjs not found; '
            + 'falling back to child_process worker (run `pnpm run build:playwright-worker`).',
        );
        return;
    }

    BrowserMcpAdapter.configureWorkerRuntime({
        entry,
        spawner: new UtilityProcessPlaywrightSpawner({ entry, env: process.env }),
    });
    console.log('[PlaywrightRuntime] Using utilityProcess Playwright worker:', entry);
}

/** 退出前释放所有 Playwright worker（含 Chrome 子进程） */
export async function shutdownPlaywrightWorkers(): Promise<void> {
    try {
        await BrowserMcpAdapter.getInstance().shutdown();
    } catch (error) {
        console.warn('[PlaywrightRuntime] Shutdown failed:', error);
    }
}

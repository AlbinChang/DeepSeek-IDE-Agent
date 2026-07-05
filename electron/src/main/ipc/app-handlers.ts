/**
 * App IPC Handler
 * 
 * 应用级别的 IPC：工作区选择、应用信息、原生对话框等。
 */
import { IpcMain, BrowserWindow, dialog } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { PROJECT_ROOT, ELECTRON_ROOT } from '../index.js';

// 用户工作区映射
const userWorkspaces = new Map<string, string>();

export function registerAppIpc(ipcMain: IpcMain, mainWindow: BrowserWindow) {
    
    // ── 选择工作区目录 ──
    ipcMain.handle('workspace:select', async () => {
        const result = await dialog.showOpenDialog(mainWindow, {
            title: '选择工作区目录',
            properties: ['openDirectory'],
            defaultPath: PROJECT_ROOT,
        });

        if (result.canceled || result.filePaths.length === 0) {
            return null;
        }

        return result.filePaths[0];
    });

    // ── 初始化工作区 ──
    ipcMain.handle('workspace:init', async (_event, params: { userId: string; root: string }) => {
        try {
            const { userId, root } = params;
            
            // 确保工作区目录存在
            if (!fs.existsSync(root)) {
                return { success: false, error: `Workspace directory not found: ${root}` };
            }

            // 记录用户工作区
            userWorkspaces.set(userId, root);

            // 创建必要的目录结构
            const llmDir = path.join(root, '.llm', 'users', userId);
            if (!fs.existsSync(llmDir)) {
                fs.mkdirSync(llmDir, { recursive: true });
            }

            // 广播工作区就绪事件
            if (!mainWindow.isDestroyed()) {
                mainWindow.webContents.send('system:event', {
                    type: 'workspace_ready',
                    payload: { userId, root },
                });
            }

            console.log(`[AppIPC] Workspace initialized: userId=${userId}, root=${root}`);
            return { success: true, root };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── 获取当前工作区 ──
    ipcMain.handle('workspace:getRoot', async (_event, userId: string) => {
        return userWorkspaces.get(userId) || null;
    });

    // ── 应用信息 ──
    ipcMain.handle('app:info', async () => {
        const { app } = await import('electron');
        const os = await import('os');
        return {
            version: app.getVersion(),
            platform: process.platform,
            arch: process.arch,
            electronVersion: process.versions.electron,
            nodeVersion: process.versions.node,
            chromeVersion: process.versions.chrome,
            isDev: !app.isPackaged,
            username: process.env.USERNAME || os.userInfo().username || 'unknown',
        };
    });

    // ── 打开外部链接 ──
    ipcMain.handle('app:openExternal', async (_event, url: string) => {
        const { shell } = await import('electron');
        await shell.openExternal(url);
        return { success: true };
    });

    // ── 在文件资源管理器中显示 ──
    ipcMain.handle('app:revealInExplorer', async (_event, filePath: string) => {
        try {
            const { shell } = await import('electron');
            // normalize 处理跨平台路径分隔符
            const resolved = path.normalize(filePath);
            console.log(`[AppIPC] revealInExplorer: filePath="${filePath}" → resolved="${resolved}"`);

            if (!fs.existsSync(resolved)) {
                console.warn(`[AppIPC] revealInExplorer: 路径不存在: ${resolved}`);
                return { success: false, error: `路径不存在: ${resolved}` };
            }

            // 在文件管理器中打开并选中该文件/文件夹
            shell.showItemInFolder(resolved);
            console.log(`[AppIPC] revealInExplorer: done`);

            return { success: true };
        } catch (err: any) {
            console.error(`[AppIPC] revealInExplorer error:`, err);
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── 显示消息框 ──
    ipcMain.handle('app:showMessage', async (_event, options: {
        type?: 'info' | 'warning' | 'error' | 'question';
        title: string;
        message: string;
        detail?: string;
        buttons?: string[];
    }) => {
        const result = await dialog.showMessageBox(mainWindow, {
            type: options.type || 'info',
            title: options.title,
            message: options.message,
            detail: options.detail,
            buttons: options.buttons || ['确定'],
        });
        return { response: result.response };
    });

    // ── 获取项目路径 ──
    ipcMain.handle('app:getPaths', async () => {
        return {
            projectRoot: PROJECT_ROOT,
            electronRoot: ELECTRON_ROOT,
            homeDir: process.env.HOME || process.env.USERPROFILE || '',
        };
    });

    // ── 工作区状态查询 ──
    ipcMain.handle('workspace:status', async (_event, params: { userId: string }) => {
        const root = userWorkspaces.get(params.userId) || null;
        return {
            initialized: !!root,
            workspaceRoot: root,
        };
    });

    // ── 重置工作区 ──
    ipcMain.handle('workspace:reset', async (_event, params: { userId: string }) => {
        userWorkspaces.delete(params.userId);
        return { success: true };
    });

    console.log('[AppIPC] App IPC handlers registered');
}

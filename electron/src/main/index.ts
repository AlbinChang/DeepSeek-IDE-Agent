/**
 * Electron Main Process Entry
 * 
 * 将原来的三进程架构 (client ↔ server ↔ terminal-server) 合并为单进程 Electron 应用。
 * Main Process 直接运行 Agent 引擎、node-pty、文件系统操作，通过 IPC 与 Renderer 通信。
 */
import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

// ── 路径初始化（对齐 server/src/utils/PathUtils.ts 的逻辑） ──
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** 判断是否打包生产模式 */
const isPackaged = app.isPackaged;

/** Electron 应用根目录 (开发时为 electron/，打包后为 app.asar 根目录) */
export const ELECTRON_ROOT = isPackaged ? app.getAppPath() : path.resolve(__dirname, '../..');

/** 项目/用户数据根目录 (开发环境: 源码根目录；打包生产环境: app.getPath('userData')) */
export const PROJECT_ROOT = isPackaged ? app.getPath('userData') : path.resolve(ELECTRON_ROOT, '..');

/** Server 源码目录 */
export const SERVER_SRC = isPackaged ? path.join(process.resourcesPath, 'config') : path.join(PROJECT_ROOT, 'server', 'src');

/** 配置文件目录 (打包后从 extraResources 的 resources/config 读取，开发时从 server/src/config 读取) */
export const CONFIG_ROOT = isPackaged
    ? (fs.existsSync(path.join(process.resourcesPath, 'config'))
        ? path.join(process.resourcesPath, 'config')
        : path.join(ELECTRON_ROOT, 'server', 'src', 'config'))
    : path.join(PROJECT_ROOT, 'server', 'src', 'config');

/** 客户端构建输出 (打包后在 app.asar 内的 dist/renderer，开发时在 client/dist) */
export const CLIENT_DIST = isPackaged
    ? path.join(ELECTRON_ROOT, 'dist', 'renderer')
    : path.join(path.resolve(ELECTRON_ROOT, '..'), 'client', 'dist');

/** 日志目录 */
export const LOG_DIR = path.join(PROJECT_ROOT, 'logs');

/** Preload 脚本路径（编译后在 electron/dist/preload.cjs）。Electron preload 在 type=module 包内需要 .cjs。 */
const PRELOAD_PATH = path.join(ELECTRON_ROOT, 'dist', 'preload.cjs');

// ── 路径环境变量注入（必须在任何 server 模块被 import 之前执行） ──
// server/src/utils/PathUtils.ts 在模块初始化时读取这些变量并冻结为常量。
// 若在 bundle 中先经由其他路径（如 agent:clear → AgentChatComponent）触发 PathUtils 初始化，
// 而环境变量尚未设置，CONFIG_ROOT 会错误回退到 electron/src/config（不存在）。
// 因此在入口模块顶层无条件注入，消除对 import 时序的依赖。
process.env.SERVER_ROOT = SERVER_SRC;
process.env.PROJECT_ROOT = PROJECT_ROOT;
process.env.CONFIG_ROOT = CONFIG_ROOT;

// ── 加载 .env ──
// 使用动态 import 避免顶层 dotenv 副作用
let dotenv: any;
try {
    dotenv = await import('dotenv');
    const envCandidatePaths = isPackaged
        ? [path.join(process.resourcesPath, '.env'), path.join(PROJECT_ROOT, '.env')]
        : [path.join(PROJECT_ROOT, '.env')];

    for (const envPath of envCandidatePaths) {
        if (fs.existsSync(envPath)) {
            dotenv.config({ path: envPath });
            console.log('[Electron] .env loaded from', envPath);
            break;
        }
    }
} catch {
    console.log('[Electron] dotenv not available, skipping .env load');
}

// ── 判断是否开发模式 ──
const isDev = !app.isPackaged && (process.argv.includes('--dev') || process.env.NODE_ENV === 'development');

// ── 窗口引用 ──
let mainWindow: BrowserWindow | null = null;

// ── IPC 处理器注册（延迟导入，避免循环依赖） ──
async function registerIpcHandlers() {
    console.log('[Electron] Registering IPC handlers...');
    
    // 动态导入各 IPC 模块
    const { registerAgentIpc } = await import('./ipc/agent-handlers.js');
    const { registerFileIpc } = await import('./ipc/file-handlers.js');
    const { registerTerminalIpc } = await import('./ipc/terminal-handlers.js');
    const { registerGitIpc } = await import('./ipc/git-handlers.js');
    const { registerSettingsIpc } = await import('./ipc/settings-handlers.js');
    const { registerContextIpc, registerCompletionIpc } = await import('./ipc/context-handlers.js');
    const { registerAppIpc } = await import('./ipc/app-handlers.js');
    const { registerDiagnosticsIpc } = await import('./ipc/diagnostics-handlers.js');

    registerAgentIpc(ipcMain, mainWindow!);
    registerFileIpc(ipcMain);
    registerTerminalIpc(ipcMain, mainWindow!);
    registerGitIpc(ipcMain);
    registerSettingsIpc(ipcMain);
    registerContextIpc(ipcMain, mainWindow!);
    registerCompletionIpc(ipcMain, mainWindow!);
    registerAppIpc(ipcMain, mainWindow!);
    registerDiagnosticsIpc(ipcMain);

    console.log('[Electron] All IPC handlers registered.');
}

// ── 创建主窗口 ──
function createMainWindow(): BrowserWindow {
    const win = new BrowserWindow({
        width: 1400,
        height: 900,
        minWidth: 900,
        minHeight: 600,
        title: 'DeepSeek IDE Agent',
        backgroundColor: '#1e1e1e', // VS Code dark theme background
        show: false, // 等 ready-to-show 再显示，避免白屏
        webPreferences: {
            preload: PRELOAD_PATH,
            nodeIntegration: false,       // 安全：禁用 Node 集成
            contextIsolation: true,        // 安全：启用上下文隔离
            sandbox: false,                // 需要 preload 访问 Node API
            webSecurity: true,
            spellcheck: false,
        },
    });

    console.log(`[Electron] Preload path: ${PRELOAD_PATH} (exists: ${fs.existsSync(PRELOAD_PATH)})`);

    // 加载页面
    if (isDev) {
        const devPort = process.env.VITE_DEV_PORT || '5174';
        const devUrl = `http://localhost:${devPort}`;
        console.log(`[Electron] Dev mode: loading ${devUrl}`);
        win.loadURL(devUrl);
        win.webContents.openDevTools({ mode: 'detach' });
    } else {
        // 生产模式：加载 Vite 构建的静态文件
        const indexPath = path.join(CLIENT_DIST, 'index.html');
        if (fs.existsSync(indexPath)) {
            console.log(`[Electron] Production mode: loading ${indexPath}`);
            win.loadFile(indexPath);
        } else {
            console.error(`[Electron] Build not found at ${indexPath}, falling back to dev`);
            win.loadURL('http://localhost:5174');
        }
    }

    // 就绪后显示窗口
    win.once('ready-to-show', () => {
        win.show();
        win.focus();
    });

    // 窗口关闭时清理
    win.on('closed', () => {
        mainWindow = null;
    });

    return win;
}

// ── 应用生命周期 ──
app.whenReady().then(async () => {
    console.log('[Electron] App ready, creating main window...');

    // 隐藏默认菜单栏（File/Edit/View 等对 IDE 无意义）
    Menu.setApplicationMenu(null);
    
    mainWindow = createMainWindow();
    
    // 注册所有 IPC 处理器
    await registerIpcHandlers();
    
    // macOS: 点击 dock 图标时重新创建窗口
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            mainWindow = createMainWindow();
        }
    });
});

// 所有窗口关闭时退出（macOS 除外）
app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// 防止多实例
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

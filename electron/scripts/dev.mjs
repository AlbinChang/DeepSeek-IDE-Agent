/**
 * Electron Dev Script
 * 
 * 开发模式启动流程：
 * 1. 编译 preload 脚本（esbuild，CJS）
 * 2. 编译 main process（esbuild，ESM）
 * 3. 启动 Vite dev server（Renderer 热更新）
 * 4. 启动 Electron（加载编译后的 main process）
 * 
 * 使用: node electron/scripts/dev.mjs
 */
import { spawn, execSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ELECTRON_ROOT = path.resolve(__dirname, '..');
const PROJECT_ROOT = path.resolve(ELECTRON_ROOT, '..');
const CLIENT_DIR = path.join(PROJECT_ROOT, 'client');

const VITE_PORT = process.env.VITE_DEV_PORT || '5174';

// 颜色输出
const colors = {
    reset: '\x1b[0m',
    cyan: '\x1b[36m',
    yellow: '\x1b[33m',
    green: '\x1b[32m',
    red: '\x1b[31m',
    magenta: '\x1b[35m',
};

function log(tag, color, ...args) {
    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    console.log(`${color}[${ts}][${tag}]${colors.reset}`, ...args);
}

// ── 确保 dist 目录存在 ──
function ensureDist() {
    const distDir = path.join(ELECTRON_ROOT, 'dist');
    if (!fs.existsSync(distDir)) {
        fs.mkdirSync(distDir, { recursive: true });
    }
    const mainDir = path.join(distDir, 'main');
    if (!fs.existsSync(mainDir)) {
        fs.mkdirSync(mainDir, { recursive: true });
    }
}

// ── 步骤 1: 编译 Preload ──
function buildPreload() {
    log('PRELOAD', colors.magenta, 'Building preload script...');
    try {
        execSync(
            `npx esbuild src/main/preload.ts --bundle --platform=node --target=node20 --outfile=dist/preload.cjs --format=cjs --external:electron`,
            { cwd: ELECTRON_ROOT, stdio: 'pipe' }
        );
        log('PRELOAD', colors.green, 'Preload built → dist/preload.cjs');
    } catch (err) {
        log('PRELOAD', colors.red, 'Preload build failed:', err.message);
        process.exit(1);
    }
}

// ── 步骤 2: 编译 Main Process ──
function buildMainProcess() {
    log('MAIN', colors.magenta, 'Building main process...');
    try {
        // ESM 格式，external 所有 Electron 运行时提供的模块
        execSync(
            [
                'npx esbuild src/main/index.ts',
                '--bundle',
                '--platform=node',
                '--target=node20',
                '--outfile=dist/main/index.js',
                '--format=esm',
                '--alias:@=../server/src',
                '--external:electron',
                '--external:node-pty',
                '--external:simple-git',
                '--external:iconv-lite',
                '--external:jschardet',
                '--external:mathjs',
                '--external:js-yaml',
                '--external:openai',
                '--external:dotenv',
                '--external:@modelcontextprotocol/*',
                '--external:@playwright/*',
                '--external:@fastify/*',
            ].join(' '),
            { cwd: ELECTRON_ROOT, stdio: 'pipe' }
        );
        log('MAIN', colors.green, 'Main process built → dist/main/index.js');
    } catch (err) {
        log('MAIN', colors.red, 'Main process build failed:', err.message);
        process.exit(1);
    }
}

// ── 端口清理：杀掉占用目标端口的进程 ──
function killPortProcess(port) {
    try {
        if (process.platform === 'win32') {
            execSync(
                `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
                { shell: 'powershell.exe', stdio: 'pipe', timeout: 5000 }
            );
        } else {
            execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'pipe', timeout: 3000 });
        }
        log('DEV', colors.cyan, `Port ${port} cleaned`);
    } catch {
        // 端口空闲或清理失败都是预期内，静默继续
    }
}

// ── 步骤 3: 启动 Vite Dev Server ──
function startViteDevServer() {
    return new Promise((resolve) => {
        // 先清理端口
        killPortProcess(VITE_PORT);

        log('VITE', colors.yellow, `Starting Vite dev server on port ${VITE_PORT}...`);

        const vite = spawn('npx', ['vite', '--host', '0.0.0.0', '--port', VITE_PORT, '--strictPort'], {
            cwd: CLIENT_DIR,
            stdio: 'pipe',
            shell: true,
            env: { ...process.env, VITE_DEV_PORT: VITE_PORT },
        });

        let started = false;
        let accumulated = '';

        vite.stdout.on('data', (data) => {
            const text = data.toString();
            process.stdout.write(`${colors.cyan}[VITE]${colors.reset} ${text}`);
            accumulated += text;

            // 累积检测：避免 "Local:" 跨 chunk 分割导致漏检
            if (!started && (accumulated.includes('Local:') || accumulated.includes('ready in'))) {
                started = true;
                log('VITE', colors.green, `Dev server ready at http://localhost:${VITE_PORT}`);
                resolve(vite);
            }
        });

        vite.stderr.on('data', (data) => {
            process.stderr.write(`${colors.red}[VITE:ERR]${colors.reset} ${data}`);
        });

        vite.on('error', (err) => {
            if (!started) {
                log('VITE', colors.red, 'Failed to start:', err.message);
                process.exit(1);
            }
        });

        // 超时回退（端口占用的 fallback）
        setTimeout(() => {
            if (!started) {
                log('VITE', colors.yellow, 'Timeout waiting for Vite, retrying with port cleanup...');
                vite.kill();
                // 二次清理后重试
                setTimeout(() => {
                    killPortProcess(VITE_PORT);
                    log('VITE', colors.yellow, 'Please restart manually if port is still occupied');
                    process.exit(1);
                }, 2000);
            }
        }, 15000);
    });
}

// ── 步骤 4: 启动 Electron ──
function startElectron() {
    log('ELECTRON', colors.green, 'Starting Electron...');

    const electronBin = path.join(ELECTRON_ROOT, 'node_modules', '.bin', 'electron.cmd');

    const electron = spawn(electronBin, ['.'], {
        cwd: ELECTRON_ROOT,
        stdio: 'inherit',
        shell: true,
        env: {
            ...process.env,
            NODE_ENV: 'development',
            VITE_DEV_PORT: VITE_PORT,
        },
    });

    electron.on('close', (code) => {
        log('ELECTRON', colors.yellow, `Electron exited with code ${code}`);
        process.exit(code || 0);
    });

    electron.on('error', (err) => {
        log('ELECTRON', colors.red, 'Failed to start Electron:', err.message);
        process.exit(1);
    });

    return electron;
}

// ── 主流程 ──
async function main() {
    console.log(`${colors.green}╔══════════════════════════════════════╗${colors.reset}`);
    console.log(`${colors.green}║  DeepSeek IDE Agent — Electron Dev  ║${colors.reset}`);
    console.log(`${colors.green}╚══════════════════════════════════════╝${colors.reset}`);
    console.log('');

    ensureDist();

    // 1. 编译 Preload（CJS，供 Electron 加载）
    buildPreload();

    // 2. 编译 Main Process（ESM）
    buildMainProcess();

    // 3. 启动 Vite Dev Server
    const viteProcess = await startViteDevServer();

    // 4. 启动 Electron
    const electronProcess = startElectron();

    // 清理
    const cleanup = () => {
        log('DEV', colors.yellow, 'Shutting down...');
        viteProcess.kill();
        electronProcess.kill();
        killPortProcess(VITE_PORT);
        process.exit(0);
    };

    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
}

main().catch((err) => {
    console.error('Dev script failed:', err);
    process.exit(1);
});

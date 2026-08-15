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
            `pnpm exec esbuild src/main/preload.ts --bundle --platform=node --target=node20 --outfile=dist/preload.cjs --format=cjs --external:electron`,
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
                'pnpm exec esbuild src/main/index.ts',
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

// ── 全局子进程句柄与退出清理标志 ──
let viteProcess = null;
let electronProcess = null;
let isCleaningUp = false;

// ── 终止进程树（跨平台杀死进程及其所有子进程） ──
function killProcessTree(proc) {
    if (!proc || !proc.pid) return;
    try {
        if (process.platform === 'win32') {
            execSync(`taskkill /PID ${proc.pid} /T /F`, { stdio: 'ignore' });
        } else {
            try {
                process.kill(-proc.pid, 'SIGKILL');
            } catch {
                proc.kill('SIGKILL');
            }
        }
    } catch {
        try {
            proc.kill();
        } catch {
            // 静默跳过
        }
    }
}

// ── 端口清理：强力杀掉占用目标端口的所有进程 ──
function killPortProcess(port) {
    try {
        if (process.platform === 'win32') {
            // 方案 1: netstat + taskkill（原生秒级精准终止）
            try {
                const output = execSync('netstat -ano -p tcp', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
                const lines = output.split('\n');
                const pids = new Set();
                for (const line of lines) {
                    if (line.includes(`:${port}`) && line.toUpperCase().includes('LISTENING')) {
                        const parts = line.trim().split(/\s+/);
                        const pid = parseInt(parts[parts.length - 1], 10);
                        if (pid && pid > 4 && pid !== process.pid) {
                            pids.add(pid);
                        }
                    }
                }
                for (const pid of pids) {
                    try {
                        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' });
                    } catch {
                        // ignore
                    }
                }
            } catch {
                // netstat 提取失败时走 PowerShell 兜底
            }

            // 方案 2: PowerShell 兜底查询
            try {
                execSync(
                    `Get-NetTCPConnection -LocalPort ${port} -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -gt 4 -and $_.OwningProcess -ne ${process.pid} } | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }`,
                    { shell: 'powershell.exe', stdio: 'ignore', timeout: 3000 }
                );
            } catch {
                // ignore
            }
        } else {
            execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null || true`, { stdio: 'ignore', timeout: 3000 });
        }
        log('DEV', colors.cyan, `Port ${port} cleaned`);
    } catch {
        // 端口空闲或清理失败都是预期内，静默继续
    }
}

// ── 统一清理退出函数 ──
function cleanup(exitCode = 0) {
    if (isCleaningUp) return;
    isCleaningUp = true;

    log('DEV', colors.yellow, 'Shutting down dev environment and releasing port 5174...');

    if (viteProcess) {
        killProcessTree(viteProcess);
        viteProcess = null;
    }

    if (electronProcess) {
        killProcessTree(electronProcess);
        electronProcess = null;
    }

    // 强力释放 Vite 端口
    killPortProcess(VITE_PORT);

    process.exit(exitCode);
}

// ── 步骤 3: 启动 Vite Dev Server ──
function startViteDevServer() {
    return new Promise((resolve) => {
        // 启动前先强力清理端口占用
        killPortProcess(VITE_PORT);

        log('VITE', colors.yellow, `Starting Vite dev server on port ${VITE_PORT}...`);

        const spawnVite = () => {
            const vite = spawn('pnpm', ['exec', 'vite', '--host', '0.0.0.0', '--port', VITE_PORT, '--strictPort'], {
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
                    viteProcess = vite;
                    resolve(vite);
                }
            });

            vite.stderr.on('data', (data) => {
                const text = data.toString();
                process.stderr.write(`${colors.red}[VITE:ERR]${colors.reset} ${text}`);

                // 若发现端口被占用，立即自动清理端口并重试启动
                if (!started && text.includes('already in use')) {
                    log('VITE', colors.yellow, `Detected port ${VITE_PORT} collision, force killing zombie process...`);
                    killProcessTree(vite);
                    killPortProcess(VITE_PORT);
                    setTimeout(() => {
                        if (!started) {
                            log('VITE', colors.yellow, `Retrying Vite dev server on port ${VITE_PORT}...`);
                            spawnVite();
                        }
                    }, 800);
                }
            });

            vite.on('error', (err) => {
                if (!started) {
                    log('VITE', colors.red, 'Failed to start:', err.message);
                    cleanup(1);
                }
            });

            // 15 秒启动超时兜底
            setTimeout(() => {
                if (!started) {
                    log('VITE', colors.yellow, 'Timeout waiting for Vite, retrying with port cleanup...');
                    killProcessTree(vite);
                    killPortProcess(VITE_PORT);
                    cleanup(1);
                }
            }, 15000);

            return vite;
        };

        spawnVite();
    });
}

// ── 步骤 4: 启动 Electron ──
function startElectron() {
    log('ELECTRON', colors.green, 'Starting Electron...');

    const isWin = process.platform === 'win32';
    const binName = isWin ? 'electron.cmd' : 'electron';
    const localBin = path.join(ELECTRON_ROOT, 'node_modules', '.bin', binName);
    const rootBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', binName);
    const electronBin = fs.existsSync(localBin) ? localBin : (fs.existsSync(rootBin) ? rootBin : binName);

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

    electronProcess = electron;

    // 当用户手动关闭 Electron 主窗口或主进程退出时，自动触发全局清理（释放 Vite 与端口 5174）
    electron.on('close', (code) => {
        log('ELECTRON', colors.yellow, `Electron window closed (code: ${code}). Automatically terminating Vite and cleaning port ${VITE_PORT}...`);
        cleanup(code || 0);
    });

    electron.on('exit', (code) => {
        if (!isCleaningUp) {
            cleanup(code || 0);
        }
    });

    electron.on('error', (err) => {
        log('ELECTRON', colors.red, 'Failed to start Electron:', err.message);
        cleanup(1);
    });

    return electron;
}

// ── 主流程 ──
async function main() {
    console.log(`${colors.green}╔══════════════════════════════════════╗${colors.reset}`);
    console.log(`${colors.green}║  DeepSeek IDE Agent — Electron Dev  ║${colors.reset}`);
    console.log(`${colors.green}╚══════════════════════════════════════╝${colors.reset}`);
    console.log('');

    // 注册全局终止信号与退出监听
    process.on('SIGINT', () => cleanup(0));
    process.on('SIGTERM', () => cleanup(0));
    process.on('SIGHUP', () => cleanup(0));
    process.on('uncaughtException', (err) => {
        console.error('[DEV:FATAL]', err);
        cleanup(1);
    });

    ensureDist();

    // 1. 编译 Preload（CJS，供 Electron 加载）
    buildPreload();

    // 2. 编译 Main Process（ESM）
    buildMainProcess();

    // 3. 启动 Vite Dev Server
    await startViteDevServer();

    // 4. 启动 Electron
    startElectron();
}

main().catch((err) => {
    console.error('Dev script failed:', err);
    process.exit(1);
});

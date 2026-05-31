import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

const COLORS = {
  reset: '\x1b[0m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

const SERVICES = {
  server: { dir: 'server', color: COLORS.cyan, label: 'API' },
  terminal: { dir: 'terminal-server', color: COLORS.magenta, label: 'PTY' },
  client: { dir: 'client', color: COLORS.yellow, label: 'WEB' },
};

function getCommands(mode) {
  const isWin = process.platform === 'win32';

  switch (mode) {
    case 'dev':
      return {
        server: {
          cwd: resolve(ROOT, 'server'),
          // tsx watch needs shell on Windows for correct signal forwarding
          command: isWin ? 'npx.cmd' : 'npx',
          args: ['tsx', 'watch', '--max-old-space-size=4096', 'src/index.ts'],
        },
        terminal: {
          cwd: resolve(ROOT, 'terminal-server'),
          command: isWin ? 'npx.cmd' : 'npx',
          args: ['tsx', 'watch', 'src/index.ts'],
        },
        client: {
          cwd: resolve(ROOT, 'client'),
          command: isWin ? 'npx.cmd' : 'npx',
          args: ['vite', '--host', '0.0.0.0'],
        },
      };
    case 'start':
      return {
        server: {
          cwd: resolve(ROOT, 'server'),
          command: 'node',
          args: ['--max-old-space-size=4096', 'dist/index.js'],
        },
        terminal: {
          cwd: resolve(ROOT, 'terminal-server'),
          command: 'node',
          args: ['dist/index.js'],
        },
        client: {
          cwd: resolve(ROOT, 'client'),
          command: 'node',
          args: ['static-server.js'],
        },
      };
    default:
      throw new Error(`Unknown mode: ${mode}. Use "dev", "start", or "check".`);
  }
}

function checkConfigs() {
  const checks = [
    { path: resolve(ROOT, 'server', 'server_conf.json'), name: 'server/server_conf.json' },
    { path: resolve(ROOT, 'terminal-server', 'server_conf.json'), name: 'terminal-server/server_conf.json' },
    { path: resolve(ROOT, 'client', 'server_conf.json'), name: 'client/server_conf.json' },
  ];

  let allOk = true;
  for (const { path, name } of checks) {
    if (existsSync(path)) {
      console.log(`  ${COLORS.green}✓${COLORS.reset} ${name}`);
    } else {
      console.log(`  ${COLORS.red}✗${COLORS.reset} ${name} ${COLORS.red}(MISSING)${COLORS.reset}`);
      allOk = false;
    }
  }

  // Check dist directories for start mode
  const distChecks = [
    { path: resolve(ROOT, 'server', 'dist'), name: 'server/dist/' },
    { path: resolve(ROOT, 'terminal-server', 'dist'), name: 'terminal-server/dist/' },
    { path: resolve(ROOT, 'client', 'dist'), name: 'client/dist/' },
  ];

  for (const { path, name } of distChecks) {
    if (existsSync(path)) {
      console.log(`  ${COLORS.green}✓${COLORS.reset} ${name}`);
    } else {
      console.log(`  ${COLORS.yellow}⚠${COLORS.reset} ${name} ${COLORS.yellow}(not built yet — run 'npm run build' first)${COLORS.reset}`);
    }
  }

  return allOk;
}

function timestamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function startServices(mode) {
  const commands = getCommands(mode);
  const children = [];
  let shuttingDown = false;

  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${COLORS.yellow}[${timestamp()}] 正在关闭所有服务...${COLORS.reset}`);

    for (const child of children) {
      if (child && !child.killed) {
        // On Windows, tree-kill is more reliable. Use taskkill as fallback.
        if (process.platform === 'win32') {
          try {
            process.kill(child.pid, 'SIGTERM');
          } catch {
            // pid may already be gone
          }
        } else {
          child.kill('SIGTERM');
        }
      }
    }

    // Force kill after 3 seconds
    setTimeout(() => {
      for (const child of children) {
        if (child && !child.killed) {
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
        }
      }
      process.exit(0);
    }, 3000);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  for (const [key, svc] of Object.entries(SERVICES)) {
    const cmd = commands[key];
    if (!cmd) continue;

    const prefix = `${svc.color}[${svc.label}]${COLORS.reset}`;
    console.log(`${prefix} 启动: ${cmd.cwd}`);

    const child = spawn(cmd.command, cmd.args, {
      cwd: cmd.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: process.platform === 'win32',
      env: { ...process.env, FORCE_COLOR: '1' },
    });

    child.stdout.on('data', (data) => {
      const lines = data.toString().trimEnd().split('\n');
      for (const line of lines) {
        if (line.trim()) console.log(`${prefix} ${line}`);
      }
    });

    child.stderr.on('data', (data) => {
      const lines = data.toString().trimEnd().split('\n');
      for (const line of lines) {
        if (line.trim()) console.log(`${prefix} ${COLORS.red}${line}${COLORS.reset}`);
      }
    });

    child.on('close', (code) => {
      if (!shuttingDown) {
        console.log(`${prefix} ${COLORS.red}进程退出 (code: ${code})${COLORS.reset}`);
        // When any service dies unexpectedly, shut down all
        shutdown();
      }
    });

    child.on('error', (err) => {
      console.log(`${prefix} ${COLORS.red}启动失败: ${err.message}${COLORS.reset}`);
      shutdown();
    });

    children.push(child);
  }

  console.log(`\n${COLORS.green}[${timestamp()}] 所有服务已启动 (${mode} 模式)${COLORS.reset}`);
  console.log(`${COLORS.green}  前端: http://localhost:5174${COLORS.reset}`);
  console.log(`${COLORS.green}  API:  http://localhost:3001${COLORS.reset}`);
  console.log(`${COLORS.green}  终端: ws://localhost:3003${COLORS.reset}`);
  console.log(`${COLORS.yellow}  按 Ctrl+C 停止所有服务${COLORS.reset}\n`);
}

// Main
const mode = process.argv[2];

if (!mode || !['dev', 'start', 'check'].includes(mode)) {
  console.log(`${COLORS.yellow}用法: node scripts/start-services.mjs <dev|start|check>${COLORS.reset}`);
  process.exit(1);
}

if (mode === 'check') {
  console.log(`${COLORS.cyan}检查配置文件...${COLORS.reset}`);
  const ok = checkConfigs();
  process.exit(ok ? 0 : 1);
}

// Ensure .env exists (copy from .env.example if not)
const envPath = resolve(ROOT, '.env');
const envExamplePath = resolve(ROOT, '.env.example');
if (!existsSync(envPath) && existsSync(envExamplePath)) {
  const { copyFileSync } = await import('node:fs');
  copyFileSync(envExamplePath, envPath);
  console.log(`${COLORS.yellow}[${timestamp()}] 已从 .env.example 创建 .env，请根据需要修改配置${COLORS.reset}`);
}

startServices(mode);

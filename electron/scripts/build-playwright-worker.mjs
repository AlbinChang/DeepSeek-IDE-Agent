/**
 * 构建 Playwright MCP Worker 单文件 bundle。
 *
 * 与 workflow worker 同样的取舍：CJS 输出 + banner 补齐 import.meta.url，
 * 因为 bundle 里会带入 server 侧的 CJS 依赖（dotenv 等）。
 *
 * MCP SDK 一并 bundle 进产物：打包后 worker 位于 resources/workers/（asar 之外），
 * 在那里 require('@modelcontextprotocol/sdk/...') 解析不到 node_modules，
 * 只有单文件才能保证启动路径稳定。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_ROOT = path.resolve(__dirname, '..');
const SERVER_SRC = path.resolve(ELECTRON_ROOT, '..', 'server', 'src');
const workersDir = path.join(ELECTRON_ROOT, 'dist', 'workers');

await fs.mkdir(workersDir, { recursive: true });

await build({
    entryPoints: [path.join(ELECTRON_ROOT, 'src', 'workers', 'playwrightMcpWorker.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(workersDir, 'playwrightMcpWorker.cjs'),
    alias: { '@': SERVER_SRC },
    define: { 'import.meta.url': '__playwrightImportMetaUrl' },
    banner: {
        js: [
            "const { pathToFileURL: __playwrightPathToFileURL } = require('node:url');",
            'const __playwrightImportMetaUrl = __playwrightPathToFileURL(__filename).href;',
        ].join('\n'),
    },
    logLevel: 'info',
});

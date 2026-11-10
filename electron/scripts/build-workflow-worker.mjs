/**
 * 构建 Workflow Worker 单文件 bundle。
 *
 * 选择 CJS 输出：server 依赖（dotenv/simple-git/openai 等）是 CJS，
 * ESM bundle 会把它们的 require('fs') 变成运行时动态 require 而失败。
 * CJS 输出下用 banner 提供 import.meta.url 兼容值（PathUtils 等模块会读取）。
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
// 清理上一版 ESM bundle，避免打包时同时带两个入口
await fs.rm(path.join(workersDir, 'workflowWorker.js'), { force: true });

await build({
    entryPoints: [path.join(ELECTRON_ROOT, 'src', 'workers', 'workflowWorker.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(workersDir, 'workflowWorker.cjs'),
    alias: { '@': SERVER_SRC },
    define: { 'import.meta.url': '__workflowImportMetaUrl' },
    banner: {
        js: [
            "const { pathToFileURL: __workflowPathToFileURL } = require('node:url');",
            'const __workflowImportMetaUrl = __workflowPathToFileURL(__filename).href;',
        ].join('\n'),
    },
    logLevel: 'info',
});

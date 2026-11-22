/**
 * 构建 DuckDB Worker 单文件 bundle。
 *
 * - CJS 输出：与 workflow worker 一致，兼容 server 依赖的 CJS 语义。
 * - `@duckdb/node-api` 保持 external：原生 .node/.dll 由 Node 在运行时按平台解析，
 *   打包时通过 electron-builder 的 asarUnpack 暴露。
 * - banner 提供 import.meta.url 兼容值（PathUtils 等模块会读取）。
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
await fs.rm(path.join(workersDir, 'duckdbWorker.js'), { force: true });

await build({
    entryPoints: [path.join(SERVER_SRC, 'duckdb', 'duckdbWorkerMain.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'cjs',
    outfile: path.join(workersDir, 'duckdbWorker.cjs'),
    alias: { '@': SERVER_SRC },
    external: ['@duckdb/node-api', '@duckdb/node-bindings'],
    define: { 'import.meta.url': '__duckdbImportMetaUrl' },
    banner: {
        js: [
            "const { pathToFileURL: __duckdbPathToFileURL } = require('node:url');",
            'const __duckdbImportMetaUrl = __duckdbPathToFileURL(__filename).href;',
        ].join('\n'),
    },
    logLevel: 'info',
});

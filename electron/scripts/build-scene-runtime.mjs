/**
 * 构建 scene3d 无头渲染运行时（IIFE 单文件）。
 *
 * 与客户端共用同一份源码 client/src/three/scene-runtime.ts：
 * - 客户端由 Vite 打包，直接走 ESM；
 * - 服务端预渲染需要浏览器可直接执行的产物，因此把 three.js 及 addons 一起 bundle，
 *   由 Playwright 页面的 <script> 加载，产物随 extraResources 发布到 resources/three/。
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_ROOT = path.resolve(__dirname, '..');
const CLIENT_RUNTIME = path.resolve(ELECTRON_ROOT, '..', 'client', 'src', 'three', 'scene-runtime.ts');
const outputDir = path.join(ELECTRON_ROOT, 'dist', 'three');

await fs.mkdir(outputDir, { recursive: true });

await build({
    entryPoints: [CLIENT_RUNTIME],
    bundle: true,
    platform: 'browser',
    target: 'chrome110',
    format: 'iife',
    globalName: 'Scene3dRuntime',
    outfile: path.join(outputDir, 'scene-runtime.js'),
    minify: true,
    legalComments: 'none',
    logLevel: 'info',
});

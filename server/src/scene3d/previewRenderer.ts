/**
 * 3D 无头预渲染：Playwright(Chromium) + three.js 运行时 → PNG。
 *
 * 流程：临时 HTTP 服务（127.0.0.1 随机端口 + 随机 token 前缀）→ 打开内联 HTML →
 * 载入 dist/three/scene-runtime.js → 渲染 → 截图 → 回收浏览器与服务。
 * 页面内同时回报三角面/包围盒/像素覆盖率，纯文本模型据此判断构图是否为空。
 */

import { createServer, type Server } from 'node:http';
import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import * as path from 'node:path';
import crypto from 'node:crypto';
import { SERVER_ROOT } from '@/utils/PathUtils.js';

export interface Scene3dRenderStats {
    objects: number;
    meshes: number;
    triangles: number;
    drawCalls: number;
    textures: number;
    geometries: number;
    animations: number;
    bounds: {
        min: [number, number, number];
        max: [number, number, number];
        size: [number, number, number];
        center: [number, number, number];
        radius: number;
    };
    durationMs: number;
}

export interface Scene3dRenderPixelStats {
    coverage: number;
    meanLuma: number;
    minLuma: number;
    maxLuma: number;
    background: [number, number, number, number];
}

export interface Scene3dRenderResult {
    png: Buffer;
    stats: Scene3dRenderStats;
    pixelStats: Scene3dRenderPixelStats | null;
    width: number;
    height: number;
    durationMs: number;
}

export interface Scene3dRenderRequest {
    workspaceRoot: string;
    /** 已校验的场景（可直接用于渲染） */
    spec: Record<string, any>;
    /** 解析 spec 内相对 src 的基准目录（工作区相对路径） */
    baseDir?: string;
    width?: number;
    height?: number;
    timeoutMs?: number;
}

const MIME_BY_EXT: Record<string, string> = {
    '.glb': 'model/gltf-binary',
    '.gltf': 'model/gltf+json',
    '.obj': 'text/plain; charset=utf-8',
    '.stl': 'model/stl',
    '.bin': 'application/octet-stream',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.ktx2': 'image/ktx2',
};

const MAX_VIEWPORT = 4096;
const MIN_VIEWPORT = 64;
const DEFAULT_TIMEOUT_MS = 60_000;

/** 串行化渲染：避免并发拉起多个 Chromium 拖垮桌面环境 */
let renderQueue: Promise<unknown> = Promise.resolve();

function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const next = renderQueue.then(task, task);
    renderQueue = next.catch(() => undefined);
    return next;
}

export function resolveScene3dRuntimePath(): string | null {
    const candidates = [
        process.env.SCENE3D_RUNTIME,
        path.resolve(SERVER_ROOT, '..', 'electron', 'dist', 'three', 'scene-runtime.js'),
    ].filter((value): value is string => Boolean(value));
    for (const candidate of candidates) {
        if (existsSync(candidate)) return candidate;
    }
    return null;
}

/**
 * Playwright 在打包产物里被标记为 external；utilityProcess Worker 的入口位于
 * resources/workers，无法按相对路径找到 node_modules，因此优先用主进程注入的
 * SCENE3D_REQUIRE_BASE（应用根 package.json）解析。
 */
async function loadPlaywright(): Promise<any> {
    const base = process.env.SCENE3D_REQUIRE_BASE;
    if (base) {
        try {
            return createRequire(base)('playwright');
        } catch {
            // 回退到常规 ESM 解析（开发/测试环境）
        }
    }
    return import('playwright');
}

function clampViewport(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : fallback;
    return Math.max(MIN_VIEWPORT, Math.min(MAX_VIEWPORT, parsed));
}

function isInsideDirectory(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function buildPreviewHtml(request: {
    spec: Record<string, any>;
    token: string;
    baseDir: string;
    width: number;
    height: number;
}): string {
    const safeSpec = JSON.stringify(request.spec).replace(/</g, '\\u003c');
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>scene3d preview</title>
<style>
  html, body { margin: 0; padding: 0; width: 100%; height: 100%; overflow: hidden; background: #0b0d12; }
  #scene { display: block; width: 100vw; height: 100vh; }
</style>
</head>
<body>
<canvas id="scene"></canvas>
<script src="runtime.js"></script>
<script>
(function () {
  var spec = ${safeSpec};
  var baseDir = ${JSON.stringify(request.baseDir || '')};
  var token = ${JSON.stringify(request.token)};
  window.__scene3d = { ready: false };

  function joinPath(base, src) {
    var parts = String(base || '').split('/').concat(String(src || '').split('/'));
    var output = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      if (!part || part === '.') continue;
      if (part === '..') { output.pop(); continue; }
      output.push(part);
    }
    return output.join('/');
  }

  function resolveUrl(src) {
    if (/^(data:|https?:|blob:|\\/)/.test(src)) return src;
    var joined = joinPath(baseDir, src);
    return '/s/' + token + '/' + joined.split('/').map(encodeURIComponent).join('/');
  }

  Scene3dRuntime
    .renderPreview(document.getElementById('scene'), spec, {
      resolveUrl: resolveUrl,
      width: ${request.width},
      height: ${request.height},
    })
    .then(function (result) {
      window.__scene3d = { ready: true, stats: result.stats, pixelStats: result.pixelStats };
    })
    .catch(function (error) {
      window.__scene3d = { ready: false, error: String((error && error.message) || error) };
    });
})();
</script>
</body>
</html>`;
}

interface StaticServerHandle {
    server: Server;
    origin: string;
}

async function startStaticServer(options: {
    workspaceRoot: string;
    runtimePath: string;
    html: string;
    token: string;
}): Promise<StaticServerHandle> {
    const { workspaceRoot, runtimePath, html, token } = options;
    const runtimeBytes = await fs.readFile(runtimePath);
    const workspaceAbsolute = path.resolve(workspaceRoot);

    const server = createServer(async (req, res) => {
        try {
            const requestUrl = new URL(req.url || '/', 'http://127.0.0.1');
            const pathname = decodeURIComponent(requestUrl.pathname);

            // 所有路由都必须带上本次渲染的随机 token，避免本机其它进程探测端口后读取工作区文件
            const prefix = `/s/${token}/`;
            if (!pathname.startsWith(prefix)) {
                res.writeHead(404);
                res.end('not found');
                return;
            }
            const relative = pathname.slice(prefix.length);

            if (relative === '' || relative === 'index.html') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end(html);
                return;
            }
            if (relative === 'runtime.js') {
                res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
                res.end(runtimeBytes);
                return;
            }
            if (!relative || relative.includes('\0') || relative.split('/').includes('..')) {
                res.writeHead(400);
                res.end('bad path');
                return;
            }
            const absolute = path.resolve(workspaceAbsolute, relative);
            if (!isInsideDirectory(workspaceAbsolute, absolute)) {
                res.writeHead(403);
                res.end('forbidden');
                return;
            }
            const stat = await fs.stat(absolute).catch(() => null);
            if (!stat || !stat.isFile()) {
                res.writeHead(404);
                res.end('not found');
                return;
            }
            const extension = path.extname(absolute).toLowerCase();
            res.writeHead(200, {
                'Content-Type': MIME_BY_EXT[extension] || 'application/octet-stream',
                'Content-Length': stat.size,
                'Cache-Control': 'no-store',
            });
            res.end(await fs.readFile(absolute));
        } catch (error: any) {
            res.writeHead(500);
            res.end(String(error?.message || error));
        }
    });

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve());
    });
    const address = server.address();
    const port = typeof address === 'object' && address ? address.port : 0;
    return { server, origin: `http://127.0.0.1:${port}` };
}

async function closeServer(server: Server): Promise<void> {
    await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function renderInternal(request: Scene3dRenderRequest): Promise<Scene3dRenderResult> {
    const startedAt = Date.now();
    const width = clampViewport(request.width, 1280);
    const height = clampViewport(request.height, 720);
    const runtimePath = resolveScene3dRuntimePath();
    if (!runtimePath) {
        throw new Error(
            '缺少 3D 渲染运行时（scene-runtime.js）。请先执行 `pnpm --filter deepseek-ide-agent-electron run build:scene-runtime`，'
            + '或设置环境变量 SCENE3D_RUNTIME 指向打包产物。',
        );
    }

    let playwright: any;
    try {
        playwright = await loadPlaywright();
    } catch (error: any) {
        throw new Error(`Playwright 未安装，无法进行 3D 预渲染：${error?.message || error}`);
    }

    const token = crypto.randomUUID();
    const html = buildPreviewHtml({
        spec: request.spec,
        token,
        baseDir: (request.baseDir || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
        width,
        height,
    });

    const { server, origin } = await startStaticServer({
        workspaceRoot: request.workspaceRoot,
        runtimePath,
        html,
        token,
    });

    let browser: any = null;
    const consoleErrors: string[] = [];
    try {
        browser = await playwright.chromium.launch({
            headless: true,
            args: [
                '--use-angle=swiftshader',
                '--enable-unsafe-swiftshader',
                '--hide-scrollbars',
                '--mute-audio',
                '--disable-dev-shm-usage',
                '--force-color-profile=srgb',
            ],
        });
        const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
        page.on('pageerror', (error: any) => consoleErrors.push(String(error?.message || error)));
        page.on('console', (message: any) => {
            if (message.type() === 'error') consoleErrors.push(message.text());
        });
        // 渲染页只允许访问本次临时服务与内存资源，防止模型内嵌 URL 发起外部请求
        await page.route('**/*', (route: any) => {
            const requestUrl = String(route.request().url());
            if (requestUrl.startsWith(origin) || requestUrl.startsWith('data:') || requestUrl.startsWith('blob:')) {
                return route.continue();
            }
            return route.abort();
        });

        await page.goto(`${origin}/s/${token}/`, { waitUntil: 'load', timeout: 20_000 });
        const timeout = Math.max(5_000, Math.min(180_000, request.timeoutMs ?? DEFAULT_TIMEOUT_MS));
        // 字符串表达式：避免 Node 侧 TS 需要 DOM lib 类型
        await page.waitForFunction(
            'Boolean(window.__scene3d && (window.__scene3d.ready || window.__scene3d.error))',
            undefined,
            { timeout, polling: 100 },
        );
        const state = await page.evaluate('window.__scene3d');
        if (!state?.ready) {
            const detail = [state?.error, ...consoleErrors.slice(-4)].filter(Boolean).join(' | ');
            throw new Error(`3D 渲染失败：${detail || '未知错误'}`);
        }
        const png = await page.screenshot({ type: 'png', animations: 'disabled' });
        return {
            png: Buffer.from(png),
            stats: state.stats,
            pixelStats: state.pixelStats ?? null,
            width,
            height,
            durationMs: Date.now() - startedAt,
        };
    } finally {
        if (browser) await browser.close().catch(() => undefined);
        await closeServer(server).catch(() => undefined);
    }
}

export function renderScene3dPreview(request: Scene3dRenderRequest): Promise<Scene3dRenderResult> {
    return runExclusive(() => renderInternal(request));
}

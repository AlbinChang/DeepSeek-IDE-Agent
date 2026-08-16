/**
 * File Operations IPC Handler
 * 
 * 替换 REST /api/files/* 路由，直接使用 FileIO + PathUtils 操作文件系统。
 * 在 Electron Main Process 中运行，享有完整文件系统访问权限。
 */
import { IpcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as zlib from 'node:zlib';
import { PROJECT_ROOT } from '../index.js';

// ═══════════════════════════════════════════════════════════════
// ZIP/JAR 文件解析工具（纯 Node.js 内置模块，零外部依赖）
// ═══════════════════════════════════════════════════════════════

/** ZIP 中央目录条目 */
interface ZipEntry {
    name: string;
    isDirectory: boolean;
    compressedSize: number;
    uncompressedSize: number;
    compressionMethod: number;
    localHeaderOffset: number;
}

/** 解析 ZIP 文件的中央目录，返回所有条目列表 */
function parseZipEntries(zipBuffer: Buffer): ZipEntry[] {
    const entries: ZipEntry[] = [];

    // 查找 EOCD 签名 (0x06054b50) 从文件末尾向前搜索
    let eocdOffset = -1;
    const minEocdSize = 22;
    const maxEocdCommentSize = 65535;
    const searchStart = Math.max(0, zipBuffer.length - minEocdSize - maxEocdCommentSize);

    for (let i = zipBuffer.length - minEocdSize; i >= searchStart; i--) {
        if (zipBuffer.readUInt32LE(i) === 0x06054b50) {
            eocdOffset = i;
            break;
        }
    }

    if (eocdOffset === -1) {
        throw new Error('Invalid ZIP file: EOCD signature not found');
    }

    const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
    const centralDirOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

    let offset = centralDirOffset;
    for (let i = 0; i < totalEntries; i++) {
        if (offset + 46 > zipBuffer.length) break;

        const signature = zipBuffer.readUInt32LE(offset);
        if (signature !== 0x02014b50) break;

        const compressionMethod = zipBuffer.readUInt16LE(offset + 10);
        const compressedSize = zipBuffer.readUInt32LE(offset + 20);
        const uncompressedSize = zipBuffer.readUInt32LE(offset + 24);
        const fileNameLength = zipBuffer.readUInt16LE(offset + 28);
        const extraFieldLength = zipBuffer.readUInt16LE(offset + 30);
        const fileCommentLength = zipBuffer.readUInt16LE(offset + 32);
        const localHeaderOffset = zipBuffer.readUInt32LE(offset + 42);

        const fileNameStart = offset + 46;
        if (fileNameStart + fileNameLength > zipBuffer.length) break;
        const fileName = zipBuffer.toString('utf-8', fileNameStart, fileNameStart + fileNameLength);
        const normalizedName = fileName.replace(/\\/g, '/');

        entries.push({
            name: normalizedName,
            isDirectory: normalizedName.endsWith('/'),
            compressedSize,
            uncompressedSize,
            compressionMethod,
            localHeaderOffset,
        });

        offset = fileNameStart + fileNameLength + extraFieldLength + fileCommentLength;
    }

    return entries;
}

/** 从 ZIP buffer 中读取并解压单个条目的内容 */
function readZipEntryContent(zipBuffer: Buffer, entry: ZipEntry): Buffer {
    let localOffset = entry.localHeaderOffset;

    if (localOffset + 30 > zipBuffer.length) {
        throw new Error('Local file header out of bounds');
    }

    const signature = zipBuffer.readUInt32LE(localOffset);
    if (signature !== 0x04034b50) {
        throw new Error('Invalid local file header signature');
    }

    const fileNameLength = zipBuffer.readUInt16LE(localOffset + 26);
    const extraFieldLength = zipBuffer.readUInt16LE(localOffset + 28);

    const dataOffset = localOffset + 30 + fileNameLength + extraFieldLength;
    const compressedData = zipBuffer.subarray(dataOffset, dataOffset + entry.compressedSize);

    if (entry.compressionMethod === 0) {
        // STORE（无压缩）
        return Buffer.from(compressedData);
    } else if (entry.compressionMethod === 8) {
        // DEFLATE 压缩
        return zlib.inflateRawSync(compressedData);
    } else {
        throw new Error(`Unsupported compression method: ${entry.compressionMethod}`);
    }
}

// 简单路径校验（对齐 PathUtils 的沙箱逻辑）
function resolveSafePath(userPath: string, root?: string): string {
    const base = root || PROJECT_ROOT;
    
    // 处理相对路径
    let resolved: string;
    if (path.isAbsolute(userPath)) {
        resolved = path.resolve(userPath);
    } else {
        resolved = path.resolve(base, userPath);
    }
    
    // 确保路径在 project root 内（可配置放宽）
    // 在 Electron 桌面应用中，我们允许访问用户选择的任意工作区
    if (root && !resolved.startsWith(path.resolve(root))) {
        // 放宽限制：允许访问工作区外的文件（桌面应用有完整文件系统权限）
        console.warn(`[FileIPC] Path outside workspace root: ${resolved}`);
    }
    
    return resolved;
}

// ═══════════════════════════════════════════════════════════════
// 全局文件搜索优化配置与工具函数
// ═══════════════════════════════════════════════════════════════

/** 搜索时忽略的目录（依赖、构建产物、缓存、虚拟环境等） */
const SEARCH_SKIP_DIRS = new Set([
    // 版本控制
    '.git', '.svn', '.hg', '.bzr', 'CVS',
    // 依赖与包管理器
    'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'Pods', '.pnpm-store',
    // 构建产物与缓存
    'dist', 'build', 'out', 'target', '.next', '.nuxt', '.turbo', '.cache', '.output',
    '.svelte-kit', '.parcel-cache', '.docusaurus', 'storybook-static', 'coverage', '.nyc_output',
    // 虚拟环境
    '.venv', 'venv', 'env', '.env', 'virtualenv', '.conda', 'conda-meta',
    // IDE 与 Agent 内部目录
    '.idea', '.vscode', '.vs', '.ide-agent', '.llm', '.tools', '.memory', '.cursor',
    // 语言与框架缓存
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.gradle', '.cargo', 'tmp', 'temp',
]);

/** 搜索文件内容时应跳过的二进制/巨型文件后缀 */
const BINARY_EXTENSIONS = new Set([
    // 图片
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.bmp', '.tiff', '.tif', '.svg', '.psd', '.ai', '.raw', '.heic', '.avif',
    // 音视频
    '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.aac', '.m4a', '.wma', '.avi', '.mov', '.mkv', '.webm', '.flv', '.wmv',
    // 压缩与归档
    '.zip', '.tar', '.gz', '.tgz', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war', '.ear', '.iso', '.dmg',
    // 二进制可执行与动态库
    '.exe', '.dll', '.so', '.dylib', '.bin', '.node', '.wasm', '.obj', '.o', '.a', '.lib',
    // 编译字节码
    '.pyc', '.pyo', '.pyd', '.class', '.dex',
    // 数据库与数据文件
    '.db', '.sqlite', '.sqlite3', '.db3', '.parquet', '.arrow', '.feather', '.pkl', '.pickle', '.dat',
    // 字体与大型文档
    '.woff', '.woff2', '.ttf', '.otf', '.eot', '.pdf', '.docx', '.xlsx', '.pptx',
    // Source Map 与压缩打包（单行超大，内容搜索会导致主进程卡顿）
    '.map', '.min.js', '.min.css',
]);

/** 搜索内容时应跳过的巨型 lock 文件 */
const LOCK_FILES = new Set([
    'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'cargo.lock', 'composer.lock', 'poetry.lock', 'gemfile.lock'
]);

// 维护全局当前的搜索请求序列，用于取消过期搜索任务
let globalActiveSearchSeq = 0;

// 简单 MIME 类型推断（按文件扩展名）
function getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const mimeMap: Record<string, string> = {
        '.pdf': 'application/pdf',
        '.png': 'image/png',
        '.jpg': 'image/jpeg',
        '.jpeg': 'image/jpeg',
        '.gif': 'image/gif',
        '.webp': 'image/webp',
        '.svg': 'image/svg+xml',
        '.bmp': 'image/bmp',
        '.ico': 'image/x-icon',
        '.tiff': 'image/tiff',
        '.tif': 'image/tiff',
    };
    return mimeMap[ext] || 'application/octet-stream';
}

// 文件编码检测与转换（简化版）
function detectEncoding(buffer: Buffer): string {
    // 简单的 BOM 检测
    if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) return 'utf-8';
    if (buffer.length >= 2 && buffer[0] === 0xFE && buffer[1] === 0xFF) return 'utf-16be';
    if (buffer.length >= 2 && buffer[0] === 0xFF && buffer[1] === 0xFE) return 'utf-16le';
    
    // 检查是否为二进制文件
    for (let i = 0; i < Math.min(buffer.length, 512); i++) {
        if (buffer[i] === 0) return 'binary';
    }
    
    return 'utf-8';
}

export function registerFileIpc(ipcMain: IpcMain) {
    
    // ── 读取文件 ──
    ipcMain.handle('file:read', async (_event, params: {
        filePath: string;
        startLine?: number;
        endLine?: number;
        encoding?: string;
        root?: string;
    }) => {
        try {
            const resolvedPath = resolveSafePath(params.filePath, params.root);
            
            if (!fs.existsSync(resolvedPath)) {
                return { success: false, error: `File not found: ${params.filePath}` };
            }

            const stat = fs.statSync(resolvedPath);
            if (stat.isDirectory()) {
                return { success: false, error: `Path is a directory: ${params.filePath}` };
            }

            const buffer = fs.readFileSync(resolvedPath);
            const detectedEncoding = params.encoding || detectEncoding(buffer);
            
            let content: string;
            try {
                // 使用 iconv-lite 进行编码转换（如果可用）
                const iconv = await import('iconv-lite');
                content = iconv.default.decode(buffer, detectedEncoding);
            } catch {
                content = buffer.toString(detectedEncoding as BufferEncoding || 'utf-8');
            }

            const lines = content.split('\n');
            
            // 行号裁剪
            if (params.startLine !== undefined || params.endLine !== undefined) {
                const start = Math.max(1, params.startLine || 1) - 1;
                const end = Math.min(lines.length, params.endLine || lines.length);
                content = lines.slice(start, end).join('\n');
            }

            return {
                success: true,
                content,
                encoding: detectedEncoding,
                lineCount: lines.length,
                filePath: resolvedPath,
            };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── 写入文件 ──
    ipcMain.handle('file:write', async (_event, params: {
        filePath: string;
        content: string;
        encoding?: string;
        root?: string;
    }) => {
        try {
            const resolvedPath = resolveSafePath(params.filePath, params.root);
            
            // 确保目录存在
            const dir = path.dirname(resolvedPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            const encoding = params.encoding || 'utf-8';
            
            try {
                const iconv = await import('iconv-lite');
                const encodedBuffer = iconv.default.encode(params.content, encoding);
                fs.writeFileSync(resolvedPath, encodedBuffer);
            } catch {
                fs.writeFileSync(resolvedPath, params.content, encoding as BufferEncoding || 'utf-8');
            }

            return {
                success: true,
                filePath: resolvedPath,
            };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── 新建文件/目录 (2026.08 新建文本文件功能) ──
    ipcMain.handle('file:create', async (_event, params: {
        filePath: string;
        type?: 'file' | 'directory' | 'folder';
        root?: string;
    }) => {
        try {
            const resolvedPath = resolveSafePath(params.filePath, params.root);
            const name = path.basename(resolvedPath);
            if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) {
                return { success: false, error: `Invalid file name: ${name}` };
            }

            if (fs.existsSync(resolvedPath)) {
                return { success: false, error: `Path already exists: ${params.filePath}` };
            }

            const isDirectory = params.type === 'directory' || params.type === 'folder';
            const dir = path.dirname(resolvedPath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }

            if (isDirectory) {
                fs.mkdirSync(resolvedPath, { recursive: true });
            } else {
                fs.writeFileSync(resolvedPath, '');
            }

            return { success: true, filePath: resolvedPath, type: isDirectory ? 'directory' : 'file' };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── 列出目录 ──
    ipcMain.handle('file:list', async (_event, params: {
        dirPath: string;
        depth?: number;
        root?: string;
    }) => {
        try {
            const resolvedPath = resolveSafePath(params.dirPath, params.root);
            const maxDepth = Math.min(params.depth || 3, 10); // 最大深度限制

            function walkDir(dir: string, currentDepth: number): Array<{
                name: string;
                path: string;
                type: 'file' | 'directory';
                isDirectory: boolean;
                isFile: boolean;
            }> {
                if (currentDepth > maxDepth) return [];
                
                const results: any[] = [];
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    
                    // 过滤系统目录
                    const skipDirs = new Set([
                        '.git', 'node_modules', '.ide-agent', '.llm', '.tools',
                        '.memory', '__pycache__', '.vscode', 'dist', '.next'
                    ]);
                    
                    for (const entry of entries) {
                        // 跳过隐藏文件和系统目录
                        if (entry.name.startsWith('.') && skipDirs.has(entry.name)) continue;
                        
                        const fullPath = path.join(dir, entry.name);
                        const isDir = entry.isDirectory();
                        
                        results.push({
                            name: entry.name,
                            path: fullPath,
                            type: isDir ? 'directory' : 'file',
                            isDirectory: isDir,
                            isFile: entry.isFile(),
                        });
                        
                        // 递归（仅目录 + 未超深度）
                        if (isDir && currentDepth < maxDepth) {
                            // 不递归 node_modules
                            if (entry.name !== 'node_modules') {
                                results.push(...walkDir(fullPath, currentDepth + 1));
                            }
                        }
                    }
                } catch {
                    // 权限不足等，跳过
                }
                return results;
            }

            const files = walkDir(resolvedPath, 1);

            return {
                success: true,
                files,
                totalCount: files.length,
            };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── 搜索文件 ──
    ipcMain.handle('file:search', async (_event, params: {
        pattern: string;
        root?: string;
        maxResults?: number;
    }) => {
        const searchSeq = ++globalActiveSearchSeq;
        try {
            const resolvedPath = resolveSafePath(params.root || '.', params.root);
            const maxResults = Math.min(Math.max(params.maxResults || 50, 1), 200);
            const searchPattern = (params.pattern || '').trim().toLowerCase();
            
            if (!searchPattern) {
                return { success: true, results: [] };
            }

            const results: Array<{ path: string; line: number; content: string }> = [];
            const seenPaths = new Set<string>();
            const contentCandidates: string[] = [];

            // 1. 广度优先异步扫描目录（非阻塞主线程）
            const dirQueue: Array<{ dir: string; depth: number }> = [{ dir: resolvedPath, depth: 0 }];
            const visitedDirs = new Set<string>();
            const maxDepth = 15;
            const maxScannedFiles = 5000; // 最多扫描 5000 个文件，防止超大项目耗时过长
            let scannedFileCount = 0;
            let loopCounter = 0;

            const startTime = Date.now();
            const MAX_SEARCH_TIME_MS = 2500; // 单次搜索最大允许耗时 2.5s

            while (dirQueue.length > 0 && results.length < maxResults) {
                // 如果已有新的搜索请求发起，立即中止当前过期的搜索
                if (searchSeq !== globalActiveSearchSeq) {
                    return { success: false, error: 'SEARCH_ABORTED' };
                }

                // 超时保护
                if (Date.now() - startTime > MAX_SEARCH_TIME_MS) {
                    break;
                }

                const current = dirQueue.shift()!;
                if (visitedDirs.has(current.dir) || current.depth > maxDepth) continue;
                visitedDirs.add(current.dir);

                let entries: fs.Dirent[];
                try {
                    entries = await fs.promises.readdir(current.dir, { withFileTypes: true });
                } catch {
                    continue; // 忽略无权限等目录
                }

                for (const entry of entries) {
                    const fullPath = path.join(current.dir, entry.name);

                    if (entry.isDirectory()) {
                        // 过滤忽略目录及隐藏目录
                        if (!SEARCH_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) {
                            dirQueue.push({ dir: fullPath, depth: current.depth + 1 });
                        }
                    } else if (entry.isFile()) {
                        scannedFileCount++;
                        if (seenPaths.has(fullPath)) continue;

                        const lowerName = entry.name.toLowerCase();
                        // 优先按文件名匹配（快速路径，无需磁盘读内容）
                        if (lowerName.includes(searchPattern)) {
                            seenPaths.add(fullPath);
                            results.push({
                                path: fullPath,
                                line: 0,
                                content: `[文件名匹配] ${entry.name}`,
                            });
                            if (results.length >= maxResults) break;
                        } else {
                            // 收集可能需要进行内容搜索的文本文件候选列表
                            const ext = path.extname(lowerName);
                            if (!BINARY_EXTENSIONS.has(ext) && !LOCK_FILES.has(lowerName)) {
                                contentCandidates.push(fullPath);
                            }
                        }

                        if (scannedFileCount >= maxScannedFiles) break;
                    }
                }

                // 协程让出：每遍历 10 个目录主动让出事件循环，确保 Electron 主线程处理 UI 与 IPC 事件
                loopCounter++;
                if (loopCounter % 10 === 0) {
                    await new Promise<void>((resolve) => setImmediate(resolve));
                }

                if (scannedFileCount >= maxScannedFiles) break;
            }

            // 2. 如果文件名匹配未填满 maxResults，且搜索词长度 >= 2，对候选文件进行内容匹配
            // （单个字符不做全盘内容扫描，避免匹配量过大）
            if (results.length < maxResults && searchPattern.length >= 2 && contentCandidates.length > 0) {
                let contentCheckedCount = 0;
                const MAX_CONTENT_CANDIDATES = 300; // 最多检查 300 个候选文本文件
                const MAX_FILE_SIZE = 256 * 1024; // 大于 256KB 的文件不进行内容全文扫描

                for (const candidatePath of contentCandidates) {
                    if (results.length >= maxResults) break;
                    if (searchSeq !== globalActiveSearchSeq) {
                        return { success: false, error: 'SEARCH_ABORTED' };
                    }
                    if (Date.now() - startTime > MAX_SEARCH_TIME_MS) break;

                    contentCheckedCount++;
                    try {
                        const stat = await fs.promises.stat(candidatePath);
                        if (stat.size > MAX_FILE_SIZE || stat.size === 0) continue;

                        const content = await fs.promises.readFile(candidatePath, 'utf-8');
                        
                        // 快速二进制特征检测（前 512 字节含 NULL 字符则跳过）
                        const sample = content.substring(0, 512);
                        if (sample.includes('\0')) continue;

                        const lines = content.split('\n');
                        for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                            const line = lines[i];
                            if (line.toLowerCase().includes(searchPattern)) {
                                seenPaths.add(candidatePath);
                                results.push({
                                    path: candidatePath,
                                    line: i + 1,
                                    content: line.trim().substring(0, 200),
                                });
                                break; // 每个文件只记录首个命中行
                            }
                        }
                    } catch {
                        // 忽略读取错误
                    }

                    // 每检查 15 个文件让出一次事件循环
                    if (contentCheckedCount % 15 === 0) {
                        await new Promise<void>((resolve) => setImmediate(resolve));
                    }

                    if (contentCheckedCount >= MAX_CONTENT_CANDIDATES) break;
                }
            }

            return { success: true, results };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── 获取文件 MD5 ──
    ipcMain.handle('file:md5', async (_event, params: { filePath: string }) => {
        try {
            const resolvedPath = resolveSafePath(params.filePath);
            const crypto = await import('node:crypto');
            const content = fs.readFileSync(resolvedPath);
            const md5 = crypto.createHash('md5').update(content).digest('hex');
            return { success: true, md5 };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── 读取二进制文件（base64 编码返回，用于 PDF/图片等非文本预览） ──
    ipcMain.handle('file:readBinary', async (_event, params: {
        filePath: string;
        root?: string;
    }) => {
        try {
            const resolvedPath = resolveSafePath(params.filePath, params.root);

            if (!fs.existsSync(resolvedPath)) {
                return { success: false, error: `File not found: ${params.filePath}` };
            }

            const stat = fs.statSync(resolvedPath);
            if (stat.isDirectory()) {
                return { success: false, error: `Path is a directory: ${params.filePath}` };
            }

            // 50MB 上限，防止主进程 OOM
            const MAX_BINARY_SIZE = 50 * 1024 * 1024;
            if (stat.size > MAX_BINARY_SIZE) {
                return { success: false, error: `File too large (${(stat.size / 1024 / 1024).toFixed(1)}MB > 50MB)` };
            }

            const buffer = fs.readFileSync(resolvedPath);
            const base64 = buffer.toString('base64');

            return {
                success: true,
                base64,
                size: stat.size,
                mimeType: getMimeType(resolvedPath),
            };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── 删除文件/目录 ──
    ipcMain.handle('file:delete', async (_event, params: {
        filePath: string;
        root?: string;
    }) => {
        try {
            const resolvedPath = resolveSafePath(params.filePath, params.root);
            try {
                await fs.promises.access(resolvedPath);
            } catch {
                return { success: false, error: 'File not found' };
            }
            const stat = await fs.promises.stat(resolvedPath);
            if (stat.isDirectory()) {
                await fs.promises.rm(resolvedPath, { recursive: true, force: true });
            } else {
                await fs.promises.unlink(resolvedPath);
            }
            return { success: true };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── 重命名/移动文件 ──
    ipcMain.handle('file:rename', async (_event, params: {
        oldPath: string;
        newPath: string;
        root?: string;
    }) => {
        try {
            const resolvedOld = resolveSafePath(params.oldPath, params.root);
            const resolvedNew = resolveSafePath(params.newPath, params.root);
            try {
                await fs.promises.access(resolvedOld);
            } catch {
                return { success: false, error: 'Source file not found' };
            }
            // 确保目标目录存在
            const newDir = path.dirname(resolvedNew);
            await fs.promises.mkdir(newDir, { recursive: true });
            await fs.promises.rename(resolvedOld, resolvedNew);
            return { success: true, newPath: resolvedNew };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── 列出 JAR/ZIP 内部文件目录 ──
    ipcMain.handle('file:listJar', async (_event, params: {
        jarPath: string;
        innerPath?: string;
        root?: string;
    }) => {
        try {
            const resolvedJarPath = resolveSafePath(params.jarPath, params.root);

            if (!fs.existsSync(resolvedJarPath)) {
                return { success: false, error: `JAR file not found: ${params.jarPath}` };
            }

            const stat = fs.statSync(resolvedJarPath);
            // 50MB 上限保护主进程内存
            if (stat.size > 50 * 1024 * 1024) {
                return { success: false, error: `JAR file too large (${(stat.size / 1024 / 1024).toFixed(1)}MB > 50MB)` };
            }

            const jarBuffer = fs.readFileSync(resolvedJarPath);
            const allEntries = parseZipEntries(jarBuffer);

            const innerPath = params.innerPath || '';
            const prefix = innerPath ? (innerPath.endsWith('/') ? innerPath : innerPath + '/') : '';

            const seenDirs = new Set<string>();
            const resultEntries: any[] = [];

            for (const entry of allEntries) {
                if (!entry.name.startsWith(prefix)) continue;
                if (entry.name === prefix) continue;

                const relativePath = entry.name.substring(prefix.length);
                const slashIdx = relativePath.indexOf('/');

                let displayName: string;
                let isDir: boolean;

                if (slashIdx === -1) {
                    displayName = relativePath;
                    isDir = false;
                } else {
                    displayName = relativePath.substring(0, slashIdx);
                    isDir = true;
                }

                if (!displayName) continue;

                const key = `${isDir ? 'D' : 'F'}:${displayName}`;
                if (seenDirs.has(key)) continue;
                seenDirs.add(key);

                resultEntries.push({
                    name: displayName,
                    path: `${params.jarPath}::${prefix}${displayName}${isDir ? '/' : ''}`,
                    type: isDir ? 'directory' : 'file',
                    isDirectory: isDir,
                    isFile: !isDir,
                });
            }

            return { success: true, files: resultEntries, totalCount: resultEntries.length };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── 读取 JAR/ZIP 内部文件内容 ──
    ipcMain.handle('file:readJarEntry', async (_event, params: {
        jarPath: string;
        entryPath: string;
        root?: string;
    }) => {
        try {
            const resolvedJarPath = resolveSafePath(params.jarPath, params.root);

            if (!fs.existsSync(resolvedJarPath)) {
                return { success: false, error: `JAR file not found: ${params.jarPath}` };
            }

            const stat = fs.statSync(resolvedJarPath);
            if (stat.size > 50 * 1024 * 1024) {
                return { success: false, error: 'JAR file too large (>50MB)' };
            }

            const jarBuffer = fs.readFileSync(resolvedJarPath);
            const allEntries = parseZipEntries(jarBuffer);

            const targetName = params.entryPath.replace(/\\/g, '/');
            const entry = allEntries.find(e => e.name === targetName);

            if (!entry) {
                return { success: false, error: `Entry not found in JAR: ${targetName}` };
            }

            if (entry.isDirectory) {
                return { success: false, error: `Entry is a directory: ${targetName}` };
            }

            const contentBuffer = readZipEntryContent(jarBuffer, entry);

            // 检测是否为文本内容（简单启发式：前 512 字节不含 NULL 字节）
            const sample = contentBuffer.subarray(0, Math.min(512, contentBuffer.length));
            const isBinary = sample.includes(0);

            if (isBinary) {
                const base64 = contentBuffer.toString('base64');
                return {
                    success: true,
                    content: `[BINARY] 此文件为二进制内容（${entry.uncompressedSize} bytes），无法以文本形式显示。\n` +
                             `Base64 编码（前 2000 字符）:\n${base64.substring(0, 2000)}`,
                    encoding: 'base64',
                    lineCount: 1,
                    isBinary: true,
                    entryPath: targetName,
                };
            }

            const textContent = contentBuffer.toString('utf-8');
            return {
                success: true,
                content: textContent,
                encoding: 'utf-8',
                lineCount: textContent.split('\n').length,
                isBinary: false,
                entryPath: targetName,
            };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    console.log('[FileIPC] File IPC handlers registered');
}

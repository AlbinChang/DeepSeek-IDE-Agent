/**
 * File Operations IPC Handler
 * 
 * 替换 REST /api/files/* 路由，直接使用 FileIO + PathUtils 操作文件系统。
 * 在 Electron Main Process 中运行，享有完整文件系统访问权限。
 */
import { IpcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { PROJECT_ROOT } from '../index.js';

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
        try {
            const resolvedPath = resolveSafePath(params.root || '.', params.root);
            const maxResults = Math.min(params.maxResults || 50, 200);
            const searchPattern = params.pattern.toLowerCase();
            
            const results: Array<{ path: string; line: number; content: string }> = [];
            
            function searchInDir(dir: string) {
                if (results.length >= maxResults) return;
                
                try {
                    const entries = fs.readdirSync(dir, { withFileTypes: true });
                    const skipDirs = new Set(['.git', 'node_modules', '.ide-agent', 'dist', '__pycache__']);
                    
                    for (const entry of entries) {
                        if (results.length >= maxResults) return;
                        
                        const fullPath = path.join(dir, entry.name);
                        
                        if (entry.isDirectory()) {
                            if (!skipDirs.has(entry.name) && !entry.name.startsWith('.')) {
                                searchInDir(fullPath);
                            }
                        } else if (entry.isFile()) {
                            // 文件名匹配
                            if (entry.name.toLowerCase().includes(searchPattern)) {
                                results.push({ path: fullPath, line: 0, content: `[文件名匹配] ${entry.name}` });
                            }
                            
                            // 内容搜索（仅文本文件，限制大小）
                            try {
                                const stat = fs.statSync(fullPath);
                                if (stat.size > 500 * 1024) return; // 跳过大于 500KB 的文件
                                
                                const content = fs.readFileSync(fullPath, 'utf-8');
                                const lines = content.split('\n');
                                for (let i = 0; i < lines.length && results.length < maxResults; i++) {
                                    if (lines[i].toLowerCase().includes(searchPattern)) {
                                        results.push({
                                            path: fullPath,
                                            line: i + 1,
                                            content: lines[i].trim().substring(0, 200),
                                        });
                                    }
                                }
                            } catch {
                                // 二进制文件或读取失败，跳过
                            }
                        }
                    }
                } catch {
                    // 权限不足，跳过
                }
            }

            searchInDir(resolvedPath);

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
            if (!fs.existsSync(resolvedPath)) {
                return { success: false, error: 'File not found' };
            }
            const stat = fs.statSync(resolvedPath);
            if (stat.isDirectory()) {
                fs.rmSync(resolvedPath, { recursive: true, force: true });
            } else {
                fs.unlinkSync(resolvedPath);
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
            if (!fs.existsSync(resolvedOld)) {
                return { success: false, error: 'Source file not found' };
            }
            // 确保目标目录存在
            const newDir = path.dirname(resolvedNew);
            if (!fs.existsSync(newDir)) {
                fs.mkdirSync(newDir, { recursive: true });
            }
            fs.renameSync(resolvedOld, resolvedNew);
            return { success: true, newPath: resolvedNew };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    console.log('[FileIPC] File IPC handlers registered');
}

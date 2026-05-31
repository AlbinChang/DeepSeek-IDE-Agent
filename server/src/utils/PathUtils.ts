import * as path from 'path';
import * as url from 'url';
import * as fs from 'fs';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 对齐 31.0 节：多环境路径自适应 (src vs dist)
function findServerRoot(startDir: string): string {
    let current = startDir;
    // 向上递归寻找 package.json，它是 server 目录的识别标志
    while (current !== path.parse(current).root) {
        if (fs.existsSync(path.join(current, 'package.json'))) {
            return current;
        }
        current = path.dirname(current);
    }
    // 回退逻辑：如果没找到，沿用原有的双层偏移 (适用于标准的 src/utils 结构)
    return path.resolve(__dirname, '../../');
}

export const SERVER_ROOT = findServerRoot(__dirname);
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, '..');

/**
 * 资源目录自适应定位 (Section 31.2)
 * 解决开发环境 (src/config) 与生产环境 (dist/config 或 server/config) 的路径差异
 */
export const CONFIG_ROOT = (() => {
    // 方案 1: 通过相对路径寻找，最靠谱（不受 SERVER_ROOT 层级影响）
    const relativeConfig = path.resolve(__dirname, '..', 'config');
    if (fs.existsSync(relativeConfig)) return relativeConfig;

    // 方案 2: 标准开发路径兜底
    const srcConfig = path.join(SERVER_ROOT, 'src/config');
    if (fs.existsSync(srcConfig)) return srcConfig;
    
    // 兜底方案：生产环境可能直接就在 server/config
    const rootConfig = path.join(SERVER_ROOT, 'config');
    if (fs.existsSync(rootConfig)) return rootConfig;

    return srcConfig; // 默认回退
})();

/**
 * URI & Path Standardizer
 * 对齐技术规范 第 31 节：多环境路径一致性保障
 * 解决 Windows 环境下特殊符号（如空格、#、-、中文）在传递过程中的编码歧义
 */
export class PathUtils {
    /**
     * 将文件路径标准化为规范的 file:// URI
     */
    static pathToUri(filePath: string): string {
        if (!path.isAbsolute(filePath)) {
            throw new Error(`PathUtils.pathToUri requires an absolute path: ${filePath}`);
        }
        // 在 Windows 上，url.pathToFileURL 会正确处理驱动器号和特殊字符编码
        const fileUri = url.pathToFileURL(filePath).toString();
        
        // 确保格式为 file:///D:/... 而不是 file:/D:/... 或 file:////D:/...
        let formatted = fileUri.replace(/^file:\/+(?=[A-Za-z]:)/, 'file:///');
        
        // 处理 Windows 特殊编码
        if (process.platform === 'win32') {
            formatted = formatted.replace(/%3A/g, ':');
        }
        return formatted;
    }

    /**
     * 将 URI 标准化为本地文件 system 路径
     */
    static uriToPath(uri: string): string {
        try {
            const decodedUri = decodeURIComponent(uri);
            const fileUrl = new URL(decodedUri);
            return path.normalize(url.fileURLToPath(fileUrl));
        } catch (e) {
            return path.normalize(uri);
        }
    }

    /**
     * 系统级路径清洗
     */
    static normalizePath(unsafePath: string): string {
        if (!unsafePath || typeof unsafePath !== 'string') {
            throw new Error('Invalid path provided. Path must be a non-empty string.');
        }
        let cleaned = unsafePath.toString().trim();
        try {
            if (cleaned.includes('%')) {
                cleaned = decodeURIComponent(cleaned);
                if (cleaned.includes('%')) {
                    cleaned = decodeURIComponent(cleaned);
                }
            }
        } catch(e) {}

        if (cleaned.startsWith('file://')) {
            try {
                const urlObj = new URL(cleaned);
                cleaned = url.fileURLToPath(urlObj);
            } catch (e) {
                cleaned = cleaned.replace(/^file:\/+/i, '');
                if (process.platform === 'win32') {
                    if (!/^[a-z]:/i.test(cleaned) && /^\/[a-z]:/i.test(cleaned)) {
                        cleaned = cleaned.substring(1);
                    }
                }
            }
        }

        cleaned = cleaned.replace(/\\+/g, '/').replace(/\/+/g, '/');

        if (process.platform === 'win32') {
            if (cleaned.startsWith('/') && /^\/[a-z]:/i.test(cleaned)) {
                cleaned = cleaned.substring(1);
            }
            if (/^[a-z]:/i.test(cleaned)) {
                cleaned = cleaned[0].toUpperCase() + cleaned.substring(1);
            }
        }

        if (cleaned.length > 3 && (cleaned.endsWith('/') || cleaned.endsWith('\\'))) {
            cleaned = cleaned.substring(0, cleaned.length - 1);
        }

        return cleaned;
    }

    /**
     * 安全地解析并强制转换为绝对路径
     */
    static resolvePath(unsafePath: string, workspaceRoot: string, accessMode: 'read' | 'write' = 'write'): string {
        const normalizedRoot = this.normalizePath(workspaceRoot);
        const normalizedInput = this.normalizePath(unsafePath);

        let absolutePath: string;
        
        // 判定输入是否为相对于根目录或者是绝对路径
        if (path.isAbsolute(normalizedInput)) {
            absolutePath = normalizedInput;
        } else {
            // 禁止在此时使用可能引起歧义的相对路径层级 (如 ../)
            absolutePath = path.resolve(normalizedRoot, normalizedInput);
        }

        const normalizedAbsolute = this.normalizePath(absolutePath);

        if (accessMode === 'read') {
            return normalizedAbsolute;
        }

        // 必须以工作区根目录开头，且必须是真正的子目录或文件 (Section 31.0 Strict Abs Path)
        // 增加结尾斜杠判断，防止 mall-admin 匹配到 mall
        const rootPrefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
        const isChild = normalizedAbsolute === normalizedRoot || normalizedAbsolute.startsWith(rootPrefix);
        
        if (!isChild) {
            throw new Error(`[SECURITY_VIOLATION] Path escapes workspace boundary. \nTarget: ${normalizedAbsolute}\nWorkspace: ${normalizedRoot}`);
        }

        return normalizedAbsolute;
    }

    /**
     * 读操作路径解析：允许读取工作区外绝对路径。
     */
    static resolveReadPath(unsafePath: string, workspaceRoot: string): string {
        return this.resolvePath(unsafePath, workspaceRoot, 'read');
    }

    /**
     * 写操作路径解析：严格限制在工作区内。
     */
    static resolveWritePath(unsafePath: string, workspaceRoot: string): string {
        return this.resolvePath(unsafePath, workspaceRoot, 'write');
    }

    /**
     * 获取相对工作区的标准化路径
     */
    static getRelativePath(absolutePath: string, workspaceRoot: string): string {
        const normAbs = this.normalizePath(absolutePath);
        const normRoot = this.normalizePath(workspaceRoot);
        const relative = path.relative(normRoot, normAbs);
        return relative.replace(/\\/g, '/');
    }
}

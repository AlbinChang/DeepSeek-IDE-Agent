import * as fs from 'fs/promises';
import * as path from 'path';
import crypto from 'crypto';
import simpleGit from 'simple-git';
import { PathUtils } from '@/utils/PathUtils.js';
import { FileIO } from '@/utils/FileIO.js';
import { config as globalConfig } from '@/config/index.js';
import { WORKSPACE_SKILL_CONTAINER_DIRECTORIES, isWorkspaceSkillPath } from '@/utils/WorkspaceSkillPaths.js';

export class FileTools {
    private static readonly LIST_FILES_MAX_DEPTH = 5;
    private static readonly LIST_FILES_MAX_ITEMS = 1200;
    private static readonly AGENT_SYSTEM_DIR_NAMES = new Set([
        '.ide-agent',
        '.llm',
        '.tools',
        '.memory'
    ]);
    private static readonly DIRECTORY_TREE_VISIBLE_DOT_DIR_NAMES = new Set([
        ...WORKSPACE_SKILL_CONTAINER_DIRECTORIES,
        '.rules'
    ]);

    private static isAgentSystemDirPath(relativePath: string): boolean {
        const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
        if (!normalized || normalized === '.') return false;
        const segments = normalized.split('/');
        return segments.some((seg) => FileTools.AGENT_SYSTEM_DIR_NAMES.has(seg));
    }

    private static isDirectoryTreeImportantPath(relativePath: string): boolean {
        const normalized = relativePath.replace(/\\/g, '/').replace(/^\.\//, '');
        return normalized === '.rules' || normalized.startsWith('.rules/') || isWorkspaceSkillPath(normalized);
    }

    /**
     * 获取文件 MD5 (Agent 校验使用)
     * 所有输入统一进入 resolvePath 进行绝对路径强制转化
     */
    static async getFileMd5(workspaceRoot: string, unsafePath: string): Promise<string> {
        try {
            const fullPath = PathUtils.resolveReadPath(unsafePath, workspaceRoot);
            const content = await fs.readFile(fullPath);
            return crypto.createHash('md5').update(content).digest('hex');
        } catch (e) {
            return '';
        }
    }

    /**
     * Agent 受控目录扫描（递归深度必填，防止信息爆炸）
     */
    static async listFiles(workspaceRoot: string, unsafePath: string = '.', depth?: number) {
        if (!Number.isInteger(depth)) {
            return {
                status: 'error',
                error: 'DEPTH_REQUIRED',
                message: '参数 depth 为必填整数，范围 1-5。'
            };
        }

        const maxDepth = Number(depth);
        if (maxDepth < 1 || maxDepth > FileTools.LIST_FILES_MAX_DEPTH) {
            return {
                status: 'error',
                error: 'DEPTH_OUT_OF_RANGE',
                message: `参数 depth 超出范围：${maxDepth}。允许范围为 1-${FileTools.LIST_FILES_MAX_DEPTH}。`
            };
        }

        let fullPath: string;
        try {
            fullPath = PathUtils.resolveReadPath(unsafePath, workspaceRoot);
        } catch (e: any) {
            return { status: 'error', error: 'PATH_SECURITY_VIOLATION', dirPath: unsafePath,
                message: `路径 "${unsafePath}" 非法或无法解析。` };
        }

        let dirStat: import('fs').Stats;
        try {
            dirStat = await fs.stat(fullPath);
        } catch (e: any) {
            if (e.code === 'ENOENT') {
                return { status: 'error', error: 'DIR_NOT_FOUND', dirPath: unsafePath,
                    message: `目录不存在："${unsafePath}"，请先通过 list_files 确认父路径后重试。` };
            }
            if (e.code === 'ENOTDIR') {
                return { status: 'error', error: 'NOT_A_DIRECTORY', dirPath: unsafePath,
                    message: `"${unsafePath}" 是文件，不是目录。请使用 read_file 读取其内容。` };
            }
            return { status: 'error', error: 'LIST_ERROR', dirPath: unsafePath, message: e.message };
        }

        if (!dirStat.isDirectory()) {
            return {
                status: 'error',
                error: 'NOT_A_DIRECTORY',
                dirPath: unsafePath,
                message: `"${unsafePath}" 是文件，不是目录。请使用 read_file 读取其内容。`
            };
        }

        const baseRelativePath = PathUtils.getRelativePath(fullPath, workspaceRoot);
        if (FileTools.isAgentSystemDirPath(baseRelativePath)) {
            return {
                status: 'success',
                dirPath: unsafePath,
                maxDepth,
                totalCount: 0,
                isEmpty: true,
                truncated: false,
                maxItems: FileTools.LIST_FILES_MAX_ITEMS,
                ignoredSystemDirs: [baseRelativePath],
                items: []
            };
        }

        const items: Array<{
            name: string;
            path: string;
            type: 'directory' | 'file' | 'symlink';
            isDirectory: boolean;
            isFile: boolean;
            isSymbolicLink: boolean;
            depth: number;
        }> = [];
        const ignoredSystemDirs = new Set<string>();
        let truncated = false;

        const walk = async (currentPath: string, currentDepth: number): Promise<void> => {
            if (truncated) return;

            let entries: import('fs').Dirent[];
            try {
                entries = await fs.readdir(currentPath, { withFileTypes: true }) as import('fs').Dirent[];
            } catch {
                return;
            }

            entries.sort((a, b) => {
                if (a.isDirectory() === b.isDirectory()) return a.name.localeCompare(b.name);
                return a.isDirectory() ? -1 : 1;
            });

            for (const entry of entries) {
                if (truncated) break;

                const entryPath = path.join(currentPath, entry.name);
                const relativePath = PathUtils.getRelativePath(entryPath, workspaceRoot);

                if (entry.isDirectory() && FileTools.isAgentSystemDirPath(relativePath)) {
                    ignoredSystemDirs.add(relativePath);
                    continue;
                }

                const depthFromBase = currentDepth + 1;
                const isDirectory = entry.isDirectory();
                const isSymbolicLink = entry.isSymbolicLink();
                const isFile = entry.isFile();
                const type: 'directory' | 'file' | 'symlink' = isDirectory
                    ? 'directory'
                    : (isSymbolicLink ? 'symlink' : 'file');

                items.push({
                    name: entry.name,
                    path: relativePath,
                    type,
                    isDirectory,
                    isFile,
                    isSymbolicLink,
                    depth: depthFromBase
                });

                if (items.length >= FileTools.LIST_FILES_MAX_ITEMS) {
                    truncated = true;
                    break;
                }

                // depth=1 仅遍历当前目录下一层；depth=N 则最多展开 N 层。
                if (isDirectory && depthFromBase < maxDepth) {
                    await walk(entryPath, depthFromBase);
                }
            }
        };

        await walk(fullPath, 0);

        return {
            status: 'success',
            dirPath: unsafePath,
            maxDepth,
            totalCount: items.length,
            isEmpty: items.length === 0,
            truncated,
            maxItems: FileTools.LIST_FILES_MAX_ITEMS,
            ignoredSystemDirs: Array.from(ignoredSystemDirs).sort(),
            items
        };
    }

    /**
     * 构建目录树结构 (用于 System Prompt 注入)
     * 限制深度和文件数量，防止 Prompt 过长
     */
    static async getDirectoryTree(workspaceRoot: string, maxDepth: number = 3): Promise<string> {
        const buildTree = async (currentPath: string, depth: number): Promise<string[]> => {
            // 当 maxDepth=0（仅首层）时，必须禁用任何深度穿透，避免额外 IO 与 Prompt 抖动。
            const allowImportantDirDepthBypass = maxDepth > 0;
            // 对 workspace skills 和 .rules 目录放宽最大深度限制，确保重要的规则和提示文件都能暴露。
            const currentRelativePath = PathUtils.getRelativePath(currentPath, workspaceRoot);
            const isImportantDir = allowImportantDirDepthBypass && FileTools.isDirectoryTreeImportantPath(currentRelativePath);
            if (depth > maxDepth && !isImportantDir) return [];
            
            try {
                
                const entries = await fs.readdir(currentPath, { withFileTypes: true });
                const lines: string[] = [];

                entries.sort((left, right) => {
                    if (left.isDirectory() === right.isDirectory()) return left.name.localeCompare(right.name);
                    return left.isDirectory() ? -1 : 1;
                });
                
                // 过滤掉一些依赖库目录，减少不必要的 IO 和数据处理
                const ignoreList = ['node_modules', 'dist', '__pycache__'];
                
                for (const entry of entries) {
                    if (ignoreList.includes(entry.name)) continue;

                    // . 开头的目录也跳过，除非是 workspace skills 或 .rules 相关目录
                    if (entry.name.startsWith('.') && !FileTools.DIRECTORY_TREE_VISIBLE_DOT_DIR_NAMES.has(entry.name)) continue;
                    
                    const indent = '  '.repeat(depth);
                    if (entry.isDirectory()) {
                        lines.push(`${indent}📁 ${entry.name}/`);
                        const subTree = await buildTree(path.join(currentPath, entry.name), depth + 1);
                        lines.push(...subTree);
                    } else {
                        // 针对 workspace skills 和 .rules 目录，特别展示其内部所有的文件（如 .md, schema, scripts 等）
                        if (FileTools.isDirectoryTreeImportantPath(currentRelativePath)) {
                            lines.push(`${indent}📄 ${entry.name}`);
                        } else {
                            // 普通目录依然可以忽略文件，以减少超大项目下的 IO 和 context 过载
                        }
                    }
                }
                return lines;
            } catch (e) {
                return [];
            }
        };

        const treeLines = await buildTree(workspaceRoot, 0);
        return treeLines.length > 0 ? treeLines.join('\n') : " (Empty or access denied)";
    }

    /**
     * Agent 受控文件读取 (按行读取，默认单次上限 3000 行)
     * 相关限制统一由 config.readFile 控制，避免工具描述与实际行为漂移。
     */
    static async readFile(workspaceRoot: string, unsafePath: string, startLine: number = 1, lineCount?: number) {
        let fullPath: string;
        try {
            fullPath = PathUtils.resolveReadPath(unsafePath, workspaceRoot);
        } catch (e: any) {
            return { status: 'error', error: 'PATH_SECURITY_VIOLATION',
                message: `路径 "${unsafePath}" 非法或无法解析。` };
        }

        try {
            const readFileConfig = globalConfig.readFile;

            // 整文件体积守卫：仅在用户未指定分段参数时生效
            // 当用户显式传入 startLine 或 lineCount 时，说明已在进行分段读取，
            // 跳过整体文件体积检查（后续仍有行数上限 + 内容大小上限作为安全兜底）
            const isSegmentedRead = startLine > 1 || lineCount !== undefined;
            const stats = await fs.stat(fullPath);
            const MAX_SIZE = readFileConfig.maxFileSizeBytes;
            if (!isSegmentedRead && stats.size > MAX_SIZE) {
                // 尝试获取总行数，方便 LLM 规划分段读取的 startLine/lineCount
                let fileTotalLines: number | null = null;
                try {
                    const rawBuf = await fs.readFile(fullPath);
                    const { content: rawText } = FileIO.decodeBuffer(rawBuf);
                    fileTotalLines = rawText.split(/\r?\n|\r|\u2028|\u2029/).length;
                } catch {}
                return {
                    status: 'error',
                    error: 'FILE_TOO_LARGE',
                    totalLines: fileTotalLines,
                    message: `文件大小为 ${(stats.size / 1024).toFixed(1)}KB，超过 ${(MAX_SIZE / 1024).toFixed(0)}KB 上限。请使用 read_file 配合 startLine 和 lineCount 参数分段读取（总行数：${fileTotalLines ?? '未知'}）。`
                };
            }

            const rawBuffer = await fs.readFile(fullPath);
            FileIO.checkBinaryHeader(rawBuffer);

            const { content: rawContent, encoding: fileEncoding } = FileIO.decodeBuffer(rawBuffer);

            // 兼容处理不同换行符，包含 Unicode 行分隔符 \u2028/\u2029
            const lines = rawContent.split(/\r?\n|\r|\u2028|\u2029/);
            const totalLines = lines.length;

            const startIdx = Math.max(0, startLine - 1);

            // startLine 超过文件末尾：明确报错，避免 LLM 收到空 content 产生歧义
            if (startIdx >= totalLines && totalLines > 0) {
                return {
                    status: 'error',
                    error: 'START_LINE_OUT_OF_RANGE',
                    totalLines,
                    message: `startLine(${startLine}) 超过文件总行数(${totalLines})，请检查参数后重试。`
                };
            }

            const maxAllowed = readFileConfig.maxLines;
            const requestedCount = lineCount !== undefined ? lineCount : (totalLines - startIdx);
            const actualCount = Math.min(requestedCount, maxAllowed);

            const MAX_CHARS = readFileConfig.maxContentBytes;

            const selectedLines = lines.slice(startIdx, startIdx + actualCount);
            // 每行前缀行号（右对齐到总行数宽度），格式：" 27: code..."
            // 方便 LLM 直接用行号定位，无需自行计数
            const lineNumWidth = String(totalLines).length;
            let content = selectedLines
                .map((l, i) => `${String(startIdx + i + 1).padStart(lineNumWidth)}: ${l}`)
                .join('\n');

            let truncated = false;
            if (content.length > MAX_CHARS) {
                const LONG_LINE_THRESHOLD = readFileConfig.longLineThreshold;
                const hasLongLine = selectedLines.some(l => l.length > LONG_LINE_THRESHOLD);
                // 截断到字符边界，确保不截断行号前缀中间（找最后一个完整行边界）
                const cutoff = FileIO.safeSubstring(content, MAX_CHARS);
                const lastNewline = cutoff.lastIndexOf('\n');
                const truncMsg = hasLongLine
                    ? `\n--- [截断：存在单行超过 ${LONG_LINE_THRESHOLD} 字符的超长行，后续内容请改用 read_file_by_byte 按字节读取] ---`
                    : `\n--- [截断：内容总量超过 ${Math.round(MAX_CHARS / 1024)}KB 上限，请使用 read_file 配合 startLine 参数继续读取后续内容] ---`;
                content = (lastNewline > 0 ? cutoff.substring(0, lastNewline) : cutoff) + truncMsg;
                truncated = true;
            }

            return {
                content,
                encoding: fileEncoding,
                startLine: startIdx + 1,
                endLine: startIdx + selectedLines.length,
                totalLines,
                truncated,
                hasMore: (startIdx + selectedLines.length) < totalLines
            };
        } catch (err: any) {
            if (err.code === 'ENOENT') {
                return { status: 'error', error: 'FILE_NOT_FOUND',
                    message: `文件不存在："${unsafePath}"，请先通过 list_files 确认路径后重试。` };
            }
            if (err.code === 'EACCES' || err.code === 'EPERM') {
                return { status: 'error', error: 'PERMISSION_DENIED',
                    message: `无法读取 "${unsafePath}"：权限不足。` };
            }
            if (err.message === 'Binary file detection.') {
                return { status: 'error', error: 'BINARY_FILE_DETECTED',
                    message: `文件 "${unsafePath}" 是二进制文件，请改用 read_file_by_byte 按字节读取。` };
            }
            return { status: 'error', error: 'READ_ERROR', message: err.message };
        }
    }

    /**
     * Agent 字节维度文件读取 - 用于应对单行超长或二进制结构探测。
     * 仅在 readFile 因为单行过长被截断时，或需要精确字节对齐时使用。
     */
    static async readFileByByte(workspaceRoot: string, unsafePath: string, offset: number = 0, length: number = 2500) {
        const fullPath = PathUtils.resolveReadPath(unsafePath, workspaceRoot);
        const handle = await fs.open(fullPath, 'r');
        try {
            const { size } = await handle.stat();
            const rawBuf = Buffer.alloc(Math.min(length, 2560)); // 最大允许一次读 2.5KB
            const { bytesRead } = await handle.read(rawBuf, 0, rawBuf.length, offset);
            const sliced = rawBuf.slice(0, bytesRead);

            // 接入动态编解码，避免 GBK 等本地化编码超长行读取乱码
            const { content } = FileIO.decodeBuffer(sliced);
            // 检测字节边界截断导致的替换符，提示 Agent 调整 offset
            const hasBoundaryIssue = content.includes('\uFFFD');

            return {
                content,
                offset,
                bytesRead,
                totalSize: size,
                hasMore: (offset + bytesRead) < size,
                boundaryWarning: hasBoundaryIssue
                    ? '首/末字节可能处于多字节字符边界，请调整 offset 以对齐字符边界后重试。'
                    : undefined
            };
        } finally {
            await handle.close();
        }
    }

    /**
    * Agent 全量文件写入 - 用于 multi_file_write
     */
    static async writeFile(workspaceRoot: string, unsafePath: string, content: string, encodingOverride?: string) {
        let fullPath: string;
        try {
            fullPath = PathUtils.resolveWritePath(unsafePath, workspaceRoot);
        } catch (e: any) {
            return { status: 'error', error: 'PATH_SECURITY_VIOLATION',
                message: `路径 "${unsafePath}" 超出工作区边界，禁止写入。` };
        }

        // 写入体积守卫：防止超大内容经 GBK roundtrip 校验产生 20 倍内存放大
        const MAX_WRITE_CHARS = 5 * 1024 * 1024; // 5M 字符，与读取侧 5MB 字节上限对齐
        if (content.length > MAX_WRITE_CHARS) {
            return { status: 'error', error: 'CONTENT_TOO_LARGE',
                message: `写入内容长度 ${(content.length / 1024 / 1024).toFixed(1)}M 字符超过 5M 上限，请拆分后分段写入。` };
        }

        // null 字节守卫：写入含 \u0000 的内容后读取会被 checkBinaryHeader 永久拦截
        if (content.includes('\u0000')) {
            return { status: 'error', error: 'NULL_BYTE_IN_CONTENT',
                message: '写入内容含 null 字节（\\u0000），写入后文件将无法通过二进制检测，操作已拒绝。' };
        }

        let finalContent = content;
        let targetEncoding = 'utf-8';
        let isCRLF = false;

        // 全量读取现有文件做编码检测，与 patchFileByLines 精度完全对齐
        // 文件 ≤5MB 时用 decodeBuffer 全量检测；>5MB 回退到 64KB 采样（精度有限但可接受）
        // 注意：读取现有文件真到写入之间存在竞态窗口，并发写入同一文件时可能用旧编码写回
        // 这是文件系统层面的固有局限，单用户单文件操作场景不受影响
        try {
            const existStats = await fs.stat(fullPath);
            const MAX_DETECT_SIZE = 5 * 1024 * 1024;
            if (existStats.size > 0 && existStats.size <= MAX_DETECT_SIZE) {
                const rawBuffer = await fs.readFile(fullPath);
                const { encoding: detectedEncoding, content: rawContent } = FileIO.decodeBuffer(rawBuffer);
                targetEncoding = detectedEncoding;
                // 多数投票法：与 patchFileByLines 保持完全一致的 EOL 检测策略
                const crlfCount = (rawContent.match(/\r\n/g) || []).length;
                const lfOnlyCount = (rawContent.match(/(?<!\r)\n/g) || []).length;
                isCRLF = crlfCount > 0 && crlfCount >= lfOnlyCount;
            } else if (existStats.size > MAX_DETECT_SIZE) {
                // 超大现有文件无法全量读取，回退到 64KB 头部采样
                const profile = await FileIO.detectFileProfile(fullPath);
                targetEncoding = profile.encoding;
                isCRLF = profile.isCRLF;
            }
            // size === 0：空文件，保持默认 utf-8/LF
        } catch {
            // 文件不存在（新建）：使用调用方指定的编码，否则默认 utf-8/LF
            if (encodingOverride && FileIO.encodingExists(encodingOverride)) {
                targetEncoding = encodingOverride;
            }
        }

        if (isCRLF) {
            // 三步法：先折叠 \r\n→\n，再将裸 \r→\n，最后统一注入 \r\n
            // 避免裸 \r 被直接剥掉导致两段代码静默合并为一行
            finalContent = finalContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/\n/g, '\r\n');
        } else {
            // LF 文件：清洗 Agent 输入中可能混入的 \r（\r\n → \n，裸 \r → \n）
            // 先替换 \r\n 避免被拆成 \n\n，再替换残余裸 \r
            finalContent = finalContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        }

        // 使用 FileIO 进行原子级持久化写入，通过动态编解码打包
        try {
            const finalBuffer = FileIO.encodeString(finalContent, targetEncoding);
            await FileIO.writeFile(unsafePath, workspaceRoot, finalBuffer);
        } catch (err: any) {
            if (err.message?.startsWith('[ENCODING_LOSS]')) {
                return { status: 'error', error: 'ENCODING_LOSS', message: err.message };
            }
            if (err.code === 'ENOSPC') {
                return { status: 'error', error: 'DISK_FULL',
                    message: `磁盘空间不足，无法写入 "${unsafePath}"，请清理磁盘后重试。` };
            }
            if (err.code === 'EACCES' || err.code === 'EPERM') {
                return { status: 'error', error: 'PERMISSION_DENIED',
                    message: `无法写入 "${unsafePath}"：权限不足。` };
            }
            return { status: 'error', error: 'WRITE_ERROR', message: err.message };
        }
        return { status: 'success', path: unsafePath, mode: 'overwrite', encoding: targetEncoding };
    }

    /**
    * Agent 行级精修写入 - 用于 single_file_write
     * 支持在特定行插入、替换或删除代码的极高稳健性操作
     */
    static async patchFileByLines(workspaceRoot: string, unsafePath: string, content: string, startLine: number, lineCount: number = 0, encodingOverride?: string) {
        const fullPath = PathUtils.resolveWritePath(unsafePath, workspaceRoot);
        
        try {
            if (!Number.isInteger(startLine) || startLine < 1) {
                return {
                    status: 'error',
                    mode: 'line_patch',
                    path: fullPath,
                    error: 'START_LINE_INVALID',
                    message: `startLine(${startLine}) 必须是 >= 1 的整数。`
                };
            }
            if (!Number.isInteger(lineCount) || lineCount < 0) {
                return {
                    status: 'error',
                    mode: 'line_patch',
                    path: fullPath,
                    error: 'LINECOUNT_INVALID',
                    message: `lineCount(${lineCount}) 必须是 >= 0 的整数；0 表示纯插入。`
                };
            }

            let wasNewFile = false;
            try { 
                await fs.access(fullPath); 
            } catch { 
                wasNewFile = true;
                // 使用原子写入创建空文件（FileIO.writeFile 内部已包含 mkdir）
                await FileIO.writeFile(unsafePath, workspaceRoot, '');
            }

            const stats = await fs.stat(fullPath);
            const MAX_UI_READ_SIZE = 5 * 1024 * 1024; // 5MB
            if (stats.size > MAX_UI_READ_SIZE) {
                return { 
                    status: 'error', 
                    mode: 'line_patch', 
                    path: fullPath, 
                    error: 'FILE_TOO_LARGE',
                    message: `文件大小超限 (${(stats.size / 1024 / 1024).toFixed(1)}MB > 5MB)，拒绝行级精修。` 
                };
            }

            const rawBuffer = await fs.readFile(fullPath);
            
            try {
                FileIO.checkBinaryHeader(rawBuffer);
            } catch (e) {
                return { 
                    status: 'error', 
                    mode: 'line_patch', 
                    path: fullPath, 
                    error: 'BINARY_FILE_DETECTED',
                    message: '拒绝执行：检测到目标文件可能是二进制文件，禁止精修操作。' 
                };
            }

            // null 字节守卫：写入含 \u0000 的内容后读取会被 checkBinaryHeader 永久拦截
            if (content.includes('\u0000')) {
                return {
                    status: 'error',
                    mode: 'line_patch',
                    path: fullPath,
                    error: 'NULL_BYTE_IN_CONTENT',
                    message: '写入内容含 null 字节（\\u0000），写入后文件将无法通过二进制检测，操作已拒绝。'
                };
            }

            // 写入体积守卫：防止超大 content 经 GBK roundtrip 校验产生内存放大（与 writeFile 对齐）
            const MAX_PATCH_CHARS = 5 * 1024 * 1024; // 5M 字符
            if (content.length > MAX_PATCH_CHARS) {
                return {
                    status: 'error',
                    mode: 'line_patch',
                    path: fullPath,
                    error: 'CONTENT_TOO_LARGE',
                    message: `写入内容长度 ${(content.length / 1024 / 1024).toFixed(1)}M 字符超过 5M 上限，请拆分后分段写入。`
                };
            }

            // 智能解码处理并捕获原文件的实际编码
            const { content: rawContent, encoding: detectedEncoding } = FileIO.decodeBuffer(rawBuffer);
            // 新建文件：空 Buffer 会被检测为 utf-8，若调用方指定了 encodingOverride 则优先使用
            const encoding = (wasNewFile && encodingOverride && FileIO.encodingExists(encodingOverride))
                ? encodingOverride
                : detectedEncoding;
            
            // 多数投票法：统计行尾 \r\n 与纯 \n 的数量，以多数决定 EOL 风格
            // 避免代码中字符串字面量含 \r\n 导致误判整个文件为 CRLF 风格
            const crlfCount = (rawContent.match(/\r\n/g) || []).length;
            const lfOnlyCount = (rawContent.match(/(?<!\r)\n/g) || []).length;
            const isCRLF = crlfCount > 0 && crlfCount >= lfOnlyCount;
            const eol = isCRLF ? '\r\n' : '\n';
            
            // 扩展行拆分正则，支持 Unicode 行分隔符 \u2028/\u2029
            let lines = rawContent.length > 0 ? rawContent.split(/\r?\n|\r|\u2028|\u2029/) : [];
            const totalLinesBeforeOp = lines.length;

            // startLine 合法性校验：必须 >= 1；允许等于 totalLines+1（在末尾追加）
            if (startLine < 1) {
                return {
                    status: 'error',
                    mode: 'line_patch',
                    path: fullPath,
                    error: 'START_LINE_INVALID',
                    message: `startLine(${startLine}) 必须 >= 1。当前文件共 ${totalLinesBeforeOp} 行。`
                };
            }
            if (startLine > totalLinesBeforeOp + 1) {
                return {
                    status: 'error',
                    mode: 'line_patch',
                    path: fullPath,
                    error: 'START_LINE_OUT_OF_RANGE',
                    totalLines: totalLinesBeforeOp,
                    message: `startLine(${startLine}) 超过文件末尾+1(${totalLinesBeforeOp + 1})。` +
                        `当前文件共 ${totalLinesBeforeOp} 行，startLine 最大为 ${totalLinesBeforeOp + 1}（末尾追加）。`
                };
            }

            const startIdx = startLine - 1;
            const delCount = lineCount;
            
            // 贪婪剥离尾部所有换行符（\r\n、\n、裸\r、\u2028、\u2029），与行拆分正则覆盖范围保持一致
            const safeContent = content.replace(/(\r?\n|\r|\u2028|\u2029)+$/, '');
            const newLines = safeContent.length > 0 ? safeContent.split(/\r?\n|\r|\u2028|\u2029/) : [];

            // 越界守卫：防止 lineCount 远大于实际剩余行数时静默截断文件后半段
            // 典型误用：LLM 把文件总行数当作 lineCount 传入，导致从 startLine 起的所有内容被删除
            const remainingLines = Math.max(0, lines.length - startIdx);
            if (delCount > remainingLines + 50) {
                return {
                    status: 'error',
                    mode: 'line_patch',
                    path: fullPath,
                    error: 'LINECOUNT_OUT_OF_RANGE',
                    message: `lineCount(${delCount}) 远大于从第 ${startLine} 行起的剩余行数(${remainingLines})。` +
                        `请检查：lineCount 是"要删除的行数"而非文件总行数。` +
                        `当前文件共 ${lines.length} 行，从第 ${startLine} 行起最多可删除 ${remainingLines} 行。`
                };
            }

            // 记录实际被删除的行（在 splice 前），供 LLM 立即验证删除范围是否正确
            const deletedLines = lines.slice(startIdx, startIdx + delCount).join('\n');

            lines.splice(startIdx, delCount, ...newLines);
            const finalContent = lines.join(eol);

            // 复用底层原子化写出，按原解析的编码重新封入二进制形式
            const finalBuffer = FileIO.encodeString(finalContent, encoding);
            await FileIO.writeFile(unsafePath, workspaceRoot, finalBuffer);

            // 操作后上下文快照：前后各 3 行，供 LLM 立即验证修改效果
            // 行号右对齐宽度与 read_file 保持一致，方便 LLM 直接对照
            const lineNumWidth = String(lines.length).length;
            const snapshotStart = Math.max(0, startIdx - 3);
            const snapshotEnd = Math.min(lines.length, startIdx + newLines.length + 3);
            const contextSnapshot = lines
                .slice(snapshotStart, snapshotEnd)
                .map((l, i) => `${String(snapshotStart + i + 1).padStart(lineNumWidth)}: ${l}`)
                .join('\n');

            return { 
                status: 'success', 
                mode: 'line_patch',
                path: fullPath,
                encoding,
                startLine,
                linesRemoved: delCount,
                linesAdded: newLines.length,
                newTotalLines: lines.length,  // 操作后文件总行数，规划下次操作前必须参考此值
                deletedLines,                 // 实际被删除的内容，立即核实是否删对了范围
                contextSnapshot               // 操作位置前后各 3 行，立即核对是否符合预期
            };
        } catch (err: any) {
            console.error(`[FileTools] Patch Error: ${err.message}`);
            if (err.message?.startsWith('[ENCODING_LOSS]')) {
                return { status: 'error', error: 'ENCODING_LOSS', message: err.message };
            }
            return { status: 'error', message: err.message };
        }
    }

    /**
     * Agent 文件删除
     */
    static async deletePath(workspaceRoot: string, unsafePath: string, recursive: boolean = false) {
        const fullPath = PathUtils.resolveWritePath(unsafePath, workspaceRoot);
        await fs.rm(fullPath, { recursive, force: true });
        return { status: 'success', path: fullPath }; // 返回绝对路径
    }

    static async searchFiles(workspaceRoot: string, query: string) { return []; }
}

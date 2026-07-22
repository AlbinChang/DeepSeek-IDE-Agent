import * as fs from 'fs/promises';
import { PathUtils } from '@/utils/PathUtils.js';
import * as path from 'path';
import iconv from 'iconv-lite';
import jschardet from 'jschardet';

/**
 * 对应技术规范 33.0 节：核心文件系统 IO 抽象 (Internal IO Engine)
 * 供 IDE 前端 (Editor)、后端服务及 AI Agent 使用的底层文件读写工具。
 */
export class FileIO {
    /** 置信度阈值：低于此值不信任 jschardet 的推断，回退到 UTF-8 */
    private static readonly CONFIDENCE_THRESHOLD = 0.7;
    private static readonly UI_LIST_IGNORED_DIRS = new Set([
        '.git',
        '.ide-agent',
        'node_modules',
        'dist',
        'build',
        'coverage',
        '.next',
        '.turbo',
    ]);

    /**
     * 智能解码 Buffer，支持 GBK、UTF-8、UTF-8-BOM 等多种编码。
     * 置信度低于 0.7 时安全回退至 UTF-8，避免短文件/纯ASCII头部误判。
     * UTF-8-BOM：读取时剥离 \uFEFF 前缀，但通过 encoding='UTF-8-BOM' 保留标记供写回时复原。
     */
    public static decodeBuffer(buffer: Buffer): { content: string, encoding: string } {
        // UTF-16 BOM 优先检测（jschardet 对 UTF-16 识别率不稳定，提前拦截避免误判）
        if (buffer.length >= 2) {
            const b0 = buffer[0], b1 = buffer[1];
            if (b0 === 0xFF && b1 === 0xFE) {
                // UTF-16 LE BOM：剥去 2 字节 BOM 后解码
                return { content: iconv.decode(buffer.slice(2), 'utf-16le'), encoding: 'UTF-16-LE' };
            }
            if (b0 === 0xFE && b1 === 0xFF) {
                // UTF-16 BE BOM：剥去 2 字节 BOM 后解码
                return { content: iconv.decode(buffer.slice(2), 'utf-16be'), encoding: 'UTF-16-BE' };
            }
        }

        const detected = jschardet.detect(buffer);

        let encoding = 'utf-8'; // 安全默认值
        // ISO-8859-x 系列是 jschardet 与 Windows-1252 混淆的重灾区，提高置信度阈值至 0.85
        const threshold = (detected?.encoding?.toLowerCase().startsWith('iso-8859'))
            ? 0.85
            : FileIO.CONFIDENCE_THRESHOLD;
        if (detected && detected.encoding && detected.confidence >= threshold) {
            encoding = detected.encoding;
        }

        // ASCII 是 UTF-8 的严格子集，直接升级为 utf-8
        if (encoding.toLowerCase() === 'ascii') encoding = 'utf-8';

        // UTF-8-BOM：剥离 BOM 字符后以 'UTF-8-BOM' 标记保留编码类型
        const encLower = encoding.toLowerCase();
        if (encLower === 'utf-8-bom' || encLower === 'utf-8 bom') {
            let str = buffer.toString('utf-8');
            if (str.charCodeAt(0) === 0xFEFF) str = str.slice(1);
            return { content: str, encoding: 'UTF-8-BOM' };
        }

        if (encLower !== 'utf-8' && iconv.encodingExists(encoding)) {
            return { content: iconv.decode(buffer, encoding), encoding };
        }

        // 标准 UTF-8：也检测并剥离可能存在的 BOM 头
        let str = buffer.toString('utf-8');
        if (str.charCodeAt(0) === 0xFEFF) {
            str = str.slice(1);
            return { content: str, encoding: 'UTF-8-BOM' };
        }
        return { content: str, encoding: 'utf-8' };
    }

    /**
     * 一次性采样文件，同时返回编码类型和换行符类型。
     * - 编码推断：读取头部最多 32KB（jschardet 最佳实践）。
     * - EOL 嗅探：头部 32KB + 尾部 4KB 双点采样，解决头部全为 ASCII 而 CRLF 在后半段的边缘场景。
     * - 消除重复 jschardet 调用：直接使用第一次检测的 encoding 进行解码，不再二次调用 decodeBuffer。
     * 新文件或无法读取时返回安全默认值 { encoding: 'utf-8', isCRLF: false }。
     */
    public static async detectFileProfile(fullPath: string): Promise<{ encoding: string; isCRLF: boolean }> {
        try {
            const stats = await fs.stat(fullPath);
            const HEAD_SAMPLE = 64 * 1024; // 头部最多 64KB 用于编码推断
            const TAIL_SAMPLE = 4 * 1024;  // 尾部额外 4KB 用于 EOL 双点采样
            const headSize = Math.min(stats.size, HEAD_SAMPLE);
            if (headSize === 0) return { encoding: 'utf-8', isCRLF: false };

            const fd = await fs.open(fullPath, 'r');
            const headBuf = Buffer.alloc(headSize);
            let headRead = 0;
            let tailHasCRLF = false;
            let isUTF16LE = false;
            let isUTF16BE = false;

            // 内层 try...finally 保护所有 fd IO，磁盘异常时也能保证 fd.close()
            try {
                ({ bytesRead: headRead } = await fd.read(headBuf, 0, headSize, 0));

                // 读到头部后立即检测 UTF-16 BOM，影响尾部字节扫描策略
                if (headRead >= 2) {
                    if (headBuf[0] === 0xFF && headBuf[1] === 0xFE) isUTF16LE = true;
                    else if (headBuf[0] === 0xFE && headBuf[1] === 0xFF) isUTF16BE = true;
                }

                // 尾部双点采样：仅在文件超过头部采样范围时补充读取
                if (stats.size > HEAD_SAMPLE) {
                    const tailOffset = Math.max(HEAD_SAMPLE, stats.size - TAIL_SAMPLE);
                    const tailBuf = Buffer.alloc(TAIL_SAMPLE);
                    const { bytesRead: tailRead } = await fd.read(tailBuf, 0, TAIL_SAMPLE, tailOffset);
                    if (isUTF16LE) {
                        // UTF-16 LE CRLF 字节序列：0x0D 0x00 0x0A 0x00
                        for (let i = 0; i < tailRead - 3; i++) {
                            if (tailBuf[i] === 0x0D && tailBuf[i+1] === 0x00 &&
                                tailBuf[i+2] === 0x0A && tailBuf[i+3] === 0x00) {
                                tailHasCRLF = true; break;
                            }
                        }
                    } else if (isUTF16BE) {
                        // UTF-16 BE CRLF 字节序列：0x00 0x0D 0x00 0x0A
                        for (let i = 0; i < tailRead - 3; i++) {
                            if (tailBuf[i] === 0x00 && tailBuf[i+1] === 0x0D &&
                                tailBuf[i+2] === 0x00 && tailBuf[i+3] === 0x0A) {
                                tailHasCRLF = true; break;
                            }
                        }
                    } else {
                        // 标准单字节/UTF-8：直接扫描 0x0D 0x0A 序列
                        for (let i = 0; i < tailRead - 1; i++) {
                            if (tailBuf[i] === 0x0D && tailBuf[i + 1] === 0x0A) {
                                tailHasCRLF = true; break;
                            }
                        }
                    }
                }
            } finally {
                await fd.close(); // 无论 IO 是否异常，fd 必定关闭
            }

            const slice = headBuf.slice(0, headRead);

            // UTF-16 BOM 优先（与 decodeBuffer 保持一致），避免 jschardet 对 UTF-16 推断不稳定
            let encoding: string;
            let decodedHead: string;

            if (isUTF16LE) {
                encoding = 'UTF-16-LE';
                decodedHead = iconv.decode(slice.slice(2), 'utf-16le');
            } else if (isUTF16BE) {
                encoding = 'UTF-16-BE';
                decodedHead = iconv.decode(slice.slice(2), 'utf-16be');
            } else {
                encoding = 'utf-8';
                const detected = jschardet.detect(slice);
                // ISO-8859-x 系列提高阈值至 0.85（与 decodeBuffer 保持一致），防止误判为 Windows-1252
                const threshold = detected?.encoding?.toLowerCase().startsWith('iso-8859')
                    ? 0.85
                    : FileIO.CONFIDENCE_THRESHOLD;
                if (detected && detected.encoding && detected.confidence >= threshold) {
                    encoding = detected.encoding.toLowerCase() === 'ascii' ? 'utf-8' : detected.encoding;
                }
                const encLower = encoding.toLowerCase();
                if (encLower === 'utf-8-bom' || encLower === 'utf-8 bom') {
                    decodedHead = slice.toString('utf-8');
                } else if (encLower !== 'utf-8' && iconv.encodingExists(encoding)) {
                    decodedHead = iconv.decode(slice, encoding);
                } else {
                    decodedHead = slice.toString('utf-8');
                }
            }

            const headHasCRLF = decodedHead.includes('\r\n');
            const isCRLF = headHasCRLF || tailHasCRLF;

            return { encoding, isCRLF };
        } catch (e) {
            return { encoding: 'utf-8', isCRLF: false };
        }
    }

    /**
     * 探测指定文件的实际编码（采样 64KB 以确保 jschardet 推断精度）
     * 新文件或无法读取时返回 'utf-8' 作为安全默认值。
     * @deprecated 优先使用 detectFileProfile，可同时获得编码和 EOL 信息。
     */
    public static async detectEncoding(fullPath: string): Promise<string> {
        return (await FileIO.detectFileProfile(fullPath)).encoding;
    }

    /**
     * 将字符串按指定编码重新打包为 Buffer。
     * UTF-8-BOM：在输出 Buffer 头部前置 3 字节 BOM 标记（0xEF 0xBB 0xBF），保持文件格式一致。
     * 非 UTF-8 目标编码：执行往返校验，若存在无法映射的字符（如 emoji 写入 GBK），则抛出明确错误，
     * 防止 iconv 静默替换为 '?' 导致数据丢失且 Agent 无感知。
     */
    public static encodeString(content: string, encoding: string): Buffer {
        const encLower = encoding ? encoding.toLowerCase() : 'utf-8';

        // UTF-8-BOM：补回 BOM 头
        if (encLower === 'utf-8-bom' || encLower === 'utf-8 bom') {
            const bom = Buffer.from([0xEF, 0xBB, 0xBF]);
            const body = Buffer.from(content, 'utf-8');
            return Buffer.concat([bom, body]);
        }

        // UTF-16-LE：补回 BOM 0xFF 0xFE + LE 编码体，与 decodeBuffer 读取路径对称
        if (encLower === 'utf-16-le' || encLower === 'utf-16le') {
            const bom = Buffer.from([0xFF, 0xFE]);
            const body = iconv.encode(content, 'utf-16le');
            return Buffer.concat([bom, body]);
        }

        // UTF-16-BE：补回 BOM 0xFE 0xFF + BE 编码体，与 decodeBuffer 读取路径对称
        if (encLower === 'utf-16-be' || encLower === 'utf-16be') {
            const bom = Buffer.from([0xFE, 0xFF]);
            const body = iconv.encode(content, 'utf-16be');
            return Buffer.concat([bom, body]);
        }

        if (encLower !== 'utf-8' && iconv.encodingExists(encoding)) {
            const encoded = iconv.encode(content, encoding);
            // 往返校验：检测是否有字符被静默替换为 '?'（0x3F）
            const roundtrip = iconv.decode(encoded, encoding);
            if (roundtrip !== content) {
                // 以码点为单位收集丢失字符，避免代理对被割裂为两个独立 code unit
                // [...str] 利用字符串 Iterator 按完整码点迭代，emoji 等 SMP 字符可正确显示
                const lostChars = new Set<string>();
                const contentPoints = [...content];
                const roundtripPoints = [...roundtrip];
                const minLen = Math.min(contentPoints.length, roundtripPoints.length);
                for (let i = 0; i < minLen; i++) {
                    if (contentPoints[i] !== roundtripPoints[i]) lostChars.add(contentPoints[i]);
                }
                for (let i = roundtripPoints.length; i < contentPoints.length; i++) {
                    lostChars.add(contentPoints[i]);
                }
                const lostDesc = [...lostChars]
                    .map(c => `'${c}'(U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, '0')})`)
                    .join(', ');
                throw new Error(
                    `[ENCODING_LOSS] 目标编码 ${encoding} 无法表示以下字符：${lostDesc}。` +
                    `建议将文件编码转换为 UTF-8 后再写入，或确认内容不含该编码不支持的字符。`
                );
            }
            return encoded;
        }
        return Buffer.from(content, 'utf-8');
    }

    /**
     * 代理对感知的安全字符串截断（基于 UTF-16 code unit）。
     * 原生 substring(n) 可能在高代理码元（\uD800-\uDBFF）和低代理码元（\uDC00-\uDFFF）之间截断，
     * 产生孤立的代理码元，导致 JSON 序列化或某些解析器报错。
     * 本方法在截断点是高代理码元时向前退一位，确保输出是合法的 Unicode 字符串。
     */
    public static safeSubstring(str: string, maxLength: number): string {
        if (str.length <= maxLength) return str;
        let truncated = str.substring(0, maxLength);
        // 若末尾字符是高代理码元（代理对前半部分），退后一位避免产生孤立代理
        const lastCode = truncated.charCodeAt(truncated.length - 1);
        if (lastCode >= 0xD800 && lastCode <= 0xDBFF) {
            truncated = truncated.substring(0, truncated.length - 1);
        }
        return truncated;
    }

    /**
     * 读取文件内容 (全量读取，供编辑器及 Agent 语义分析使用)
     * 应用 2.5MB 的硬性安全上限。自动智能解码非 UTF-8 字符。
     * 返回体包含 encoding 字段，供前端保存时原路回传，确保读写编码 100% 对称。
     */
    static async readFile(unsafePath: string, workspaceRoot: string): Promise<{ content: string; encoding: string }> {
        const fullPath = PathUtils.resolveReadPath(unsafePath, workspaceRoot);
        const stats = await fs.stat(fullPath);
        const MAX_UI_READ_SIZE = 2.5 * 1024 * 1024; // 2.5MB

        if (stats.size > MAX_UI_READ_SIZE) {
            throw new Error(`File is too large for system processing (${(stats.size / 1024 / 1024).toFixed(1)}MB). Limit is 2.5MB.`);
        }

        const buffer = await fs.readFile(fullPath);
        this.checkBinaryHeader(buffer);
        return this.decodeBuffer(buffer); // { content, encoding }
    }

    /**
     * 写入文件内容
     * 支持字符串，或已根据原有编码打包好的 Buffer
     */
    static async writeFile(unsafePath: string, workspaceRoot: string, content: string | Buffer): Promise<void> {
        const fullPath = PathUtils.resolveWritePath(unsafePath, workspaceRoot);
        const dir = path.dirname(fullPath);
        await fs.mkdir(dir, { recursive: true });

        // fs.writeFile 支持直接落盘 Buffer，保持原有二进制编码序列
        await fs.writeFile(fullPath, content);
    }

    /**
     * 删除文件或目录
     */
    static async deletePath(unsafePath: string, workspaceRoot: string, recursive: boolean = false): Promise<void> {
        const fullPath = PathUtils.resolveWritePath(unsafePath, workspaceRoot);
        await fs.rm(fullPath, { recursive, force: true });
    }

    /**
     * 重命名文件或目录（原地重命名，不跨目录移动）
     * @param unsafePath 原路径（绝对或相对工作区）
     * @param newName 新名称（仅文件名/目录名，不含路径分隔符）；若提供 newPath 则优先使用完整路径
     * @param workspaceRoot 工作区根目录
     * @param newPath 可选：完整新路径，用于跨目录移动
     */
    static async renamePath(unsafePath: string, newName: string, workspaceRoot: string, newPath?: string): Promise<string> {
        const fullPath = PathUtils.resolveWritePath(unsafePath, workspaceRoot);
        let targetPath: string;

        if (newPath && typeof newPath === 'string' && newPath.trim().length > 0) {
            // 跨目录移动：使用完整新路径
            targetPath = PathUtils.resolveWritePath(newPath.trim(), workspaceRoot);
        } else {
            // 同目录重命名
            if (!newName || typeof newName !== 'string' || newName.trim().length === 0) {
                throw new Error('New name must be a non-empty string');
            }
            if (/[\/\\]/.test(newName)) {
                throw new Error('New name cannot contain path separators');
            }
            const parentDir = path.dirname(fullPath);
            targetPath = PathUtils.normalizePath(path.join(parentDir, newName.trim()));
        }

        // 若新旧路径完全相同（仅大小写变化在同一文件系统可能被视为相同），则不执行
        if (fullPath === targetPath) {
            return targetPath;
        }

        // 检查目标路径是否已存在
        try {
            await fs.access(targetPath);
            throw new Error(`A file or directory already exists at "${targetPath}"`);
        } catch (e: any) {
            if (e.code !== 'ENOENT') throw e;
            // ENOENT 表示不存在，可以继续重命名
        }

        // 确保目标父目录存在
        const targetDir = path.dirname(targetPath);
        try {
            await fs.access(targetDir);
        } catch {
            await fs.mkdir(targetDir, { recursive: true });
        }

        await fs.rename(fullPath, targetPath);
        return targetPath;
    }

    /**
     * 获取目录列表
     */
    static async listFiles(unsafePath: string, workspaceRoot: string) {
        const fullPath = PathUtils.resolveReadPath(unsafePath, workspaceRoot);
        const files = await fs.readdir(fullPath, { withFileTypes: true });
        
        // 关键修复：返回规范化的绝对路径以支持后续 IO 操作 (Section 31.0 Absolute Path Enforcement)
        return files.filter(file => !(file.isDirectory() && FileIO.UI_LIST_IGNORED_DIRS.has(file.name))).map(file => ({
            name: file.name,
            path: PathUtils.normalizePath(path.join(fullPath, file.name)),
            isDirectory: file.isDirectory(),
            isSymbolicLink: file.isSymbolicLink(),
            size: 0
        })).sort((a, b) => {
            if (a.isDirectory === b.isDirectory) return a.name.localeCompare(b.name);
            return a.isDirectory ? -1 : 1;
        });
    }

    /**
     * 全局路径模糊搜索 (返回绝对路径列表)
     */
    static async searchFiles(workspaceRoot: string, query: string): Promise<string[]> {
        const normRoot = PathUtils.normalizePath(workspaceRoot);
        const results: string[] = [];
        const lowerQuery = query.toLowerCase();

        async function walk(dir: string) {
            const files = await fs.readdir(dir, { withFileTypes: true });
            for (const file of files) {
                const fullPath = PathUtils.normalizePath(path.join(dir, file.name));
                if (file.name === 'node_modules' || file.name === 'dist' || file.name === '.git') continue;
                if (file.isDirectory()) {
                    await walk(fullPath);
                } else if (file.name.toLowerCase().includes(lowerQuery)) {
                    results.push(fullPath);
                }
            }
        }
        await walk(normRoot);
        return results;
    }

    public static checkBinaryHeader(buffer: Buffer) {
        // UTF-16 LE BOM: 0xFF 0xFE  /  UTF-16 BE BOM: 0xFE 0xFF
        // UTF-16 文件每个 ASCII 字符均含 null 字节，是编码正常特征，不应误判为二进制
        if (buffer.length >= 2) {
            const b0 = buffer[0], b1 = buffer[1];
            if ((b0 === 0xFF && b1 === 0xFE) || (b0 === 0xFE && b1 === 0xFF)) return;
        }
        for (let i = 0; i < Math.min(buffer.length, 512); i++) {
            if (buffer[i] === 0) {
                throw new Error('Binary file detection.');
            }
        }
    }

    /** 检查 iconv-lite 是否支持指定编码名称（供调用方无需直接导入 iconv-lite）*/
    public static encodingExists(encoding: string): boolean {
        return iconv.encodingExists(encoding);
    }

    /**
     * 规范化文本内容（将 CRLF \r\n 归一化为 LF \n），并建立规范化索引到原始文本索引的映射数组 normToRawMap。
     * 保证在屏蔽换行符差异（如 \r\n vs \n）的前提下，能够将归一化后的匹配区间 [normStart, normEnd] 还原回原始文本区间 [rawStart, rawEnd]。
     */
    public static normalizeWithMapping(rawContent: string): { normContent: string; normToRawMap: number[] } {
        const normChars: string[] = [];
        const normToRawMap: number[] = [];
        let i = 0;
        while (i < rawContent.length) {
            if (rawContent[i] === '\r' && i + 1 < rawContent.length && rawContent[i + 1] === '\n') {
                normChars.push('\n');
                normToRawMap.push(i);
                i += 2;
            } else {
                normChars.push(rawContent[i]);
                normToRawMap.push(i);
                i += 1;
            }
        }
        normToRawMap.push(rawContent.length);
        return {
            normContent: normChars.join(''),
            normToRawMap
        };
    }

    /**
     * 根据 normToRawMap 将规范化文本中的字符区间 [normStart, normEnd] 映射回原始文本中的字符区间 [rawStart, rawEnd]。
     */
    public static getRawRange(
        rawContent: string,
        normToRawMap: number[],
        normStart: number,
        normEnd: number
    ): { rawStart: number; rawEnd: number } {
        if (normStart === normEnd) {
            const rawStart = normToRawMap[normStart] ?? rawContent.length;
            return { rawStart, rawEnd: rawStart };
        }
        const rawStart = normToRawMap[normStart];
        const rawLastCharIdx = normToRawMap[normEnd - 1];
        let charLen = 1;
        if (
            rawContent[rawLastCharIdx] === '\r' &&
            rawLastCharIdx + 1 < rawContent.length &&
            rawContent[rawLastCharIdx + 1] === '\n'
        ) {
            charLen = 2;
        }
        const rawEnd = rawLastCharIdx + charLen;
        return { rawStart, rawEnd };
    }
}

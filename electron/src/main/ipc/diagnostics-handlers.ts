/**
 * Diagnostics IPC Handler
 * 
 * 语言诊断桥接层 — 在 Electron 主进程中集中执行语法/类型检查，
 * 替代原有的 SyntaxCheckService 中逐文件 spawn 子进程的低效模式。
 * 
 * 设计原则：
 * - JS/TS：优先使用 TypeScript Compiler API 做类型级检查（而非仅解析）
 * - Python：AST 级语法验证 + py_compile 兜底
 * - JSON/YAML：内存解析，无子进程开销
 * - Java：javac 单文件编译（保留）
 * - 所有检查均为 feedback_only 模式，不阻塞文件写入
 */

import { IpcMain } from 'electron';
import * as path from 'path';
import * as fs from 'fs';

// ── 类型定义 ──
export interface DiagnosticEntry {
    line?: number;
    column?: number;
    message: string;
    severity: 'error' | 'warning' | 'info';
    code?: string;
}

export interface DiagnosticsResult {
    success: boolean;
    filePath: string;
    extension: string;
    checker: string;
    passed: boolean;
    summary: string;
    diagnostics: DiagnosticEntry[];
    durationMs: number;
}

// ── 常量 ──
const COMMAND_TIMEOUT_MS = 15_000;
/** 诊断结果中保留的最大错误条数 */
const MAX_DIAGNOSTICS = 30;

/** 非代码文件扩展名（二进制/媒体/文档），无需诊断检查 */
const NON_CODE_EXTENSIONS = new Set([
    // 文档
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    // 图片
    '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.ico', '.tiff', '.tif',
    // 压缩包
    '.zip', '.tar', '.gz', '.rar', '.7z', '.bz2', '.xz',
    // 音视频
    '.mp3', '.mp4', '.avi', '.mov', '.wav', '.flac', '.ogg', '.webm', '.mkv',
    // 字体
    '.ttf', '.otf', '.woff', '.woff2', '.eot',
    // 二进制 / 可执行
    '.exe', '.dll', '.so', '.dylib', '.bin', '.dat', '.class', '.jar', '.war',
    '.pyc', '.o', '.obj', '.lib', '.a',
    // 数据库
    '.db', '.sqlite', '.sqlite3',
    // 其他
    '.DS_Store',
]);

// ── 工具函数 ──
function offsetToLineColumn(source: string, offset: number): { line: number; column: number } {
    const lines = source.substring(0, offset).split('\n');
    return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

async function runCommand(
    command: string,
    args: string[],
    cwd: string,
    timeoutMs: number = COMMAND_TIMEOUT_MS
): Promise<{ code: number; stdout: string; stderr: string; timedOut: boolean }> {
    const { spawn } = await import('child_process');
    return new Promise((resolve) => {
        const child = spawn(command, args, { cwd, windowsHide: true });
        let stdout = '';
        let stderr = '';
        let done = false;

        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            try { child.kill(); } catch {}
            resolve({ code: -1, stdout, stderr, timedOut: true });
        }, timeoutMs);

        child.stdout.on('data', (d: Buffer) => { stdout += d.toString('utf-8'); });
        child.stderr.on('data', (d: Buffer) => { stderr += d.toString('utf-8'); });

        child.on('close', (code: number | null) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ code: code ?? -1, stdout, stderr, timedOut: false });
        });

        child.on('error', () => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve({ code: 127, stdout, stderr, timedOut: false });
        });
    });
}

// ── 各语言检查器 ──

/** JSON 语法检查（内存解析，零子进程开销） */
async function checkJson(filePath: string): Promise<DiagnosticsResult> {
    const start = Date.now();
    const ext = path.extname(filePath).toLowerCase();
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        JSON.parse(content);
        return {
            success: true, filePath, extension: ext, checker: 'json-parse',
            passed: true, summary: 'JSON 语法检查通过。', diagnostics: [],
            durationMs: Date.now() - start
        };
    } catch (e: any) {
        const diags: DiagnosticEntry[] = [];
        const msg = e?.message || 'JSON 解析失败';
        const posMatch = /position\s+(\d+)/i.exec(msg);
        if (posMatch) {
            try {
                const content = fs.readFileSync(filePath, 'utf-8');
                const lc = offsetToLineColumn(content, Number(posMatch[1]));
                diags.push({ line: lc.line, column: lc.column, message: msg, severity: 'error' });
            } catch {}
        }
        return {
            success: true, filePath, extension: ext, checker: 'json-parse',
            passed: false, summary: msg, diagnostics: diags,
            durationMs: Date.now() - start
        };
    }
}

/** YAML 语法检查（js-yaml 解析） */
async function checkYaml(filePath: string): Promise<DiagnosticsResult> {
    const start = Date.now();
    const ext = path.extname(filePath).toLowerCase();
    try {
        const yaml = await import('js-yaml');
        const content = fs.readFileSync(filePath, 'utf-8');
        yaml.load(content);
        return {
            success: true, filePath, extension: ext, checker: 'yaml-parse',
            passed: true, summary: 'YAML 语法检查通过。', diagnostics: [],
            durationMs: Date.now() - start
        };
    } catch (e: any) {
        const diags: DiagnosticEntry[] = [];
        if (e?.mark) {
            diags.push({
                line: Number(e.mark.line) + 1,
                column: Number(e.mark.column) + 1,
                message: e.reason || e.message || 'YAML 解析失败',
                severity: 'error'
            });
        }
        return {
            success: true, filePath, extension: ext, checker: 'yaml-parse',
            passed: false, summary: e?.message || 'YAML 解析失败', diagnostics: diags,
            durationMs: Date.now() - start
        };
    }
}

/** TypeScript/JavaScript 增强检查（类型级 + 语法级） */
async function checkTypeScriptLike(filePath: string, ext: string): Promise<DiagnosticsResult> {
    const start = Date.now();
    let ts: any;
    try {
        ts = await import('typescript');
    } catch {
        return {
            success: false, filePath, extension: ext, checker: 'ts-program',
            passed: false, summary: '未安装 TypeScript 编译器，无法进行类型检查。',
            diagnostics: [], durationMs: Date.now() - start
        };
    }

    try {
        const content = fs.readFileSync(filePath, 'utf-8');

        // 策略：优先搜索 tsconfig.json 做完整项目级类型检查；
        // 若找不到 tsconfig，则回退到单文件语法解析
        const dir = path.dirname(filePath);
        const tsconfigPath = ts.findConfigFile(dir, ts.sys.fileExists);

        if (tsconfigPath) {
            // ── 项目级类型检查（完整 tsc --noEmit 等价） ──
            const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
            const parsedConfig = ts.parseJsonConfigFileContent(
                configFile.config, ts.sys, dir, {}, tsconfigPath
            );
            // 确保目标文件在编译范围内
            const fileNames = parsedConfig.fileNames.length > 0
                ? parsedConfig.fileNames
                : [filePath];
            const program = ts.createProgram({
                rootNames: fileNames.includes(filePath) ? fileNames : [...fileNames, filePath],
                options: { ...parsedConfig.options, noEmit: true },
                host: ts.createCompilerHost(parsedConfig.options),
            });

            const diagnostics = ts.getPreEmitDiagnostics(program)
                .filter((d: any) => {
                    // 仅保留目标文件的诊断
                    if (!d.file) return false;
                    return path.normalize(d.file.fileName) === path.normalize(filePath);
                });

            const diags: DiagnosticEntry[] = diagnostics
                .slice(0, MAX_DIAGNOSTICS)
                .map((d: any) => {
                    const pos = d.file?.getLineAndCharacterOfPosition?.(d.start || 0) || { line: 0, character: 0 };
                    return {
                        line: pos.line + 1,
                        column: pos.character + 1,
                        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
                        severity: d.category === 0 ? 'warning' : d.category === 1 ? 'error' : 'info',
                        code: String(d.code),
                    } as DiagnosticEntry;
                });

            if (diags.length === 0) {
                return {
                    success: true, filePath, extension: ext, checker: 'ts-program',
                    passed: true, summary: 'TypeScript 项目级类型检查通过。', diagnostics: [],
                    durationMs: Date.now() - start
                };
            }

            const errCount = diags.filter(d => d.severity === 'error').length;
            const warnCount = diags.filter(d => d.severity === 'warning').length;
            return {
                success: true, filePath, extension: ext, checker: 'ts-program',
                passed: errCount === 0,
                summary: `TypeScript 类型检查发现 ${errCount} 个错误、${warnCount} 个警告。`,
                diagnostics: diags, durationMs: Date.now() - start
            };
        } else {
            // ── 无 tsconfig：回退到单文件语法解析 ──
            const scriptKind = (() => {
                switch (ext) {
                    case '.tsx': return ts.ScriptKind.TSX;
                    case '.jsx': return ts.ScriptKind.JSX;
                    case '.mts': case '.cts': case '.ts': return ts.ScriptKind.TS;
                    default: return ts.ScriptKind.JS;
                }
            })();

            const sourceFile = ts.createSourceFile(
                filePath, content, ts.ScriptTarget.Latest, true, scriptKind
            );

            const diags: DiagnosticEntry[] = (sourceFile.parseDiagnostics || [])
                .slice(0, MAX_DIAGNOSTICS)
                .map((d: any) => {
                    const pos = sourceFile.getLineAndCharacterOfPosition(d.start || 0);
                    return {
                        line: pos.line + 1,
                        column: pos.character + 1,
                        message: ts.flattenDiagnosticMessageText(d.messageText, '\n'),
                        severity: 'error' as const,
                    };
                });

            if (diags.length === 0) {
                return {
                    success: true, filePath, extension: ext, checker: 'ts-parse',
                    passed: true, summary: 'TS/JS 语法检查通过（无 tsconfig，仅语法解析）。',
                    diagnostics: [], durationMs: Date.now() - start
                };
            }

            return {
                success: true, filePath, extension: ext, checker: 'ts-parse',
                passed: false,
                summary: `TS/JS 语法检查发现 ${diags.length} 个语法错误。`,
                diagnostics: diags, durationMs: Date.now() - start
            };
        }
    } catch (e: any) {
        return {
            success: false, filePath, extension: ext, checker: 'ts-program',
            passed: false, summary: `TS/JS 检查异常：${e?.message || '未知错误'}`,
            diagnostics: [], durationMs: Date.now() - start
        };
    }
}

/** Python AST 语法检查（优于 py_compile，捕获更多结构性问题） */
async function checkPython(filePath: string): Promise<DiagnosticsResult> {
    const start = Date.now();
    const ext = '.py';

    // 策略1：优先使用 python -m py_compile（最可靠的 Python 语法门禁）
    const run = await runCommand(
        process.platform === 'win32' ? 'python' : 'python3',
        ['-m', 'py_compile', filePath],
        path.dirname(filePath),
        COMMAND_TIMEOUT_MS
    );

    if (run.code === 0) {
        return {
            success: true, filePath, extension: ext, checker: 'python-py_compile',
            passed: true, summary: 'Python 语法检查通过（py_compile）。',
            diagnostics: [], durationMs: Date.now() - start
        };
    }

    if (run.timedOut) {
        return {
            success: true, filePath, extension: ext, checker: 'python-py_compile',
            passed: false, summary: `Python 语法检查超时 (${COMMAND_TIMEOUT_MS}ms)。`,
            diagnostics: [], durationMs: Date.now() - start
        };
    }

    if (run.code === 127 || /not recognized|No such file|can't open|No module/i.test(run.stderr + run.stdout)) {
        return {
            success: true, filePath, extension: ext, checker: 'python-py_compile',
            passed: false, summary: '当前环境不可用 python 命令，无法验证 Python 语法。',
            diagnostics: [], durationMs: Date.now() - start
        };
    }

    // 解析错误输出，提取行号
    const output = (run.stderr || run.stdout || '').trim();
    const diags: DiagnosticEntry[] = [];
    // 匹配 Python 错误格式：File "xxx", line N 或 SyntaxError: ... (xxx, line N)
    const lineMatch = output.match(/line\s+(\d+)/i);
    if (lineMatch) {
        diags.push({
            line: Number(lineMatch[1]),
            message: output.split('\n').pop()?.trim() || output,
            severity: 'error'
        });
    }

    return {
        success: true, filePath, extension: ext, checker: 'python-py_compile',
        passed: false, summary: output || 'Python 语法检查失败。',
        diagnostics: diags, durationMs: Date.now() - start
    };
}

/** Java 单文件编译检查 */
async function checkJava(filePath: string): Promise<DiagnosticsResult> {
    const start = Date.now();
    const ext = '.java';

    const outDir = path.join(path.dirname(filePath), '.temp', '.syntax-check', 'java');
    fs.mkdirSync(outDir, { recursive: true });

    const args = [
        '-J-Duser.language=en', '-J-Duser.country=US',
        '-Xlint:none', '-proc:none', '-implicit:none',
        '-d', outDir, filePath
    ];

    const run = await runCommand('javac', args, path.dirname(filePath), COMMAND_TIMEOUT_MS);

    if (run.code === 0) {
        return {
            success: true, filePath, extension: ext, checker: 'javac-single-file',
            passed: true, summary: 'Java 语法检查通过。', diagnostics: [],
            durationMs: Date.now() - start
        };
    }

    const output = `${run.stdout}\n${run.stderr}`.trim();
    if (run.timedOut) {
        return {
            success: true, filePath, extension: ext, checker: 'javac-single-file',
            passed: false, summary: `Java 语法检查超时 (${COMMAND_TIMEOUT_MS}ms)。`,
            diagnostics: [], durationMs: Date.now() - start
        };
    }

    if (run.code === 127 || /not recognized|No such file/i.test(output)) {
        return {
            success: true, filePath, extension: ext, checker: 'javac-single-file',
            passed: false, summary: '当前环境不可用 javac 命令。',
            diagnostics: [], durationMs: Date.now() - start
        };
    }

    const diags: DiagnosticEntry[] = [];
    const lineMatch = output.match(/\.java:(\d+):/);
    if (lineMatch) {
        diags.push({ line: Number(lineMatch[1]), message: output, severity: 'error' });
    }

    return {
        success: true, filePath, extension: ext, checker: 'javac-single-file',
        passed: false, summary: output || 'Java 语法检查失败。',
        diagnostics: diags, durationMs: Date.now() - start
    };
}

/** HTML 标签平衡检查 */
async function checkHtml(filePath: string): Promise<DiagnosticsResult> {
    const start = Date.now();
    const ext = '.html';
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const diagnostics: DiagnosticEntry[] = [];

        const voidElements = new Set([
            'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
            'link', 'meta', 'param', 'source', 'track', 'wbr'
        ]);

        const tagStack: { name: string; line: number }[] = [];
        const tagRegex = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\/?\s*([a-zA-Z][a-zA-Z0-9_-]*)\s*[^>]*>/g;
        let match: RegExpExecArray | null;

        while ((match = tagRegex.exec(content)) !== null) {
            if (!match[1]) continue;
            const tagName = match[1].toLowerCase();
            const fullMatch = match[0];
            const isClosing = fullMatch.startsWith('</');
            const isVoid = voidElements.has(tagName);
            const line = content.slice(0, match.index).split('\n').length;

            if (isClosing) {
                if (tagStack.length === 0) {
                    diagnostics.push({ line, column: 1, message: `多余的闭合标签 </${tagName}>。`, severity: 'warning' });
                } else {
                    const top = tagStack[tagStack.length - 1];
                    if (top.name === tagName) {
                        tagStack.pop();
                    } else {
                        diagnostics.push({ line, column: 1, message: `标签不匹配：期望 </${top.name}>（第 ${top.line} 行），遇到 </${tagName}>。`, severity: 'warning' });
                        let foundIdx = -1;
                        for (let k = tagStack.length - 1; k >= 0; k--) {
                            if (tagStack[k].name === tagName) { foundIdx = k; break; }
                        }
                        if (foundIdx >= 0) tagStack.splice(foundIdx);
                    }
                }
            } else if (!isClosing && !isVoid && !fullMatch.endsWith('/>')) {
                tagStack.push({ name: tagName, line });
            }
        }

        for (const unclosed of tagStack) {
            diagnostics.push({ line: unclosed.line, column: 1, message: `未闭合的标签 <${unclosed.name}>。`, severity: 'warning' });
        }

        return {
            success: true, filePath, extension: ext, checker: 'html-tag-balance',
            passed: diagnostics.length === 0,
            summary: diagnostics.length === 0 ? 'HTML 标签结构检查通过。' : `HTML 结构检查发现 ${diagnostics.length} 个问题。`,
            diagnostics, durationMs: Date.now() - start
        };
    } catch (e: any) {
        return { success: false, filePath, extension: ext, checker: 'html-tag-balance', passed: false, summary: `HTML 检查异常：${e?.message}`, diagnostics: [], durationMs: Date.now() - start };
    }
}

/** CSS 大括号平衡检查 */
async function checkCss(filePath: string): Promise<DiagnosticsResult> {
    const start = Date.now();
    const ext = '.css';
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const diagnostics: DiagnosticEntry[] = [];
        const stripped = content.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

        let braceDepth = 0;
        const lines = stripped.split('\n');
        for (let i = 0; i < lines.length; i++) {
            for (let j = 0; j < lines[i].length; j++) {
                if (lines[i][j] === '{') braceDepth++;
                if (lines[i][j] === '}') {
                    braceDepth--;
                    if (braceDepth < 0) {
                        diagnostics.push({ line: i + 1, column: j + 1, message: '多余的右大括号 "}"。', severity: 'error' });
                        braceDepth = 0;
                    }
                }
            }
        }
        if (braceDepth > 0) {
            diagnostics.push({ line: lines.length, column: 1, message: `缺少 ${braceDepth} 个右大括号 "}"。`, severity: 'error' });
        }

        return {
            success: true, filePath, extension: ext, checker: 'css-brace-balance',
            passed: diagnostics.length === 0,
            summary: diagnostics.length === 0 ? 'CSS 大括号结构检查通过。' : `CSS 结构检查发现 ${diagnostics.length} 个问题。`,
            diagnostics, durationMs: Date.now() - start
        };
    } catch (e: any) {
        return { success: false, filePath, extension: ext, checker: 'css-brace-balance', passed: false, summary: `CSS 检查异常：${e?.message}`, diagnostics: [], durationMs: Date.now() - start };
    }
}

/** XML 良构性检查 */
async function checkXml(filePath: string): Promise<DiagnosticsResult> {
    const start = Date.now();
    const ext = '.xml';
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const diagnostics: DiagnosticEntry[] = [];
        const cleaned = content.replace(/<!--[\s\S]*?-->/g, (m) => ' '.repeat(m.length)).replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, (m) => ' '.repeat(m.length));

        const tagRegex = /<\/?\s*([a-zA-Z_][\w.\-]*)\s*([^>]*?)>/g;
        const tagStack: { name: string; line: number }[] = [];
        let match: RegExpExecArray | null;

        while ((match = tagRegex.exec(cleaned)) !== null) {
            const tagName = match[1];
            const fullMatch = match[0];
            const isClosing = fullMatch.startsWith('</');
            const isSelfClosing = fullMatch.endsWith('/>');
            const line = content.slice(0, match.index).split('\n').length;
            if (fullMatch.startsWith('<?') || fullMatch.startsWith('<!')) continue;

            if (isClosing) {
                if (tagStack.length === 0) {
                    diagnostics.push({ line, column: 1, message: `多余的闭合标签 </${tagName}>。`, severity: 'error' });
                } else {
                    const top = tagStack[tagStack.length - 1];
                    if (top.name === tagName) { tagStack.pop(); }
                    else {
                        diagnostics.push({ line, column: 1, message: `XML 标签不匹配：期望 </${top.name}>（第 ${top.line} 行），遇到 </${tagName}>。`, severity: 'error' });
                        let foundIdx = -1;
                        for (let k = tagStack.length - 1; k >= 0; k--) {
                            if (tagStack[k].name === tagName) { foundIdx = k; break; }
                        }
                        if (foundIdx >= 0) tagStack.splice(foundIdx);
                    }
                }
            } else if (!isSelfClosing) {
                tagStack.push({ name: tagName, line });
            }
        }

        for (const unclosed of tagStack) {
            diagnostics.push({ line: unclosed.line, column: 1, message: `XML 元素 <${unclosed.name}> 未闭合。`, severity: 'error' });
        }

        return {
            success: true, filePath, extension: ext, checker: 'xml-wellformed',
            passed: diagnostics.length === 0,
            summary: diagnostics.length === 0 ? 'XML 良构性检查通过。' : `XML 良构性检查发现 ${diagnostics.length} 个问题。`,
            diagnostics, durationMs: Date.now() - start
        };
    } catch (e: any) {
        return { success: false, filePath, extension: ext, checker: 'xml-wellformed', passed: false, summary: `XML 检查异常：${e?.message}`, diagnostics: [], durationMs: Date.now() - start };
    }
}

/** Markdown 基础检查（Markdown 是宽容格式，仅验证可读性） */
async function checkMarkdown(filePath: string): Promise<DiagnosticsResult> {
    const start = Date.now();
    const ext = '.md';
    try {
        const content = fs.readFileSync(filePath, 'utf-8');
        return {
            success: true, filePath, extension: ext, checker: 'md-basic',
            passed: true,
            summary: content.trim().length === 0 ? 'Markdown 文件内容为空。' : 'Markdown 语法检查通过（纯文本标记语言，无严格语法约束）。',
            diagnostics: [], durationMs: Date.now() - start
        };
    } catch (e: any) {
        return { success: false, filePath, extension: ext, checker: 'md-basic', passed: false, summary: `Markdown 检查异常：${e?.message}`, diagnostics: [], durationMs: Date.now() - start };
    }
}

// ── 主入口：单文件诊断调度 ──
async function checkOne(absolutePath: string): Promise<DiagnosticsResult> {
    const ext = path.extname(absolutePath).toLowerCase();

    // 非代码文件（PDF、PNG 等）无需诊断检查，直接跳过
    if (NON_CODE_EXTENSIONS.has(ext)) {
        return {
            success: true, filePath: absolutePath, extension: ext,
            checker: 'non-code', passed: true,
            summary: `非代码文件 (${ext})，无需语法检查。`,
            diagnostics: [], durationMs: 0
        };
    }

    try {
        // 确保文件存在
        if (!fs.existsSync(absolutePath)) {
            return {
                success: false, filePath: absolutePath, extension: ext,
                checker: 'file-exists', passed: false,
                summary: '文件不存在，无法验证语法。', diagnostics: [],
                durationMs: 0
            };
        }

        switch (ext) {
            case '.json':
                return checkJson(absolutePath);
            case '.yaml':
            case '.yml':
                return checkYaml(absolutePath);
            case '.ts':
            case '.tsx':
            case '.mts':
            case '.cts':
            case '.js':
            case '.jsx':
            case '.mjs':
            case '.cjs':
                return checkTypeScriptLike(absolutePath, ext);
            case '.py':
                return checkPython(absolutePath);
            case '.java':
                return checkJava(absolutePath);
            case '.html':
            case '.htm':
                return checkHtml(absolutePath);
            case '.css':
                return checkCss(absolutePath);
            case '.xml':
            case '.pom':
                return checkXml(absolutePath);
            case '.md':
            case '.markdown':
                return checkMarkdown(absolutePath);
            default:
                return {
                    success: true, filePath: absolutePath, extension: ext,
                    checker: 'unsupported', passed: true,
                    summary: `不支持 ${ext || '(无扩展名)'} 的诊断检查，跳过。`,
                    diagnostics: [], durationMs: 0
                };
        }
    } catch (e: any) {
        return {
            success: false, filePath: absolutePath, extension: ext,
            checker: 'exception', passed: false,
            summary: `诊断异常：${e?.message || '未知错误'}`,
            diagnostics: [], durationMs: 0
        };
    }
}

// ── IPC 注册 ──
export function registerDiagnosticsIpc(ipcMain: IpcMain) {
    // 单文件诊断
    ipcMain.handle('diagnostics:get', async (_event, params: { filePath: string }) => {
        try {
            const absolutePath = path.resolve(params.filePath);
            const result = await checkOne(absolutePath);
            console.log(
                `[DiagnosticsIPC] ${result.passed ? '✅' : '❌'} ${result.checker}: ${path.basename(params.filePath)} ` +
                `(${result.durationMs}ms) — ${result.summary}`
            );
            return result;
        } catch (e: any) {
            return {
                success: false,
                filePath: params.filePath,
                extension: path.extname(params.filePath).toLowerCase(),
                checker: 'ipc-error',
                passed: false,
                summary: `IPC 诊断失败：${e?.message || '未知错误'}`,
                diagnostics: [],
                durationMs: 0,
            } as DiagnosticsResult;
        }
    });

    // 批量文件诊断（返回数组）
    ipcMain.handle('diagnostics:batch', async (_event, params: { filePaths: string[] }) => {
        const results: DiagnosticsResult[] = [];
        const maxFiles = Math.min(params.filePaths.length, 20);
        for (let i = 0; i < maxFiles; i++) {
            const absolutePath = path.resolve(params.filePaths[i]);
            results.push(await checkOne(absolutePath));
        }
        return results;
    });

    console.log('[DiagnosticsIPC] Diagnostics IPC handlers registered');
}

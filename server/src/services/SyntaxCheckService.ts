import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import yaml from 'js-yaml';
import { PathUtils } from '@/utils/PathUtils.js';
import { FileIO } from '@/utils/FileIO.js';

export type SyntaxCheckStatus = 'ok' | 'error' | 'skipped';

export interface SyntaxCheckDiagnostic {
    line?: number;
    column?: number;
    message: string;
}

export interface SyntaxCheckResult {
    path: string;
    extension: string;
    checker: string;
    status: SyntaxCheckStatus;
    message: string;
    diagnostics?: SyntaxCheckDiagnostic[];
    durationMs: number;
}

interface CommandRunResult {
    code: number;
    stdout: string;
    stderr: string;
    timedOut: boolean;
}

// ============================================================
// TypeScript 项目级类型检查 Worker（避免 ts.createProgram 阻塞主线程/事件循环）
// ============================================================

interface TsCheckWorkerResult {
    ok: boolean;
    hasTsconfig?: boolean;
    tsconfigBasename?: string;
    diagnostics?: SyntaxCheckDiagnostic[];
    errorCount?: number;
    warnCount?: number;
    error?: string;
}

let tsCheckWorker: Worker | null = null;
let tsCheckReqSeq = 0;
const tsCheckPending = new Map<number, {
    resolve: (value: TsCheckWorkerResult) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}>();

function failAllPendingTsChecks(err: Error): void {
    for (const pending of tsCheckPending.values()) {
        clearTimeout(pending.timer);
        pending.reject(err);
    }
    tsCheckPending.clear();
}

function getTsCheckWorker(): Worker {
    if (tsCheckWorker) return tsCheckWorker;

    const workerUrl = new URL('../workers/typescriptProgramCheck.worker.mjs', import.meta.url);
    const worker = new Worker(fileURLToPath(workerUrl));

    worker.on('message', (msg: any) => {
        const pending = tsCheckPending.get(msg?.requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        tsCheckPending.delete(msg.requestId);
        pending.resolve(msg);
    });
    worker.on('error', (err) => {
        failAllPendingTsChecks(err instanceof Error ? err : new Error(String(err)));
        tsCheckWorker = null;
    });
    worker.on('exit', () => {
        failAllPendingTsChecks(new Error('TypeScript 类型检查 worker 已退出'));
        tsCheckWorker = null;
    });

    worker.unref(); // 不阻止进程退出
    tsCheckWorker = worker;
    return worker;
}

/**
 * 在独立 worker 线程中执行 TypeScript 项目级类型检查（ts.createProgram），
 * 避免这类 CPU 密集型同步计算阻塞 Electron 主进程 / Node 主事件循环。
 */
function runTsProgramCheckInWorker(fullPath: string, timeoutMs: number): Promise<TsCheckWorkerResult> {
    return new Promise((resolve, reject) => {
        let worker: Worker;
        try {
            worker = getTsCheckWorker();
        } catch (err: any) {
            reject(err instanceof Error ? err : new Error(String(err)));
            return;
        }

        const requestId = ++tsCheckReqSeq;
        const timer = setTimeout(() => {
            tsCheckPending.delete(requestId);
            reject(new Error(`TypeScript 项目级类型检查超时(${timeoutMs}ms)`));
        }, timeoutMs);

        tsCheckPending.set(requestId, { resolve, reject, timer });
        worker.postMessage({ requestId, fullPath });
    });
}

export class SyntaxCheckService {
    private static readonly MAX_FILES_PER_BATCH = Number(process.env.AGENT_SYNTAX_CHECK_MAX_FILES) || 20;
    private static readonly COMMAND_TIMEOUT_MS = Number(process.env.AGENT_SYNTAX_CHECK_TIMEOUT_MS) || 15000;
    private static readonly ENFORCED_EXTENSIONS = new Set([
        '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts',
        '.json', '.yaml', '.yml', '.py', '.java'
    ]);

    static isEnforcedExtension(ext: string): boolean {
        return this.ENFORCED_EXTENSIONS.has((ext || '').toLowerCase());
    }

    static isGatePass(result?: SyntaxCheckResult): boolean {
        if (!result) return false;
        if (!this.isEnforcedExtension(result.extension)) return true;
        return result.status === 'ok';
    }

    static async checkFiles(workspaceRoot: string, relativePaths: string[]): Promise<SyntaxCheckResult[]> {
        if (!Array.isArray(relativePaths) || relativePaths.length === 0) return [];

        const deduped = [...new Set(relativePaths.filter(Boolean))];
        const targets = deduped.slice(0, this.MAX_FILES_PER_BATCH);
        const skipped = deduped.slice(this.MAX_FILES_PER_BATCH).map((p): SyntaxCheckResult => ({
            path: p,
            extension: path.extname(p).toLowerCase(),
            checker: 'batch-limit',
            status: 'error',
            message: `超出单批语法检查上限(${this.MAX_FILES_PER_BATCH})，本文件未验证语法（仅反馈）。`,
            durationMs: 0
        }));

        const checked: SyntaxCheckResult[] = [];
        for (const relPath of targets) {
            checked.push(await this.checkOne(workspaceRoot, relPath));
        }

        return [...checked, ...skipped];
    }

    private static async checkOne(workspaceRoot: string, relativePath: string): Promise<SyntaxCheckResult> {
        const start = Date.now();
        const ext = path.extname(relativePath).toLowerCase();

        let fullPath = '';
        try {
            fullPath = PathUtils.resolvePath(relativePath, workspaceRoot);
        } catch (e: any) {
            return {
                path: relativePath,
                extension: ext,
                checker: 'path-security',
                status: 'error',
                message: e?.message || '路径越界，无法进行语法检查。',
                durationMs: Date.now() - start
            };
        }

        try {
            await fs.access(fullPath);
        } catch {
            return {
                path: relativePath,
                extension: ext,
                checker: 'file-exists',
                status: 'error',
                message: '文件不存在，无法验证语法（仅反馈）。',
                durationMs: Date.now() - start
            };
        }

        try {
            if (ext === '.json') {
                return await this.checkJson(fullPath, relativePath, start);
            }

            if (ext === '.yaml' || ext === '.yml') {
                return await this.checkYaml(fullPath, relativePath, start);
            }

            if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(ext)) {
                return await this.checkTypeScriptLike(fullPath, relativePath, ext, start);
            }

            if (ext === '.py') {
                return await this.checkPython(fullPath, relativePath, start);
            }

            if (ext === '.java') {
                return await this.checkJava(fullPath, relativePath, start);
            }

            return {
                path: relativePath,
                extension: ext,
                checker: 'unsupported',
                status: 'skipped',
                message: `未配置 ${ext || '(no-ext)'} 的轻量语法检查器，跳过。`,
                durationMs: Date.now() - start
            };
        } catch (e: any) {
            return {
                path: relativePath,
                extension: ext,
                checker: 'exception',
                status: 'error',
                message: e?.message || '语法检查过程发生异常。',
                durationMs: Date.now() - start
            };
        }
    }

    private static async readTextFile(fullPath: string): Promise<string> {
        const raw = await fs.readFile(fullPath);
        const { content } = FileIO.decodeBuffer(raw);
        return content;
    }

    private static async checkJson(fullPath: string, relativePath: string, start: number): Promise<SyntaxCheckResult> {
        const source = await this.readTextFile(fullPath);
        try {
            JSON.parse(source);
            return {
                path: relativePath,
                extension: '.json',
                checker: 'json-parse',
                status: 'ok',
                message: 'JSON 语法检查通过。',
                durationMs: Date.now() - start
            };
        } catch (e: any) {
            const diagnostics: SyntaxCheckDiagnostic[] = [];
            const msg = e?.message || 'JSON 解析失败。';
            const posMatch = /position\s+(\d+)/i.exec(msg);
            if (posMatch) {
                const position = Number(posMatch[1]);
                const lc = this.offsetToLineColumn(source, position);
                diagnostics.push({ line: lc.line, column: lc.column, message: msg });
            }
            return {
                path: relativePath,
                extension: '.json',
                checker: 'json-parse',
                status: 'error',
                message: msg,
                diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
                durationMs: Date.now() - start
            };
        }
    }

    private static async checkYaml(fullPath: string, relativePath: string, start: number): Promise<SyntaxCheckResult> {
        const source = await this.readTextFile(fullPath);
        try {
            yaml.load(source);
            return {
                path: relativePath,
                extension: path.extname(relativePath).toLowerCase(),
                checker: 'yaml-parse',
                status: 'ok',
                message: 'YAML 语法检查通过。',
                durationMs: Date.now() - start
            };
        } catch (e: any) {
            const diagnostics: SyntaxCheckDiagnostic[] = [];
            if (e?.mark) {
                diagnostics.push({
                    line: Number(e.mark.line) + 1,
                    column: Number(e.mark.column) + 1,
                    message: e.reason || e.message || 'YAML 解析失败。'
                });
            }
            return {
                path: relativePath,
                extension: path.extname(relativePath).toLowerCase(),
                checker: 'yaml-parse',
                status: 'error',
                message: e?.message || 'YAML 解析失败。',
                diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
                durationMs: Date.now() - start
            };
        }
    }

    private static async checkTypeScriptLike(fullPath: string, relativePath: string, ext: string, start: number): Promise<SyntaxCheckResult> {
        // JS 文件先尝试 node --check（快速且准确）
        if (['.js', '.mjs', '.cjs'].includes(ext)) {
            const nodeCheck = await this.checkJavaScriptWithNode(fullPath, relativePath, ext, start);
            if (nodeCheck.status === 'ok' || nodeCheck.status === 'error') {
                return nodeCheck;
            }
        }

        let ts: any;
        try {
            ts = await import('typescript');
        } catch {
            return {
                path: relativePath,
                extension: ext,
                checker: 'typescript-parser',
                status: 'error',
                message: '未安装 TypeScript 运行时解析器，无法完成 TS/JS 语法门禁。',
                durationMs: Date.now() - start
            };
        }

        try {
            // ── 增强策略：优先搜索 tsconfig.json 做项目级类型检查 ──
            // 🚀 项目级类型检查（ts.createProgram — 等价于 tsc --noEmit）在独立 worker 线程执行，
            // 避免这类 CPU 密集型同步计算阻塞 Electron 主线程 / Node 主事件循环（详见 typescriptProgramCheck.worker.mjs）。
            const workerResult = await runTsProgramCheckInWorker(fullPath, this.COMMAND_TIMEOUT_MS);

            if (!workerResult.ok) {
                return {
                    path: relativePath,
                    extension: ext,
                    checker: 'ts-program',
                    status: 'error',
                    message: workerResult.error || 'TypeScript 项目级类型检查执行失败。',
                    durationMs: Date.now() - start
                };
            }

            if (workerResult.hasTsconfig) {
                const diagnostics: SyntaxCheckDiagnostic[] = workerResult.diagnostics || [];

                if (diagnostics.length === 0) {
                    return {
                        path: relativePath,
                        extension: ext,
                        checker: 'ts-program',
                        status: 'ok',
                        message: `TypeScript 项目级类型检查通过（tsconfig: ${workerResult.tsconfigBasename}）。`,
                        durationMs: Date.now() - start
                    };
                }

                const errorCount = workerResult.errorCount || 0;
                const warnCount = workerResult.warnCount || 0;
                return {
                    path: relativePath,
                    extension: ext,
                    checker: 'ts-program',
                    status: 'error',
                    message: `TypeScript 类型检查发现 ${errorCount} 个错误${warnCount > 0 ? `、${warnCount} 个警告` : ''}。`,
                    diagnostics: diagnostics.length > 0 ? diagnostics : undefined,
                    durationMs: Date.now() - start
                };
            }

            // ── 回退：无 tsconfig → 单文件语法解析（保留原逻辑） ──
            const source = await this.readTextFile(fullPath);
            const sourceFile = ts.createSourceFile(
                fullPath,
                source,
                ts.ScriptTarget.Latest,
                true,
                this.resolveScriptKind(ts, ext)
            );

            const parseDiags = (sourceFile.parseDiagnostics || []).slice(0, 30).map((d: any) => {
                const pos = sourceFile.getLineAndCharacterOfPosition(d.start || 0);
                const message = ts.flattenDiagnosticMessageText(d.messageText, '\n');
                return {
                    line: pos.line + 1,
                    column: pos.character + 1,
                    message
                } as SyntaxCheckDiagnostic;
            });

            if (parseDiags.length > 0) {
                return {
                    path: relativePath,
                    extension: ext,
                    checker: 'ts-parse',
                    status: 'error',
                    message: parseDiags[0].message,
                    diagnostics: parseDiags,
                    durationMs: Date.now() - start
                };
            }

            return {
                path: relativePath,
                extension: ext,
                checker: 'ts-parse',
                status: 'ok',
                message: 'TS/JS 语法检查通过（无 tsconfig，仅语法解析）。',
                durationMs: Date.now() - start
            };
        } catch (e: any) {
            return {
                path: relativePath,
                extension: ext,
                checker: 'typescript-parser',
                status: 'error',
                message: e?.message || 'TS/JS 类型检查过程发生异常。',
                durationMs: Date.now() - start
            };
        }
    }

    private static async checkJavaScriptWithNode(fullPath: string, relativePath: string, ext: string, start: number): Promise<SyntaxCheckResult> {
        const run = await this.runCommand('node', ['--check', fullPath], path.dirname(fullPath), this.COMMAND_TIMEOUT_MS);
        if (run.code === 0) {
            return {
                path: relativePath,
                extension: ext,
                checker: 'node-check',
                status: 'ok',
                message: 'JavaScript 语法检查通过（node --check）。',
                durationMs: Date.now() - start
            };
        }

        if (run.timedOut) {
            return {
                path: relativePath,
                extension: ext,
                checker: 'node-check',
                status: 'error',
                message: `JavaScript 语法检查超时(${this.COMMAND_TIMEOUT_MS}ms)，未能验证语法（仅反馈）。`,
                durationMs: Date.now() - start
            };
        }

        const output = `${run.stdout}\n${run.stderr}`.trim();
        if (run.code === 127 || /not recognized|No such file or directory/i.test(output)) {
            return {
                path: relativePath,
                extension: ext,
                checker: 'node-check',
                status: 'skipped',
                message: '当前环境不可用 node --check，回退到 TypeScript 解析器检查 JS 语法。',
                durationMs: Date.now() - start
            };
        }

        const diagnostics: SyntaxCheckDiagnostic[] = [];
        const lineMatch = output.match(/:(\d+)(?::\d+)?\s*$/m) || output.match(/:(\d+)\s*$/m);
        const line = lineMatch ? Number(lineMatch[1]) : undefined;
        const messageLine = output
            .split(/\r?\n/)
            .map((s) => s.trim())
            .find((s) => /^SyntaxError:/i.test(s) || /Unexpected token|missing\s/i.test(s));
        const message = messageLine || output || 'JavaScript 语法检查失败（node --check）。';
        diagnostics.push({ line, message });

        return {
            path: relativePath,
            extension: ext,
            checker: 'node-check',
            status: 'error',
            message,
            diagnostics,
            durationMs: Date.now() - start
        };
    }

    private static resolveScriptKind(ts: any, ext: string): number {
        switch (ext) {
            case '.tsx': return ts.ScriptKind.TSX;
            case '.jsx': return ts.ScriptKind.JSX;
            case '.js':
            case '.mjs':
            case '.cjs':
                return ts.ScriptKind.JS;
            case '.mts':
            case '.cts':
            case '.ts':
            default:
                return ts.ScriptKind.TS;
        }
    }

    private static async checkPython(fullPath: string, relativePath: string, start: number): Promise<SyntaxCheckResult> {
        const run = await this.runCommand('python', ['-m', 'py_compile', fullPath], path.dirname(fullPath), this.COMMAND_TIMEOUT_MS);
        if (run.code === 0) {
            return {
                path: relativePath,
                extension: '.py',
                checker: 'python-py_compile',
                status: 'ok',
                message: 'Python 语法检查通过。',
                durationMs: Date.now() - start
            };
        }

        if (run.timedOut) {
            return {
                path: relativePath,
                extension: '.py',
                checker: 'python-py_compile',
                status: 'error',
                message: `Python 语法检查超时(${this.COMMAND_TIMEOUT_MS}ms)，未能验证语法（仅反馈）。`,
                durationMs: Date.now() - start
            };
        }

        if (run.code === 127 || /not recognized|No such file or directory|can't open file|No module named/i.test(run.stderr + run.stdout)) {
            return {
                path: relativePath,
                extension: '.py',
                checker: 'python-py_compile',
                status: 'error',
                message: '当前环境不可用 python 命令，无法验证 Python 语法（仅反馈）。',
                durationMs: Date.now() - start
            };
        }

        return {
            path: relativePath,
            extension: '.py',
            checker: 'python-py_compile',
            status: 'error',
            message: (run.stderr || run.stdout || 'Python 语法检查失败。').trim(),
            durationMs: Date.now() - start
        };
    }

    private static async checkJava(fullPath: string, relativePath: string, start: number): Promise<SyntaxCheckResult> {
        const outDir = path.join(path.dirname(fullPath), '.temp', '.syntax-check', 'java');
        await fs.mkdir(outDir, { recursive: true });

        const args = [
            '-J-Duser.language=en',
            '-J-Duser.country=US',
            '-Xlint:none',
            '-proc:none',
            '-implicit:none',
            '-d',
            outDir,
            fullPath
        ];

        const run = await this.runCommand('javac', args, path.dirname(fullPath), this.COMMAND_TIMEOUT_MS);
        if (run.code === 0) {
            return {
                path: relativePath,
                extension: '.java',
                checker: 'javac-single-file',
                status: 'ok',
                message: 'Java 轻量语法检查通过。',
                durationMs: Date.now() - start
            };
        }

        const output = `${run.stdout}\n${run.stderr}`.trim();
        if (run.timedOut) {
            return {
                path: relativePath,
                extension: '.java',
                checker: 'javac-single-file',
                status: 'error',
                message: `Java 语法检查超时(${this.COMMAND_TIMEOUT_MS}ms)，未能验证语法（仅反馈）。`,
                durationMs: Date.now() - start
            };
        }

        if (run.code === 127 || /not recognized|No such file or directory/i.test(output)) {
            return {
                path: relativePath,
                extension: '.java',
                checker: 'javac-single-file',
                status: 'error',
                message: '当前环境不可用 javac 命令，无法验证 Java 语法（仅反馈）。',
                durationMs: Date.now() - start
            };
        }

        const syntaxIndicators = [
            /';' expected/i,
            /not a statement/i,
            /illegal start of expression/i,
            /class, interface, enum, or record expected/i,
            /reached end of file while parsing/i,
            /'\)' expected/i,
            /'\}' expected/i,
            /'\]' expected/i,
            /<identifier> expected/i,
            /unclosed string literal/i
        ];

        const hasSyntaxError = syntaxIndicators.some(re => re.test(output));
        if (!hasSyntaxError) {
            return {
                path: relativePath,
                extension: '.java',
                checker: 'javac-single-file',
                status: 'error',
                message: 'javac 返回了类型/依赖类错误，无法稳定确认纯语法通过（仅反馈）。',
                durationMs: Date.now() - start
            };
        }

        return {
            path: relativePath,
            extension: '.java',
            checker: 'javac-single-file',
            status: 'error',
            message: output || 'Java 语法检查失败。',
            durationMs: Date.now() - start
        };
    }

    private static async runCommand(
        command: string,
        args: string[],
        cwd: string,
        timeoutMs: number
    ): Promise<CommandRunResult> {
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

            child.stdout.on('data', (d) => { stdout += d.toString(); });
            child.stderr.on('data', (d) => { stderr += d.toString(); });

            child.on('error', (err) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve({ code: 127, stdout, stderr: `${stderr}\n${err.message}`, timedOut: false });
            });

            child.on('close', (code) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                resolve({ code: code ?? 1, stdout, stderr, timedOut: false });
            });
        });
    }

    private static offsetToLineColumn(source: string, offset: number): { line: number; column: number } {
        const clamped = Math.max(0, Math.min(offset, source.length));
        const before = source.slice(0, clamped);
        const lines = before.split(/\r\n|\n|\r/);
        const line = lines.length;
        const column = (lines[lines.length - 1] || '').length + 1;
        return { line, column };
    }
}

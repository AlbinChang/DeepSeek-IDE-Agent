import * as os from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn, type ChildProcess } from 'child_process';
import { ProcessSafetyGuard } from '@/services/ProcessSafetyGuard.js';
import {
    PowerShellSessionManager,
    PowerShellSessionUnavailableError,
} from '@/services/PowerShellSessionManager.js';
import type { PowerShellSessionRunResult } from '@/services/PowerShellSessionManager.js';
import { GitService } from '@/services/GitService.js';
import { FileIO } from '@/utils/FileIO.js';

export interface CommandResult {
    stdout: string;
    stderr: string;
    status: 'success' | 'error';
    code: number | string | null;
}

interface FinalizedCommandOutput {
    fullStdout: string;
    fullStderr: string;
    stdoutFinal: string;
    stderrFinal: string;
    isTruncated: boolean;
}

/**
 * 命令输出疑似乱码时给出可执行的下一步建议。
 * 典型场景：PS 5.1 的 Get-Content 默认按 ANSI 读文件，混合 GBK/UTF-8 文档必然读错；
 * 或旧版 PowerShell 把 GBK 输出交给 UTF-8 解码。
 */
export function buildEncodingHint(command: string, stdout: string, stderr: string): string {
    const combined = `${stdout}\n${stderr}`;
    const looksGarbled = /\uFFFD|锟斤拷|ï¿½/.test(combined);
    const readsText = /\b(?:get-content|select-string|gc|type|cat)\b/i.test(command);
    // 只认真正的参数（前面是空白/引号），避免路径里的 "ds-encoding-test" 之类误判
    const missingEncoding = readsText && !/(?:^|[\s"'`])-Enc(?:oding)?\b/i.test(command);
    const hasNonAscii = /[^\x00-\x7F]/.test(combined);
    const hasQuestionRuns = /\?{3,}/.test(combined);

    if (looksGarbled) {
        const psHint = missingEncoding
            ? ' PowerShell 5.1 的 Get-Content 请显式 -Encoding Default（GBK）或 -Encoding UTF8。'
            : '';
        return `\n[编码提示] 输出疑似乱码：读文本文件优先 read_file（自动识别 GBK/UTF-8，可传 encoding 强制）。${psHint}`;
    }

    // 未显式 -Encoding 的文本读取：只给温和提示，不武断判定为乱码
    if (missingEncoding && (hasNonAscii || hasQuestionRuns)) {
        return '\n[编码提示] Get-Content 未指定 -Encoding；若中文异常，改用 read_file（自动识别 GBK/UTF-8，可传 encoding）或显式 -Encoding Default（GBK）或 -Encoding UTF8。';
    }
    return '';
}

/**
 * 解码命令输出字节流：
 * 1. 完整字节流交给 FileIO（严格 UTF-8 优先，GB18030/GBK 兜底）；
 * 2. 剥离 ANSI 颜色/控制序列；
 * 3. 过滤 JVM 因 JAVA_TOOL_OPTIONS 注入而打印的 "Picked up ..." 噪音。
 */
export function decodeCommandOutput(buffer: Buffer): string {
    return FileIO.decodeBuffer(buffer).content
        .replace(/\x1b\[[0-9;]*[mGKHFABCDJRsul]|\x1b\].*?\x07|\x1b[>=]/g, '')
        .replace(/^Picked up (?:JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS):.*(?:\r?\n|$)/gm, '');
}

export function terminatePosixCommandGroup(child: Pick<ChildProcess, 'pid' | 'kill'>, toolName: string): void {
    if (child.pid) {
        try {
            process.kill(-child.pid, 'SIGKILL');
            return;
        } catch (error) {
            console.warn(`[${toolName}] Failed to terminate command process group:`, error);
        }
    }
    child.kill('SIGKILL');
}

/**
 * 失败时给出可执行的下一步建议。
 *
 * 只覆盖日志里高频出现的五类失败（内联脚本被 shell 破坏、路径不存在、
 * 网络不可达、GUI/子进程超时、已有部分输出），最多两条，避免污染 stderr。
 */
export function buildFailureHints(command: string, stdout: string, stderr: string): string {
    const hints: string[] = [];
    const inlinePython = /\bpython(?:3|\.exe)?\s+-c\b/i.test(command);
    const syntaxLike = /SyntaxError|IndentationError|invalid syntax|unexpected token|Unexpected token|Missing '\(|Expressions are only allowed/i.test(stderr);
    if (inlinePython && syntaxLike) {
        hints.push('内联 python -c 在 PowerShell 下易被引号/花括号解析破坏：改用 write_file 落盘 .py 再执行。');
    } else if (syntaxLike) {
        hints.push('PowerShell 把 { } 当作脚本块：把 Python/JS 代码落盘成文件后执行，或改用单引号 here-string。');
    }
    if (/Cannot find path|ItemNotFound|No such file|cannot access|does not exist/i.test(stderr)) {
        hints.push('路径不存在：先用 Test-Path 守卫或 -ErrorAction SilentlyContinue，避免整条命令以 exit 1 结束。');
    }
    // 只有真正的网络类错误才提示「不可达/限流」。
    // 不能只匹配 timed out：本地子进程超时（如 Chrome 弹窗卡住）也会命中，
    // 会给出完全错误的「外部接口不可达」建议（2026-11-26 真实误判）。
    const networkLike = /Max retries exceeded|HTTPSConnectionPool|Connection(?:Error|Refused|Reset|Aborted)|ConnectTimeout|Name or service not known|getaddrinfo|SSLError|SSL: /i.test(stderr);
    const subprocessTimeoutLike = /TimeoutExpired|timed out after \d+\s*(?:ms|s|seconds|秒)|Command timed out|进程超时/i.test(stderr);
    if (networkLike) {
        hints.push('外部接口不可达或限流：加重试/退避并复用本地缓存，避免整批重跑。');
    } else if (subprocessTimeoutLike) {
        hints.push(
            '子进程超时：GUI 程序（Chrome/Edge 等）弹窗时不会自己退出，会一直等到超时；'
            + '改用 --headless 并把 --user-data-dir/--screenshot 写成绝对路径，失败时清理临时 profile。',
        );
    }
    if (!hints.length) return '';
    if (stdout.trim()) {
        hints.push('已产生部分输出：先检查 stdout 再决定是否整条重跑。');
    }
    return `\n[提示] ${hints.slice(0, 2).join(' ')}`;
}

// ============================================================================
// 破坏性命令识别（系统稳定性保护）
//
// 只在「语句起始位置 + 命令名」上判定，绝不扫描参数、注释、引号内的普通文本。
// 真实故障（2026-05/06 生产日志）：`git log --pretty=format:`、注释里的
// "check the format"、提交信息里的 "shutdown" 都被旧的全文关键词匹配误拦截。
// ============================================================================

interface CommandTokens {
    /** 小写命令名（已去掉目录与 .exe/.com 等后缀） */
    head: string;
    /** 命令参数（已去掉外层引号） */
    args: string[];
}

/** shell 语句分隔符：cmd / PowerShell / bash 通用 */
const STATEMENT_SEPARATORS = new Set([';', '&', '|', '\n', '\r']);

/** 出现在真正命令前的包装器：它们不改变后随命令的破坏性 */
const COMMAND_WRAPPERS = new Set([
    'sudo', 'doas', 'nohup', 'exec', 'command', 'env', 'time', 'start',
    'start-process', 'invoke-expression', 'xargs',
    'powershell', 'pwsh', 'cmd', 'bash', 'sh', 'zsh',
]);

/** 去掉目录、扩展名并转小写，得到可比较的命令名 */
function toCommandName(token: string): string {
    const base = token.replace(/^.*[\\/]/, '').toLowerCase();
    return base.replace(/\.(?:exe|com|bat|cmd|ps1|sh)$/, '');
}

/** 包装器里带值选项（如 sudo -u root）：跳过选项本身与它的值。
 *  注意不能加 i 标志：`-C` 是带值选项，而 `-c`（bash -c）后面跟的正是要检查的命令本身。 */
const WRAPPER_OPTIONS_WITH_VALUE = /^-(?:u|g|p|U|C|D|h|r|t|user|group|prompt|host|role|type)$/;

/** 去掉整体包裹的一对引号（`cmd /c "format D:"` 的内部命令需要按裸命令继续解析） */
function unquoteStatement(statement: string): string {
    const trimmed = statement.trim();
    if (trimmed.length >= 2) {
        const first = trimmed[0];
        const last = trimmed[trimmed.length - 1];
        if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
            return trimmed.slice(1, -1);
        }
    }
    return trimmed;
}

/** 剥离 sudo/env/cmd /c/powershell -Command 等包装器，返回真正执行的命令文本 */
function stripCommandWrappers(statement: string): string {
    let rest = statement.trim();
    for (;;) {
        const wrapper = rest.match(/^(\S+)\s+/);
        if (!wrapper || !COMMAND_WRAPPERS.has(toCommandName(wrapper[1]))) break;
        rest = rest.slice(wrapper[0].length).trim();
        // 跳过包装器自身的选项与 FOO=bar 赋值（如 cmd /c、sudo -E）
        for (;;) {
            const option = rest.match(/^(\S+)\s+/);
            if (!option) break;
            const token = option[1];
            const isAssignment = /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
            const isSwitch = /^-{1,2}/.test(token) || /^\/[A-Za-z]+$/.test(token);
            if (!isAssignment && !isSwitch) break;
            rest = rest.slice(option[0].length).trim();
            if (WRAPPER_OPTIONS_WITH_VALUE.test(token)) {
                const value = rest.match(/^\S+\s+/);
                if (value) rest = rest.slice(value[0].length).trim();
            }
        }
        // `cmd /c` 之后仍可能是另一层包装器（如 cmd /c powershell -Command ...）
    }
    return rest;
}

/** 按 shell 语句切分命令；引号内的分隔符不切分（避免提交信息里的 "a; b" 被当成两条命令） */
function splitShellStatements(command: string): string[] {
    const statements: string[] = [];
    let current = '';
    let quote: '"' | "'" | null = null;
    for (const ch of command) {
        if (quote) {
            current += ch;
            if (ch === quote) quote = null;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            current += ch;
            continue;
        }
        if (STATEMENT_SEPARATORS.has(ch)) {
            statements.push(current);
            current = '';
            continue;
        }
        current += ch;
    }
    statements.push(current);
    return statements;
}

/** 词法切分：保留引号内空格，去掉成对引号 */
function tokenizeCommand(text: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let hasToken = false;
    let quote: '"' | "'" | null = null;
    for (const ch of text) {
        if (quote) {
            if (ch === quote) quote = null;
            else current += ch;
            continue;
        }
        if (ch === '"' || ch === "'") {
            quote = ch;
            hasToken = true;
            continue;
        }
        if (/\s/.test(ch)) {
            if (hasToken) {
                tokens.push(current);
                current = '';
                hasToken = false;
            }
            continue;
        }
        current += ch;
        hasToken = true;
    }
    if (hasToken) tokens.push(current);
    return tokens;
}

function toCommandTokens(statement: string): CommandTokens | null {
    // 先去掉整条语句的外层引号（`"rm -rf /"`），再剥离包装器；
    // 包装器参数本身也常常是引号包裹的命令（`cmd /c "format D:"`），需要二次去引号。
    const inner = stripCommandWrappers(unquoteStatement(statement));
    const tokens = tokenizeCommand(unquoteStatement(inner));
    if (tokens.length === 0) return null;
    return { head: toCommandName(tokens[0]), args: tokens.slice(1) };
}

/** rm -r -f 且目标是绝对路径（`rm -rf ./build`、`rm -rf node_modules` 是正常清理） */
function isRecursiveForceRm(args: string[]): boolean {
    let recursive = false;
    let force = false;
    for (const arg of args) {
        if (arg === '--recursive') recursive = true;
        else if (arg === '--force') force = true;
        else if (/^-[a-z]+$/i.test(arg)) {
            if (/r/i.test(arg)) recursive = true;
            if (/f/i.test(arg)) force = true;
        }
    }
    return recursive && force && args.some(arg => arg.startsWith('/'));
}

const DESTRUCTIVE_COMMAND_RULES: Array<{ label: string; test: (tokens: CommandTokens) => boolean }> = [
    {
        label: 'rm -rf（递归强删绝对路径）',
        test: ({ head, args }) => head === 'rm' && isRecursiveForceRm(args),
    },
    {
        label: 'format（磁盘格式化）',
        test: ({ head, args }) => head === 'format'
            && (args.length === 0 || args.some(arg => /^[a-z]:/i.test(arg) || /^\/[a-z]/i.test(arg))),
    },
    {
        label: 'mkfs（文件系统格式化）',
        test: ({ head }) => /^mkfs(?:\.[a-z0-9]+)?$/.test(head) || head === 'mke2fs',
    },
    {
        label: 'dd if=（裸设备写入）',
        test: ({ head, args }) => head === 'dd' && args.some(arg => /^if=/i.test(arg)),
    },
    {
        label: 'shutdown / reboot（关机重启）',
        test: ({ head }) => ['shutdown', 'reboot', 'poweroff', 'halt'].includes(head),
    },
    {
        label: 'nc -e（远程命令执行）',
        test: ({ head, args }) => ['nc', 'ncat', 'netcat'].includes(head)
            && args.some(arg => /^--exec$/i.test(arg) || /^-[a-z]*e[a-z]*$/i.test(arg)),
    },
    {
        label: 'net user / net localgroup（系统账户操作）',
        test: ({ head, args }) => head === 'net' && ['user', 'localgroup'].includes((args[0] || '').toLowerCase()),
    },
    {
        label: 'reg add / reg delete（注册表写入）',
        test: ({ head, args }) => head === 'reg' && ['add', 'delete'].includes((args[0] || '').toLowerCase()),
    },
    {
        label: 'icacls / takeown / passwd（权限与凭据修改）',
        test: ({ head }) => ['icacls', 'takeown', 'passwd'].includes(head),
    },
];

/** 无法用「命令名 + 参数」表达的形态（fork bomb、重定向到裸设备等） */
const DESTRUCTIVE_COMMAND_PATTERNS: Array<{ label: string; pattern: RegExp }> = [
    { label: 'fork bomb', pattern: /:\s*\(\s*\)\s*\{[^}]*:\s*\|\s*:[^}]*\}/ },
    { label: '反弹 shell（/dev/tcp）', pattern: /\/dev\/(?:tcp|udp)\//i },
    {
        label: '直写设备文件（> /dev/xxx）',
        pattern: />{1,2}\s*\/dev\/(?!null\b|zero\b|full\b|random\b|urandom\b|stdout\b|stderr\b|tty\b|fd\/|pts\/)/i,
    },
];

/**
 * 识别破坏性命令，返回命中的规则名；未命中返回 null。
 * 只有位于语句起始位置（可带 sudo/env/嵌套 shell 前缀）的命令名才会参与匹配。
 */
export function findDestructiveCommand(command: string): string | null {
    const text = String(command ?? '');
    for (const rule of DESTRUCTIVE_COMMAND_PATTERNS) {
        if (rule.pattern.test(text)) return rule.label;
    }
    for (const statement of splitShellStatements(text)) {
        const tokens = toCommandTokens(statement);
        if (!tokens) continue;
        for (const rule of DESTRUCTIVE_COMMAND_RULES) {
            if (rule.test(tokens)) return rule.label;
        }
    }
    return null;
}

export class SystemTools {
    /** 命令输出持久化目录（相对于工作区根目录） */
    private static readonly COMMAND_OUTPUT_DIR = '.command';
    /** 单文件输出路径（每次命令执行覆盖写入） */
    private static readonly COMMAND_OUTPUT_FILE = 'output.txt';

    private static readonly SHELL_WRAPPER_PATTERNS = [
        /^(?:cmd|cmd\.exe)\s+\/[cCdDsS]/i,
        /^(?:powershell|powershell\.exe|pwsh)\s+-/i,
        /^(?:bash|sh|zsh)\s+-c\b/i,
    ];

    private static startsWithShellWrapper(command: string): boolean {
        const trimmed = String(command || '').trim();
        return this.SHELL_WRAPPER_PATTERNS.some((pattern) => pattern.test(trimmed));
    }

    /**
     * Windows: 决定注入 JAVA_TOOL_OPTIONS 的 -Dfile.encoding 值，
     * 保证 Maven 自身 JVM 与 fork 出的 javac 子进程使用同一编码。
     *
     * 注意：Maven 命令行 -Dfile.encoding=xxx 只影响 Maven 自身 JVM（最高优先级 for Maven），
     *       但 forked javac 子进程继承的是 JAVA_TOOL_OPTIONS，不是 Maven 的 -D 参数。
     *       因此必须将命令中指定的编码同步写入 JAVA_TOOL_OPTIONS，才能让 javac 也使用同一编码。
     *
     * 优先级（高→低）：
     *   1. 命令中显式 -Dfile.encoding=xxx（LLM 意图最明确）→ 同步注入 JAVA_TOOL_OPTIONS
     *   2. pom.xml 中声明的 <encoding>（项目级约定）→ 注入该编码
     *   3. 系统 JAVA_TOOL_OPTIONS 已含 -Dfile.encoding → 保留，不覆盖
     *   4. 有 pom.xml 但无显式 encoding → 不注入，保留系统默认（GBK 等）
     *   5. 非 Maven 项目 → 注入 UTF-8（安全默认）
     */
    private static buildJavaToolOptions(
        command: string,
        javaEncoding: string | null | undefined,
    ): string | undefined {
        const existing = process.env.JAVA_TOOL_OPTIONS || '';

        const cmdEncodingMatch = command.match(/-Dfile\.encoding=["']?([A-Za-z0-9_\-]+)["']?/);
        if (cmdEncodingMatch) {
            const cmdEnc = cmdEncodingMatch[1];
            const base = existing.replace(/-Dfile\.encoding=\S+/g, '').trim();
            return base ? `${base} -Dfile.encoding=${cmdEnc}` : `-Dfile.encoding=${cmdEnc}`;
        }

        if (existing.includes('-Dfile.encoding=')) return existing;

        if (typeof javaEncoding === 'string') {
            return existing ? `${existing} -Dfile.encoding=${javaEncoding}` : `-Dfile.encoding=${javaEncoding}`;
        }

        if (javaEncoding === null) {
            return existing || undefined;
        }

        return existing ? `${existing} -Dfile.encoding=UTF-8` : '-Dfile.encoding=UTF-8';
    }

    /** 构造本次命令需要覆盖的环境变量（一次性 spawn 与长驻会话共用）。 */
    private static buildCommandEnv(
        command: string,
        isWin: boolean,
        javaEncoding: string | null | undefined,
        extraEnv?: Record<string, string>,
    ): Record<string, string> {
        const env: Record<string, string> = {};
        // 不强制覆盖 NODE_ENV，尊重系统已有配置；未设置时默认 development。
        // 强制 production 会导致 vite/webpack 等构建工具启用压缩、禁用 HMR。
        if (!process.env.NODE_ENV) env.NODE_ENV = 'development';
        if (isWin) {
            const jto = this.buildJavaToolOptions(command, javaEncoding);
            if (jto !== undefined) env.JAVA_TOOL_OPTIONS = jto;
        } else {
            env.FORCE_COLOR = '1';
            env.TERM = 'xterm-256color';
        }
        return { ...env, ...(extraEnv || {}) };
    }

    /**
     * 将命令执行的完整输出持久化到工作区的 .command/output.txt
     * Agent 可通过 read_file 按需检索完整输出，避免长输出被截断丢失信息
     */
    private static async persistCommandOutput(
        workspaceRoot: string,
        command: string,
        shell: string,
        exitCode: number | string | null,
        durationMs: number,
        fullStdout: string,
        fullStderr: string,
        truncated: boolean,
        hardKilled: boolean
    ): Promise<string | null> {
        try {
            const dir = path.join(workspaceRoot, this.COMMAND_OUTPUT_DIR);
            await fs.mkdir(dir, { recursive: true });
            const filePath = path.join(dir, this.COMMAND_OUTPUT_FILE);

            const timestamp = new Date().toISOString();
            const durationSec = (durationMs / 1000).toFixed(2);
            const truncatedNote = truncated ? ' (LLM 上下文已截断，此文件包含完整输出)' : '';
            const hardKilledNote = hardKilled ? ' ⚠️ 输出超过 5MB 物理上限，进程已被强制终止' : '';

            const content = [
                `=== 命令执行输出${truncatedNote}${hardKilledNote} ===`,
                `时间: ${timestamp}`,
                `命令: ${command}`,
                `Shell: ${shell}`,
                `退出码: ${exitCode ?? 'N/A'}`,
                `耗时: ${durationSec}s`,
                `=== STDOUT ===`,
                fullStdout || '(无输出)',
                `=== STDERR ===`,
                fullStderr || '(无输出)',
                `=== END ===`,
            ].join('\n');

            await fs.writeFile(filePath, content, 'utf-8');
            return filePath;
        } catch (err) {
            console.error('[SystemTools] 持久化命令输出失败:', err);
            return null;
        }
    }

    /**
     * 对齐 3.2 节：获取当前环境变量、OS 类型及Agent助手工具链快照 (单例初始化时调用)
     */
    static async getEnvInfo() {
        // [New Fix]: 异步探测并收集环境快照 (Section 33.6)
        const gitVersionRaw = await GitService.getVersion();
        const gitAvailable = !!gitVersionRaw;
        const gitVersion = gitAvailable ? `git ${gitVersionRaw}` : 'Not Found';

        // 探测 shell 版本信息，让 LLM 精准感知运行时环境
        let shellVersion = 'unknown';
        let powershellAvailable = false;
        let powershellVersion = 'Not Found';
        let cmdAvailable = false;
        let cmdVersion = 'Not Found';
        let javaVersion = 'Not Found';
        try {
            const { execSync } = await import('child_process');
            if (process.platform === 'win32') {
                // 获取 PowerShell 版本（兼容 PS 5.1 和 PS 7+）
                const raw = execSync('powershell -NoProfile -NonInteractive -Command "$PSVersionTable.PSVersion.ToString()"', { timeout: 5000 }).toString().trim();
                shellVersion = `PowerShell ${raw}`;
                powershellAvailable = true;
                powershellVersion = raw;

                // 探测 cmd.exe 可用性
                const cmdRaw = execSync('cmd /d /s /c ver', { timeout: 5000 }).toString().trim();
                cmdAvailable = true;
                cmdVersion = cmdRaw.split('\n')[0]?.trim() || 'cmd';
            } else {
                const shellPath = process.env.SHELL || '/bin/bash';
                const raw = execSync(`${shellPath} --version 2>&1 | head -1`, { timeout: 5000 }).toString().trim();
                shellVersion = raw.split('\n')[0].trim();
            }
        } catch {}

        // 探测 JDK 版本（java -version 输出到 stderr，需重定向）
        try {
            const { execSync } = await import('child_process');
            // java -version 输出到 stderr，stdio: 'pipe' 可同时捕获
            const raw = execSync('java -version 2>&1', { timeout: 5000 }).toString().trim();
            // 取第一行，格式如：openjdk version "17.0.x" / java version "1.8.0_xxx"
            const firstLine = raw.split('\n')[0].trim();
            // 提取版本号字符串（引号内）
            const match = firstLine.match(/"([^"]+)"/);
            const versionStr = match ? match[1] : firstLine;
            // 检测 JAVA_HOME 辅助信息
            const javaHome = process.env.JAVA_HOME || '';
            javaVersion = javaHome ? `${versionStr} (JAVA_HOME: ${javaHome})` : versionStr;
        } catch {
            // java 未安装或不在 PATH 中
            javaVersion = process.env.JAVA_HOME ? `Not in PATH (JAVA_HOME: ${process.env.JAVA_HOME})` : 'Not Found';
        }

        const info: any = {
            os: process.platform,
            arch: process.arch,
            shell: shellVersion || (process.env.SHELL || (process.platform === 'win32' ? 'powershell' : 'bash')),
            nodeVersion: process.version,
            javaVersion,
            git: gitAvailable ? `Installed (${gitVersion})` : 'Not Found',
            gitAvailable,
            gitVersion,
            powershellAvailable,
            powershellVersion,
            cmdAvailable,
            cmdVersion,
            homeDir: os.homedir(),
            cpuCores: os.cpus().length,
            totalMemory: `${(os.totalmem() / 1024 / 1024 / 1024).toFixed(2)} GB`,
            env: {
                PATH: process.env.PATH || '', 
                USER: process.env.USER || process.env.USERNAME || 'unknown'
            },
            cwd: process.cwd()
        };

        return info;
    }

    /**
     * [run_powershell_command] 在 PowerShell 中执行命令 (流式同步版)
     * 跨平台：Windows 使用 powershell.exe，Linux/macOS 使用 pwsh
     * timeout 为必填参数，由调用方（LLM）明确指定；缺失或 <= 0 时直接报错，不提供默认值。
     */
    static async executePowerShellCommand(
        command: string,
        cwd: string,
        userId?: string,
        timeout?: number,
        javaEncoding?: string | null,
        workspaceRoot?: string,
        extraEnv?: Record<string, string>,
        abortSignal?: AbortSignal,
    ): Promise<CommandResult> {
        return this.executeCommandInternal(command, cwd, userId, timeout, javaEncoding, 'powershell', workspaceRoot, 'run_powershell_command', extraEnv, abortSignal);
    }

    /**
     * [run_cmd_command] 在 Windows CMD 中执行命令 (流式同步版)
     * 仅限 Windows 平台使用
     * timeout 为必填参数，由调用方（LLM）明确指定；缺失或 <= 0 时直接报错，不提供默认值。
     */
    static async executeCmdCommand(
        command: string,
        cwd: string,
        userId?: string,
        timeout?: number,
        javaEncoding?: string | null,
        workspaceRoot?: string,
        extraEnv?: Record<string, string>,
        abortSignal?: AbortSignal,
    ): Promise<CommandResult> {
        return this.executeCommandInternal(command, cwd, userId, timeout, javaEncoding, 'cmd', workspaceRoot, 'run_cmd_command', extraEnv, abortSignal);
    }

    /**
     * 内部实现：在指定 shell 中执行命令 (流式同步版)
     * 具备跨平台适配与自适应编码处理
     */
    private static async executeCommandInternal(
        command: string,
        cwd: string,
        userId: string | undefined,
        timeout: number | undefined,
        javaEncoding: string | null | undefined,
        shell: 'powershell' | 'cmd',
        workspaceRoot: string | undefined,
        toolName: string,
        extraEnv?: Record<string, string>,
        abortSignal?: AbortSignal,
    ): Promise<CommandResult> {
        if (!timeout || timeout <= 0) {
            throw new Error(`[${toolName}] timeout 为必填项且必须 > 0，请在调用时明确指定超时时间（ms），例如：简单命令 30000，构建/测试 120000~300000，依赖安装 600000`);
        }
        if (abortSignal?.aborted) throw new Error(`[${toolName}] 命令已被取消`);
        if (this.startsWithShellWrapper(command)) {
            throw new Error(`[${toolName}] command 中禁止再嵌套 shell 启动器（如 cmd /c、powershell -Command、bash -c）。本工具已指定了执行 shell，command 请直接写该 shell 的原生命令体。`);
        }
        const finalTimeout = timeout;

        // 1. 增强型稳定性校验 (5.0 & 17.0 节运行规范)
        //    只在语句起始位置识别命令名，不扫描参数/注释/引号内文本：
        //    旧实现用全文关键词匹配，导致 `git log --pretty=format:`、
        //    注释里的 "check the format" 等正常命令被误拦截。
        const destructiveRule = findDestructiveCommand(command);
        if (destructiveRule) {
            throw new Error(
                `[稳定性拦截] 检测到潜在的高风险破坏性命令（命中规则：${destructiveRule}），执行已被阻止。` +
                `请改用不会破坏系统或数据的方式；确需执行时由用户手动操作。`
            );
        }

        // [Agent 存活护航] 使用 ProcessSafetyGuard 统一拦截杀进程指令
        // 对齐 §5.0 / §17.0 运行规范 & main-agent.json 的 forbidden_operations
        // 功能包括：
        //   - 禁止按进程名批量杀进程（如 taskkill /IM node.exe）
        //   - 强制必须显式指定 PID
        //   - 检测目标 PID 是否绑定 Agent 核心端口（从三个 server_conf.json 读取）
        //   - 检测目标 PID 是否为系统关键服务进程
        //   - 跨平台支持：Windows (netstat/tasklist) + Linux/macOS (ss/lsof/proc)
        await ProcessSafetyGuard.getInstance().guard(command);
        if (abortSignal?.aborted) throw new Error(`[${toolName}] 命令已被取消`);

        // 长驻 PowerShell 会话：就绪后复用宿主进程；
        // 未就绪时当前命令走一次性 spawn（不承担冷启动成本），同时后台预热宿主。
        // 会话不可用返回 null，回退到下面的一次性 spawn（行为与旧实现一致）。
        if (shell === 'powershell' && PowerShellSessionManager.shouldUseSession(command)) {
            const sessionManager = PowerShellSessionManager.getInstance();
            if (sessionManager.isReady(userId)) {
                const sessionResult = await this.executePowerShellViaSession(
                    command,
                    cwd,
                    userId,
                    finalTimeout,
                    javaEncoding,
                    workspaceRoot,
                    extraEnv,
                    abortSignal,
                );
                if (sessionResult) return sessionResult;
            } else {
                void sessionManager.prewarm(userId).catch((error) => {
                    console.warn('[SystemTools] PowerShell session prewarm failed:', error);
                });
            }
        }

        return new Promise((resolve) => {
            const isWin = process.platform === 'win32';
            const requestedShell = String(shell).toLowerCase();

            // 2. 跨平台 Shell 适配
            // 命令文本原样透传；工具名已隐含 shell 选择，无需 LLM 再传 shell 参数。
            let selectedShell: string;
            let args: string[];
            if (requestedShell === 'cmd') {
                if (!isWin) {
                    resolve({
                        stdout: '',
                        stderr: `[${toolName}] CMD 仅支持 Windows 平台，当前平台: ${process.platform}`,
                        status: 'error',
                        code: -1,
                    });
                    return;
                }
                selectedShell = 'cmd.exe';
                args = ['/d', '/s', '/c', command];
            } else {
                // powershell
                if (isWin) {
                    selectedShell = 'powershell.exe';
                } else {
                    selectedShell = 'pwsh';
                }
                args = ['-NoProfile', '-NonInteractive', '-Command', command];
            }
            
            const child = spawn(selectedShell, args, {
                cwd,
                // A separate POSIX process group lets cancellation stop the shell and its descendants.
                detached: !isWin,
                env: {
                    ...process.env,
                    ...this.buildCommandEnv(command, isWin, javaEncoding, extraEnv),
                }
            });

            // [2026.08 优化] 将 command 工具启动的 shell 进程登记为「可杀进程」。
            // 这些 shell 是 Agent Server 的直接子进程，若不加登记会被 ProcessSafetyGuard 当作
            // 「Agent 核心子进程」拦截，导致 Agent 无法终止自己通过 run_powershell_command /
            // run_cmd_command 启动的进程（如后台服务、遗留构建任务）。登记后 Agent 可按 PID 正常杀死。
            if (child.pid) {
                ProcessSafetyGuard.getInstance().registerCommandChild(child.pid);
            }

            // Windows: taskkill /F /T 杀整棵进程树（child.kill() 只杀顶层 PS 壳，npm/node 子进程会残留占用端口和 CPU）
            const killProc = () => {
                if (isWin && child.pid) {
                    try {
                        const killer = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)],
                            { stdio: 'ignore', detached: true });
                        killer.on('error', (error) => {
                            console.warn(`[${toolName}] Failed to terminate command process tree:`, error);
                            child.kill();
                        });
                        killer.unref();
                    } catch (error) {
                        console.warn(`[${toolName}] Failed to start process tree termination:`, error);
                        child.kill();
                    }
                } else {
                    terminatePosixCommandGroup(child, toolName);
                }
            };

            // 强制关闭进程 Standard Input，防止某些命令进入交互模式等待输入 (Wait For Stdin - 对齐 33.1 节)
            if (child.stdin) {
                child.stdin.end();
            }

            const stdoutChunks: Buffer[] = [];
            const stderrChunks: Buffer[] = [];
            let totalLength = 0;

            /**
             * 系统稳定性保护 - 极力防止大数据量冲垮 TCP 链接
             * 对齐 3.2 节 & 41.1：工具输出强力截断逻辑
             * 
             * 阈值说明：
             * - 2.5KB: 返回给大模型推理的内容上限，防止上下文爆炸及链路积压。
             * - PROCESS_HARD_LIMIT (5MB): 允许子进程生存的输出上限，防止恶意输出或死循环。
             * - FULL_OUTPUT_FILE_LIMIT (10MB): 持久化到 .command/output.txt 的完整输出上限。
             */
            const PROCESS_HARD_LIMIT = 5 * 1024 * 1024; // 5MB 物理熔断红线
            const FULL_OUTPUT_FILE_LIMIT = 10 * 1024 * 1024; // 10MB 文件持久化上限
            
            let isHardKilled = false; // OOM 熔断标志，供 close 事件附加错误提示

            // 完整输出缓冲区（不截断），用于持久化到 .command/output.txt
            // Agent 可通过 read_file 按需检索，避免长输出被截断损失信息
            let fullTotalLength = 0;
            const commandStartTime = Date.now();

            // 统一 cleanup：无论哪条路径 resolve，都需要清除所有 timer
            let resolved = false;
            let aborted = false;
            let timer: NodeJS.Timeout | null = null;
            const onAbort = () => {
                if (resolved || aborted) return;
                aborted = true;
                killProc();
            };
            const cleanup = () => {
                if (timer) clearTimeout(timer);
                abortSignal?.removeEventListener('abort', onAbort);
            };
            if (abortSignal) {
                if (abortSignal.aborted) onAbort();
                else abortSignal.addEventListener('abort', onAbort, { once: true });
            }

            const onData = (data: Buffer, pipeType: 'stdout' | 'stderr') => {
                totalLength += data.length;

                // 保留原始字节：流式 chunk 可能把多字节字符截成两半，
                // 且 PowerShell 5.1 / CMD 在中文 Windows 上可能输出 GBK 而非 UTF-8，
                // 必须在完整字节流上做编码识别，不能逐块 data.toString('utf8')。
                if (fullTotalLength < FULL_OUTPUT_FILE_LIMIT) {
                    fullTotalLength += data.length;
                    if (pipeType === 'stdout') {
                        stdoutChunks.push(data);
                    } else {
                        stderrChunks.push(data);
                    }
                }

                // 极速熔断：防止恶意/坏死进程无限输出冲毁内存 (OOM 保护)
                if (totalLength > PROCESS_HARD_LIMIT) {
                    if (!child.killed) {
                        isHardKilled = true;
                        killProc();
                        console.error(`[SystemTools] Hard limit (5MB) reached for command execution. Process killed.`);
                    }
                }
            };

            child.stdout.on('data', (d) => onData(d, 'stdout'));
            child.stderr.on('data', (d) => onData(d, 'stderr'));

            const finalizeOutput = (): FinalizedCommandOutput =>
                this.finalizeBuffers(stdoutChunks, stderrChunks);

            /**
             * 在命令执行完毕后，将完整输出写入 .command/output.txt 供 Agent 按需检索
             */
            const persistAndResolve = async (
                exitCode: number | string | null,
                status: 'success' | 'error',
                extraStderr: string,
                output: FinalizedCommandOutput,
            ) => {
                const result = await this.buildCommandResult({
                    command,
                    shell,
                    exitCode,
                    status,
                    extraStderr,
                    workspaceRoot,
                    output,
                    hardKilled: isHardKilled,
                    durationMs: Date.now() - commandStartTime,
                });
                resolve(result);
            };

            timer = setTimeout(() => {
                if (resolved) return;
                resolved = true;
                cleanup();
                killProc();
                // 超时路径：进程已被强杀，注销可杀登记
                ProcessSafetyGuard.getInstance().unregisterCommandChild(child.pid ?? -1);
                // 超时路径：异步持久化后再 resolve
                const exitCode = 'SIGTERM';
                const output = finalizeOutput();
                void persistAndResolve(
                    exitCode,
                    'error',
                    `\n[Error] Command timed out after ${finalTimeout}ms`,
                    output,
                );
            }, finalTimeout);

            child.on('close', (code) => {
                if (resolved) return; // 已由 stall/timeout 路径处理，避免双 resolve
                resolved = true;
                cleanup();
                // 进程已退出，注销可杀登记
                ProcessSafetyGuard.getInstance().unregisterCommandChild(child.pid ?? -1);
                
                // OOM 熔断时补充大模型可读的错误提示
                const extraStderr = isHardKilled
                    ? '\n[错误] 命令输出超过 5MB 物理上限，进程已被强制终止。请优化命令减少输出量（如加 --silent / -q 参数）。'
                    : (aborted ? '\n[错误] 命令已被取消' : '');

                const status = code === 0 && !aborted ? 'success' as const : 'error' as const;

                // 对最后一份数据做微小延迟确保 onData 队列清空，然后持久化并 resolve
                setTimeout(async () => {
                    const output = finalizeOutput();
                    await persistAndResolve(code, status, extraStderr, output);
                }, 10);
            });

            child.on('error', (err) => {
                if (resolved) return;
                resolved = true;
                cleanup();
                // spawn 失败（如 shell 不存在），注销可杀登记
                ProcessSafetyGuard.getInstance().unregisterCommandChild(child.pid ?? -1);
                // spawn 失败（如 shell 不存在），无需持久化
                const output = finalizeOutput();
                resolve({
                    stdout: output.stdoutFinal,
                    stderr: err.message,
                    status: 'error',
                    code: -1
                });
            });
        });
    }

    /** 完整字节流解码 + 截断（一次性 spawn 与长驻会话共用）。 */
    private static finalizeBuffers(stdoutChunks: Buffer[], stderrChunks: Buffer[]): FinalizedCommandOutput {
        const LLM_MAX_OUTPUT = 2560;
        const fullStdout = stdoutChunks.length ? decodeCommandOutput(Buffer.concat(stdoutChunks)) : '';
        const fullStderr = stderrChunks.length ? decodeCommandOutput(Buffer.concat(stderrChunks)) : '';

        // stdout 采用滚动尾部窗口：构建结果/测试报告/错误堆栈总在末尾，保留尾部才有意义
        let stdoutFinal = fullStdout;
        let isTruncated = false;
        if (stdoutFinal.length > LLM_MAX_OUTPUT * 2) {
            stdoutFinal = stdoutFinal.slice(stdoutFinal.length - LLM_MAX_OUTPUT);
            isTruncated = true;
        }

        let stderrFinal = fullStderr;
        if (stderrFinal.length > LLM_MAX_OUTPUT) {
            stderrFinal = stderrFinal.substring(0, LLM_MAX_OUTPUT) + '\n[stderr截断]';
        }

        return { fullStdout, fullStderr, stdoutFinal, stderrFinal, isTruncated };
    }

    /**
     * 统一组装最终结果：编码提示、失败提示、完整输出持久化到 .command/output.txt。
     */
    private static async buildCommandResult(params: {
        command: string;
        shell: 'powershell' | 'cmd';
        exitCode: number | string | null;
        status: 'success' | 'error';
        extraStderr: string;
        workspaceRoot: string | undefined;
        output: FinalizedCommandOutput;
        hardKilled: boolean;
        durationMs: number;
    }): Promise<CommandResult> {
        const {
            command, shell, exitCode, status, extraStderr,
            workspaceRoot, output, hardKilled, durationMs,
        } = params;

        const encodingHint = buildEncodingHint(
            command,
            output.stdoutFinal,
            output.stderrFinal + extraStderr,
        );
        const hint = status === 'error'
            ? buildFailureHints(command, output.stdoutFinal, output.stderrFinal + extraStderr)
            : '';
        const resultStderr = output.stderrFinal + extraStderr + encodingHint + hint;

        let outputFilePath: string | null = null;
        if (workspaceRoot) {
            outputFilePath = await this.persistCommandOutput(
                workspaceRoot, command, shell, exitCode, durationMs,
                output.fullStdout, output.fullStderr, output.isTruncated, hardKilled,
            );
        }

        // 仅当输出被截断或熔断时才追加简短提示，避免每次命令执行都浪费 ~150 字符
        // 完整输出始终持久化到 .command/output.txt（已在系统提示词中说明）
        const fileHint = (outputFilePath && (output.isTruncated || hardKilled))
            ? `\n[截断，完整日志: ${this.COMMAND_OUTPUT_DIR}/${this.COMMAND_OUTPUT_FILE}]`
            : '';

        return {
            stdout: (output.isTruncated ? '[截断，仅保留尾部]\n' : '') + output.stdoutFinal + fileHint,
            stderr: resultStderr,
            status,
            code: exitCode,
        };
    }

    /**
     * 走长驻 PowerShell 会话执行；会话未启动成功时返回 null，由调用方回退一次性 spawn。
     */
    private static async executePowerShellViaSession(
        command: string,
        cwd: string,
        userId: string | undefined,
        timeout: number,
        javaEncoding: string | null | undefined,
        workspaceRoot: string | undefined,
        extraEnv: Record<string, string> | undefined,
        abortSignal: AbortSignal | undefined,
    ): Promise<CommandResult | null> {
        let sessionResult: PowerShellSessionRunResult;
        try {
            sessionResult = await PowerShellSessionManager.getInstance().run(userId, {
                command,
                cwd,
                timeout,
                extraEnv: this.buildCommandEnv(command, process.platform === 'win32', javaEncoding, extraEnv),
                abortSignal,
            });
        } catch (error) {
            const unavailable = error instanceof PowerShellSessionUnavailableError
                || (error as { name?: string } | null)?.name === 'PowerShellSessionUnavailableError';
            if (unavailable) {
                console.warn(
                    '[SystemTools] PowerShell long-lived session unavailable, falling back to one-shot spawn:',
                    (error as Error)?.message || error,
                );
                return null;
            }
            throw error;
        }

        const output = this.finalizeBuffers([sessionResult.stdout], [sessionResult.stderr]);
        const extraStderr = sessionResult.timedOut
            ? `\n[Error] Command timed out after ${timeout}ms`
            : sessionResult.hardKilled
                ? '\n[错误] 命令输出超过 5MB 物理上限，进程已被强制终止。请优化命令减少输出量（如加 --silent / -q 参数）。'
                : sessionResult.aborted
                    ? '\n[错误] 命令已被取消'
                    : sessionResult.hostError
                        ? `\n[错误] ${sessionResult.hostError}`
                        : '';
        const status = (sessionResult.timedOut || sessionResult.aborted || sessionResult.hardKilled || sessionResult.hostError)
            ? 'error'
            : sessionResult.status;

        return this.buildCommandResult({
            command,
            shell: 'powershell',
            exitCode: sessionResult.code,
            status,
            extraStderr,
            workspaceRoot,
            output,
            hardKilled: sessionResult.hardKilled,
            durationMs: sessionResult.durationMs,
        });
    }
}

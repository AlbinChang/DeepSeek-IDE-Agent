import * as os from 'os';
import * as fs from 'fs/promises';
import * as path from 'path';
import { spawn } from 'child_process';
import { EventDistributor } from '@/services/EventDistributor.js';
import { GitService } from '@/services/GitService.js';
import { ProcessSafetyGuard } from '@/services/ProcessSafetyGuard.js';

export interface CommandResult {
    stdout: string;
    stderr: string;
    status: 'success' | 'error';
    code: number | string | null;
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
     * 系统稳定性保护 (System Stability Protection)
     * 对齐 5.0 & 17.0 节运行规范：仅保留物理破坏性指令
     */
    public static readonly PROTECTED_COMMANDS = [
        'rm -rf /', 'format ', ':(){ :|:& };:', 
        'mkfs', 'dd if=', 'shutdown', 'reboot',
        '> /dev/', 'nc -e', 'bash -i >&',
        // Windows 物理破坏指令（del /s / rd /s 是常见开发清理命令，不在此列）
        'net user', 'net localgroup',
        'reg add', 'reg delete', 'icacls', 'takeown',
        // 防内核破坏 (保留最低限度的物理安全)
        'passwd ', 'rm -rf /etc', 'rm -rf /var'
    ];

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
        workspaceRoot?: string
    ): Promise<CommandResult> {
        return this.executeCommandInternal(command, cwd, userId, timeout, javaEncoding, 'powershell', workspaceRoot, 'run_powershell_command');
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
        workspaceRoot?: string
    ): Promise<CommandResult> {
        return this.executeCommandInternal(command, cwd, userId, timeout, javaEncoding, 'cmd', workspaceRoot, 'run_cmd_command');
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
        toolName: string
    ): Promise<CommandResult> {
        if (!timeout || timeout <= 0) {
            throw new Error(`[${toolName}] timeout 为必填项且必须 > 0，请在调用时明确指定超时时间（ms），例如：简单命令 30000，构建/测试 120000~300000，依赖安装 600000`);
        }
        if (this.startsWithShellWrapper(command)) {
            throw new Error(`[${toolName}] command 中禁止再嵌套 shell 启动器（如 cmd /c、powershell -Command、bash -c）。本工具已指定了执行 shell，command 请直接写该 shell 的原生命令体。`);
        }
        const finalTimeout = timeout;

        // 1. 增强型稳定性校验 (5.0 & 17.0 节运行规范)
        // 对齐 Section 17.0：增强型匹配逻辑，避免误伤参数（如 PowerShell 的 -Format）
        const isForbidden = this.PROTECTED_COMMANDS.some(b => {
            const lowerCmd = command.toLowerCase();
            const lowerB = b.toLowerCase().trim(); // 去掉末尾空格进行更精确的边界探测
            const startIdx = lowerCmd.indexOf(lowerB);
            if (startIdx === -1) return false;

            // 检查关键词前后边界，确保它是一个独立的 token 而非参数的一部分
            const charBefore = startIdx > 0 ? lowerCmd[startIdx - 1] : '';
            const charAfter = startIdx + lowerB.length < lowerCmd.length ? lowerCmd[startIdx + lowerB.length] : '';

            // 如果前一个字符是字母、数字或连字符，判定为参数（如 -format）或大单词的一部分
            if (charBefore && /[a-zA-Z0-9\-]/.test(charBefore)) return false;
            
            // 如果是 format 关键词，后面如果是冒号 (D:) 也算命中
            if (lowerB === 'format') {
                return (charAfter === '' || /[\s\:\/]/.test(charAfter));
            }
            
            return true;
        });

        if (isForbidden) {
            // 对齐 15.0 节：本地化稳定性提示
            throw new Error(`[稳定性拦截] 检测到潜在的高风险物理损坏命令，执行已被阻止。相关关键词处于保护名单内。`);
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

        // 1.5 指令回显 (对齐 Terminal.md Section 4.0)
        if (userId) {
            const echoMsg = `\r\n\x1b[38;5;28m❯\x1b[0m \x1b[38;5;250mEXEC:\x1b[0m \x1b[38;5;244m${command}\x1b[0m\r\n`;
            EventDistributor.broadcast('terminal:data', echoMsg, (client) => {
                return client.userId === userId && (!workspaceRoot || client.workspaceRoot === workspaceRoot);
            });
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
            
            // Windows: 按优先级决定注入 JAVA_TOOL_OPTIONS 的 -Dfile.encoding 值，
            // 保证 Maven 自身 JVM 与 fork 出的 javac 子进程使用同一编码。
            //
            // 注意：Maven 命令行 -Dfile.encoding=xxx 只影响 Maven 自身 JVM（最高优先级 for Maven），
            //       但 forked javac 子进程继承的是 JAVA_TOOL_OPTIONS，不是 Maven 的 -D 参数。
            //       因此必须将命令中指定的编码同步写入 JAVA_TOOL_OPTIONS，才能让 javac 也使用同一编码。
            //
            // 优先级（高→低）：
            //   1. 命令中显式 -Dfile.encoding=xxx（LLM 意图最明确）→ 同步注入 JAVA_TOOL_OPTIONS
            //   2. pom.xml 中声明的 <encoding>（项目级约定）→ 注入该编码
            //   3. 系统 JAVA_TOOL_OPTIONS 已含 -Dfile.encoding → 保留，不覆盖
            //   4. 有 pom.xml 但无显式 encoding → 不注入，保留系统默认（GBK 等）
            //   5. 非 Maven 项目 → 注入 UTF-8（安全默认）
            const buildJavaToolOptions = (): string | undefined => {
                const existing = process.env.JAVA_TOOL_OPTIONS || '';

                // 优先级 1：扫描命令字符串中的 -Dfile.encoding=xxx（含引号包裹形式）
                const cmdEncodingMatch = command.match(/-Dfile\.encoding=["']?([A-Za-z0-9_\-]+)["']?/);
                if (cmdEncodingMatch) {
                    const cmdEnc = cmdEncodingMatch[1];
                    // 将命令中指定的编码同步注入 JAVA_TOOL_OPTIONS，
                    // 让 forked javac 也使用相同编码，而不是系统默认
                    const base = existing.replace(/-Dfile\.encoding=\S+/g, '').trim();
                    return base ? `${base} -Dfile.encoding=${cmdEnc}` : `-Dfile.encoding=${cmdEnc}`;
                }

                // 优先级 3：系统 JAVA_TOOL_OPTIONS 已设置，不覆盖
                if (existing.includes('-Dfile.encoding=')) return existing;

                // 优先级 2：pom.xml 中有显式 encoding 声明
                if (typeof javaEncoding === 'string') {
                    return existing ? `${existing} -Dfile.encoding=${javaEncoding}` : `-Dfile.encoding=${javaEncoding}`;
                }

                // 优先级 4：有 pom.xml 但无显式 encoding（javaEncoding === null）→ 不注入
                if (javaEncoding === null) {
                    return existing || undefined;
                }

                // 优先级 5：非 Maven 项目（javaEncoding === undefined）→ 默认 UTF-8
                return existing ? `${existing} -Dfile.encoding=UTF-8` : '-Dfile.encoding=UTF-8';
            };

            const child = spawn(selectedShell, args, {
                cwd,
                env: { 
                    ...process.env, 
                    // 不强制覆盖 NODE_ENV，尊重系统已有配置；未设置时默认 development
                    // 强制 production 会导致 vite/webpack 等构建工具启用压缩、禁用 HMR
                    ...(process.env.NODE_ENV ? {} : { NODE_ENV: 'development' }),
                    // Windows: JAVA_TOOL_OPTIONS 注入 UTF-8，Linux/macOS: 注入颜色支持
                    ...(isWin
                        ? (() => {
                            const jto = buildJavaToolOptions();
                            return jto !== undefined ? { JAVA_TOOL_OPTIONS: jto } : {};
                          })()
                        : { FORCE_COLOR: '1', TERM: 'xterm-256color' }
                    )
                }
            });

            // Windows: taskkill /F /T 杀整棵进程树（child.kill() 只杀顶层 PS 壳，npm/node 子进程会残留占用端口和 CPU）
            const killProc = () => {
                if (isWin && child.pid) {
                    try {
                        spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)],
                            { stdio: 'ignore', detached: true }).unref();
                    } catch {}
                } else {
                    child.kill();
                }
            };

            // [2026.03] 修复 (SSE 实时心跳策略)：针对长时任务，每 10s 发送一个 stage 信号，防止网关/代理超时逻辑杀死请求
            const startTime = Date.now();
            let heartbeatTimer: NodeJS.Timeout | null = null;
            if (userId) {
                heartbeatTimer = setInterval(() => {
                    const elapsed = Math.floor((Date.now() - startTime) / 1000);
                    EventDistributor.broadcast('chat:stream', { 
                        type: 'stage', 
                        workspaceRoot,
                        content: `命令运行中 (${elapsed}s): ${command.substring(0, 30)}${command.length > 30 ? '...' : ''}` 
                    }, (client) => {
                        return client.userId === userId && (!workspaceRoot || client.workspaceRoot === workspaceRoot);
                    });
                }, 10000);
            }

            // 强制关闭进程 Standard Input，防止某些命令进入交互模式等待输入 (Wait For Stdin - 对齐 33.1 节)
            if (child.stdin) {
                child.stdin.end();
            }

            let stdout = '';
            let stderr = '';
            let totalLength = 0;

            /**
             * 系统稳定性保护 - 极力防止大数据量冲垮 TCP 链接
             * 对齐 3.2 节 & 41.1：工具输出强力截断逻辑
             * 
             * 阈值说明：
             * - LLM_MAX_OUTPUT (2.5KB): 返回给大模型推理的内容上限，防止上下文爆炸及链路积压。
             * - PROCESS_HARD_LIMIT (5MB): 允许子进程生存的输出上限，防止恶意输出或死循环。
             * - FULL_OUTPUT_FILE_LIMIT (10MB): 持久化到 .command/output.txt 的完整输出上限。
             */
            const LLM_MAX_OUTPUT = 2560; // 2.5KB 强力截断点
            const PROCESS_HARD_LIMIT = 5 * 1024 * 1024; // 5MB 物理熔断红线
            const FULL_OUTPUT_FILE_LIMIT = 10 * 1024 * 1024; // 10MB 文件持久化上限
            
            let isTruncated = false;
            let isHardKilled = false; // OOM 熔断标志，供 close 事件附加错误提示

            // 完整输出缓冲区（不截断），用于持久化到 .command/output.txt
            // Agent 可通过 read_file 按需检索，避免长输出被截断损失信息
            let fullStdout = '';
            let fullStderr = '';
            let fullTotalLength = 0;
            const commandStartTime = Date.now();

            // 统一 cleanup：无论哪条路径 resolve，都需要清除所有 timer
            let resolved = false;
            let timer: NodeJS.Timeout | null = null;
            const cleanup = () => {
                if (timer)          clearTimeout(timer);
                if (heartbeatTimer) clearInterval(heartbeatTimer);
            };

            const onData = (data: Buffer, pipeType: 'stdout' | 'stderr') => {
                
                // ANSI 剥离：防止颜色转义码污染 LLM 推理（如 npm 颜色输出、git 颜色 diff 等）
                // 同时过滤 JVM 因 JAVA_TOOL_OPTIONS 注入而打印的 "Picked up ..." 提示行（属于 JVM 噪音）
                const chunk = data.toString('utf8')
                    .replace(/\x1b\[[0-9;]*[mGKHFABCDJRsul]|\x1b\].*?\x07|\x1b[>=]/g, '')
                    .replace(/^Picked up (?:JAVA_TOOL_OPTIONS|_JAVA_OPTIONS|JDK_JAVA_OPTIONS):.*(?:\r?\n|$)/gm, '');
                totalLength += data.length;

                // [DECOUPLING OPTIMIZATION] Agent 终端数据不再广播至前端 PTY 区域。
                // 仅保留逻辑层缓冲区供 LLM 使用和链路追踪记录。

                // 1. 完整输出缓冲区（用于文件持久化，不做 LLM 截断）
                if (fullTotalLength < FULL_OUTPUT_FILE_LIMIT) {
                    fullTotalLength += data.length;
                    if (pipeType === 'stdout') {
                        fullStdout += chunk;
                    } else {
                        fullStderr += chunk;
                    }
                }

                // 2. 逻辑层缓冲区 (用于返回给 LLM 或后续处理)
                // stdout 采用滚动尾部窗口：构建结果/测试报告/错误堆栈总在末尾，保留尾部才有意义
                // stderr 独立截断，不受 stdout isTruncated 影响
                if (pipeType === 'stdout') {
                    stdout += chunk;
                    // 滚动窗口：超过 2× 上限时丢弃头部，保留最近 LLM_MAX_OUTPUT 字节
                    if (stdout.length > LLM_MAX_OUTPUT * 2) {
                        stdout = stdout.substring(stdout.length - LLM_MAX_OUTPUT);
                        isTruncated = true;
                    }
                } else {
                    // stderr 独立截断，不受 stdout isTruncated 影响
                    if (stderr.length < LLM_MAX_OUTPUT) {
                        stderr += chunk;
                    } else if (!stderr.includes('[stderr截断]')) {
                        stderr = stderr.substring(0, LLM_MAX_OUTPUT) + '\n[stderr截断]';
                    }
                }

                // 3. 极速熔断：防止恶意/坏死进程无限输出冲毁内存 (OOM 保护)
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

            /**
             * 在命令执行完毕后，将完整输出写入 .command/output.txt 供 Agent 按需检索
             */
            const persistAndResolve = async (
                exitCode: number | string | null,
                status: 'success' | 'error',
                extraStderr: string,
                outputFilePath: string | null
            ) => {
                const stdoutFinal = isTruncated ? '[截断，仅保留尾部]\n' + stdout : stdout;
                const resultStderr = stderr + extraStderr;

                // 仅当输出被截断或熔断时才追加简短提示，避免每次命令执行都浪费 ~150 字符
                // 完整输出始终持久化到 .command/output.txt（已在系统提示词中说明）
                const fileHint = (outputFilePath && (isTruncated || isHardKilled))
                    ? `\n[截断，完整日志: ${this.COMMAND_OUTPUT_DIR}/${this.COMMAND_OUTPUT_FILE}]`
                    : '';

                resolve({
                    stdout: stdoutFinal + fileHint,
                    stderr: resultStderr,
                    status,
                    code: exitCode
                });
            };

            timer = setTimeout(() => {
                if (resolved) return;
                resolved = true;
                cleanup();
                killProc();
                // 超时路径：异步持久化后再 resolve
                const exitCode = 'SIGTERM';
                const duration = Date.now() - commandStartTime;
                if (workspaceRoot) {
                    this.persistCommandOutput(
                        workspaceRoot, command, shell, exitCode, duration,
                        fullStdout, fullStderr, isTruncated, isHardKilled
                    ).then((filePath) => {
                        persistAndResolve(exitCode, 'error',
                            `\n[Error] Command timed out after ${finalTimeout}ms`, filePath);
                    });
                } else {
                    persistAndResolve(exitCode, 'error',
                        `\n[Error] Command timed out after ${finalTimeout}ms`, null);
                }
            }, finalTimeout);

            child.on('close', (code) => {
                if (resolved) return; // 已由 stall/timeout 路径处理，避免双 resolve
                resolved = true;
                cleanup();
                
                // OOM 熔断时补充大模型可读的错误提示
                const extraStderr = isHardKilled
                    ? '\n[错误] 命令输出超过 5MB 物理上限，进程已被强制终止。请优化命令减少输出量（如加 --silent / -q 参数）。'
                    : '';

                const status = code === 0 ? 'success' as const : 'error' as const;
                const duration = Date.now() - commandStartTime;

                // 对最后一份数据做微小延迟确保 onData 队列清空，然后持久化并 resolve
                setTimeout(async () => {
                    let filePath: string | null = null;
                    if (workspaceRoot) {
                        filePath = await this.persistCommandOutput(
                            workspaceRoot, command, shell, code, duration,
                            fullStdout, fullStderr, isTruncated, isHardKilled
                        );
                    }
                    await persistAndResolve(code, status, extraStderr, filePath);
                }, 10);
            });

            child.on('error', (err) => {
                if (resolved) return;
                resolved = true;
                cleanup();
                // spawn 失败（如 shell 不存在），无需持久化
                resolve({
                    stdout: stdout,
                    stderr: err.message,
                    status: 'error',
                    code: -1
                });
            });
        });
    }
}


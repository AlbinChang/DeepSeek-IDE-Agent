import { spawn, type ChildProcess } from 'child_process';
import { randomBytes } from 'crypto';
import { ProcessSafetyGuard } from '@/services/ProcessSafetyGuard.js';

/**
 * 长驻 PowerShell 宿主进程。
 *
 * 背景：run_powershell_command 是使用频率最高的工具，旧实现每条命令都
 * spawn/销毁一个 powershell.exe（含 -NoProfile 冷启动 300~800ms）。
 * 这里改为「一个用户一个长驻宿主进程 + 每条命令独立 Runspace」：
 *  - 宿主进程复用，省掉冷启动与进程创建/销毁开销；
 *  - 每条命令新建 Runspace，变量/函数不跨命令泄漏，`exit` 也不会带走宿主
 *    （含 exit 的命令走一次性 spawn 回退，保证退出码语义不变）；
 *  - cwd、注入的环境变量逐命令设置并在结束后恢复。
 *
 * 安全边界：
 *  - 输出超过 5MB 熔断并重启宿主；
 *  - 超时/取消时终止宿主进程树（会连同该会话此前拉起的后台子进程一起结束）；
 *  - 空闲释放只杀宿主本身，不误伤命令用 Start-Process 拉起的后台服务。
 */

export interface PowerShellSessionRunOptions {
    command: string;
    cwd: string;
    timeout: number;
    extraEnv?: Record<string, string>;
    abortSignal?: AbortSignal;
}

export interface PowerShellSessionRunResult {
    stdout: Buffer;
    stderr: Buffer;
    code: number | string | null;
    status: 'success' | 'error';
    timedOut: boolean;
    aborted: boolean;
    hardKilled: boolean;
    durationMs: number;
    hostError?: string;
}

/** 会话未成功启动（此时调用方应回退到一次性 spawn，命令尚未执行过）。 */
export class PowerShellSessionUnavailableError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PowerShellSessionUnavailableError';
    }
}

const READY_PREFIX = '<<<AGENT_PS_READY:';
const BEGIN_PREFIX = '<<<AGENT_PS_BEGIN:';
const END_PREFIX = '<<<AGENT_PS_END:';
const ERR_DATA_PREFIX = '<<<AGENT_PS_E64:';

const STARTUP_TIMEOUT_MS = 20_000;
const HARD_OUTPUT_LIMIT = 5 * 1024 * 1024;
const MAX_SESSIONS = 4;
const DEFAULT_IDLE_MS = 10 * 60 * 1000;
const MIN_IDLE_MS = 30_000;

/** 供统计/测试观察：长驻宿主进程真实启动次数。 */
let hostStartCount = 0;

/**
 * 含 exit 语句或引用 .ps1 脚本的命令回退到一次性 spawn：
 * - Runspace 内 exit 不会落回退出码（且可能终止宿主进程）；
 * - .ps1 脚本内部可能 exit，同样无法从 Runspace 取回退出码。
 * 这两类命令占比低，回退后语义与旧实现完全一致。
 */
const EXIT_STATEMENT_PATTERN = /(?:^|[;\r\n{}])\s*exit(?=\s|\(|$)/i;
const PS1_REFERENCE_PATTERN = /\.ps1\b/i;

function makeNonce(): string {
    return randomBytes(8).toString('hex');
}

function makeCommandId(): string {
    return randomBytes(6).toString('hex');
}

function readIdleMs(): number {
    const raw = Number(process.env.AGENT_POWERSHELL_SESSION_IDLE_MS);
    return Number.isFinite(raw) && raw >= MIN_IDLE_MS ? Math.floor(raw) : DEFAULT_IDLE_MS;
}

function buildHostScript(nonce: string): string {
    return String.raw`
$ErrorActionPreference = 'Continue'
$ProgressPreference = 'SilentlyContinue'
$nonce = '__NONCE__'
$out = [Console]::Out
function Write-AgentOut([string]$s) { $out.WriteLine($s); $out.Flush() }
function Write-AgentError([string]$commandId, [string]$text) {
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($text))
    Write-AgentOut ("<<<AGENT_PS_E64:" + $nonce + ":" + $commandId + ":" + $b64 + ">>>")
}
function Get-AgentEnvSnapshot {
    $snap = @{}
    foreach ($entry in [Environment]::GetEnvironmentVariables('Process').GetEnumerator()) {
        $snap[[string]$entry.Key] = [string]$entry.Value
    }
    return $snap
}
function Restore-AgentEnv($snap) {
    $now = [Environment]::GetEnvironmentVariables('Process')
    foreach ($key in @($now.Keys)) {
        if (-not $snap.ContainsKey([string]$key)) {
            Remove-Item -Path ("Env:" + $key) -ErrorAction SilentlyContinue
        }
    }
    foreach ($key in $snap.Keys) {
        $current = [Environment]::GetEnvironmentVariable([string]$key, 'Process')
        if ($null -eq $current -or $current -ne $snap[$key]) {
            Set-Item -Path ("Env:" + $key) -Value $snap[$key] -ErrorAction SilentlyContinue
        }
    }
}
$beginInvoke = $null
# 预热首个 Runspace（加载 Management/Utility 与格式化子系统），
# 避免宿主就绪后的首条用户命令额外承担 0.7~1s 的模块加载成本。
try {
    $warmRs = [RunspaceFactory]::CreateRunspace()
    $warmRs.Open()
    $warmPs = [PowerShell]::Create()
    $warmPs.Runspace = $warmRs
    [void]$warmPs.AddScript('Set-Location -LiteralPath $env:TEMP; Write-Output 1')
    [void]$warmPs.AddCommand('Out-String').AddParameter('Stream', $true).AddParameter('Width', 4096)
    $null = $warmPs.Invoke()
    $warmPs.Dispose()
    $warmRs.Dispose()
} catch {}
Write-AgentOut ("<<<AGENT_PS_READY:" + $nonce + ">>>")
while ($true) {
    $line = [Console]::In.ReadLine()
    if ($null -eq $line) { break }
    if ([string]::IsNullOrWhiteSpace($line)) { continue }
    $payload = $null
    try {
        $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
        $payload = $json | ConvertFrom-Json
    } catch {
        continue
    }
    $id = [string]$payload.id
    $cmd = [string]$payload.command
    $cwd = [string]$payload.cwd
    $envMap = $payload.env
    $envBefore = Get-AgentEnvSnapshot
    $procCwd = [Environment]::CurrentDirectory
    $code = 0
    $ps = $null
    $rs = $null
    Write-AgentOut ("<<<AGENT_PS_BEGIN:" + $nonce + ":" + $id + ">>>")
    try {
        if ($envMap) {
            foreach ($item in $envMap.PSObject.Properties) {
                $name = [string]$item.Name
                Set-Item -Path ("Env:" + $name) -Value ([string]$item.Value) -ErrorAction Stop
            }
        }
        $rs = [RunspaceFactory]::CreateRunspace()
        $rs.Open()
        if ($cwd) {
            [void]$rs.SessionStateProxy.Path.SetLocation($cwd)
            # 让 [System.IO.File] 等 .NET API 的相对路径也以命令 cwd 为基准；
            # Set-Location 只改 Runspace 位置，不改进程 CurrentDirectory。
            [Environment]::CurrentDirectory = $cwd
        }
        $ps = [PowerShell]::Create()
        $ps.Runspace = $rs
        [void]$ps.AddScript($cmd)
        [void]$ps.AddCommand('Out-String').AddParameter('Stream', $true).AddParameter('Width', 4096)
        $output = [System.Management.Automation.PSDataCollection[psobject]]::new()
        $inputCol = [System.Management.Automation.PSDataCollection[psobject]]::new()
        $inputCol.Complete()
        if ($null -eq $beginInvoke) {
            $beginInvoke = $ps.GetType().GetMethods() | Where-Object {
                $_.Name -eq 'BeginInvoke' -and $_.IsGenericMethod -and ($_.GetParameters()).Count -eq 2
            } | Select-Object -First 1
        }
        $handle = $beginInvoke.MakeGenericMethod([psobject], [psobject]).Invoke($ps, @($inputCol, $output))
        try {
            # 轮询读取输出：PSDataCollection 的 DataAdded 事件回调有 ~300ms 调度延迟，
            # 会抵消长驻会话的性能收益；10ms 轮询换来确定性的低延迟。
            while (-not $handle.IsCompleted) {
                foreach ($item in $output.ReadAll()) { Write-AgentOut ([string]$item) }
                Start-Sleep -Milliseconds 10
            }
            $ps.EndInvoke($handle) | Out-Null
            foreach ($item in $output.ReadAll()) { Write-AgentOut ([string]$item) }
        } catch {
            foreach ($item in $output.ReadAll()) { Write-AgentOut ([string]$item) }
            $inner = $_.Exception
            while ($inner.InnerException) { $inner = $inner.InnerException }
            if ($ps.Streams.Error.Count -eq 0) { Write-AgentError $id ([string]$inner.Message) }
            $code = 1
        }
        foreach ($record in $ps.Streams.Error) { Write-AgentError $id ([string]$record) }
        foreach ($record in $ps.Streams.Warning) { Write-AgentOut ("WARNING: " + [string]$record) }
        foreach ($record in $ps.Streams.Information) { Write-AgentOut ([string]$record) }
        foreach ($record in $ps.Streams.Verbose) { Write-AgentOut ("VERBOSE: " + [string]$record) }
        if ($ps.InvocationStateInfo.State -eq 'Failed') { $code = 1 }
        try {
            $lastExit = $rs.SessionStateProxy.GetVariable('LASTEXITCODE')
            if ($null -ne $lastExit -and [int]$lastExit -ne 0) { $code = [int]$lastExit }
        } catch {}
    } catch {
        Write-AgentError $id ([string]$_.Exception.Message)
        $code = 1
    } finally {
        if ($ps) { try { $ps.Dispose() } catch {} }
        if ($rs) { try { $rs.Dispose() } catch {} }
        try { [Environment]::CurrentDirectory = $procCwd } catch {}
        try { Restore-AgentEnv $envBefore } catch {}
        Write-AgentOut ("<<<AGENT_PS_END:" + $nonce + ":" + $id + ":" + $code + ">>>")
    }
}
`.replace('__NONCE__', nonce);
}

interface QueuedCommand {
    id: string;
    options: PowerShellSessionRunOptions;
    resolve: (result: PowerShellSessionRunResult) => void;
    reject: (error: unknown) => void;
}

interface InFlightCommand {
    job: QueuedCommand;
    stdoutChunks: Buffer[];
    stderrChunks: Buffer[];
    stdoutBytes: number;
    stderrBytes: number;
    inStdout: boolean;
    endCode: number | null;
    startedAt: number;
    timer: NodeJS.Timeout | null;
    onAbort: (() => void) | null;
}

class PowerShellSession {
    private child: ChildProcess | null = null;
    private ready = false;
    private starting = false;
    private dead = false;
    private disposed = false;
    private startPromise: Promise<void> | null = null;
    private startResolve: (() => void) | null = null;
    private startReject: ((error: unknown) => void) | null = null;
    private startTimer: NodeJS.Timeout | null = null;
    private stdoutBuffer: Buffer = Buffer.alloc(0);
    private hostStderrChunks: Buffer[] = [];
    private hostStderrBytes = 0;
    private queue: QueuedCommand[] = [];
    private current: InFlightCommand | null = null;
    private pumping = false;
    private idleTimer: NodeJS.Timeout | null = null;
    private readonly nonce = makeNonce();
    private readonly idleMs = readIdleMs();

    constructor(
        private readonly key: string,
        private readonly onDispose: (session: PowerShellSession) => void,
    ) {}

    public lastUsedAt = Date.now();

    public isBusy(): boolean {
        return Boolean(this.current) || this.queue.length > 0 || this.starting;
    }

    public isReady(): boolean {
        return this.ready && !this.dead && !this.disposed;
    }

    /** 仅启动宿主与首条命令所需的环境预热，不执行用户命令。 */
    public prewarm(): Promise<void> {
        this.touch();
        return this.ensureStarted();
    }

    public enqueue(options: PowerShellSessionRunOptions): Promise<PowerShellSessionRunResult> {
        this.lastUsedAt = Date.now();
        return new Promise((resolve, reject) => {
            if (options.abortSignal?.aborted) {
                resolve(this.emptyResult({ aborted: true }));
                return;
            }
            this.queue.push({ id: makeCommandId(), options, resolve, reject });
            void this.pump();
        });
    }

    public touch(): void {
        this.lastUsedAt = Date.now();
        if (this.disposed) return;
        if (this.idleTimer) clearTimeout(this.idleTimer);
        if (this.current || this.queue.length > 0 || this.starting) return;
        this.idleTimer = setTimeout(() => this.dispose('idle'), this.idleMs);
        this.idleTimer.unref?.();
    }

    public dispose(reason: string, killTree = false): void {
        if (this.disposed) return;
        this.disposed = true;
        this.dead = true;
        this.ready = false;
        if (this.idleTimer) clearTimeout(this.idleTimer);
        this.idleTimer = null;
        this.failStart(new PowerShellSessionUnavailableError(`PowerShell 会话已释放（${reason}）`));
        this.failQueued(new PowerShellSessionUnavailableError(`PowerShell 会话已释放（${reason}）`));
        if (this.current) {
            this.finalizeCurrent({
                status: 'error',
                hostError: `PowerShell 会话已释放（${reason}）`,
            });
        }
        const child = this.child;
        if (child?.pid) {
            console.log(`[PowerShellSession] disposing host pid=${child.pid} (${reason})`);
            ProcessSafetyGuard.getInstance().unregisterCommandChild(child.pid);
            this.killChild(child, killTree);
        }
        this.child = null;
        this.onDispose(this);
    }

    /** 进程退出钩子里不能等待异步任务，只做同步 kill。 */
    public disposeSync(): void {
        this.disposed = true;
        this.dead = true;
        if (this.child?.pid) {
            try {
                this.child.kill();
            } catch { /* ignore */ }
        }
        this.child = null;
    }

    private emptyResult(partial: Partial<PowerShellSessionRunResult>): PowerShellSessionRunResult {
        return {
            stdout: Buffer.alloc(0),
            stderr: Buffer.alloc(0),
            code: null,
            status: 'error',
            timedOut: false,
            aborted: false,
            hardKilled: false,
            durationMs: 0,
            ...partial,
        };
    }

    private async pump(): Promise<void> {
        if (this.pumping) return;
        this.pumping = true;
        try {
            while (!this.disposed && !this.current && this.queue.length > 0) {
                const job = this.queue.shift()!;
                if (job.options.abortSignal?.aborted) {
                    job.resolve(this.emptyResult({ aborted: true }));
                    continue;
                }
                try {
                    await this.ensureStarted();
                } catch (error) {
                    // 启动失败时命令尚未执行，统一拒绝让调用方回退一次性 spawn；
                    // 同时清空队列，避免为同一次故障反复重试启动。
                    job.reject(error);
                    this.failQueued(error);
                    break;
                }
                // 启动可能耗时数百毫秒，期间可能已被取消：绝不能再执行该命令。
                if (job.options.abortSignal?.aborted) {
                    job.resolve(this.emptyResult({ aborted: true }));
                    continue;
                }
                this.execute(job);
            }
        } finally {
            this.pumping = false;
            this.touch();
        }
    }

    private ensureStarted(): Promise<void> {
        if (this.disposed) {
            return Promise.reject(new PowerShellSessionUnavailableError('PowerShell 会话已释放'));
        }
        if (this.ready && this.child && !this.dead) return Promise.resolve();
        if (this.startPromise) return this.startPromise;
        this.startPromise = this.start().finally(() => {
            this.startPromise = null;
        });
        return this.startPromise;
    }

    private start(): Promise<void> {
        this.dead = false;
        this.ready = false;
        this.starting = true;
        this.stdoutBuffer = Buffer.alloc(0);
        this.hostStderrChunks = [];
        this.hostStderrBytes = 0;

        const script = buildHostScript(this.nonce);
        const encoded = Buffer.from(script, 'utf16le').toString('base64');
        const child = spawn(
            'powershell.exe',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
            {
                cwd: process.cwd(),
                windowsHide: true,
                stdio: ['pipe', 'pipe', 'pipe'],
                env: { ...process.env },
            },
        );
        this.child = child;
        hostStartCount += 1;

        child.stdout?.on('data', (chunk: Buffer) => this.onStdoutData(chunk));
        child.stderr?.on('data', (chunk: Buffer) => this.onStderrData(chunk));
        child.on('error', (error) => {
            if (this.child === child) this.onChildError(error);
        });
        child.on('close', (code) => {
            if (this.child === child) this.onChildClose(code);
        });

        if (child.pid) {
            ProcessSafetyGuard.getInstance().registerCommandChild(child.pid);
            console.log(`[PowerShellSession] started host pid=${child.pid} (key=${this.key})`);
        }

        return new Promise<void>((resolve, reject) => {
            this.startResolve = resolve;
            this.startReject = reject;
            this.startTimer = setTimeout(() => {
                if (this.child !== child) return;
                this.failStart(new PowerShellSessionUnavailableError(
                    `PowerShell 会话启动超时（${STARTUP_TIMEOUT_MS}ms）${this.hostStderrSnippet()}`,
                ));
                ProcessSafetyGuard.getInstance().unregisterCommandChild(child.pid ?? -1);
                this.killChild(child, true);
                this.child = null;
                this.dead = true;
            }, STARTUP_TIMEOUT_MS);
            this.startTimer.unref?.();
        });
    }

    private succeedStart(): void {
        if (this.startTimer) clearTimeout(this.startTimer);
        this.startTimer = null;
        this.starting = false;
        this.ready = true;
        this.dead = false;
        const resolve = this.startResolve;
        this.startResolve = null;
        this.startReject = null;
        resolve?.();
    }

    private failStart(error: unknown): void {
        if (this.startTimer) clearTimeout(this.startTimer);
        this.startTimer = null;
        this.starting = false;
        this.ready = false;
        const reject = this.startReject;
        this.startResolve = null;
        this.startReject = null;
        reject?.(error);
    }

    private failQueued(error: unknown): void {
        const queued = this.queue;
        this.queue = [];
        for (const job of queued) job.reject(error);
    }

    private execute(job: QueuedCommand): void {
        const child = this.child;
        if (!child?.stdin) {
            job.reject(new PowerShellSessionUnavailableError('PowerShell 会话 stdin 不可用'));
            this.dead = true;
            return;
        }

        const current: InFlightCommand = {
            job,
            stdoutChunks: [],
            stderrChunks: [],
            stdoutBytes: 0,
            stderrBytes: 0,
            inStdout: false,
            endCode: null,
            startedAt: Date.now(),
            timer: null,
            onAbort: null,
        };
        this.current = current;

        current.timer = setTimeout(() => this.onTimeout(current), job.options.timeout);
        current.timer.unref?.();

        const signal = job.options.abortSignal;
        if (signal) {
            current.onAbort = () => this.onAbort(current);
            signal.addEventListener('abort', current.onAbort, { once: true });
        }

        const payload = Buffer.from(JSON.stringify({
            id: job.id,
            command: job.options.command,
            cwd: job.options.cwd,
            env: job.options.extraEnv || {},
        }), 'utf8').toString('base64');

        child.stdin.write(payload + '\n', (error) => {
            if (error) {
                this.finalizeCurrent({
                    status: 'error',
                    hostError: `PowerShell 会话写入失败：${error.message}`,
                });
                this.dead = true;
                this.killChild(child, true);
            }
        });
    }

    private onStdoutData(chunk: Buffer): void {
        this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
        let index: number;
        while ((index = this.stdoutBuffer.indexOf(0x0a)) >= 0) {
            const line = this.stdoutBuffer.subarray(0, index);
            this.stdoutBuffer = this.stdoutBuffer.subarray(index + 1);
            this.onStdoutLine(line);
        }
    }

    private onStderrData(chunk: Buffer): void {
        // 命令级 stderr 通过 stdout 的 E64 帧回传；宿主 stderr 只可能是启动/序列化噪音，
        // 保留少量用于启动失败诊断即可。
        if (this.hostStderrBytes >= 8192) return;
        const slice = chunk.subarray(0, 8192 - this.hostStderrBytes);
        this.hostStderrChunks.push(slice);
        this.hostStderrBytes += slice.length;
    }

    private hostStderrSnippet(limit = 300): string {
        if (!this.hostStderrChunks.length) return '';
        const text = Buffer.concat(this.hostStderrChunks).toString('utf8').replace(/\s+/g, ' ').trim();
        return text ? `：${text.slice(0, limit)}` : '';
    }

    private onStdoutLine(line: Buffer): void {
        const text = line.toString('latin1').replace(/\r$/, '');
        if (!this.ready) {
            if (text.startsWith(READY_PREFIX + this.nonce + '>>>')) this.succeedStart();
            return;
        }
        const current = this.current;
        if (!current) return;

        const beginMarker = `${BEGIN_PREFIX}${this.nonce}:${current.job.id}>>>`;
        if (text === beginMarker) {
            current.inStdout = true;
            return;
        }
        const errDataPrefix = `${ERR_DATA_PREFIX}${this.nonce}:${current.job.id}:`;
        if (text.startsWith(errDataPrefix) && text.endsWith('>>>')) {
            const encoded = text.slice(errDataPrefix.length, -3);
            const decoded = Buffer.from(encoded, 'base64').toString('utf8');
            this.appendStderrText(current, decoded);
            return;
        }
        const endMarkerPrefix = `${END_PREFIX}${this.nonce}:${current.job.id}:`;
        if (text.startsWith(endMarkerPrefix) && text.endsWith('>>>')) {
            const rawCode = text.slice(endMarkerPrefix.length, -3);
            const parsed = Number(rawCode);
            const code = Number.isFinite(parsed) ? parsed : null;
            this.finalizeCurrent({
                status: code === 0 ? 'success' : 'error',
                code,
            });
            return;
        }
        if (current.inStdout) this.appendStdout(current, line);
    }

    private appendStdout(current: InFlightCommand, line: Buffer): void {
        current.stdoutBytes += line.length + 1;
        current.stdoutChunks.push(Buffer.concat([line, Buffer.from('\n')]));
        this.checkOutputLimit(current);
    }

    private appendStderrText(current: InFlightCommand, text: string): void {
        const normalized = text.endsWith('\n') ? text : text + '\n';
        const buffer = Buffer.from(normalized, 'utf8');
        current.stderrBytes += buffer.length;
        current.stderrChunks.push(buffer);
        this.checkOutputLimit(current);
    }

    private checkOutputLimit(current: InFlightCommand): void {
        if (current !== this.current) return;
        if (current.stdoutBytes + current.stderrBytes <= HARD_OUTPUT_LIMIT) return;
        this.killCurrent(true);
        this.finalizeCurrent({
            status: 'error',
            code: 'SIGTERM',
            hardKilled: true,
        });
    }

    private onTimeout(current: InFlightCommand): void {
        if (this.current !== current) return;
        this.killCurrent(true);
        this.finalizeCurrent({
            status: 'error',
            code: 'SIGTERM',
            timedOut: true,
        });
    }

    private onAbort(current: InFlightCommand): void {
        if (this.current !== current) return;
        this.killCurrent(true);
        this.finalizeCurrent({
            status: 'error',
            code: 'SIGTERM',
            aborted: true,
        });
    }

    private killCurrent(tree: boolean): void {
        if (this.child) {
            this.killChild(this.child, tree);
            this.dead = true;
            this.ready = false;
        }
    }

    private finalizeCurrent(overrides: Partial<PowerShellSessionRunResult>): void {
        const current = this.current;
        if (!current) return;
        this.current = null;

        if (current.timer) clearTimeout(current.timer);
        if (current.onAbort && current.job.options.abortSignal) {
            current.job.options.abortSignal.removeEventListener('abort', current.onAbort);
        }

        const stdout = Buffer.concat(current.stdoutChunks);
        const stderr = Buffer.concat(current.stderrChunks);
        const code = overrides.code !== undefined ? overrides.code : current.endCode;
        const status = overrides.status
            ?? (code === 0 ? 'success' : 'error');

        current.job.resolve({
            stdout,
            stderr,
            code: code ?? null,
            status,
            timedOut: false,
            aborted: false,
            hardKilled: false,
            durationMs: Date.now() - current.startedAt,
            ...overrides,
        });

        void this.pump();
    }

    private onChildError(error: Error): void {
        this.dead = true;
        this.ready = false;
        if (this.starting) {
            this.failStart(new PowerShellSessionUnavailableError(
                `PowerShell 会话启动失败：${error.message}${this.hostStderrSnippet()}`,
            ));
        }
        if (this.current) {
            this.finalizeCurrent({
                status: 'error',
                hostError: `PowerShell 会话进程错误：${error.message}`,
            });
        }
    }

    private onChildClose(code: number | null): void {
        const child = this.child;
        if (child?.pid) {
            ProcessSafetyGuard.getInstance().unregisterCommandChild(child.pid);
        }
        this.child = null;
        this.ready = false;
        this.dead = true;

        if (this.starting) {
            this.failStart(new PowerShellSessionUnavailableError(
                `PowerShell 会话进程提前退出（code=${code ?? 'null'}）${this.hostStderrSnippet()}`,
            ));
        }
        if (this.current) {
            this.finalizeCurrent({
                status: 'error',
                code: code ?? 'SIGTERM',
                hostError: `PowerShell 会话进程意外退出（code=${code ?? 'null'}）`,
            });
        }
        void this.pump();
    }

    private killChild(child: ChildProcess, tree: boolean): void {
        if (child.pid) {
            ProcessSafetyGuard.getInstance().unregisterCommandChild(child.pid);
        }
        if (!child.pid) {
            try { child.kill(); } catch { /* ignore */ }
            return;
        }
        if (process.platform === 'win32' && tree) {
            try {
                const killer = spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
                    stdio: 'ignore',
                    windowsHide: true,
                    detached: true,
                });
                killer.on('error', () => {
                    try { child.kill(); } catch { /* ignore */ }
                });
                killer.unref();
                return;
            } catch {
                try { child.kill(); } catch { /* ignore */ }
                return;
            }
        }
        try {
            child.kill();
        } catch { /* ignore */ }
    }
}

export class PowerShellSessionManager {
    private static instance: PowerShellSessionManager | null = null;

    private readonly sessions = new Map<string, PowerShellSession>();
    private readonly prewarmBlockedUntil = new Map<string, number>();

    private constructor() {
        process.once('exit', () => this.disposeAllSync());
    }

    public static getInstance(): PowerShellSessionManager {
        if (!PowerShellSessionManager.instance) {
            PowerShellSessionManager.instance = new PowerShellSessionManager();
        }
        return PowerShellSessionManager.instance;
    }

    /** 默认在 Windows 启用；AGENT_POWERSHELL_SESSION=0/false/off 可关闭。 */
    public static isEnabled(): boolean {
        if (process.platform !== 'win32') return false;
        const flag = String(process.env.AGENT_POWERSHELL_SESSION ?? '').trim().toLowerCase();
        return flag !== '0' && flag !== 'false' && flag !== 'off';
    }

    /** 该命令是否适合走长驻会话（exit / .ps1 回退到一次性 spawn 以保退出码语义）。 */
    public static shouldUseSession(command: string): boolean {
        if (!PowerShellSessionManager.isEnabled()) return false;
        if (EXIT_STATEMENT_PATTERN.test(command)) return false;
        if (PS1_REFERENCE_PATTERN.test(command)) return false;
        return true;
    }

    public run(userId: string | undefined, options: PowerShellSessionRunOptions): Promise<PowerShellSessionRunResult> {
        if (!PowerShellSessionManager.isEnabled()) {
            return Promise.reject(new PowerShellSessionUnavailableError('PowerShell 长驻会话未启用'));
        }
        const session = this.getOrCreateSession(this.keyOf(userId));
        session.touch();
        return session.enqueue(options);
    }

    /** 长驻会话是否已就绪（未就绪时调用方先走一次性 spawn，避免为首条命令承担冷启动）。 */
    public isReady(userId: string | undefined): boolean {
        return this.sessions.get(this.keyOf(userId))?.isReady() ?? false;
    }

    /**
     * 后台预热长驻宿主（不执行命令）。返回 false 表示未启用/被失败退避拦截/启动失败。
     * 失败后 60 秒内不再重试，避免每条命令都触发一次失败的冷启动。
     */
    public async prewarm(userId: string | undefined): Promise<boolean> {
        if (!PowerShellSessionManager.isEnabled()) return false;
        const key = this.keyOf(userId);
        if (this.sessions.get(key)?.isReady()) return true;
        if (Date.now() < (this.prewarmBlockedUntil.get(key) ?? 0)) return false;

        const session = this.getOrCreateSession(key);
        try {
            await session.prewarm();
            return true;
        } catch (error) {
            console.warn(
                '[PowerShellSession] prewarm failed:',
                (error as Error)?.message || error,
            );
            this.prewarmBlockedUntil.set(key, Date.now() + 60_000);
            session.dispose('prewarm-failed');
            return false;
        }
    }

    private keyOf(userId: string | undefined): string {
        return String(userId || '').trim() || 'default';
    }

    private getOrCreateSession(key: string): PowerShellSession {
        let session = this.sessions.get(key);
        if (!session) {
            session = new PowerShellSession(key, (disposed) => {
                if (this.sessions.get(key) === disposed) this.sessions.delete(key);
            });
            this.sessions.set(key, session);
            this.evictIfNeeded(key);
        }
        return session;
    }

    public disposeUser(userId: string | undefined): void {
        const key = this.keyOf(userId);
        this.prewarmBlockedUntil.delete(key);
        const session = this.sessions.get(key);
        if (!session) return;
        this.sessions.delete(key);
        session.dispose('user-reset');
    }

    public disposeAll(): void {
        const sessions = Array.from(this.sessions.values());
        this.sessions.clear();
        this.prewarmBlockedUntil.clear();
        for (const session of sessions) session.dispose('shutdown');
    }

    private disposeAllSync(): void {
        const sessions = Array.from(this.sessions.values());
        this.sessions.clear();
        for (const session of sessions) session.disposeSync();
    }

    /** 仅供测试/诊断：长驻宿主进程启动次数与当前活跃会话数。 */
    public getStats(): { started: number; active: number } {
        return { started: hostStartCount, active: this.sessions.size };
    }

    private evictIfNeeded(protectedKey: string): void {
        if (this.sessions.size <= MAX_SESSIONS) return;
        const candidates = Array.from(this.sessions.entries())
            .filter(([key, session]) => key !== protectedKey && !session.isBusy())
            .sort((a, b) => a[1].lastUsedAt - b[1].lastUsedAt);
        const victim = candidates[0];
        if (!victim) return;
        this.sessions.delete(victim[0]);
        victim[1].dispose('lru');
    }
}

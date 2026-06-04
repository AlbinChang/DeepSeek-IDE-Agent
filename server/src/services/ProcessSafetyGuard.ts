/**
 * ProcessSafetyGuard — 进程安全守护模块
 * 
 * 职责：
 * 1. 从三个 server_conf.json 读取 deepseek-ide-agent 所有服务端口，建立防护白名单
 * 2. 检测大模型是否试图通过命令杀死进程，若目标 PID 关联到受保护端口则拦截
 * 3. 禁止杀死系统关键服务进程（Windows services / Linux system daemons）
 * 4. 强制"杀进程必须显式指定 PID"的契约，禁止按进程名批量杀进程
 * 5. 禁止用户服务启动命令监听 Agent 受保护端口
 * 6. 跨平台：Windows (netstat / tasklist) + Linux/macOS (ss / lsof / /proc)
 * 
 * 对齐：
 * - TECH_SPEC.md §5.0 & §17.0 运行规范
 * - main-agent.json forbidden_operations
 * - 用户偏好：禁止自动降级模型、进程安全防护
 */

import { execSync } from 'child_process';
import * as fs from 'fs';
import { config as globalConfig } from '@/config/index.js';

// ============================================================================
// 类型定义
// ============================================================================

export interface PidPortBinding {
    pid: number;
    port: number;
    protocol: 'TCP' | 'UDP';
    address: string;
}

export interface KillAttempt {
    /** 原始命令字符串 */
    rawCommand: string;
    /** 匹配到的 kill 工具名 */
    killTool: string;
    /** 从命令中提取到的 PID 列表 */
    targetPids: number[];
    /** 从端口杀进程命令或管道中提取到的目标端口列表 */
    targetPorts: number[];
    /** 从命令中提取到的进程名模式 */
    targetProcessNames: string[];
    /** 是否按进程名批量杀（危险） */
    isMassKill: boolean;
}

export interface KillVerdict {
    allowed: boolean;
    reason: string;
    blockedPids: number[];
    blockedPorts: number[];
}

export interface ProtectedPortUsageVerdict {
    allowed: boolean;
    reason: string;
    blockedPorts: number[];
}

// ============================================================================
// 系统关键进程名单
// ============================================================================

/**
 * Windows 系统关键进程（绝不能杀）
 * 这些进程是 OS 核心组件，终止会导致系统不稳定或崩溃
 */
const WINDOWS_SYSTEM_PROCESSES = new Set([
    'system', 'system idle process', 'system idle',
    'smss.exe', 'csrss.exe', 'wininit.exe', 'winlogon.exe',
    'services.exe', 'lsass.exe', 'svchost.exe',
    'spoolsv.exe', 'dwm.exe', 'explorer.exe',
    'taskhostw.exe', 'taskhost.exe', 'sihost.exe',
    'fontdrvhost.exe', 'audiodg.exe', 'wlms.exe',
    'searchindexer.exe', 'securityhealthservice.exe',
    'msmpeng.exe', 'nis.exe', 'sense.exe',
    // 杀毒/安全软件
    'msmpeng.exe', 'msseces.exe', 'msascuil.exe',
]);

/**
 * Linux 系统关键进程（绝不能杀）
 */
const LINUX_SYSTEM_PROCESSES = new Set([
    'systemd', 'init', 'kthreadd', 'ksoftirqd',
    'migration', 'rcu_sched', 'watchdog',
    // 内核线程（PID 通常 < 1000 或名称以 [ ] 包裹）
]);

/** Linux 上 PID 小于此值的进程视为系统级进程 */
const LINUX_SYSTEM_PID_THRESHOLD = 1000;

// ============================================================================
// Kill 命令检测模式
// ============================================================================

/**
 * Kill 相关命令的正则模式库
 * 覆盖 Windows / Linux / macOS 上常见的进程终止方式
 */
const KILL_COMMAND_PATTERNS: Array<{ pattern: RegExp; toolName: string; isMassKillRisk: boolean }> = [
    // Windows
    { pattern: /\b(taskkill)\b/i,                    toolName: 'taskkill',           isMassKillRisk: true },
    { pattern: /\b(tskill)\b/i,                      toolName: 'tskill',             isMassKillRisk: true },
    { pattern: /\bstop-process\b/i,                  toolName: 'Stop-Process',       isMassKillRisk: true },
    { pattern: /\bwmic\s+process\b.*\b(?:delete|call\s+terminate)\b/i, toolName: 'wmic', isMassKillRisk: true },
    { pattern: /\bget-process\b.*\bstop-process\b/i, toolName: 'Get-Process|Stop-Process', isMassKillRisk: true },
    { pattern: /\binvoke-cimmethod\b/i,              toolName: 'Invoke-CimMethod',   isMassKillRisk: true },
    { pattern: /\bremove-process\b/i,                toolName: 'Remove-Process',     isMassKillRisk: true },
    // Linux / macOS
    { pattern: /\b(kill)\b/i,                        toolName: 'kill',               isMassKillRisk: false },
    { pattern: /\b(killall)\b/i,                     toolName: 'killall',            isMassKillRisk: true },
    { pattern: /\b(pkill)\b/i,                       toolName: 'pkill',              isMassKillRisk: true },
    { pattern: /\bfuser\s+-k\b/i,                    toolName: 'fuser -k',           isMassKillRisk: true },
    // 跨平台 Node 工具
    { pattern: /\b(?:npx\s+)?(?:kill-port|fkill)\b/i, toolName: 'kill-port/fkill',  isMassKillRisk: true },
    // 通过 /proc 直接杀进程（Linux）
    { pattern: /\/proc\/\d+\/[^\s]*\b(kill|oom|term)\b/i, toolName: '/proc kill', isMassKillRisk: false },
];

/**
 * 按进程名批量杀进程的模式（极度危险）
 */
const MASS_KILL_PATTERNS = [
    // Windows: taskkill /IM xxx.exe, Get-Process xxx | Stop-Process
    /\/IM\s+(\S+)/i,
    /\/FI\s+"IMAGENAME\s+eq\s+(\S+)"/i,
    /Get-Process\s+['"]?(\w[\w.]*)['"]?\s*\|/i,
    // Linux: killall xxx, pkill xxx
    /killall\s+(\S+)/i,
    /pkill\s+(?:-[a-zA-Z]+\s+)*(\S+)/i,
    // 通用: kill-port 端口
    /(?:kill-port|fkill)\s+(\d+)/i,
];

/**
 * Node/npm 进程名模式（批量杀这些等于自杀）
 */
const NODE_PROCESS_PATTERNS = [
    /\bnode\b/i,
    /\bnode\.exe\b/i,
    /\bnpm\b/i,
    /\bnpx\b/i,
    /\bnode:\b/i,    // Node.js 内部标识
    /\bts-node\b/i,
    /\btsx\b/i,
    /\bts-node-esm\b/i,
    /\bnodemon\b/i,
    /\bpm2\b/i,
    /\bvite\b/i,
    /\besbuild\b/i,
    /\bswc\b/i,
];

// ============================================================================
// 主类
// ============================================================================

export class ProcessSafetyGuard {
    private static instance: ProcessSafetyGuard;

    /** 受保护的端口列表（从三个 server_conf.json 读取） */
    private protectedPorts: number[] = [];

    /** 当前进程（Agent Server）的 PID 及其子进程 PID 集合 */
    private selfPid: number;
    private childPids: Set<number> = new Set();
    private isWin: boolean;

    private constructor() {
        this.isWin = process.platform === 'win32';
        this.selfPid = process.pid;
        this.refreshProtectedPorts();
        this.refreshChildPids();
    }

    static getInstance(): ProcessSafetyGuard {
        if (!ProcessSafetyGuard.instance) {
            ProcessSafetyGuard.instance = new ProcessSafetyGuard();
        }
        return ProcessSafetyGuard.instance;
    }

    // ========================================================================
    // 1. 受保护端口管理
    // ========================================================================

    /**
     * 从三个 server_conf.json 刷新受保护端口列表
     * 同时在每次检查前调用，确保端口变更能被感知
     */
    refreshProtectedPorts(): void {
        const ports = new Set<number>();

        const addPort = (p: number | undefined, fallback: number) => {
            const port = (p != null && p > 0) ? p : fallback;
            if (port > 0) ports.add(port);
        };

        // server/server_conf.json → port
        addPort(globalConfig.servicePorts?.serverPort, 3001);
        // client/server_conf.json → devPort / staticPort
        addPort(globalConfig.servicePorts?.clientDevPort, 5174);
        // terminal-server/server_conf.json → port
        addPort(globalConfig.servicePorts?.terminalPort, 3003);

        // 同时扫描环境变量中的端口覆盖
        const envPorts = [process.env.PORT, process.env.TERMINAL_SERVER_PORT, process.env.DEV_PORT];
        for (const ep of envPorts) {
            const num = Number(ep);
            if (Number.isFinite(num) && num > 0) ports.add(num);
        }

        this.protectedPorts = Array.from(ports).sort((a, b) => a - b);
    }

    getProtectedPorts(): number[] {
        return [...this.protectedPorts];
    }

    getProtectedPortsText(): string {
        return this.protectedPorts.join('/');
    }

    private addUniqueNumber(target: number[], value: number): void {
        if (Number.isFinite(value) && value > 0 && !target.includes(value)) {
            target.push(value);
        }
    }

    private getProtectedMatches(ports: number[]): number[] {
        const protectedSet = new Set(this.protectedPorts);
        return [...new Set(ports.filter(port => protectedSet.has(port)))];
    }

    // ========================================================================
    // 2. 自身进程树感知
    // ========================================================================

    /**
     * 刷新当前 Agent 进程的子进程 PID 列表
     */
    refreshChildPids(): void {
        try {
            if (this.isWin) {
                // Windows: wmic process where (ParentProcessId={selfPid}) get ProcessId
                const raw = execSync(
                    `wmic process where (ParentProcessId=${this.selfPid}) get ProcessId /format:csv`,
                    { timeout: 5000, encoding: 'utf8' }
                );
                const lines = raw.split('\n').filter(l => l.trim());
                for (let i = 1; i < lines.length; i++) {
                    const cols = lines[i].split(',');
                    const pid = parseInt(cols[cols.length - 1]?.trim(), 10);
                    if (pid && pid > 0 && pid !== this.selfPid) {
                        this.childPids.add(pid);
                    }
                }
            } else {
                // Linux/macOS: pgrep -P {selfPid}
                const raw = execSync(`pgrep -P ${this.selfPid} 2>/dev/null || echo ''`, {
                    timeout: 5000, encoding: 'utf8'
                });
                for (const line of raw.trim().split('\n')) {
                    const pid = parseInt(line.trim(), 10);
                    if (pid > 0 && pid !== this.selfPid) {
                        this.childPids.add(pid);
                    }
                }
            }
        } catch {
            // 静默失败；self-awareness 非关键路径
        }
    }

    /**
     * 检查给定 PID 是否属于 Agent 自身或子进程
     */
    isSelfOrChild(pid: number): boolean {
        return pid === this.selfPid || this.childPids.has(pid);
    }

    // ========================================================================
    // 3. PID → 端口 绑定查询（跨平台）
    // ========================================================================

    /**
     * 查询指定 PID 绑定的网络端口
     * 跨平台实现：Windows netstat / Linux ss
     */
    queryPidPortBindings(pid: number): PidPortBinding[] {
        const bindings: PidPortBinding[] = [];
        try {
            if (this.isWin) {
                bindings.push(...this.queryPidPortsWindows(pid));
            } else {
                bindings.push(...this.queryPidPortsLinux(pid));
            }
        } catch {
            // 查询失败时保守处理：不返回绑定信息
        }
        return bindings;
    }

    /**
     * Windows: 使用 netstat -ano 查询 PID 端口绑定
     */
    private queryPidPortsWindows(pid: number): PidPortBinding[] {
        const bindings: PidPortBinding[] = [];
        try {
            const raw = execSync('netstat -ano', { timeout: 8000, encoding: 'utf8' });
            const pidStr = String(pid);
            // netstat -ano 格式：
            //   TCP    0.0.0.0:3001           0.0.0.0:0              LISTENING       12345
            //   TCP    [::]:3001              [::]:0                 LISTENING       12345
            for (const line of raw.split('\n')) {
                if (!line.includes(pidStr)) continue;
                const trimmed = line.trim();
                if (!trimmed) continue;

                const parts = trimmed.split(/\s+/);
                if (parts.length < 5) continue;
                const linePid = parseInt(parts[parts.length - 1], 10);
                if (linePid !== pid) continue;

                const proto = parts[0].toUpperCase() === 'TCP' ? 'TCP' : parts[0].toUpperCase() === 'UDP' ? 'UDP' : 'TCP';
                const localAddr = parts[1];
                // 提取端口号：0.0.0.0:3001 → 3001, [::]:3001 → 3001
                const portMatch = localAddr.match(/:(\d+)\]?$/);
                if (portMatch) {
                    bindings.push({
                        pid,
                        port: parseInt(portMatch[1], 10),
                        protocol: proto as 'TCP' | 'UDP',
                        address: localAddr,
                    });
                }
            }
        } catch {
            // netstat 不可用时静默退化
        }
        return bindings;
    }

    /**
     * Linux/macOS: 使用 ss / lsof 查询 PID 端口绑定
     */
    private queryPidPortsLinux(pid: number): PidPortBinding[] {
        const bindings: PidPortBinding[] = [];
        try {
            // 优先使用 ss (iproute2)，比 netstat 更快
            let raw: string;
            try {
                raw = execSync(`ss -tlnp 2>/dev/null | grep "pid=${pid}"`, {
                    timeout: 5000, encoding: 'utf8'
                });
            } catch {
                // ss 不可用时降级到 lsof
                raw = execSync(`lsof -i -P -n 2>/dev/null | grep "^\\S*\\s*${pid}\\s"`, {
                    timeout: 5000, encoding: 'utf8'
                });
            }

            for (const line of raw.split('\n')) {
                const trimmed = line.trim();
                if (!trimmed) continue;

                if (raw.includes('pid=')) {
                    // ss 输出：LISTEN 0 128 0.0.0.0:3001 0.0.0.0:* users:(("node",pid=12345,fd=18))
                    const portMatch = trimmed.match(/:(\d+)\s/);
                    if (portMatch) {
                        bindings.push({
                            pid,
                            port: parseInt(portMatch[1], 10),
                            protocol: 'TCP',
                            address: '',
                        });
                    }
                } else {
                    // lsof 输出
                    const parts = trimmed.split(/\s+/);
                    if (parts.length >= 9) {
                        const addrPart = parts[8];
                        const portMatch = addrPart.match(/:(\d+)$/);
                        if (portMatch) {
                            bindings.push({
                                pid,
                                port: parseInt(portMatch[1], 10),
                                protocol: parts[7]?.toUpperCase() === 'UDP' ? 'UDP' : 'TCP',
                                address: addrPart,
                            });
                        }
                    }
                }
            }
        } catch {
            // 静默退化
        }
        return bindings;
    }

    /**
     * 查询当前有哪些 PID 在监听受保护端口
     */
    queryProtectedPortPids(): Map<number, number[]> {
        const portToPids = new Map<number, number[]>();
        for (const port of this.protectedPorts) {
            const pids = this.queryPortPids(port);
            if (pids.length > 0) {
                portToPids.set(port, pids);
            }
        }
        return portToPids;
    }

    /**
     * 查询监听指定端口的所有 PID
     */
    private queryPortPids(port: number): number[] {
        const pids = new Set<number>();
        try {
            if (this.isWin) {
                const raw = execSync('netstat -ano', { timeout: 8000, encoding: 'utf8' });
                const portStr = `:${port}`;
                for (const line of raw.split('\n')) {
                    if (!line.includes(portStr)) continue;
                    // 精确匹配端口号，避免 :3001 误匹配 :30010
                    const portRegex = new RegExp(`:${port}\\b`);
                    if (!portRegex.test(line)) continue;
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 5) {
                        const pid = parseInt(parts[parts.length - 1], 10);
                        if (pid > 0) pids.add(pid);
                    }
                }
            } else {
                try {
                    const raw = execSync(`ss -tlnp 2>/dev/null | grep ":${port}\\b"`, {
                        timeout: 5000, encoding: 'utf8'
                    });
                    for (const line of raw.split('\n')) {
                        const pidMatch = line.match(/pid=(\d+)/);
                        if (pidMatch) {
                            const pid = parseInt(pidMatch[1], 10);
                            if (pid > 0) pids.add(pid);
                        }
                    }
                } catch {
                    // 退化到 lsof
                    const raw = execSync(`lsof -i :${port} -t 2>/dev/null`, {
                        timeout: 5000, encoding: 'utf8'
                    });
                    for (const line of raw.split('\n')) {
                        const pid = parseInt(line.trim(), 10);
                        if (pid > 0) pids.add(pid);
                    }
                }
            }
        } catch {
            // 静默退化
        }
        return Array.from(pids);
    }

    // ========================================================================
    // 4. 系统服务 PID 检测
    // ========================================================================

    /**
     * 检查 PID 是否属于系统关键服务
     * 返回：{ isSystemService, processName }
     */
    checkSystemProcess(pid: number): { isSystemService: boolean; processName: string; reason: string } {
        try {
            if (this.isWin) {
                return this.checkSystemProcessWindows(pid);
            } else {
                return this.checkSystemProcessLinux(pid);
            }
        } catch {
            // 无法确认时，PID < 100 保守视为系统进程
            if (pid < 100) {
                return { isSystemService: true, processName: 'unknown', reason: `PID ${pid} 小于 100，极可能是系统内核进程` };
            }
            return { isSystemService: false, processName: 'unknown', reason: '' };
        }
    }

    private checkSystemProcessWindows(pid: number): { isSystemService: boolean; processName: string; reason: string } {
        try {
            // tasklist 精确查询
            const raw = execSync(`tasklist /FI "PID eq ${pid}" /FO CSV /NH`, {
                timeout: 5000, encoding: 'utf8'
            }).trim();

            if (!raw) {
                return { isSystemService: false, processName: '', reason: '进程不存在或无法查询' };
            }

            const cols = raw.replace(/"/g, '').split(',');
            const imageName = (cols[0] || '').trim().toLowerCase();

            // 系统进程名检测
            if (WINDOWS_SYSTEM_PROCESSES.has(imageName)) {
                return {
                    isSystemService: true,
                    processName: imageName,
                    reason: `进程 "${imageName}" (PID ${pid}) 是 Windows 系统关键进程，终止会导致系统不稳定或崩溃`
                };
            }

            // 通过 wmic 检查是否是 Windows 服务
            try {
                const svcRaw = execSync(
                    `wmic service where (ProcessId=${pid}) get Name /format:csv 2>nul`,
                    { timeout: 3000, encoding: 'utf8' }
                ).trim();
                const svcLines = svcRaw.split('\n').filter(l => l.trim() && !l.startsWith('Node,'));
                if (svcLines.length > 1) {
                    return {
                        isSystemService: true,
                        processName: imageName,
                        reason: `进程 "${imageName}" (PID ${pid}) 是 Windows 服务宿主，终止会影响系统服务运行`
                    };
                }
            } catch {}

            return { isSystemService: false, processName: imageName, reason: '' };
        } catch {
            return { isSystemService: false, processName: 'unknown', reason: '' };
        }
    }

    private checkSystemProcessLinux(pid: number): { isSystemService: boolean; processName: string; reason: string } {
        try {
            // 读取 /proc/{pid}/comm
            const comm = fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim().toLowerCase();

            // 系统关键进程名检测
            if (LINUX_SYSTEM_PROCESSES.has(comm)) {
                return {
                    isSystemService: true,
                    processName: comm,
                    reason: `进程 "${comm}" (PID ${pid}) 是 Linux 系统关键进程，终止会导致系统不稳定`
                };
            }

            // PID < 阈值 且非用户进程 → 保守拦截
            if (pid < LINUX_SYSTEM_PID_THRESHOLD) {
                // 检查是否是内核线程（/proc/{pid}/stat 中 PPID=2 即 kthreadd 的子进程）
                try {
                    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
                    const statParts = stat.split(' ');
                    const ppid = parseInt(statParts[3], 10);
                    if (ppid === 2) {
                        return {
                            isSystemService: true,
                            processName: `[${comm}]`,
                            reason: `PID ${pid} 是内核线程（kthreadd 子进程），终止会导致内核功能异常`
                        };
                    }
                } catch {}

                return {
                    isSystemService: true,
                    processName: comm,
                    reason: `PID ${pid} (${comm}) 小于 ${LINUX_SYSTEM_PID_THRESHOLD}，被视为系统级进程，禁止终止`
                };
            }

            // 检查是否属于 systemd 服务
            try {
                const cgroup = fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8');
                if (cgroup.includes('system.slice/') && !cgroup.includes('user.slice')) {
                    return {
                        isSystemService: true,
                        processName: comm,
                        reason: `进程 "${comm}" (PID ${pid}) 属于 systemd 系统服务 (.slice)，终止可能影响系统功能`
                    };
                }
            } catch {}

            return { isSystemService: false, processName: comm, reason: '' };
        } catch {
            // 无法读取 /proc 时保守处理
            if (pid < 100) {
                return { isSystemService: true, processName: 'unknown', reason: `PID ${pid} 极可能是系统进程` };
            }
            return { isSystemService: false, processName: 'unknown', reason: '' };
        }
    }

    // ========================================================================
    // 5. Kill 意图解析
    // ========================================================================

    /**
     * 解析命令字符串，提取杀进程的意图信息
     */
    parseKillIntent(command: string): KillAttempt | null {
        let matchedTool = '';
        let isMassKill = false;

        // 检测是否包含 kill 命令
        const matchedPattern = KILL_COMMAND_PATTERNS.find(p => p.pattern.test(command));
        if (!matchedPattern) return null;

        matchedTool = matchedPattern.toolName;
        isMassKill = matchedPattern.isMassKillRisk;

        // 提取 PID（更精确：找 kill 工具后面的数字，而非命令中所有数字）
        const targetPids: number[] = [];
        const targetPorts: number[] = [];
        const targetProcessNames: string[] = [];

        // 方法 1: 直接通过 kill 命令参数提取 PID
        // taskkill /PID 1234, kill -9 1234, Stop-Process -Id 1234
        const explicitPidPatterns = [
            /(?:\/PID|--pid|-pid|=pid)\s+(\d+)/gi,
            /(?:\bkill\s+(?:-\d+\s+)?)(\d+)/gi,
            /-Id\s+(\d+)/gi,
        ];
        for (const pattern of explicitPidPatterns) {
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(command)) !== null) {
                const pid = parseInt(match[1], 10);
                if (pid > 0 && !targetPids.includes(pid)) {
                    targetPids.push(pid);
                }
            }
        }

        // 方法 2: 如果上面没提取到 PID，检查是否有进程名模式
        const nameMatch = command.match(/\/IM\s+(\S+)/i);
        if (nameMatch) {
            targetProcessNames.push(nameMatch[1].replace(/"/g, ''));
            isMassKill = true;
        }

        const gpNameMatch = command.match(/Get-Process\s+['"]?(\S+?)['"]?\s*\|/i);
        if (gpNameMatch) {
            targetProcessNames.push(gpNameMatch[1]);
            isMassKill = true;
        }

        const killallMatch = command.match(/killall\s+(?:-[a-zA-Z]+\s+)*(\S+)/i);
        if (killallMatch) {
            targetProcessNames.push(killallMatch[1]);
            isMassKill = true;
        }

        const pkillMatch = command.match(/pkill\s+(?:-[a-zA-Z]+\s+)*(\S+)/i);
        if (pkillMatch) {
            targetProcessNames.push(pkillMatch[1]);
            isMassKill = true;
        }

        // 方法 3: 从 kill-port / fkill 提取
        const portKillMatch = command.match(/\b(?:kill-port|fkill)\b([^|;&\n\r]*)/i);
        if (portKillMatch) {
            const numericArgs = portKillMatch[1].match(/\b\d{2,5}\b/g) || [];
            for (const rawPort of numericArgs) {
                const port = parseInt(rawPort, 10);
                if (port > 0) {
                    this.addUniqueNumber(targetPorts, port);
                    // 查询该端口对应的 PID
                    const portPids = this.queryPortPids(port);
                    for (const pid of portPids) {
                        this.addUniqueNumber(targetPids, pid);
                    }
                }
            }
        }

        // 方法 4: PowerShell 端口 → OwningProcess → Stop-Process 管道
        const netPortPatterns = [
            /\bGet-Net(?:TCPConnection|UDPEndpoint)\b[^|;&\n\r]*\b-LocalPort\s+(\d{2,5})/gi,
            /\bLocalPort\b[^|;&\n\r\d]{0,30}(\d{2,5})/gi,
        ];
        for (const pattern of netPortPatterns) {
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(command)) !== null) {
                const port = parseInt(match[1], 10);
                if (port > 0) {
                    this.addUniqueNumber(targetPorts, port);
                    const portPids = this.queryPortPids(port);
                    for (const pid of portPids) {
                        this.addUniqueNumber(targetPids, pid);
                    }
                }
            }
        }

        // 方法 5: netstat/ss/lsof/findstr/Select-String 查端口后再 taskkill/Stop-Process
        const portDiscoveryPatterns = [
            /\b(?:netstat|ss|lsof)\b[^|;&\n\r]*:(\d{2,5})\b/gi,
            /\bfindstr\b\s+['"]?:?(\d{2,5})\b/gi,
            /\bSelect-String\b[^|;&\n\r]*(?:-Pattern\s+)?['"]?:?(\d{2,5})\b/gi,
        ];
        for (const pattern of portDiscoveryPatterns) {
            let match: RegExpExecArray | null;
            while ((match = pattern.exec(command)) !== null) {
                const port = parseInt(match[1], 10);
                if (port > 0) {
                    this.addUniqueNumber(targetPorts, port);
                }
            }
        }

        // 如果完全没有提取到 PID 也没有进程名，但有 kill 关键词
        // 检查是否是 fuser -k 模式（作用于端口）
        if (targetPids.length === 0 && targetProcessNames.length === 0) {
            const fuserMatch = command.match(/fuser\s+-k\s+(\d+)\/(?:tcp|udp)/i);
            if (fuserMatch) {
                const port = parseInt(fuserMatch[1], 10);
                if (port > 0) {
                    this.addUniqueNumber(targetPorts, port);
                    const portPids = this.queryPortPids(port);
                    for (const pid of portPids) {
                        this.addUniqueNumber(targetPids, pid);
                    }
                }
            }
        }

        return {
            rawCommand: command,
            killTool: matchedTool,
            targetPids,
            targetPorts,
            targetProcessNames,
            isMassKill,
        };
    }

    // ========================================================================
    // 6. 受保护端口占用意图检测
    // ========================================================================

    /**
     * 检测命令是否试图启动用户服务并绑定 Agent 受保护端口。
     * 只拦截高置信启动/监听形态，避免影响 netstat/curl 等只读诊断命令。
     */
    evaluateProtectedPortUsage(command: string): ProtectedPortUsageVerdict {
        this.refreshProtectedPorts();
        const blockedPorts: number[] = [];

        const addIfMatched = (port: number, patterns: RegExp[]) => {
            if (patterns.some(pattern => pattern.test(command))) {
                this.addUniqueNumber(blockedPorts, port);
            }
        };

        for (const port of this.protectedPorts) {
            const portText = String(port);
            const patterns = [
                new RegExp(`(?:--port|--dev-port|--listen|--host-port|-p|-l)\\s*[=:]?\\s*['\"]?${portText}\\b`, 'i'),
                new RegExp(`\\$env:(?:PORT|VITE_PORT|DEV_PORT|SERVER_PORT|HOST_PORT)\\s*=\\s*['\"]?${portText}\\b`, 'i'),
                new RegExp(`\\b(?:PORT|VITE_PORT|DEV_PORT|SERVER_PORT|HOST_PORT)\\s*=\\s*['\"]?${portText}\\b`, 'i'),
                new RegExp(`\\b(?:python|python3|py)\\b[^|;&\\n\\r]*\\bhttp\\.server\\b[^|;&\\n\\r]*\\b${portText}\\b`, 'i'),
                new RegExp(`\\b(?:vite|next|nuxt|astro|webpack-dev-server|http-server|live-server)\\b[^|;&\\n\\r]*(?:--port|-p|--listen|-l)?[^|;&\\n\\r]*\\b${portText}\\b`, 'i'),
                new RegExp(`\\bserve\\b[^|;&\\n\\r]*(?:-l|--listen|--port|-p)\\s*${portText}\\b`, 'i'),
                new RegExp(`\\bdocker\\b[^|;&\\n\\r]*(?:-p|--publish)\\s+${portText}:\\d+\\b`, 'i'),
            ];
            addIfMatched(port, patterns);
        }

        if (blockedPorts.length > 0) {
            const portText = blockedPorts.join('/');
            return {
                allowed: false,
                reason: `[Agent 端口保护拦截] 命令试图让用户进程监听 Agent 已占用的核心端口 (${portText})。` +
                    `这些端口保留给 DeepSeek IDE Agent 的 API、终端或前端服务，写代码、启动开发服务器、Docker 映射或测试服务时都必须改用其他端口。`,
                blockedPorts,
            };
        }

        return { allowed: true, reason: '未检测到受保护端口监听意图', blockedPorts: [] };
    }

    // ========================================================================
    // 7. 综合裁决
    // ========================================================================

    /**
     * 对 kill 尝试进行综合安全性裁决
     * @returns KillVerdict — allowed 为 true 表示安全可执行
     */
    evaluate(command: string): KillVerdict {
        this.refreshProtectedPorts();
        this.refreshChildPids();
        const blockedPids: number[] = [];
        const blockedPorts: number[] = [];
        const reasons: string[] = [];

        // === 第 0 层：检测是否有 kill 意图 ===
        const killIntent = this.parseKillIntent(command);
        if (!killIntent) {
            return { allowed: true, reason: '非进程终止命令', blockedPids: [], blockedPorts: [] };
        }

        // === 第 0.5 层：端口杀进程工具/管道命中受保护端口时，先验拦截 ===
        const protectedTargetPorts = this.getProtectedMatches(killIntent.targetPorts);
        if (protectedTargetPorts.length > 0) {
            return {
                allowed: false,
                reason: `[自我保护拦截] 命令试图按端口终止 Agent 核心服务端口 (${protectedTargetPorts.join('/')})。` +
                    `禁止使用 kill-port/fkill/fuser/Get-NetTCPConnection→Stop-Process 等端口杀进程方式处理这些端口；端口冲突时请改用其他用户服务端口，或让用户手动处理。`,
                blockedPids: killIntent.targetPids,
                blockedPorts: protectedTargetPorts,
            };
        }

        if (killIntent.killTool === 'kill-port/fkill') {
            return {
                allowed: false,
                reason: `[安全拦截] 禁止使用 ${killIntent.killTool} 这类按端口匹配的杀进程工具。请先查询并确认具体 PID，且不得终止绑定 Agent 核心端口 (${this.getProtectedPortsText()}) 的进程。`,
                blockedPids: killIntent.targetPids,
                blockedPorts: [],
            };
        }

        // === 第 1 层：禁止按进程名批量杀进程（无论目标是谁） ===
        if (killIntent.isMassKill && killIntent.targetProcessNames.length > 0) {
            // 特别是 node / npm 进程
            const isNodeTarget = killIntent.targetProcessNames.some(name =>
                NODE_PROCESS_PATTERNS.some(p => p.test(name))
            );
            if (isNodeTarget) {
                return {
                    allowed: false,
                    reason: `[自我保护拦截] 严禁使用进程名批量杀死 node / npm 进程！Agent 本层环境及通信服务也是 Node 进程，这类操作会无差别干掉 Agent 宿主环境导致整个 IDE 与对话当场死机闪退。若有端口占用冲突，请让用户手动清理或重启服务。`,
                    blockedPids: [],
                    blockedPorts: this.protectedPorts,
                };
            }
            // 其他进程名的批量杀也禁止
            return {
                allowed: false,
                reason: `[安全拦截] 禁止按进程名 "${killIntent.targetProcessNames.join(', ')}" 批量终止进程。请明确指定要终止的 PID（进程 ID）。使用 tasklist / ps 先查询进程，确认具体 PID 后再操作。`,
                blockedPids: [],
                blockedPorts: [],
            };
        }

        // === 第 2 层：必须有明确的 PID ===
        if (killIntent.targetPids.length === 0) {
            return {
                allowed: false,
                reason: `[安全拦截] 终止进程必须明确指定 PID（进程 ID）。请先用 tasklist (Windows) 或 ps aux (Linux/macOS) 查询目标进程的 PID，然后使用 /PID <pid> 或 -Id <pid> 参数精确终止。禁止使用模糊匹配或进程名来杀进程。`,
                blockedPids: [],
                blockedPorts: [],
            };
        }

        // === 第 3 层：逐个检查每个目标 PID ===
        for (const pid of killIntent.targetPids) {
            // 3a. 系统服务检测
            const sysCheck = this.checkSystemProcess(pid);
            if (sysCheck.isSystemService) {
                blockedPids.push(pid);
                reasons.push(sysCheck.reason);
                continue;
            }

            // 3b. Agent 自身/子进程检测
            if (this.isSelfOrChild(pid)) {
                blockedPids.push(pid);
                reasons.push(
                    `[自我保护拦截] PID ${pid} 是 Agent 运行时进程（自身或子进程），终止它会导致当前对话立即中断、DeepSeek IDE 失去响应。`
                );
                continue;
            }

            // 3c. 受保护端口绑定检测
            const bindings = this.queryPidPortBindings(pid);
            const protectedBindings = bindings.filter(b => this.protectedPorts.includes(b.port));
            if (protectedBindings.length > 0) {
                blockedPids.push(pid);
                const conflictPorts = [...new Set(protectedBindings.map(b => b.port))];
                blockedPorts.push(...conflictPorts);
                reasons.push(
                    `[自我保护拦截] PID ${pid} 绑定了 Agent 内部核心服务端口 (${conflictPorts.join('/')})！` +
                    `强杀会导致对应服务网络断开或 Agent 瘫痪。请考虑其他方式或让用户手动处理。`
                );
                continue;
            }
        }

        if (blockedPids.length > 0) {
            return {
                allowed: false,
                reason: reasons.join('\n'),
                blockedPids,
                blockedPorts: [...new Set(blockedPorts)],
            };
        }

        // === 第 4 层：额外安全检查 ===
        // 4a. 检查目标 PID 的进程名是否可疑（即使端口不匹配）
        // （已在上面覆盖）

        return {
            allowed: true,
            reason: `安全检查通过。目标 PID ${killIntent.targetPids.join(', ')} 不涉及 Agent 服务端口或系统服务。`,
            blockedPids: [],
            blockedPorts: [],
        };
    }

    // ========================================================================
    // 8. 简便入口：执行前拦截
    // ========================================================================

    /**
     * 在命令执行前进行一次安全检查
     * 如果命令试图杀死受保护的进程，直接抛出错误
     */
    guard(command: string): void {
        const portUsageVerdict = this.evaluateProtectedPortUsage(command);
        if (!portUsageVerdict.allowed) {
            throw new Error(portUsageVerdict.reason);
        }

        const verdict = this.evaluate(command);
        if (!verdict.allowed) {
            throw new Error(verdict.reason);
        }
    }
}

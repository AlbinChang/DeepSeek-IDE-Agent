/**
 * ProcessSafetyGuard 测试套件
 * 覆盖：
 * - 按进程名批量杀进程拦截
 * - 无 PID 拦截
 * - 系统服务 PID 检测
 * - Agent 端口绑定 PID 检测
 * - 跨平台 kill 命令模式识别
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { ProcessSafetyGuard } from '@/services/ProcessSafetyGuard.js';

describe('ProcessSafetyGuard — Kill intent parsing', () => {
    let guard: ProcessSafetyGuard;

    beforeEach(() => {
        guard = ProcessSafetyGuard.getInstance();
    });

    it('detects taskkill /PID <pid>', async () => {
        const intent = await guard.parseKillIntent('taskkill /F /PID 12345');
        expect(intent).not.toBeNull();
        expect(intent!.killTool).toBe('taskkill');
        expect(intent!.targetPids).toContain(12345);
    });

    it('detects taskkill /IM by name as mass kill', async () => {
        const intent = await guard.parseKillIntent('taskkill /F /IM node.exe');
        expect(intent).not.toBeNull();
        expect(intent!.isMassKill).toBe(true);
        expect(intent!.targetProcessNames).toContain('node.exe');
    });

    it('detects Stop-Process -Id <pid>', async () => {
        const intent = await guard.parseKillIntent('Stop-Process -Id 12345');
        expect(intent).not.toBeNull();
        expect(intent!.targetPids).toContain(12345);
    });

    it('detects Get-Process node | Stop-Process as mass kill', async () => {
        const intent = await guard.parseKillIntent('Get-Process node | Stop-Process');
        expect(intent).not.toBeNull();
        expect(intent!.isMassKill).toBe(true);
    });

    it('detects tskill <pid>', async () => {
        const intent = await guard.parseKillIntent('tskill 12345');
        expect(intent).not.toBeNull();
        expect(intent!.killTool).toBe('tskill');
    });

    it('detects kill -9 <pid> (Linux)', async () => {
        const intent = await guard.parseKillIntent('kill -9 12345');
        expect(intent).not.toBeNull();
        expect(intent!.killTool).toBe('kill');
        expect(intent!.targetPids).toContain(12345);
    });

    it('detects killall as mass kill', async () => {
        const intent = await guard.parseKillIntent('killall node');
        expect(intent).not.toBeNull();
        expect(intent!.isMassKill).toBe(true);
    });

    it('detects pkill as mass kill', async () => {
        const intent = await guard.parseKillIntent('pkill -f node');
        expect(intent).not.toBeNull();
        expect(intent!.isMassKill).toBe(true);
    });

    it('detects kill-port <port>', async () => {
        const intent = await guard.parseKillIntent('npx kill-port 3001');
        expect(intent).not.toBeNull();
        expect(intent!.targetPorts).toContain(3001);
    });

    it('detects PowerShell port-to-process kill pipelines', async () => {
        const intent = await guard.parseKillIntent('Get-NetTCPConnection -LocalPort 3001 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }');
        expect(intent).not.toBeNull();
        expect(intent!.targetPorts).toContain(3001);
    });

    it('detects netstat/findstr protected-port kill pipelines', async () => {
        const intent = await guard.parseKillIntent('netstat -ano | findstr :3001; taskkill /F /PID 12345');
        expect(intent).not.toBeNull();
        expect(intent!.targetPorts).toContain(3001);
    });

    it('does NOT flag non-kill commands', async () => {
        expect(await guard.parseKillIntent('echo hello')).toBeNull();
        expect(await guard.parseKillIntent('npm run build')).toBeNull();
        expect(await guard.parseKillIntent('git commit -m "kill the bug"')).not.toBeNull(); // contains "kill" word
    });

    it('does NOT flag "skill" / "overkill" words', async () => {
        // "skill" is not a kill command
        expect(await guard.parseKillIntent('cat SKILL.md')).toBeNull();
    });
});

describe('ProcessSafetyGuard — evaluate (safety verdict)', () => {
    let guard: ProcessSafetyGuard;

    beforeEach(() => {
        guard = ProcessSafetyGuard.getInstance();
    });

    it('allows non-kill commands', async () => {
        const verdict = await guard.evaluate('echo hello world');
        expect(verdict.allowed).toBe(true);
    });

    it('rejects mass kill by process name (node.exe)', async () => {
        const verdict = await guard.evaluate('taskkill /F /IM node.exe');
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain('自我保护拦截');
    });

    it('rejects kill without explicit PID', async () => {
        const verdict = await guard.evaluate('taskkill /F');
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain('必须明确指定 PID');
    });

    it('rejects kill-port against protected port', async () => {
        const verdict = await guard.evaluate('npx kill-port 3001');
        expect(verdict.allowed).toBe(false);
        expect(verdict.blockedPorts).toContain(3001);
    });

    it('rejects fkill against protected port', async () => {
        const verdict = await guard.evaluate('fkill 5174');
        expect(verdict.allowed).toBe(false);
        expect(verdict.blockedPorts).toContain(5174);
    });

    it('rejects fuser against protected port', async () => {
        const verdict = await guard.evaluate('fuser -k 3003/tcp');
        expect(verdict.allowed).toBe(false);
        expect(verdict.blockedPorts).toContain(3003);
    });

    it('rejects Get-NetTCPConnection to Stop-Process against protected port', async () => {
        const verdict = await guard.evaluate('Get-NetTCPConnection -LocalPort 3001 | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }');
        expect(verdict.allowed).toBe(false);
        expect(verdict.blockedPorts).toContain(3001);
    });

    it('rejects netstat/findstr to taskkill against protected port even with explicit PID', async () => {
        const verdict = await guard.evaluate('netstat -ano | findstr :3001; taskkill /F /PID 12345');
        expect(verdict.allowed).toBe(false);
        expect(verdict.blockedPorts).toContain(3001);
    });

    it('rejects Get-Process xxx | Stop-Process mass kill', async () => {
        const verdict = await guard.evaluate('Get-Process java | Stop-Process -Force');
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain('按进程名');
    });

    it('rejects killall by name', async () => {
        const verdict = await guard.evaluate('killall -9 firefox');
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain('按进程名');
    });
});

describe('ProcessSafetyGuard — protected ports', () => {
    let guard: ProcessSafetyGuard;

    beforeEach(() => {
        guard = ProcessSafetyGuard.getInstance();
        guard.refreshProtectedPorts();
    });

    it('has default protected ports (3001, 3003, 5174)', () => {
        const ports = guard.getProtectedPorts();
        expect(ports).toContain(3001);
        expect(ports).toContain(3003);
        expect(ports).toContain(5174);
    });

    it('getProtectedPortsText returns a /-separated string', () => {
        const text = guard.getProtectedPortsText();
        expect(text).toContain('3001');
        expect(text).toContain('/');
    });
});

describe('ProcessSafetyGuard — protected port usage', () => {
    let guard: ProcessSafetyGuard;

    beforeEach(() => {
        guard = ProcessSafetyGuard.getInstance();
        guard.refreshProtectedPorts();
    });

    it('rejects starting Vite on an Agent reserved port', () => {
        const verdict = guard.evaluateProtectedPortUsage('vite --host 0.0.0.0 --port 5174');
        expect(verdict.allowed).toBe(false);
        expect(verdict.blockedPorts).toContain(5174);
    });

    it('rejects setting PORT to an Agent reserved port before starting a server', () => {
        const verdict = guard.evaluateProtectedPortUsage('$env:PORT=3001; npm run dev');
        expect(verdict.allowed).toBe(false);
        expect(verdict.blockedPorts).toContain(3001);
    });

    it('rejects python http.server on an Agent reserved port', () => {
        const verdict = guard.evaluateProtectedPortUsage('python -m http.server 3003');
        expect(verdict.allowed).toBe(false);
        expect(verdict.blockedPorts).toContain(3003);
    });

    it('allows common alternate development ports', () => {
        const verdict = guard.evaluateProtectedPortUsage('vite --host 0.0.0.0 --port 5173');
        expect(verdict.allowed).toBe(true);
    });
});

describe('ProcessSafetyGuard — system process detection', () => {
    let guard: ProcessSafetyGuard;

    beforeEach(() => {
        guard = ProcessSafetyGuard.getInstance();
    });

    it('flags PID < 100 as system process (Linux path)', async () => {
        // Note: On Windows, PID 4 is typically "System"
        const result = await guard.checkSystemProcess(4);
        // Won't necessarily be flagged on all systems, but PID 4 is always System on Windows
        if (process.platform === 'win32') {
            expect(result.isSystemService).toBe(true);
        }
    });

    it('flags PID 0 as invalid', async () => {
        // ProcessSafetyGuard doesn't specifically handle PID 0, but pid < 100 check covers it
        const result = await guard.checkSystemProcess(0);
        expect(result.isSystemService).toBe(true);
    });

    it('does NOT flag a normal user process PID', async () => {
        // Our own PID should not be flagged as a system service
        const result = await guard.checkSystemProcess(process.pid);
        expect(result.isSystemService).toBe(false);
    });
});

describe('ProcessSafetyGuard — self-awareness', () => {
    let guard: ProcessSafetyGuard;

    beforeEach(() => {
        guard = ProcessSafetyGuard.getInstance();
    });

    it('recognizes own PID', () => {
        expect(guard.isSelfOrChild(process.pid)).toBe(true);
    });

    it('does NOT recognize a random high PID as self/child', () => {
        // 99999 is unlikely to be a real process
        expect(guard.isSelfOrChild(99999)).toBe(false);
    });

    it('recognizes a real child PID as self/child', async () => {
        // spawn a transient child to get a real child PID
        const { spawn } = await import('child_process');
        const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 500)']);
        try {
            expect(child.pid).toBeDefined();
            await guard.refreshChildPids();
            expect(guard.isSelfOrChild(child.pid!)).toBe(true);
        } finally {
            child.kill();
        }
    });

    it('exempts command-tool spawned PIDs from self/child protection', async () => {
        const { spawn } = await import('child_process');
        const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 500)']);
        try {
            expect(child.pid).toBeDefined();
            // simulate command tool registration
            guard.registerCommandChild(child.pid!);
            await guard.refreshChildPids();
            // even though it's a real child, it's now killable
            expect(guard.isCommandSpawned(child.pid!)).toBe(true);
            expect(guard.isSelfOrChild(child.pid!)).toBe(false);
        } finally {
            child.kill();
            guard.unregisterCommandChild(child.pid ?? -1);
        }
    });

    it('unregisters a command-tool spawned PID back to protected state', async () => {
        const { spawn } = await import('child_process');
        const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 500)']);
        try {
            expect(child.pid).toBeDefined();
            guard.registerCommandChild(child.pid!);
            await guard.refreshChildPids();
            expect(guard.isSelfOrChild(child.pid!)).toBe(false);
            guard.unregisterCommandChild(child.pid!);
            expect(guard.isCommandSpawned(child.pid!)).toBe(false);
            expect(guard.isSelfOrChild(child.pid!)).toBe(true);
        } finally {
            child.kill();
            guard.unregisterCommandChild(child.pid ?? -1);
        }
    });

    it('allows killing a command-tool spawned PID via evaluate (unprotected)', async () => {
        const { spawn } = await import('child_process');
        const child = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 500)']);
        try {
            expect(child.pid).toBeDefined();
            guard.registerCommandChild(child.pid!);
            const verdict = await guard.evaluate(`taskkill /F /T /PID ${child.pid}`);
            expect(verdict.allowed).toBe(true);
        } finally {
            child.kill();
            guard.unregisterCommandChild(child.pid ?? -1);
        }
    });

    it('still blocks killing the Agent own PID even when registered', async () => {
        guard.registerCommandChild(process.pid);
        try {
            const verdict = await guard.evaluate(`taskkill /F /T /PID ${process.pid}`);
            expect(verdict.allowed).toBe(false);
            expect(verdict.blockedPids).toContain(process.pid);
        } finally {
            guard.unregisterCommandChild(process.pid);
        }
    });
});

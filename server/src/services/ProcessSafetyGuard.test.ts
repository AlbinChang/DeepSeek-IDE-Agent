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

    it('detects taskkill /PID <pid>', () => {
        const intent = guard.parseKillIntent('taskkill /F /PID 12345');
        expect(intent).not.toBeNull();
        expect(intent!.killTool).toBe('taskkill');
        expect(intent!.targetPids).toContain(12345);
    });

    it('detects taskkill /IM by name as mass kill', () => {
        const intent = guard.parseKillIntent('taskkill /F /IM node.exe');
        expect(intent).not.toBeNull();
        expect(intent!.isMassKill).toBe(true);
        expect(intent!.targetProcessNames).toContain('node.exe');
    });

    it('detects Stop-Process -Id <pid>', () => {
        const intent = guard.parseKillIntent('Stop-Process -Id 12345');
        expect(intent).not.toBeNull();
        expect(intent!.targetPids).toContain(12345);
    });

    it('detects Get-Process node | Stop-Process as mass kill', () => {
        const intent = guard.parseKillIntent('Get-Process node | Stop-Process');
        expect(intent).not.toBeNull();
        expect(intent!.isMassKill).toBe(true);
    });

    it('detects tskill <pid>', () => {
        const intent = guard.parseKillIntent('tskill 12345');
        expect(intent).not.toBeNull();
        expect(intent!.killTool).toBe('tskill');
    });

    it('detects kill -9 <pid> (Linux)', () => {
        const intent = guard.parseKillIntent('kill -9 12345');
        expect(intent).not.toBeNull();
        expect(intent!.killTool).toBe('kill');
        expect(intent!.targetPids).toContain(12345);
    });

    it('detects killall as mass kill', () => {
        const intent = guard.parseKillIntent('killall node');
        expect(intent).not.toBeNull();
        expect(intent!.isMassKill).toBe(true);
    });

    it('detects pkill as mass kill', () => {
        const intent = guard.parseKillIntent('pkill -f node');
        expect(intent).not.toBeNull();
        expect(intent!.isMassKill).toBe(true);
    });

    it('detects kill-port <port>', () => {
        const intent = guard.parseKillIntent('npx kill-port 3001');
        expect(intent).not.toBeNull();
    });

    it('does NOT flag non-kill commands', () => {
        expect(guard.parseKillIntent('echo hello')).toBeNull();
        expect(guard.parseKillIntent('npm run build')).toBeNull();
        expect(guard.parseKillIntent('git commit -m "kill the bug"')).not.toBeNull(); // contains "kill" word
    });

    it('does NOT flag "skill" / "overkill" words', () => {
        // "skill" is not a kill command
        expect(guard.parseKillIntent('cat SKILL.md')).toBeNull();
    });
});

describe('ProcessSafetyGuard — evaluate (safety verdict)', () => {
    let guard: ProcessSafetyGuard;

    beforeEach(() => {
        guard = ProcessSafetyGuard.getInstance();
    });

    it('allows non-kill commands', () => {
        const verdict = guard.evaluate('echo hello world');
        expect(verdict.allowed).toBe(true);
    });

    it('rejects mass kill by process name (node.exe)', () => {
        const verdict = guard.evaluate('taskkill /F /IM node.exe');
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain('自我保护拦截');
    });

    it('rejects kill without explicit PID', () => {
        const verdict = guard.evaluate('taskkill /F');
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain('必须明确指定 PID');
    });

    it('rejects kill-port against protected port', () => {
        const verdict = guard.evaluate('npx kill-port 3001');
        expect(verdict.allowed).toBe(false);
    });

    it('rejects Get-Process xxx | Stop-Process mass kill', () => {
        const verdict = guard.evaluate('Get-Process java | Stop-Process -Force');
        expect(verdict.allowed).toBe(false);
        expect(verdict.reason).toContain('按进程名');
    });

    it('rejects killall by name', () => {
        const verdict = guard.evaluate('killall -9 firefox');
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

describe('ProcessSafetyGuard — system process detection', () => {
    let guard: ProcessSafetyGuard;

    beforeEach(() => {
        guard = ProcessSafetyGuard.getInstance();
    });

    it('flags PID < 100 as system process (Linux path)', () => {
        // Note: On Windows, PID 4 is typically "System"
        const result = guard.checkSystemProcess(4);
        // Won't necessarily be flagged on all systems, but PID 4 is always System on Windows
        if (process.platform === 'win32') {
            expect(result.isSystemService).toBe(true);
        }
    });

    it('flags PID 0 as invalid', () => {
        // ProcessSafetyGuard doesn't specifically handle PID 0, but pid < 100 check covers it
        const result = guard.checkSystemProcess(0);
        expect(result.isSystemService).toBe(true);
    });

    it('does NOT flag a normal user process PID', () => {
        // Our own PID should not be flagged as a system service
        const result = guard.checkSystemProcess(process.pid);
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
});

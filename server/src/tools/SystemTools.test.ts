import { describe, expect, it, vi } from 'vitest';

import { SystemTools, terminatePosixCommandGroup } from '@/tools/SystemTools.js';
import { ProcessSafetyGuard } from '@/services/ProcessSafetyGuard.js';

describe('SystemTools.executePowerShellCommand validation', () => {
    it('rejects missing timeout', async () => {
        await expect(SystemTools.executePowerShellCommand('echo hello', process.cwd(), undefined, 0, null)).rejects.toThrow(
            'timeout 为必填项'
        );
    });

    it('rejects nested shell launchers inside command text', async () => {
        await expect(SystemTools.executePowerShellCommand('powershell -Command "echo hello"', process.cwd(), undefined, 30000, null)).rejects.toThrow(
            'command 中禁止再嵌套 shell 启动器'
        );
    });
});

describe('SystemTools.executePowerShellCommand runtime options', () => {
    it('does not spawn a command when already cancelled', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(SystemTools.executePowerShellCommand(
            'Write-Output not-run', process.cwd(), undefined, 30_000, null, undefined, undefined, controller.signal,
        )).rejects.toThrow('命令已被取消');
    });

    it('passes extra environment variables to the child shell', async () => {
        const result = await SystemTools.executePowerShellCommand(
            'Write-Output $env:WORKFLOW_TEST_ENV',
            process.cwd(),
            undefined,
            30_000,
            null,
            undefined,
            { WORKFLOW_TEST_ENV: 'env-ok' },
        );
        expect(result.status).toBe('success');
        expect(result.stdout).toContain('env-ok');
    });

    describe('POSIX command process groups', () => {
        it('terminates the owned process group rather than only the shell', () => {
            const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
            const child = { pid: 12345, kill: vi.fn() };
            try {
                terminatePosixCommandGroup(child, 'test');
                expect(kill).toHaveBeenCalledWith(-12345, 'SIGKILL');
                expect(child.kill).not.toHaveBeenCalled();
            } finally {
                kill.mockRestore();
            }
        });
    });

    it('kills the command when the abort signal fires', async () => {
        const controller = new AbortController();
        const started = Date.now();
        const guard = vi.spyOn(ProcessSafetyGuard.getInstance(), 'guard').mockResolvedValue(undefined);
        try {
            const pending = SystemTools.executePowerShellCommand(
                'Start-Sleep -Seconds 30',
                process.cwd(),
                undefined,
                60_000,
                null,
                undefined,
                undefined,
                controller.signal,
            );
            setTimeout(() => controller.abort(), 100);
            const result = await pending;
            expect(result.status).toBe('error');
            expect(Date.now() - started).toBeLessThan(10_000);
            expect(JSON.stringify(result)).toContain('取消');
        } finally {
            guard.mockRestore();
        }
    });
});

describe('SystemTools.executeCmdCommand validation', () => {
    it('rejects missing timeout', async () => {
        await expect(SystemTools.executeCmdCommand('echo hello', process.cwd(), undefined, 0, null)).rejects.toThrow(
            'timeout 为必填项'
        );
    });

    it('rejects nested shell launchers inside command text', async () => {
        await expect(SystemTools.executeCmdCommand('cmd /c "echo hello"', process.cwd(), undefined, 30000, null)).rejects.toThrow(
            'command 中禁止再嵌套 shell 启动器'
        );
    });
});
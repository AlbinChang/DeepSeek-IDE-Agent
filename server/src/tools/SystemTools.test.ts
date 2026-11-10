import { describe, expect, it } from 'vitest';

import { SystemTools } from '@/tools/SystemTools.js';

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

    it('kills the command when the abort signal fires', async () => {
        const controller = new AbortController();
        const started = Date.now();
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
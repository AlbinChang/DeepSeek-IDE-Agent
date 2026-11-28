import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { PowerShellSessionManager } from '@/services/PowerShellSessionManager.js';

const manager = PowerShellSessionManager.getInstance();
const isWindows = process.platform === 'win32';
const uniqueUser = () => `ps-session-test-${Math.random().toString(36).slice(2)}`;

describe.skipIf(!isWindows)('PowerShellSessionManager', () => {
    afterAll(() => manager.disposeAll());

    it('reuses one host across commands and isolates per-command state', async () => {
        const user = uniqueUser();
        const cwd = process.cwd();
        const before = manager.getStats().started;

        const first = await manager.run(user, {
            command: 'Write-Output "one"',
            cwd,
            timeout: 30_000,
        });
        const second = await manager.run(user, {
            command: 'Write-Output "two"',
            cwd,
            timeout: 30_000,
        });
        expect(first.stdout.toString()).toContain('one');
        expect(second.stdout.toString()).toContain('two');
        expect(first.status).toBe('success');
        expect(second.status).toBe('success');

        await manager.run(user, {
            command: '$agentLeak = "leak-value"; Write-Output "set"',
            cwd,
            timeout: 30_000,
        });
        const leak = await manager.run(user, {
            command: 'Write-Output ("leak=" + $agentLeak)',
            cwd,
            timeout: 30_000,
        });
        expect(leak.stdout.toString()).toContain('leak=');
        expect(leak.stdout.toString()).not.toContain('leak-value');

        const location = await manager.run(user, {
            command: '(Get-Location).Path',
            cwd,
            timeout: 30_000,
        });
        expect(location.stdout.toString()).toContain(cwd);

        const dir = await mkdtemp(path.join(tmpdir(), 'agent-ps-cwd-'));
        try {
            await writeFile(path.join(dir, 'probe.txt'), 'cwd-ok', 'utf8');
            const dotnet = await manager.run(user, {
                command: '[System.IO.File]::ReadAllText("probe.txt")',
                cwd: dir,
                timeout: 30_000,
            });
            expect(dotnet.stdout.toString()).toContain('cwd-ok');
        } finally {
            await rm(dir, { recursive: true, force: true });
        }

        // 多条命令、不同 cwd，宿主进程始终只有一个
        expect(manager.getStats().started - before).toBe(1);
        manager.disposeUser(user);
    });

    it('captures stderr and exit codes, and restores env per command', async () => {
        const user = uniqueUser();

        const failed = await manager.run(user, {
            command: 'Write-Error "boom-error"',
            cwd: process.cwd(),
            timeout: 30_000,
        });
        expect(failed.stderr.toString()).toContain('boom-error');

        const nativeExit = await manager.run(user, {
            command: 'node -e "process.exit(3)"',
            cwd: process.cwd(),
            timeout: 30_000,
        });
        expect(nativeExit.code).toBe(3);
        expect(nativeExit.status).toBe('error');

        const withEnv = await manager.run(user, {
            command: 'Write-Output $env:AGENT_PS_TEST_ENV',
            cwd: process.cwd(),
            timeout: 30_000,
            extraEnv: { AGENT_PS_TEST_ENV: 'env-ok' },
        });
        expect(withEnv.stdout.toString()).toContain('env-ok');

        const withoutEnv = await manager.run(user, {
            command: 'Write-Output ("v=" + $env:AGENT_PS_TEST_ENV)',
            cwd: process.cwd(),
            timeout: 30_000,
        });
        expect(withoutEnv.stdout.toString()).toContain('v=');
        expect(withoutEnv.stdout.toString()).not.toContain('env-ok');

        await manager.run(user, {
            command: '$env:AGENT_PS_LEAK = "leaked"; Write-Output "set"',
            cwd: process.cwd(),
            timeout: 30_000,
        });
        const envLeak = await manager.run(user, {
            command: 'Write-Output ("leak=" + $env:AGENT_PS_LEAK)',
            cwd: process.cwd(),
            timeout: 30_000,
        });
        expect(envLeak.stdout.toString()).toContain('leak=');
        expect(envLeak.stdout.toString()).not.toContain('leaked');
        manager.disposeUser(user);
    });

    it('prewarms a session without running a command and reuses it', async () => {
        const user = uniqueUser();
        const before = manager.getStats().started;

        expect(await manager.prewarm(user)).toBe(true);
        expect(manager.isReady(user)).toBe(true);

        const result = await manager.run(user, {
            command: 'Write-Output "warm"',
            cwd: process.cwd(),
            timeout: 30_000,
        });
        expect(result.stdout.toString()).toContain('warm');
        expect(manager.getStats().started - before).toBe(1);
        manager.disposeUser(user);
    });

    it('kills and restarts the host after a timeout', async () => {
        const user = uniqueUser();
        const before = manager.getStats().started;

        const timedOut = await manager.run(user, {
            command: 'Start-Sleep -Seconds 30',
            cwd: process.cwd(),
            timeout: 300,
        });
        expect(timedOut.timedOut).toBe(true);
        expect(timedOut.status).toBe('error');

        const after = await manager.run(user, {
            command: 'Write-Output "alive"',
            cwd: process.cwd(),
            timeout: 30_000,
        });
        expect(after.status).toBe('success');
        expect(after.stdout.toString()).toContain('alive');
        expect(manager.getStats().started - before).toBe(2);
        manager.disposeUser(user);
    });

    it('honours abort signals and stays usable afterwards', async () => {
        const user = uniqueUser();
        const controller = new AbortController();
        setTimeout(() => controller.abort(), 150);

        const aborted = await manager.run(user, {
            command: 'Start-Sleep -Seconds 30',
            cwd: process.cwd(),
            timeout: 30_000,
            abortSignal: controller.signal,
        });
        expect(aborted.aborted).toBe(true);
        expect(aborted.status).toBe('error');

        const next = await manager.run(user, {
            command: 'Write-Output "after-abort"',
            cwd: process.cwd(),
            timeout: 30_000,
        });
        expect(next.stdout.toString()).toContain('after-abort');
        manager.disposeUser(user);
    });

    it('routes exit statements and .ps1 scripts to one-shot spawn', () => {
        expect(PowerShellSessionManager.shouldUseSession('Get-ChildItem')).toBe(true);
        expect(PowerShellSessionManager.shouldUseSession('exit 1')).toBe(false);
        expect(PowerShellSessionManager.shouldUseSession('if ($x) { exit 2 }')).toBe(false);
        expect(PowerShellSessionManager.shouldUseSession('& .\\build.ps1')).toBe(false);
    });
});

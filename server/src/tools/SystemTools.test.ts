import { afterAll, describe, expect, it, vi } from 'vitest';
import iconv from 'iconv-lite';

import {
    SystemTools,
    buildEncodingHint,
    buildFailureHints,
    decodeCommandOutput,
    findDestructiveCommand,
    terminatePosixCommandGroup,
} from '@/tools/SystemTools.js';
import { ProcessSafetyGuard } from '@/services/ProcessSafetyGuard.js';
import { PowerShellSessionManager } from '@/services/PowerShellSessionManager.js';

afterAll(() => {
    // 首次 PowerShell 命令会后台预热长驻宿主，测试结束统一释放，避免影响其他用例。
    PowerShellSessionManager.getInstance().disposeAll();
});

describe('SystemTools failure hints', () => {
    it('suggests writing a file for broken inline python', () => {
        const hint = buildFailureHints(
            'python -c "print(1)"',
            'partial',
            'IndentationError: expected an indented block',
        );
        expect(hint).toContain('.py');
        expect(hint).toContain('部分输出');
    });

    it('suggests guarding missing paths', () => {
        const hint = buildFailureHints(
            'Get-Content .temp/missing.json',
            'other output',
            'Get-Content : Cannot find path ... because it does not exist.',
        );
        expect(hint).toContain('Test-Path');
    });

    it('suggests retry/backoff for network failures', () => {
        const hint = buildFailureHints(
            'python collect.py',
            '',
            'HTTPSConnectionPool(host=\'push2.eastmoney.com\'): Max retries exceeded',
        );
        expect(hint).toContain('重试');
    });

    it('本地子进程超时不会被误判成「外部接口不可达」', () => {
        // 真实故障（2026-11-26）：Chrome 被相对路径的 --user-data-dir 卡在错误对话框上，
        // Python 抛 subprocess.TimeoutExpired，旧逻辑因为匹配 "timed out" 给出了网络建议。
        const stderr = [
            'Traceback (most recent call last):',
            'subprocess.TimeoutExpired: Command \'[\'C:/Program Files/Google/Chrome/Application/chrome.exe\', '
            + '\'--headless=new\', \'--user-data-dir=.temp/render/edge-profile\']\' timed out after 90 seconds',
        ].join('\n');
        const hint = buildFailureHints('python render_png.py --run-dir .temp/x', '', stderr);
        expect(hint).not.toContain('外部接口不可达');
        expect(hint).toContain('子进程超时');
        expect(hint).toContain('绝对路径');
    });

    it('adds nothing for unrecognized failures', () => {
        expect(buildFailureHints('echo hi', '', 'boom')).toBe('');
    });
});

describe('SystemTools encoding hints', () => {
    it('suggests read_file / explicit -Encoding for Get-Content without encoding', () => {
        const hint = buildEncodingHint('Get-Content docs/需求.md', '中文内容', '');
        expect(hint).toContain('read_file');
        expect(hint).toContain('-Encoding Default');
        expect(hint).toContain('-Encoding UTF8');
    });

    it('does not nag when the command already specifies -Encoding', () => {
        expect(buildEncodingHint('Get-Content -Encoding UTF8 docs/a.md', '中文内容', '')).toBe('');
        expect(buildEncodingHint('Get-Content -Encoding Default docs/a.md', '中文内容', '')).toBe('');
    });

    it('does not nag for ASCII output or non-reader commands', () => {
        expect(buildEncodingHint('Get-Content docs/a.txt', 'plain ascii', '')).toBe('');
        expect(buildEncodingHint('git log --pretty=format:', '中文提交信息', '')).toBe('');
    });

    it('flags replacement characters regardless of command shape', () => {
        const hint = buildEncodingHint('echo test', '\uFFFD\uFFFD\uFFFD', '');
        expect(hint).toContain('read_file');
        expect(hint).not.toContain('-Encoding Default');
    });
});

describe('SystemTools command output encoding', () => {
    it('decodes GBK command output bytes instead of assuming UTF-8', () => {
        const text = '中文编码测试：GBK 输出';
        expect(decodeCommandOutput(iconv.encode(text, 'gbk'))).toContain(text);
        expect(decodeCommandOutput(Buffer.from(text, 'utf8'))).toContain(text);
    });

    it('strips ANSI escapes after decoding', () => {
        const raw = Buffer.concat([Buffer.from('\x1b[31m'), iconv.encode('中文', 'gbk'), Buffer.from('\x1b[0m')]);
        expect(decodeCommandOutput(raw)).toBe('中文');
    });
});

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

    it.skipIf(process.platform !== 'win32')('reuses one long-lived PowerShell host across regular commands', async () => {
        const user = 'systemtools-session-reuse';
        const manager = PowerShellSessionManager.getInstance();
        try {
            expect(await manager.prewarm(user)).toBe(true);

            const first = await SystemTools.executePowerShellCommand(
                'Write-Output $PID', process.cwd(), user, 30_000, null,
            );
            const second = await SystemTools.executePowerShellCommand(
                'Write-Output $PID', process.cwd(), user, 30_000, null,
            );

            expect(first.status).toBe('success');
            expect(second.status).toBe('success');
            expect(first.stdout.trim()).toBe(second.stdout.trim());
        } finally {
            manager.disposeUser(user);
        }
    }, 30_000);

    it.skipIf(process.platform !== 'win32')('keeps exit-code semantics for commands that call exit', async () => {
        const result = await SystemTools.executePowerShellCommand(
            'exit 5', process.cwd(), undefined, 30_000, null,
        );

        expect(result.status).toBe('error');
        expect(result.code).toBe(5);
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

    it('blocks real disk formatting before spawning the shell', async () => {
        await expect(SystemTools.executeCmdCommand('format D:', process.cwd(), undefined, 30000, null)).rejects.toThrow(
            '稳定性拦截'
        );
    });
});

describe('SystemTools destructive command detection', () => {
    it('does not mistake git --pretty=format: for the disk format command', () => {
        // 生产日志回归：cmd/powershell 都被误拦截，模型只能反复猜关键词
        expect(findDestructiveCommand(
            'git log --since=2026-09-27 --name-only --pretty=format: > .command/output.txt'
        )).toBeNull();
        expect(findDestructiveCommand('git log --pretty=format:"%h %s" -5')).toBeNull();
        expect(findDestructiveCommand(
            'git log --name-only --since=2026-09-27 --pretty=format: | Select-Object -First 5'
        )).toBeNull();
    });

    it('ignores the word format/shutdown in comments, strings and arguments', () => {
        expect(findDestructiveCommand(
            '# Parse report files to check the format\nGet-Content "report.txt" -TotalCount 5'
        )).toBeNull();
        expect(findDestructiveCommand('git commit -m "format the code; shutdown handling"')).toBeNull();
        expect(findDestructiveCommand('dotnet format')).toBeNull();
        expect(findDestructiveCommand('Get-ChildItem | Format-Table Name, Length')).toBeNull();
    });

    it('still blocks real disk formatting', () => {
        expect(findDestructiveCommand('format D:')).toBe('format（磁盘格式化）');
        expect(findDestructiveCommand('Format /q C:')).toBe('format（磁盘格式化）');
        expect(findDestructiveCommand('C:\\Windows\\System32\\format.com D:')).toBe('format（磁盘格式化）');
        expect(findDestructiveCommand('cmd /c "format D:"')).toBe('format（磁盘格式化）');
    });

    it('still blocks destructive commands', () => {
        expect(findDestructiveCommand('rm -rf /')).not.toBeNull();
        expect(findDestructiveCommand('sudo rm -rf /etc')).not.toBeNull();
        expect(findDestructiveCommand('mkfs.ext4 /dev/sdb1')).not.toBeNull();
        expect(findDestructiveCommand('dd if=/dev/zero of=/dev/sda')).not.toBeNull();
        expect(findDestructiveCommand('shutdown /s /t 0')).not.toBeNull();
        expect(findDestructiveCommand('net user attacker P@ss /add')).not.toBeNull();
        expect(findDestructiveCommand('reg add HKLM\\Software\\X /v Y /d 1')).not.toBeNull();
        expect(findDestructiveCommand('icacls C:\\Windows /grant Everyone:F')).not.toBeNull();
        expect(findDestructiveCommand(':(){ :|:& };:')).not.toBeNull();
        expect(findDestructiveCommand('echo x > /dev/sda')).not.toBeNull();
        expect(findDestructiveCommand('bash -c "rm -rf /"')).not.toBeNull();
    });

    it('allows normal cleanup and safe redirections', () => {
        expect(findDestructiveCommand('rm -rf ./build')).toBeNull();
        expect(findDestructiveCommand('rm -rf node_modules')).toBeNull();
        expect(findDestructiveCommand('git log > /dev/null 2>&1')).toBeNull();
        expect(findDestructiveCommand('net use Z: \\\\server\\share')).toBeNull();
        expect(findDestructiveCommand('reg query HKCU\\Software')).toBeNull();
    });
});
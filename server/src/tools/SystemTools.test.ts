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
import { getBeijingLogTimePrefix } from '@/utils/TimeUtils.js';
import { fileLogger } from '@/utils/Logger.js';

let patched = false;

function shouldSkipPrefix(args: unknown[]): boolean {
    if (args.length === 0) return false;
    const first = args[0];
    if (typeof first !== 'string') return false;
    return /^\[\d{2}:\d{2}:\d{2}\.\d{3}\]/.test(first);
}

/**
 * 将 console 参数序列化为单行字符串，用于文件日志
 * 避免对象/数组被写入为 [object Object]
 */
function stringifyArgs(args: unknown[]): string {
    return args.map((a) => {
        if (typeof a === 'string') return a;
        if (a instanceof Error) return `${a.name}: ${a.message} ${a.stack || ''}`;
        try {
            return JSON.stringify(a);
        } catch {
            return String(a);
        }
    }).join(' ');
}

/** 从日志级别推导合适的 console 方法名 */
function levelFromMethod(method: string): 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' {
    switch (method) {
        case 'error': return 'ERROR';
        case 'warn':  return 'WARN';
        case 'debug': return 'DEBUG';
        default:      return 'INFO';
    }
}

export function patchConsoleWithBeijingTime(): void {
    if (patched) return;
    patched = true;

    // 初始化文件日志（确保日志目录和流已就绪）
    fileLogger.init();

    const methods: Array<'log' | 'info' | 'warn' | 'error' | 'debug'> = ['log', 'info', 'warn', 'error', 'debug'];
    for (const method of methods) {
        const original = console[method].bind(console);
        console[method] = ((...args: unknown[]) => {
            // 控制台：添加北京时间前缀
            if (shouldSkipPrefix(args)) {
                original(...args);
            } else {
                original(getBeijingLogTimePrefix(), ...args);
            }

            // 文件：同步写入 JSON Lines 日志（静默失败，不影响主业务）
            try {
                const level = levelFromMethod(method);
                const message = stringifyArgs(args);
                fileLogger.write(level, message);
            } catch {
                // 日志文件写入失败不应影响应用运行
            }
        }) as typeof console[typeof method];
    }
}
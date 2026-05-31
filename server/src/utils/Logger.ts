/**
 * 文件日志核心模块 — 将 console 输出同步写入日志文件
 * 
 * 特性：
 * - JSON Lines 格式，方便机器解析
 * - 按天 + 按大小（10MB）双重旋转策略
 * - 日志目录：{PROJECT_ROOT}/logs/
 * - 文件命名：app-{YYYY-MM-DD}.log
 * - 单例模式，进程级全局共享
 * - 支持 LOG_LEVEL 环境变量控制最低输出级别（默认 INFO）
 * 
 * LOG_LEVEL 取值（大小写不敏感）：
 *   DEBUG | INFO | WARN | ERROR | SILENT
 */
import fs from 'fs';
import path from 'path';
import { formatBeijingIso, formatBeijingDate, formatBeijingFileStamp } from '@/utils/TimeUtils.js';
import { PROJECT_ROOT } from '@/utils/PathUtils.js';

const LOG_DIR = path.join(PROJECT_ROOT, 'logs');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB 单文件上限
const FLUSH_INTERVAL_MS = 5000; // 5 秒批量刷盘
const MAX_BUFFER_SIZE = 100; // 缓冲区上限，防止 OOM

type LogLevel = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

/** 日志级别权重，数值越小越详细 */
const LEVEL_WEIGHT: Record<LogLevel, number> = {
    DEBUG: 0,
    INFO: 1,
    WARN: 2,
    ERROR: 3,
};

interface LogEntry {
    ts: string;       // ISO-8601 北京时间
    level: LogLevel;
    message: string;
}

function resolveMinLevel(): LogLevel | 'SILENT' {
    const raw = (process.env.LOG_LEVEL || '').trim().toUpperCase();
    if (raw === 'SILENT') return 'SILENT';
    if (raw === 'ERROR') return 'ERROR';
    if (raw === 'WARN') return 'WARN';
    if (raw === 'DEBUG') return 'DEBUG';
    return 'INFO'; // 默认
}

class FileLogger {
    private static instance: FileLogger;
    private currentDate: string = '';   // YYYY-MM-DD
    private writeStream: fs.WriteStream | null = null;
    private buffer: string[] = [];
    private flushTimer: ReturnType<typeof setInterval> | null = null;
    private initialized = false;
    private minLevel: LogLevel | 'SILENT' = 'INFO';

    static getInstance(): FileLogger {
        if (!FileLogger.instance) {
            FileLogger.instance = new FileLogger();
        }
        return FileLogger.instance;
    }

    /**
     * 初始化日志目录和当日文件流
     */
    init(): void {
        if (this.initialized) return;
        this.initialized = true;

        this.minLevel = resolveMinLevel();

        // 确保日志目录存在
        if (!fs.existsSync(LOG_DIR)) {
            fs.mkdirSync(LOG_DIR, { recursive: true });
        }

        this.rotateIfNeeded();
        this.startFlushTimer();

        // 进程退出时刷盘
        process.on('exit', () => this.flushSync());
        process.on('SIGINT', () => { this.flushSync(); process.exit(0); });
        process.on('SIGTERM', () => { this.flushSync(); process.exit(0); });
        process.on('uncaughtException', (err) => {
            this.write('ERROR', `[Process] uncaughtException: ${err?.message || err}`);
            this.flushSync();
        });
    }

    /**
     * 判断给定级别是否应写入文件
     */
    shouldLog(level: LogLevel): boolean {
        if (this.minLevel === 'SILENT') return false;
        return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[this.minLevel];
    }

    /**
     * 写入一条日志（异步缓冲）
     */
    write(level: LogLevel, message: string): void {
        if (!this.initialized) this.init();
        if (!this.shouldLog(level)) return;

        const entry: LogEntry = {
            ts: formatBeijingIso(),
            level,
            message,
        };

        const line = JSON.stringify(entry);
        this.buffer.push(line);

        // ERROR 级别立即触发刷盘（尽力保证错误不丢）
        if (level === 'ERROR' || this.buffer.length >= MAX_BUFFER_SIZE) {
            this.flush();
        }
    }

    /**
     * 同步写入（仅用于进程退出等关键路径）
     */
    private writeSync(level: LogLevel, message: string): void {
        try {
            if (!fs.existsSync(LOG_DIR)) {
                fs.mkdirSync(LOG_DIR, { recursive: true });
            }
            const entry: LogEntry = {
                ts: formatBeijingIso(),
                level,
                message,
            };
            const today = formatBeijingDate();
            const filePath = path.join(LOG_DIR, `app-${today}.log`);
            fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');
        } catch {
            // 静默失败：写文件日志不应影响主业务
        }
    }

    /**
     * 刷新缓冲区到磁盘
     */
    private flush(): void {
        if (this.buffer.length === 0) return;
        const lines = this.buffer.splice(0);
        try {
            this.rotateIfNeeded();
            if (this.writeStream) {
                this.writeStream.write(lines.join('\n') + '\n');
            }
        } catch {
            // 静默失败
        }
    }

    /**
     * 同步刷盘（进程退出时）
     */
    private flushSync(): void {
        if (this.buffer.length === 0) return;
        const lines = this.buffer.splice(0);
        try {
            const today = formatBeijingDate();
            const filePath = path.join(LOG_DIR, `app-${today}.log`);
            fs.appendFileSync(filePath, lines.join('\n') + '\n');
        } catch {
            // 静默失败
        }
    }

    /**
     * 检查并按需切换日志文件（跨天或超限）
     */
    private rotateIfNeeded(): void {
        const today = formatBeijingDate();

        // 跨天轮转
        if (today !== this.currentDate) {
            this.closeStream();
            this.currentDate = today;
            this.openStream();
            return;
        }

        // 大小超限轮转
        if (this.writeStream) {
            try {
                const filePath = path.join(LOG_DIR, `app-${today}.log`);
                if (fs.existsSync(filePath)) {
                    const stats = fs.statSync(filePath);
                    if (stats.size >= MAX_FILE_SIZE) {
                        this.closeStream();
                        const stamp = formatBeijingFileStamp();
                        const rotated = path.join(LOG_DIR, `app-${today}-${stamp}.log`);
                        fs.renameSync(filePath, rotated);
                        this.openStream();
                    }
                }
            } catch {
                // 静默处理
            }
        } else if (!this.writeStream) {
            this.openStream();
        }
    }

    private openStream(): void {
        const filePath = path.join(LOG_DIR, `app-${this.currentDate}.log`);
        this.writeStream = fs.createWriteStream(filePath, { flags: 'a' });
    }

    private closeStream(): void {
        if (this.writeStream) {
            try {
                this.writeStream.end();
            } catch {
                // 静默
            }
            this.writeStream = null;
        }
    }

    private startFlushTimer(): void {
        if (this.flushTimer) return;
        this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    }
}

/** 全局单例 */
export const fileLogger = FileLogger.getInstance();

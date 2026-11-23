/**
 * LLMResponseLog — 大模型请求返回结果落盘
 *
 * 每次实际的模型请求（含重试、被丢弃的异常响应）都会异步写入工作区
 * `.llm_response/response-xxxxxx.json`，便于事后分析限流的真实原因：
 *
 *   line 1: 元数据（时间、模型、请求体量、耗时、用量、重试决策、错误信息…）
 *   line 2: 请求返回的结果（正文 / reasoning_content / tool_calls / error）
 *
 * 计数器从 1 开始、只增不减；进程首次写入某个工作区时会扫描目录承接历史计数，
 * 多进程并发写入通过 O_EXCL 独占创建保证序号唯一，因此服务器重启或新会话都不会重号。
 */

import { promises as fs } from "node:fs";
import * as path from "node:path";

export const LLM_RESPONSE_DIR_NAME = ".llm_response";

const RESPONSE_FILE_PATTERN = /^response-(\d+)\.json$/i;
/** 单个工作区保留的最近响应文件数：序号无限递增，但只留最近 100 个，避免长期运行耗尽磁盘。 */
const MAX_RETAINED_RESPONSES = 100;
/** 单个工作区允许的最大写入重试次数（序号冲突时顺延）。 */
const MAX_ALLOCATE_ATTEMPTS = 2000;

export interface LLMResponseLogEntry {
    /** 工作区根目录（绝对路径）。 */
    root: string;
    /** 写入文件第一行的元数据。 */
    metadata: Record<string, unknown>;
    /** 写入文件第二行的返回结果。 */
    result: Record<string, unknown>;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
    return error instanceof Error && "code" in error;
}

export class LLMResponseLog {
    private static instance: LLMResponseLog;

    /** 工作区 → 下一个可用序号（进程内缓存，缺失时扫描目录重建）。 */
    private readonly nextCounters = new Map<string, number>();
    /** 工作区 → 串行写入队列，避免同一目录下并发 open/write 交错。 */
    private readonly queues = new Map<string, Promise<void>>();
    /** 已经告警过的目录，避免持续刷屏。 */
    private readonly warnedDirectories = new Set<string>();

    public static getInstance(): LLMResponseLog {
        if (!this.instance) {
            this.instance = new LLMResponseLog();
        }
        return this.instance;
    }

    /**
     * 记录一次模型请求的返回结果。异步落盘，绝不阻塞或打断主流程。
     */
    public record(entry: LLMResponseLogEntry): void {
        const directory = this.resolveDirectory(entry.root);
        if (!directory) return;

        const previous = this.queues.get(directory) ?? Promise.resolve();
        const current = previous.then(
            () => this.writeAttempt(directory, entry),
            () => this.writeAttempt(directory, entry),
        );
        const settled = current.catch((error) => {
            if (!this.warnedDirectories.has(directory)) {
                this.warnedDirectories.add(directory);
                console.warn(`[LLMResponseLog] Failed to write response log in ${directory}:`, error);
            }
        });
        this.queues.set(directory, settled);
        void settled.then(() => {
            if (this.queues.get(directory) === settled) {
                this.queues.delete(directory);
            }
        });
    }

    /**
     * 强制重新扫描目录，承接已有文件的历史计数（用于「新会话」入口）。
     */
    public async refreshCounter(root: string): Promise<void> {
        const directory = this.resolveDirectory(root);
        if (!directory) return;
        try {
            await fs.mkdir(directory, { recursive: true });
            await this.restoreNextCounter(directory);
        } catch (error) {
            console.warn(`[LLMResponseLog] Failed to refresh counter in ${directory}:`, error);
        }
    }

    /** 等待所有排队中的写入完成（供测试与退出前收尾使用）。 */
    public async flush(): Promise<void> {
        await Promise.all(Array.from(this.queues.values()));
    }

    private resolveDirectory(root: string): string | null {
        if (typeof root !== "string" || !root.trim() || !path.isAbsolute(root)) {
            return null;
        }
        return path.join(path.resolve(root), LLM_RESPONSE_DIR_NAME);
    }

    private getDirectoryKey(directory: string): string {
        return process.platform === "win32" ? directory.toLowerCase() : directory;
    }

    private async writeAttempt(directory: string, entry: LLMResponseLogEntry): Promise<void> {
        await fs.mkdir(directory, { recursive: true });
        const directoryKey = this.getDirectoryKey(directory);

        for (let attempt = 0; attempt < MAX_ALLOCATE_ATTEMPTS; attempt++) {
            const counter = await this.getNextCounter(directoryKey, directory);
            const fileName = `response-${counter}.json`;
            const metadata = { counter, file: fileName, ...entry.metadata };
            const body = `${JSON.stringify(metadata)}\n${JSON.stringify(entry.result)}\n`;

            try {
                await fs.writeFile(path.join(directory, fileName), body, { encoding: "utf8", flag: "wx" });
                this.nextCounters.set(directoryKey, counter + 1);
                await this.pruneOldResponses(directory);
                return;
            } catch (error) {
                if (isNodeError(error) && error.code === "EEXIST") {
                    // 其他进程（如 workflow worker）已占用该序号，顺延重试
                    this.nextCounters.set(directoryKey, counter + 1);
                    continue;
                }
                if (isNodeError(error) && error.code === "ENOENT") {
                    // 工作区已被删除或切换：丢弃本次日志，不打断对话
                    return;
                }
                throw error;
            }
        }

        throw new Error(`Unable to allocate a response log file name in ${directory}`);
    }

    /**
     * 只保留序号最大的 MAX_RETAINED_RESPONSES 个文件。
     * 序号只增不减，因此被淘汰的一定是 100 次写入之前的旧文件，不会误删并发进程正在写的文件。
     */
    private async pruneOldResponses(directory: string): Promise<void> {
        try {
            const entries = await fs.readdir(directory);
            const files = entries.flatMap((name) => {
                const match = RESPONSE_FILE_PATTERN.exec(name);
                if (!match) return [];
                const counter = Number.parseInt(match[1], 10);
                return Number.isFinite(counter) ? [{ name, counter }] : [];
            });
            if (files.length <= MAX_RETAINED_RESPONSES) return;

            files.sort((a, b) => b.counter - a.counter || a.name.localeCompare(b.name));
            const stale = files.slice(MAX_RETAINED_RESPONSES);
            await Promise.all(stale.map(async (file) => {
                try {
                    await fs.unlink(path.join(directory, file.name));
                } catch (error) {
                    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
                }
            }));
        } catch (error) {
            if (!this.warnedDirectories.has(directory)) {
                this.warnedDirectories.add(directory);
                console.warn(`[LLMResponseLog] Failed to prune old response logs in ${directory}:`, error);
            }
        }
    }

    private async getNextCounter(directoryKey: string, directory: string): Promise<number> {
        const cached = this.nextCounters.get(directoryKey);
        if (cached !== undefined) return cached;
        return this.restoreNextCounter(directory);
    }

    private async restoreNextCounter(directory: string): Promise<number> {
        const directoryKey = this.getDirectoryKey(directory);
        let latest = 0;
        try {
            const entries = await fs.readdir(directory);
            for (const entry of entries) {
                const match = RESPONSE_FILE_PATTERN.exec(entry);
                if (!match) continue;
                const value = Number.parseInt(match[1], 10);
                if (Number.isFinite(value) && value > latest) latest = value;
            }
        } catch (error) {
            if (!isNodeError(error) || error.code !== "ENOENT") throw error;
        }

        // 已有缓存时取两者较大值：新会话刷新不能把序号回退
        const next = Math.max(latest + 1, this.nextCounters.get(directoryKey) ?? 1);
        this.nextCounters.set(directoryKey, next);
        return next;
    }
}

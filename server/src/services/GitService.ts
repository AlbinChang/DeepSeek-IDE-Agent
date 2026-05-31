import { simpleGit, SimpleGit, StatusResult } from 'simple-git';
import { PathUtils } from '@/utils/PathUtils.js';

export interface GitCommitRecord {
    hash: string;
    shortHash: string;
    author: string;
    date: string;
    message: string;
}

/**
 * Git 读写服务（精简版）
 * 仅用于前端 SourceControl 展示与显式初始化，不再承担自动托管逻辑。
 */
export class GitService {
    private git: SimpleGit;
    private workspaceRoot: string;

    constructor(workspaceRoot: string) {
        if (!workspaceRoot) throw new Error('GitService requires a valid workspace path');
        this.workspaceRoot = PathUtils.normalizePath(workspaceRoot);
        this.git = simpleGit(this.workspaceRoot);
    }

    private normalizeLimit(limit?: number, fallback: number = 50): number {
        const parsed = Number(limit);
        if (!Number.isFinite(parsed)) return fallback;
        return Math.min(200, Math.max(1, Math.floor(parsed)));
    }

    private parseCommitLog(raw: string): GitCommitRecord[] {
        return raw
            .split('\x1e')
            .map(entry => entry.trim())
            .filter(Boolean)
            .map(entry => {
                const [hash, shortHash, author, date, message] = entry.split('\x1f');
                return {
                    hash: hash || '',
                    shortHash: shortHash || (hash ? hash.slice(0, 7) : ''),
                    author: author || 'unknown',
                    date: date || '',
                    message: message || ''
                };
            })
            .filter(c => !!c.hash);
    }

    static async isInstalled(): Promise<boolean> {
        try {
            return !!(await this.getVersion());
        } catch {
            return false;
        }
    }

    static async getVersion(): Promise<string | null> {
        try {
            const version = await simpleGit().version();
            if (!version?.installed) return null;
            return String(version);
        } catch {
            return null;
        }
    }

    async isRepo(): Promise<boolean> {
        try {
            return await this.git.checkIsRepo();
        } catch {
            return false;
        }
    }

    async initRepo(): Promise<void> {
        await this.git.init();
    }

    async getStatus(): Promise<StatusResult> {
        return await this.git.status();
    }

    async getDiff(files?: string | string[]) {
        if (files) {
            return await this.git.diff(Array.isArray(files) ? files : [files]);
        }
        return await this.git.diff();
    }

    async getHistory(limit: number = 50): Promise<GitCommitRecord[]> {
        const safeLimit = this.normalizeLimit(limit, 50);
        const raw = await this.git.raw([
            'log',
            '-n',
            String(safeLimit),
            '--date=iso',
            '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e'
        ]);
        return this.parseCommitLog(raw);
    }

    async getFileHistory(relativePath: string, limit: number = 50): Promise<GitCommitRecord[]> {
        const safeLimit = this.normalizeLimit(limit, 50);
        const normalizedPath = relativePath.replace(/\\/g, '/');
        const raw = await this.git.raw([
            'log',
            '-n',
            String(safeLimit),
            '--date=iso',
            '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s%x1e',
            '--',
            normalizedPath
        ]);
        return this.parseCommitLog(raw);
    }

    async getCommitDiff(commitHash: string, relativePath?: string): Promise<string> {
        const args = ['show', '--no-color', '--format=', '--patch', commitHash];
        if (relativePath) {
            args.push('--', relativePath.replace(/\\/g, '/'));
        }
        const raw = await this.git.raw(args);

        // 超长 diff 截断保护：避免将数 MB 文本序列化到前端导致 OOM/卡顿
        const MAX_DIFF_BYTES = 256_000; // 256KB 足够展示绝大多数 commit
        const rawBytes = Buffer.byteLength(raw, 'utf8');
        if (rawBytes > MAX_DIFF_BYTES) {
            const truncated = Buffer.from(raw.slice(0, MAX_DIFF_BYTES), 'utf8');
            // 在最近的换行处截断以保持可读性
            const lastNewline = truncated.lastIndexOf(0x0a);
            const cutPoint = lastNewline > MAX_DIFF_BYTES / 2 ? lastNewline : MAX_DIFF_BYTES;
            const snipped = truncated.subarray(0, cutPoint).toString('utf8');
            return snipped + `\n\n... [截断] diff 过大（原始 ${(rawBytes / 1024).toFixed(0)} KB），仅展示前 ${(cutPoint / 1024).toFixed(0)} KB ...`;
        }

        return raw;
    }

    async getOriginalContent(relativePath: string): Promise<string> {
        try {
            const normPath = relativePath.replace(/\\/g, '/');
            return await this.git.show([`HEAD:${normPath}`]);
        } catch (e: any) {
            if (e.message.includes('exists on disk, but not in \'HEAD\'') || e.message.includes('does not have a version')) {
                throw new Error('FILE_NOT_IN_HEAD');
            }
            throw e;
        }
    }
}

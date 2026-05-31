import * as fs from 'fs/promises';
import * as path from 'path';
import { UserService } from '@/services/UserService.js';
import { formatBeijingFileStamp, formatBeijingIso } from '@/utils/TimeUtils.js';

/**
 * 对应技术规范 18.0 节：Session Persistence & User Isolation
 * 在用户专属目录下持久化工作区状态
 */
export class SessionStore {
    private static getDBPath(workspaceRoot: string, userId: string) {
        const userDir = UserService.getUserDataDir(workspaceRoot, userId);
        return path.join(userDir, 'session_db.json');
    }

    static async saveSession(workspaceRoot: string, userId: string, sessionId: string, data: any) {
        const dbPath = this.getDBPath(workspaceRoot, userId);
        const db = await this.readDB(dbPath);
        const prev = db[sessionId] || {};

        let recentTraceIds: string[] = Array.isArray(prev.recentTraceIds)
            ? prev.recentTraceIds.filter((t: any) => typeof t === 'string' && t.trim().length > 0)
            : [];

        if (typeof data?.lastTraceId === 'string' && data.lastTraceId.trim().length > 0) {
            recentTraceIds.push(data.lastTraceId.trim());
            // 去重并保持顺序，仅保留最近 100 条请求 trace。
            const dedup = new Set<string>();
            recentTraceIds = recentTraceIds.filter((t) => {
                if (dedup.has(t)) return false;
                dedup.add(t);
                return true;
            }).slice(-100);
        }

        db[sessionId] = {
            ...prev,
            ...data,
            recentTraceIds,
            lastSeen: Date.now()
        };
        await fs.mkdir(path.dirname(dbPath), { recursive: true });
        await fs.writeFile(dbPath, JSON.stringify(db, null, 2));
    }

    static async getSession(workspaceRoot: string, userId: string, sessionId: string) {
        const dbPath = this.getDBPath(workspaceRoot, userId);
        const db = await this.readDB(dbPath);
        return db[sessionId];
    }

    /**
     * 长效归档：保存会话历史到用户专属目录 (对齐 9.0 & 18.0 节)
     */
    static async archiveHistory(workspaceRoot: string, userId: string, messages: any[], traceId?: string) {
        const userDir = UserService.getUserDataDir(workspaceRoot, userId);
        const historyDir = path.join(userDir, 'history');
        await fs.mkdir(historyDir, { recursive: true });
        
        const timestamp = formatBeijingFileStamp();
        const traceSuffix = traceId ? `-${traceId.replace(/[^a-zA-Z0-9-]/g, '')}` : '';
        const filePath = path.join(historyDir, `${timestamp}${traceSuffix}.json`);
        
        await fs.writeFile(filePath, JSON.stringify({
            version: '1.0',
            timestamp: formatBeijingIso(),
            traceId: traceId || null,
            messages: messages
        }, null, 2));
        
        return filePath;
    }

    private static async readDB(dbPath: string) {
        try {
            const content = await fs.readFile(dbPath, 'utf-8');
            return JSON.parse(content);
        } catch {
            return {};
        }
    }
}

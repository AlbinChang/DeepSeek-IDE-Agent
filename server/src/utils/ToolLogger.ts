import fs from 'fs';
import path from 'path';
import { formatBeijingFileStamp, formatBeijingIso } from '@/utils/TimeUtils.js';

export class ToolLogger {
    private static logDir: string;
    private static logFile: string;
    private static maxSizeBytes = 1024 * 1024; // 1MB

    private static init(workspaceRoot: string) {
        this.logDir = path.join(workspaceRoot, '.tools');
        this.logFile = path.join(this.logDir, 'tools.log');
        
        if (!fs.existsSync(this.logDir)) {
            fs.mkdirSync(this.logDir, { recursive: true });
        }
    }

    private static rotate() {
        if (!fs.existsSync(this.logFile)) return;

        const stats = fs.statSync(this.logFile);
        if (stats.size >= this.maxSizeBytes) {
            const timestamp = formatBeijingFileStamp();
            const rotatedPath = path.join(this.logDir, `tools.${timestamp}.log`);
            fs.renameSync(this.logFile, rotatedPath);
        }
    }

    public static log(workspaceRoot: string, data: { 
        userId: string, 
        toolName: string, 
        args: any, 
        result?: any, 
        error?: string,
        traceId: string 
    }) {
        try {
            this.init(workspaceRoot);
            this.rotate();

            const entry = {
                timestamp: formatBeijingIso(),
                ...data
            };

            fs.appendFileSync(this.logFile, JSON.stringify(entry) + '\n');
        } catch (err) {
            console.error('[ToolLogger] Failed to write log:', err);
        }
    }
}

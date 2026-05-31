import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { formatBeijingDate, formatBeijingIso } from '@/utils/TimeUtils.js';

/**
 * 遥测与性能监控服务 (Telemetry & Performance Monitoring)
 * 负责收集系统运行指标与资源使用统计
 */
export class TelemetryService {
    private static readonly DAU_FILE_DIR = path.join(os.homedir(), '.deepseek-ide-agent');
    private static readonly DAU_FILE_PATH = path.join(os.homedir(), '.deepseek-ide-agent', '.dau');

    /**
     * 加载持久化的日活数据 (Load DAU from disk)
     */
    private static loadDAUFromDisk(): Set<string> {
        try {
            if (fs.existsSync(this.DAU_FILE_PATH)) {
                const content = fs.readFileSync(this.DAU_FILE_PATH, 'utf8');
                const data = JSON.parse(content);
                const todayStr = formatBeijingDate();
                
                // 仅当文件日期为今天时加载用户列表
                if (data.date === todayStr && Array.isArray(data.users)) {
                    return new Set(data.users);
                }
            }
        } catch (e) {
            console.error(`[Telemetry] Failed to load DAU from disk:`, e);
        }
        return new Set<string>();
    }

    /**
     * 将日活数据持久化到磁盘 (Persist DAU to disk)
     */
    private static saveDAUToDisk() {
        try {
            if (!fs.existsSync(this.DAU_FILE_DIR)) {
                fs.mkdirSync(this.DAU_FILE_DIR, { recursive: true });
            }
            const todayStr = formatBeijingDate();
            const data = {
                date: todayStr,
                users: Array.from(this.metrics.dailyActiveUsers),
                lastUpdated: formatBeijingIso()
            };
            fs.writeFileSync(this.DAU_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
        } catch (e) {
            console.error(`[Telemetry] Failed to save DAU to disk:`, e);
        }
    }

    private static metrics = {
        totalRequests: 0,
        successRequests: 0,
        completionRequests: 0, // 新增：代码补全统计 (Section 36.5)
        totalLatency: 0,
        totalTokens: 0,
        errors: [] as string[],
        dailyActiveUsers: TelemetryService.loadDAUFromDisk(), // [DAU STATS] 初始化从磁盘加载器获取
        lastStatsFlush: Date.now()
    };

    /**
     * 记录日活用户 (Section 11.0: DAU Tracking)
     * @param userId 浏览器端生成的动态用户标识
     */
    static recordActiveUser(userId: string) {
        const now = new Date();
        const todayStr = formatBeijingDate(now);
        
        // 检查是否跨天，若是则重置日活集合并更新磁盘
        const lastFlushDate = formatBeijingDate(new Date(this.metrics.lastStatsFlush));
        if (todayStr !== lastFlushDate) {
            console.log(`[Telemetry] New day detected (${todayStr}), flushing DAU set...`);
            this.metrics.dailyActiveUsers.clear();
            this.metrics.lastStatsFlush = Date.now();
            this.saveDAUToDisk(); // 清空后同步同步到磁盘
        }
        
        if (!this.metrics.dailyActiveUsers.has(userId)) {
            this.metrics.dailyActiveUsers.add(userId);
            this.saveDAUToDisk(); // 新增用户立即持久化
            console.log(`[Telemetry] DAU Updated: +1 (Total: ${this.metrics.dailyActiveUsers.size}) | User: ${userId}`);
        }
    }

    /**
     * 记录一次请求指标 (Section 36.5)
     */
    static recordRequest(success: boolean, latency: number, tokens: number = 0, type: 'chat' | 'completion' = 'chat', modelId: string = 'default', userId?: string) {
        if (userId) {
            this.recordActiveUser(userId);
        }
        this.metrics.totalRequests++;
        if (type === 'completion') {
            this.metrics.completionRequests++;
        }
        if (success) {
            this.metrics.successRequests++;
        }
        this.metrics.totalLatency += latency;
        this.recordTokens(tokens, modelId);
    }

    /**
     * 仅记录来自模型 API usage 的 token 消耗真值。
     */
    static recordTokens(tokens: number, modelId: string = 'default') {
        this.metrics.totalTokens += tokens;
    }

    /**
     * 对齐 36.5 节：记录性能错误并同步状态
     */
    static recordError(error: string) {
        console.error(`[TelemetryError] ${error}`);
        this.metrics.errors.unshift(`[${formatBeijingIso()}] ${error}`);
        if (this.metrics.errors.length > 20) {
            this.metrics.errors.pop();
        }
    }

    /**
     * 获取系统健康状态快照 (Section 36.2 & 36.5)
     */
    static getSystemStatus(workspaceRoot: string) {
        const avgLatency = this.metrics.totalRequests > 0 
            ? Math.round(this.metrics.totalLatency / this.metrics.totalRequests) 
            : 0;
        
        const successRate = this.metrics.totalRequests > 0 
            ? this.metrics.successRequests / this.metrics.totalRequests 
            : 1;

        return {
            totalRequests: this.metrics.totalRequests,
            completionRequests: this.metrics.completionRequests,
            successRate: (successRate * 100).toFixed(1) + '%',
            avgLatency: `${avgLatency}ms`,
            totalTokens: this.metrics.totalTokens,
            lastErrors: this.metrics.errors.slice(0, 5)
        };
    }
}
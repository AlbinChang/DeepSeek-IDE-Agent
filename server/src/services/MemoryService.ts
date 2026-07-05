import * as fs from 'fs/promises';
import * as path from 'path';
import { config as globalConfig } from '@/config/index.js';
import { formatBeijingIso, formatBeijingDateTime } from '@/utils/TimeUtils.js';

export interface UserInstructionRecord {
    timestamp: number;
    date: string;
    instruction: string;
}

export interface NeverMistakeRecord {
    id: string;
    timestamp: number;
    date: string;
    shouldNot: string;
    shouldDo: string;
}

/**
 * 用户偏好记录
 * - beijingTime: 北京时间（ISO-8601 + 08:00，机器可读）
 * - type: 偏好分类（如 model / style / language / behavior / timezone 等）
 * - content: 偏好内容描述
 * - confidence: 置信度 0.0-1.0，由时间衰减自动计算（最新=1.0）
 * - source: 来源，"explicit"=用户明确表达 / "inferred"=Agent 推断
 */
export interface UserPreferenceRecord {
    id: string;
    timestamp: number;
    beijingTime: string;
    type: string;
    content: string;
    source: 'explicit' | 'inferred';
}

export interface PreferenceUpsertResult {
    status: 'created' | 'updated' | 'no_change';
    record: UserPreferenceRecord;
    displaced: UserPreferenceRecord[];
    total: number;
}

/**
 * 长期指令记忆服务
 * 负责记录和在系统提示词中注入用户的长期指令历史
 */
export class MemoryService {
    private static readonly NEVER_MISTAKE_MAX = 20;
    private static readonly USER_PREFERENCE_MAX = 200;
    // 置信度衰减半衰期：30天（对应毫秒）
    private static readonly PREFERENCE_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

    private static getMemoryFile(workspaceRoot: string) {
        return path.join(workspaceRoot, '.memory', 'user_instructs.json');
    }

    private static getNeverMistakeFile(workspaceRoot: string) {
        return path.join(workspaceRoot, '.memory', 'never_mistake_again.json');
    }

    private static getUserPreferenceFile(workspaceRoot: string) {
        return path.join(workspaceRoot, '.memory', 'user_preferences.json');
    }

    private static normalizeRuleText(value: string): string {
        return value.trim().replace(/\s+/g, ' ').toLowerCase();
    }

    private static async ensureMemoryDir(workspaceRoot: string) {
        const dir = path.join(workspaceRoot, '.memory');
        try {
            await fs.mkdir(dir, { recursive: true });
        } catch (e) {}
    }

    /**
     * 确保所有 .memory/ 文件都存在（不存在则播种为空数组）。
     * 在每次对话启动时调用，保证用户能看到文件落地，Agent 也能在提示词中感知到。
     */
    static async ensureMemoryFiles(workspaceRoot: string): Promise<void> {
        await this.ensureMemoryDir(workspaceRoot);
        const files = [
            this.getMemoryFile(workspaceRoot),
            this.getNeverMistakeFile(workspaceRoot),
            this.getUserPreferenceFile(workspaceRoot),
        ];
        for (const filePath of files) {
            try {
                await fs.access(filePath);
            } catch {
                // 文件不存在，播种空数组
                try {
                    await fs.writeFile(filePath, '[]', 'utf8');
                } catch (e) {
                    // 权限不足或磁盘问题，静默跳过
                }
            }
        }
    }

    /**
     * 获取全部记录
     */
    static async getInstructions(workspaceRoot: string): Promise<UserInstructionRecord[]> {
        const filePath = this.getMemoryFile(workspaceRoot);
        try {
            const content = await fs.readFile(filePath, 'utf8');
            return JSON.parse(content);
        } catch {
            return [];
        }
    }

    /**
     * 写入一条新的用户指令
     */
    static async recordUserInstruction(workspaceRoot: string, instruction: string): Promise<void> {
        await this.ensureMemoryDir(workspaceRoot);
        const filePath = this.getMemoryFile(workspaceRoot);
        const records = await this.getInstructions(workspaceRoot);
        
        const newRecord: UserInstructionRecord = {
            timestamp: Date.now(),
            date: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
            instruction
        };

        // 插入到数组开头（时间倒序排列）
        records.unshift(newRecord);
        
        // 控制文件体积，最多保留最近 N 条（由 .env 配置）
        const maxStored = globalConfig.memory.maxStoredInstructions;
        if (records.length > maxStored) {
            records.length = maxStored;
        }

        await fs.writeFile(filePath, JSON.stringify(records, null, 2), 'utf8');
    }

    /**
     * 按照偏移量获取最近几次的用户指令
     * @param limit 获取条数
     * @param skip 偏移跃过最新条数（最新1条已在user消息，所以通常 skip=1）
     */
    static async getRecentInstructions(
        workspaceRoot: string,
        limit: number = globalConfig.memory.recentInstructionsLimit,
        skip: number = globalConfig.memory.recentInstructionsSkip
    ): Promise<UserInstructionRecord[]> {
        const records = await this.getInstructions(workspaceRoot);
        return records.slice(skip, skip + limit);
    }

    /**
     * 获取防重复犯错记忆规则
     */
    static async getNeverMistakeRules(workspaceRoot: string): Promise<NeverMistakeRecord[]> {
        const filePath = this.getNeverMistakeFile(workspaceRoot);
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const parsed = JSON.parse(content);
            if (!Array.isArray(parsed)) return [];

            const normalized = parsed
                .filter((item: any) => item && typeof item.shouldNot === 'string' && typeof item.shouldDo === 'string')
                .map((item: any) => ({
                    id: typeof item.id === 'string' && item.id.trim() ? item.id : Math.random().toString(36).slice(2, 10),
                    timestamp: Number(item.timestamp) || 0,
                    date: typeof item.date === 'string' ? item.date : '',
                    shouldNot: item.shouldNot,
                    shouldDo: item.shouldDo
                }));

            return normalized.slice(0, this.NEVER_MISTAKE_MAX);
        } catch {
            return [];
        }
    }

    /**
     * 追加防重复犯错规则；若语义重复则提升为最新记录
     */
    static async appendNeverMistakeRules(
        workspaceRoot: string,
        records: Array<{ shouldNot: string; shouldDo: string }>
    ): Promise<NeverMistakeRecord[]> {
        await this.ensureMemoryDir(workspaceRoot);
        const filePath = this.getNeverMistakeFile(workspaceRoot);
        const current = await this.getNeverMistakeRules(workspaceRoot);

        // 【性能优化】使用 Map 做去重查找 O(1)，替代原 findIndex 的 O(R) 扫描
        const seen = new Map<string, NeverMistakeRecord>();
        for (const rule of current) {
            const key = `${this.normalizeRuleText(rule.shouldNot)}||${this.normalizeRuleText(rule.shouldDo)}`;
            if (!seen.has(key)) seen.set(key, rule);
        }

        // 按时间倒序插入新记录，已存在的记录直接替换（保持语义：最新记录在前）
        const newEntries: NeverMistakeRecord[] = [];
        for (const item of records) {
            const shouldNot = String(item?.shouldNot || '').trim();
            const shouldDo = String(item?.shouldDo || '').trim();
            if (!shouldNot || !shouldDo) continue;

            const key = `${this.normalizeRuleText(shouldNot)}||${this.normalizeRuleText(shouldDo)}`;
            const existing = seen.get(key);

            const now = Date.now();
            const updatedRecord: NeverMistakeRecord = {
                id: existing?.id ?? Math.random().toString(36).slice(2, 10),
                timestamp: now,
                date: new Date(now).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
                shouldNot,
                shouldDo
            };

            seen.set(key, updatedRecord);
            newEntries.unshift(updatedRecord);
        }

        // 合并：新记录在前 → 原记录中未被替换的紧随其后
        const newKeys = new Set(newEntries.map(e =>
            `${this.normalizeRuleText(e.shouldNot)}||${this.normalizeRuleText(e.shouldDo)}`));
        const remaining = current.filter(rule => {
            const key = `${this.normalizeRuleText(rule.shouldNot)}||${this.normalizeRuleText(rule.shouldDo)}`;
            return !newKeys.has(key);
        });

        const merged = [...newEntries, ...remaining];

        if (merged.length > this.NEVER_MISTAKE_MAX) {
            merged.length = this.NEVER_MISTAKE_MAX;
        }

        await fs.writeFile(filePath, JSON.stringify(merged, null, 2), 'utf8');
        return merged;
    }

    /**
     * 删除防重复犯错规则
     */
    static async deleteNeverMistakeRules(workspaceRoot: string, ids: string | string[]) {
        await this.ensureMemoryDir(workspaceRoot);
        const filePath = this.getNeverMistakeFile(workspaceRoot);
        const current = await this.getNeverMistakeRules(workspaceRoot);
        const idList = (Array.isArray(ids) ? ids : [ids]).filter(Boolean);
        const idSet = new Set(idList);
        const updated = current.filter(rule => !idSet.has(rule.id));

        await fs.writeFile(filePath, JSON.stringify(updated, null, 2), 'utf8');
        return {
            status: 'success',
            deletedCount: current.length - updated.length,
            total: updated.length,
            records: updated
        };
    }

    // ─────────────────────────── 用户偏好记忆 ───────────────────────────

    /**
     * 计算偏好置信度（基于时间衰减的半衰期模型）
     * confidence = 0.5 ^ (age_ms / HALF_LIFE_MS)，最新=1.0，无限过去趋近0
     */
    static computeConfidence(timestamp: number, now: number = Date.now()): number {
        const ageMs = Math.max(0, now - timestamp);
        const confidence = Math.pow(0.5, ageMs / this.PREFERENCE_HALF_LIFE_MS);
        return Math.round(confidence * 1000) / 1000; // 保留3位小数
    }

    /**
     * 读取所有用户偏好（按时间倒序，不含 confidence）
     */
    static async getUserPreferences(workspaceRoot: string): Promise<UserPreferenceRecord[]> {
        const filePath = this.getUserPreferenceFile(workspaceRoot);
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const parsed: any[] = JSON.parse(content);
            if (!Array.isArray(parsed)) return [];
            return parsed
                .filter(r => r && r.id && r.type && r.content)
                .map(r => ({
                    id: String(r.id),
                    timestamp: Number(r.timestamp) || 0,
                    beijingTime: String(r.beijingTime || ''),
                    type: String(r.type),
                    content: String(r.content),
                    source: r.source === 'inferred' ? 'inferred' : 'explicit',
                } as UserPreferenceRecord))
                .sort((a, b) => b.timestamp - a.timestamp)
                .slice(0, this.USER_PREFERENCE_MAX);
        } catch {
            return [];
        }
    }

    /**
     * 读取所有用户偏好（附带实时置信度，用于注入系统提示词）
     */
    static async getUserPreferencesWithConfidence(workspaceRoot: string): Promise<(UserPreferenceRecord & { confidence: number })[]> {
        const records = await this.getUserPreferences(workspaceRoot);
        const now = Date.now();
        return records.map(r => ({ ...r, confidence: this.computeConfidence(r.timestamp, now) }));
    }

    /**
     * 文本归一化（用于重复检测）
     */
    private static normalizeText(value: string): string {
        return value.trim().replace(/\s+/g, ' ').toLowerCase();
    }

    /**
     * 新增或更新用户偏好
     * - 相同 type + 归一化内容相同 → 更新时间戳，视为置信度刷新
     * - conflictIds 中的 ID → 显式删除（表示被新偏好淘汰）
     */
    static async upsertUserPreference(
        workspaceRoot: string,
        type: string,
        content: string,
        source: 'explicit' | 'inferred' = 'explicit',
        conflictIds?: string[]
    ): Promise<PreferenceUpsertResult> {
        await this.ensureMemoryDir(workspaceRoot);
        const filePath = this.getUserPreferenceFile(workspaceRoot);
        const current = await this.getUserPreferences(workspaceRoot);

        const normalType = this.normalizeText(type);
        const normalContent = this.normalizeText(content);

        // 显式淘汰冲突项（剥离 confidence 字段，只持久化基础字段）
        const conflictSet = new Set(conflictIds || []);
        const strip = ({ confidence: _c, ...rest }: any): UserPreferenceRecord => rest;
        const displaced: UserPreferenceRecord[] = current.filter(r => conflictSet.has(r.id)).map(strip);
        let workList: UserPreferenceRecord[] = current.filter(r => !conflictSet.has(r.id)).map(strip);

        // 检测同类型同内容的已有记录（去重）
        const existingIdx = workList.findIndex(
            r => this.normalizeText(r.type) === normalType &&
                 this.normalizeText(r.content) === normalContent
        );

        const now = Date.now();
        let status: PreferenceUpsertResult['status'];
        let resultRecord: UserPreferenceRecord;

        if (existingIdx >= 0) {
            // 仅刷新时间戳（提升置信度到最新）
            const existing = workList[existingIdx];
            const updated: UserPreferenceRecord = {
                ...existing,
                timestamp: now,
                beijingTime: formatBeijingIso(new Date(now)),
                source,
            };
            workList.splice(existingIdx, 1);
            workList.unshift(updated);
            resultRecord = updated;
            status = displaced.length > 0 ? 'updated' : 'updated';
        } else {
            const newRecord: UserPreferenceRecord = {
                id: Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6),
                timestamp: now,
                beijingTime: formatBeijingIso(new Date(now)),
                type,
                content,
                source,
            };
            workList.unshift(newRecord);
            resultRecord = newRecord;
            status = 'created';
        }

        // 容量控制：超过上限时淘汰最旧记录
        if (workList.length > this.USER_PREFERENCE_MAX) {
            const removed = workList.splice(this.USER_PREFERENCE_MAX);
            displaced.push(...removed);
        }

        // 持久化（workList 已是纯 UserPreferenceRecord[]，直接存盘）
        await fs.writeFile(filePath, JSON.stringify(workList, null, 2), 'utf8');

        return {
            status,
            record: resultRecord,
            displaced,
            total: workList.length,
        };
    }

    /**
     * 按 ID 删除用户偏好
     */
    static async deleteUserPreferences(
        workspaceRoot: string,
        ids: string | string[]
    ): Promise<{ status: string; deletedCount: number; total: number }> {
        await this.ensureMemoryDir(workspaceRoot);
        const filePath = this.getUserPreferenceFile(workspaceRoot);
        const current = await this.getUserPreferences(workspaceRoot);
        const idSet = new Set(Array.isArray(ids) ? ids : [ids]);
        const updated = current.filter(r => !idSet.has(r.id));
        await fs.writeFile(filePath, JSON.stringify(updated, null, 2), 'utf8');
        return { status: 'success', deletedCount: current.length - updated.length, total: updated.length };
    }

    /**
     * 获取高置信度偏好快照（用于系统提示词注入）
     * @param limit 返回条数
     * @param minConfidence 最低置信度阈值（默认 0.05）
     */
    static async getTopPreferences(
        workspaceRoot: string,
        limit: number = 20,
        minConfidence: number = 0.05
    ): Promise<(UserPreferenceRecord & { confidence: number })[]> {
        const all = await this.getUserPreferencesWithConfidence(workspaceRoot);
        return all
            .filter(r => r.confidence >= minConfidence)
            .sort((a, b) => b.confidence - a.confidence)
            .slice(0, limit);
    }
}
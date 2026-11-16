import * as fs from 'fs/promises';
import * as path from 'path';
import { config as globalConfig } from '@/config/index.js';
import { formatBeijingIso, formatBeijingDateTime } from '@/utils/TimeUtils.js';

export interface UserInstructionRecord {
    timestamp: number;
    date: string;
    instruction: string;
    /**
     * 后台对话计数器分配到的对话编号（1 起单调递增，永不回收）。
     * 与 `.memory/user_instructs_reply.json` 中的 `dialogIndex` 一一对应。
     */
    dialogIndex: number;
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
 * 主 Agent 单轮最终回复记录（`.memory/user_instructs_reply.json`）。
 * `id` 形如 `11.2`：第 11 次对话中主 Agent 的第 2 份最终回复。
 */
export interface MainAgentReplyRecord {
    id: string;
    dialogIndex: number;
    replyIndex: number;
    timestamp: number;
    beijingTime: string;
    /** 该次对话的用户指令摘要（用于不读 user_instructs.json 也能识别上下文） */
    instruction: string;
    reply: string;
    /** 原文长度（截断前） */
    replyChars: number;
    truncated: boolean;
    /** 产出该回复时主 Agent 已累计的工具轮次 */
    steps: number;
}

/** 列表视图：只带摘要，避免把整份记忆读进上下文。 */
export interface MainAgentReplyIndexEntry {
    id: string;
    dialogIndex: number;
    replyIndex: number;
    beijingTime: string;
    instructionPreview: string;
    replyPreview: string;
    replyChars: number;
    truncated: boolean;
    steps: number;
}

/**
 * 长期记忆服务
 *
 * 负责四份工作区记忆的读写：
 * - `.memory/user_instructs.json`：用户指令历史（硬上限 20 条），每条带 `dialogIndex`
 * - `.memory/user_instructs_reply.json`：主 Agent 每轮最终回复，按 `dialogIndex.replyIndex` 编号，
 *   保留范围与 `user_instructs.json` 的 `dialogIndex` 集合严格一一对应
 * - `.memory/never_mistake_again.json`：防重复犯错规则
 * - `.memory/user_preferences.json`：用户偏好（置信度按时间衰减）
 * 另有 `.memory/dialog_counter.json` 作为后台对话计数器（单调递增，永不回退）。
 *
 * 注意：不无条件注入系统提示词；仅当本轮指令不明确、必须结合历史记忆
 * 才能正确理解意图时，由 Agent 通过工具或 read_file 按需读取。
 */
export class MemoryService {
    private static readonly NEVER_MISTAKE_MAX = 20;
    private static readonly USER_PREFERENCE_MAX = 200;
    /** user_instructs.json 硬上限：最多保留最近 20 条用户指令 */
    private static readonly USER_INSTRUCTS_MAX = 20;
    /** 同一次对话内最多保留的主 Agent 回复条数（异常长循环的安全阀） */
    private static readonly MAIN_AGENT_REPLY_MAX_PER_DIALOG = 50;
    /** 单条回复正文上限，超出截断并标记 truncated */
    private static readonly MAIN_AGENT_REPLY_MAX_CHARS = 20_000;
    /** 回复记忆文件总量上限，超出时按最旧对话整组淘汰 */
    private static readonly MAIN_AGENT_REPLY_MAX_FILE_BYTES = 2 * 1024 * 1024;
    /** 回复记录的指令摘要上限 */
    private static readonly MAIN_AGENT_REPLY_INSTRUCTION_MAX_CHARS = 200;
    // 置信度衰减半衰期：30天（对应毫秒）
    private static readonly PREFERENCE_HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

    private static getMemoryFile(workspaceRoot: string) {
        return path.join(workspaceRoot, '.memory', 'user_instructs.json');
    }

    private static getReplyFile(workspaceRoot: string) {
        return path.join(workspaceRoot, '.memory', 'user_instructs_reply.json');
    }

    private static getDialogCounterFile(workspaceRoot: string) {
        return path.join(workspaceRoot, '.memory', 'dialog_counter.json');
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
     * 确保所有 .memory/ 文件都存在（不存在则播种为空数组 / 零计数器）。
     * 在每次对话启动时调用，保证用户能看到文件落地，Agent 也能在提示词中感知到。
     */
    static async ensureMemoryFiles(workspaceRoot: string): Promise<void> {
        await this.ensureMemoryDir(workspaceRoot);
        const arrayFiles = [
            this.getMemoryFile(workspaceRoot),
            this.getReplyFile(workspaceRoot),
            this.getNeverMistakeFile(workspaceRoot),
            this.getUserPreferenceFile(workspaceRoot),
        ];
        for (const filePath of arrayFiles) {
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

        const counterFile = this.getDialogCounterFile(workspaceRoot);
        try {
            await fs.access(counterFile);
        } catch {
            try {
                await this.writeDialogCounter(workspaceRoot, 0);
            } catch (e) {
                // 权限不足或磁盘问题，静默跳过
            }
        }
    }

    // ─────────────────────────── 对话计数器 ───────────────────────────

    private static async readDialogCounter(workspaceRoot: string): Promise<number> {
        try {
            const raw = await fs.readFile(this.getDialogCounterFile(workspaceRoot), 'utf8');
            const parsed = JSON.parse(raw);
            const value = Number(parsed?.lastDialogIndex);
            return Number.isInteger(value) && value > 0 ? value : 0;
        } catch {
            return 0;
        }
    }

    private static async writeDialogCounter(workspaceRoot: string, lastDialogIndex: number): Promise<void> {
        await this.ensureMemoryDir(workspaceRoot);
        const payload = JSON.stringify({ lastDialogIndex }, null, 2);
        await fs.writeFile(this.getDialogCounterFile(workspaceRoot), payload, 'utf8');
    }

    /**
     * 旧版 user_instructs.json 没有 dialogIndex：按时间顺序补齐。
     * 数组为时间倒序（最新在前），因此最旧一条取 1，最新一条取 n。
     */
    private static normalizeDialogIndexes(records: UserInstructionRecord[]): UserInstructionRecord[] {
        const allValid = records.every((record) => {
            const value = Number(record?.dialogIndex);
            return Number.isInteger(value) && value > 0;
        });
        if (allValid || records.length === 0) return records;

        const total = records.length;
        return records.map((record, index) => ({ ...record, dialogIndex: total - index }));
    }

    /**
     * 当前（最近一次）对话编号；尚未开过对话时返回 0。
     */
    static async getCurrentDialogIndex(workspaceRoot: string): Promise<number> {
        const records = await this.getInstructions(workspaceRoot);
        const maxKnown = records.reduce((max, record) => Math.max(max, record.dialogIndex), 0);
        return Math.max(await this.readDialogCounter(workspaceRoot), maxKnown);
    }

    /**
     * 获取全部记录（读取时同样执行 20 条硬上限裁剪，兼容历史存量文件）
     */
    static async getInstructions(workspaceRoot: string): Promise<UserInstructionRecord[]> {
        const filePath = this.getMemoryFile(workspaceRoot);
        try {
            const content = await fs.readFile(filePath, 'utf8');
            const parsed = JSON.parse(content);
            if (!Array.isArray(parsed)) return [];
            const records = parsed
                .filter((item: any) => item && typeof item.instruction === 'string')
                .slice(0, this.USER_INSTRUCTS_MAX)
                .map((item: any) => ({
                    timestamp: Number(item.timestamp) || 0,
                    date: typeof item.date === 'string' ? item.date : '',
                    instruction: item.instruction,
                    dialogIndex: Number(item.dialogIndex),
                } as UserInstructionRecord));
            return this.normalizeDialogIndexes(records);
        } catch {
            return [];
        }
    }

    /**
     * 写入一条新的用户指令（或在恢复同一对话时沿用当前编号）。
     *
     * @returns 本次对话的编号（1 起单调递增）
     */
    static async recordUserInstruction(
        workspaceRoot: string,
        instruction: string,
        options: { resume?: boolean } = {},
    ): Promise<number> {
        await this.ensureMemoryDir(workspaceRoot);
        const filePath = this.getMemoryFile(workspaceRoot);
        const records = await this.getInstructions(workspaceRoot);

        const maxKnown = records.reduce((max, record) => Math.max(max, record.dialogIndex), 0);
        const storedCounter = await this.readDialogCounter(workspaceRoot);
        const lastDialogIndex = Math.max(maxKnown, storedCounter);

        // 恢复同一对话：沿用当前编号，不新增指令记录、不递增计数器
        if (options.resume) {
            const activeDialogIndex = lastDialogIndex || 1;
            if (storedCounter !== activeDialogIndex) {
                await this.writeDialogCounter(workspaceRoot, activeDialogIndex);
            }
            return activeDialogIndex;
        }

        const dialogIndex = lastDialogIndex + 1;
        await this.writeDialogCounter(workspaceRoot, dialogIndex);

        const newRecord: UserInstructionRecord = {
            timestamp: Date.now(),
            date: new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }),
            instruction,
            dialogIndex,
        };

        // 插入到数组开头（时间倒序排列）
        records.unshift(newRecord);

        // 硬上限：user_instructs.json 最多保留最近 20 条用户指令；
        // .env 的 AGENT_MAX_STORED_INSTRUCTIONS 只能调低，不能超过 20。
        const maxStored = Math.min(globalConfig.memory.maxStoredInstructions, this.USER_INSTRUCTS_MAX);
        if (records.length > maxStored) {
            records.length = maxStored;
        }

        await fs.writeFile(filePath, JSON.stringify(records, null, 2), 'utf8');

        // 回复记忆与指令记忆一一对应：对话被淘汰后同步淘汰其全部回复
        await this.pruneMainAgentReplies(workspaceRoot, records);

        return dialogIndex;
    }

    // ─────────────────── 主 Agent 最终回复记忆 ───────────────────

    /** 读取全部回复记录（时间倒序，已按保留策略裁剪） */
    static async getMainAgentReplies(
        workspaceRoot: string,
        options: { dialogIndex?: number; limit?: number } = {},
    ): Promise<MainAgentReplyRecord[]> {
        const records = await this.readMainAgentReplyFile(workspaceRoot);
        const filtered = typeof options.dialogIndex === 'number'
            ? records.filter((record) => record.dialogIndex === options.dialogIndex)
            : records;
        const limit = Number.isInteger(options.limit) && (options.limit as number) > 0
            ? (options.limit as number)
            : filtered.length;
        return filtered.slice(0, limit);
    }

    /** 列表视图：只给摘要，避免把整份记忆塞进上下文 */
    static async getMainAgentReplyIndex(
        workspaceRoot: string,
        options: { dialogIndex?: number; limit?: number } = {},
    ): Promise<MainAgentReplyIndexEntry[]> {
        const replies = await this.getMainAgentReplies(workspaceRoot, options);
        return replies.map((record) => ({
            id: record.id,
            dialogIndex: record.dialogIndex,
            replyIndex: record.replyIndex,
            beijingTime: record.beijingTime,
            instructionPreview: this.clip(record.instruction, 120),
            replyPreview: this.clip(record.reply.replace(/\s+/g, ' '), 240),
            replyChars: record.replyChars,
            truncated: record.truncated,
            steps: record.steps,
        }));
    }

    /** 按 `id`（如 `11.2`）读取单条完整回复 */
    static async getMainAgentReplyById(
        workspaceRoot: string,
        id: string,
    ): Promise<MainAgentReplyRecord | null> {
        const target = String(id || '').trim();
        if (!target) return null;
        const records = await this.readMainAgentReplyFile(workspaceRoot);
        return records.find((record) => record.id === target) || null;
    }

    /**
     * 记录主 Agent 单轮最终回复。
     *
     * 编号规则：`dialogIndex.replyIndex`，`replyIndex` 从 1 起按该对话内出现顺序递增。
     * 空回复不记录；对话已被指令保留策略淘汰时同样不记录。
     *
     * @returns 新写入的记录；未写入时返回 null
     */
    static async recordMainAgentReply(
        workspaceRoot: string,
        dialogIndex: number,
        reply: string,
        options: { instruction?: string; steps?: number } = {},
    ): Promise<MainAgentReplyRecord | null> {
        const text = typeof reply === 'string' ? reply : '';
        if (!text.trim()) return null;
        if (!Number.isInteger(dialogIndex) || dialogIndex <= 0) return null;

        const instructions = await this.getInstructions(workspaceRoot);
        const retained = new Set(instructions.map((record) => record.dialogIndex));
        // 指令文件为空（首次启动/被清空）时不做淘汰，避免误删历史回复
        if (retained.size > 0 && !retained.has(dialogIndex)) return null;

        const current = await this.readMainAgentReplyFile(workspaceRoot);
        const replyIndex = current
            .filter((record) => record.dialogIndex === dialogIndex)
            .reduce((max, record) => Math.max(max, record.replyIndex), 0) + 1;

        const now = Date.now();
        const truncated = text.length > this.MAIN_AGENT_REPLY_MAX_CHARS;
        const instruction = String(options.instruction
            ?? instructions.find((record) => record.dialogIndex === dialogIndex)?.instruction
            ?? '');

        const record: MainAgentReplyRecord = {
            id: `${dialogIndex}.${replyIndex}`,
            dialogIndex,
            replyIndex,
            timestamp: now,
            beijingTime: formatBeijingIso(new Date(now)),
            instruction: this.clip(instruction, this.MAIN_AGENT_REPLY_INSTRUCTION_MAX_CHARS),
            reply: truncated
                ? `${text.slice(0, this.MAIN_AGENT_REPLY_MAX_CHARS)}\n…[truncated ${text.length - this.MAIN_AGENT_REPLY_MAX_CHARS} chars]`
                : text,
            replyChars: text.length,
            truncated,
            steps: Number.isFinite(options.steps) ? Number(options.steps) : 0,
        };

        const pruned = this.pruneReplyRecords([record, ...current], retained);
        await this.writeMainAgentReplyFile(workspaceRoot, pruned);
        return record;
    }

    /** 按当前指令文件保留的 dialogIndex 集合裁剪回复记忆 */
    private static async pruneMainAgentReplies(
        workspaceRoot: string,
        instructions: UserInstructionRecord[],
    ): Promise<void> {
        const current = await this.readMainAgentReplyFile(workspaceRoot);
        if (current.length === 0) return;
        const retained = new Set(instructions.map((record) => record.dialogIndex));
        if (retained.size === 0) return;
        const pruned = this.pruneReplyRecords(current, retained);
        if (pruned.length === current.length) return;
        await this.writeMainAgentReplyFile(workspaceRoot, pruned);
    }

    /**
     * 回复记录裁剪：
     * 1. 只保留 dialogIndex 仍被保留的对话（一一对应）
     * 2. 同一对话最多保留最近 N 条
     * 3. 文件总量超限时按最旧对话整组淘汰
     */
    private static pruneReplyRecords(
        records: MainAgentReplyRecord[],
        retainedDialogs: Set<number>,
    ): MainAgentReplyRecord[] {
        const kept = retainedDialogs.size > 0
            ? records.filter((record) => retainedDialogs.has(record.dialogIndex))
            : [...records];

        // 时间倒序：同一对话内编号大的在前
        kept.sort((a, b) => (b.dialogIndex - a.dialogIndex) || (b.replyIndex - a.replyIndex));

        const perDialogCount = new Map<number, number>();
        const capped = kept.filter((record) => {
            const count = perDialogCount.get(record.dialogIndex) || 0;
            if (count >= this.MAIN_AGENT_REPLY_MAX_PER_DIALOG) return false;
            perDialogCount.set(record.dialogIndex, count + 1);
            return true;
        });

        if (Buffer.byteLength(JSON.stringify(capped), 'utf8') <= this.MAIN_AGENT_REPLY_MAX_FILE_BYTES) {
            return capped;
        }

        // 超限：从最旧的对话开始整组丢弃
        const oldestFirst = [...capped].reverse();
        let bytes = Buffer.byteLength(JSON.stringify(capped), 'utf8');
        const droppedDialogs = new Set<number>();
        for (const record of oldestFirst) {
            if (bytes <= this.MAIN_AGENT_REPLY_MAX_FILE_BYTES) break;
            if (droppedDialogs.has(record.dialogIndex)) continue;
            const groupSize = capped
                .filter((entry) => entry.dialogIndex === record.dialogIndex)
                .reduce((total, entry) => total + Buffer.byteLength(JSON.stringify(entry), 'utf8'), 0);
            droppedDialogs.add(record.dialogIndex);
            bytes -= groupSize;
        }
        return capped.filter((record) => !droppedDialogs.has(record.dialogIndex));
    }

    private static async readMainAgentReplyFile(workspaceRoot: string): Promise<MainAgentReplyRecord[]> {
        try {
            const content = await fs.readFile(this.getReplyFile(workspaceRoot), 'utf8');
            const parsed = JSON.parse(content);
            if (!Array.isArray(parsed)) return [];
            const records = parsed
                .filter((item: any) => item
                    && typeof item.reply === 'string'
                    && Number.isInteger(Number(item.dialogIndex))
                    && Number.isInteger(Number(item.replyIndex)))
                .map((item: any) => ({
                    id: typeof item.id === 'string' && item.id ? item.id : `${Number(item.dialogIndex)}.${Number(item.replyIndex)}`,
                    dialogIndex: Number(item.dialogIndex),
                    replyIndex: Number(item.replyIndex),
                    timestamp: Number(item.timestamp) || 0,
                    beijingTime: typeof item.beijingTime === 'string' ? item.beijingTime : '',
                    instruction: typeof item.instruction === 'string' ? item.instruction : '',
                    reply: item.reply,
                    replyChars: Number(item.replyChars) || item.reply.length,
                    truncated: Boolean(item.truncated),
                    steps: Number(item.steps) || 0,
                } as MainAgentReplyRecord));
            // 统一按「对话编号倒序、回复序号倒序」返回，避免文件被手工编辑后顺序不确定
            return records.sort((a, b) => (b.dialogIndex - a.dialogIndex) || (b.replyIndex - a.replyIndex));
        } catch {
            return [];
        }
    }

    private static async writeMainAgentReplyFile(
        workspaceRoot: string,
        records: MainAgentReplyRecord[],
    ): Promise<void> {
        await this.ensureMemoryDir(workspaceRoot);
        await fs.writeFile(this.getReplyFile(workspaceRoot), JSON.stringify(records, null, 2), 'utf8');
    }

    private static clip(value: string, maxChars: number): string {
        const text = String(value ?? '');
        return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
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
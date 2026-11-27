/**
 * 完成声明凭证校验（Completion Claim Guard）
 *
 * 解决的问题：模型在最终答复里声称「已完成/已加入/已修改」，但本轮根本没有执行
 * 对应工具调用（或执行失败、或写入了别的目标）。这类幻觉比直接报错更危险——用户
 * 会把未落地的结论当成事实。仅靠提示词约束无法根治，因此在「最终答复被接受之前」
 * 增加一道确定性校验：
 *
 *  1. 解析答复中的完成声明与被声明的目标（路径/文件名）；
 *  2. 与本轮真实工具执行凭证比对（谁成功写了什么、写进去的内容里有什么）；
 *  3. 对不上就返回问题清单，由调用方注入纠正指令要求回读核实或补做，
 *     纠正轮仍不达标时在答复末尾附加系统核验提示，绝不静默放行。
 *
 * 设计取向：宁可多一次「回读核实」往返，也不让未经证实的完成声明直接呈现给用户；
 * 但校验条件以「高置信」为准（有写入凭证即通过、命令参数包含目标即通过），
 * 避免对正常答复造成误报。
 */

import { resolveToolName } from '@/tools/toolNames.js';

/** 单次工具执行的凭证 */
export interface ToolEvidence {
    /** 规范化后的工具名（已按 LEGACY_TOOL_ALIASES 归一） */
    name: string;
    /** 工具是否执行成功（返回 status/error 为错误时也算失败） */
    ok: boolean;
    /** 已解析的调用参数，用于提取目标路径与写入内容 */
    args?: Record<string, unknown>;
}

export interface CompletionClaimIssue {
    kind: 'missing_write_evidence' | 'unverified_claimed_target';
    /** 直接可读的问题描述，会进入纠正指令与核验提示 */
    message: string;
}

/** 单条凭证保留的参数内容上限：够判定目标与写入内容，又不至于让长内容常驻内存 */
const EVIDENCE_ARG_MAX_CHARS = 64 * 1024;

function truncateDeep(value: unknown, depth = 0): unknown {
    if (typeof value === 'string') {
        return value.length > EVIDENCE_ARG_MAX_CHARS
            ? value.slice(0, EVIDENCE_ARG_MAX_CHARS)
            : value;
    }
    if (Array.isArray(value)) {
        return depth > 3 ? [] : value.map((item) => truncateDeep(item, depth + 1));
    }
    if (value && typeof value === 'object') {
        if (depth > 3) return {};
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
            result[key] = truncateDeep(item, depth + 1);
        }
        return result;
    }
    return value;
}

/** 记录一条工具凭证；超长参数按上限截断，避免跨轮次累积时占用过多内存。 */
export function toToolEvidence(
    name: string,
    ok: boolean,
    args: Record<string, unknown> | undefined,
): ToolEvidence {
    return {
        name: String(name || ''),
        ok,
        args: args && typeof args === 'object'
            ? (truncateDeep(args) as Record<string, unknown>)
            : undefined,
    };
}

/** 纯读取工具：即便执行成功也不能作为「已修改/已完成」的证据 */
const READ_ONLY_TOOL_NAMES = new Set<string>([
    'read_file',
    'read_file_by_byte',
    'list_files',
    'search_files',
    'read_skill',
    'list_todos',
    'list_never_mistake_rules',
    'list_main_agent_replies',
    'read_main_agent_reply',
    'list_user_preferences',
    'get_env_info',
    'calculator',
    'validate_workflow',
    'list_workflows',
    'get_workflow_run',
    'kg_query',
    'kg_vocab',
    'kg_list_attrs',
    'kg_lint',
]);

/** 「某个动作已经做完」的中文完成标记：已/成功 + 动作动词 */
const COMPLETION_CLAIM_PATTERN =
    /(?:已|成功)(?:经)?(?:完成|加入|添加|写入|追加|修改|更新|替换|删除|移除|创建|新建|移动|重命名|提交|推送|执行|运行|修复|生效|落地|归档|同步|补充|清理|配置|安装|卸载|保存|合并|迁移|回滚)/;

/** 整轮任务的完成宣告，用于「一条写操作都没有」时的高置信拦截 */
const STRONG_TASK_COMPLETION_PATTERN =
    /(?:任务|工作|需求|事项|变更|全部|所有)[^\n]{0,12}(?:已经?完成|全部完成|均已?完成|已完成|处理完毕)|已完成(?:全部|所有)/;

/** 变更清单小节的标题 */
const MANIFEST_HEADING_PATTERN = /^#{1,6}\s*.*(?:文件变更清单|变更清单)/;

/** 变更清单小节最多向后扫描多少行（防止误把正文全量当成声明） */
const MANIFEST_MAX_LINES = 20;

/** 参与「写入内容比对」的字符串总长度上限，避免超长内容拖慢校验 */
const WRITTEN_TEXT_MAX_CHARS = 2 * 1024 * 1024;

/** 从参数中提取目标路径时使用的键名 */
const TARGET_PATH_KEYS = ['path', 'filePath', 'filepath', 'targetPath', 'source', 'destination', 'from', 'to'];

function normalizePathToken(token: string): string {
    return String(token || '')
        .trim()
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/\/{2,}/g, '/')
        .toLowerCase();
}

/** 判断一个 token 是否像「工作区里的文件/目录」，用于从答复正文里抠出被声明的目标 */
export function looksLikePathToken(token: string): boolean {
    const text = String(token || '').trim();
    if (!text || text.length > 240) return false;
    if (/^https?:\/\//i.test(text)) return false;
    if (/[\s<>|*?"`]/.test(text)) return false;
    if (/^[\d.]+$/.test(text)) return false;
    if (/^v?\d+(?:\.\d+)+$/i.test(text)) return false;
    if (text.includes('/') || text.includes('\\')) return true;
    if (/\.[A-Za-z0-9]{1,12}$/.test(text)) return true;
    return /^\.[A-Za-z][\w.-]*$/.test(text);
}

/** 常见「看起来像路径其实不是」的 token，避免误报触发多余的核实轮 */
const NON_PATH_TOKENS = /^(?:and\/or|n\/a|24\/7|tcp\/ip|ci\/cd|i\/o|a\/b|m\/s|and\\or)$/i;

function extractPathTokens(line: string, allowBareFileNames: boolean): string[] {
    const tokens = new Set<string>();

    for (const match of line.matchAll(/`([^`\n]{1,240})`/g)) {
        if (looksLikePathToken(match[1])) tokens.add(match[1].trim());
    }
    // 未加反引号的裸路径：必须含分隔符，避免把普通英文单词当成文件
    for (const match of line.matchAll(/[A-Za-z0-9_\u4e00-\u9fa5.@()-]+(?:[\\/][A-Za-z0-9_\u4e00-\u9fa5.@()-]+)+(?:\.[A-Za-z0-9]{1,12})?/g)) {
        if (!NON_PATH_TOKENS.test(match[0]) && looksLikePathToken(match[0])) tokens.add(match[0].trim());
    }
    // 清单里常见的裸文件名（含扩展名）：只在变更清单小节内生效，
    // 正文里的 `Node.js` 之类技术名不应被当成被声明的文件。
    if (allowBareFileNames) {
        for (const match of line.matchAll(/[A-Za-z0-9_\u4e00-\u9fa5.@()-]+\.[A-Za-z0-9]{1,12}/g)) {
            if (looksLikePathToken(match[0])) tokens.add(match[0].trim());
        }
    }

    // `src/util.ts` 已经覆盖了同行的裸文件名 `util.ts`，去掉冗余项
    const all = Array.from(tokens);
    return all.filter((token) => !all.some((other) => other !== token && other.endsWith(`/${token}`)));
}

/** 提取答复中被「完成声明」覆盖的目标路径（含变更清单小节内的条目） */
export function extractClaimedTargets(content: string): string[] {
    const targets = new Set<string>();
    const lines = String(content || '').split(/\r?\n/);

    let manifestRemaining = 0;
    for (const line of lines) {
        if (MANIFEST_HEADING_PATTERN.test(line.trim())) {
            manifestRemaining = MANIFEST_MAX_LINES;
            continue;
        }
        if (manifestRemaining > 0) {
            if (/^#{1,6}\s/.test(line.trim())) {
                manifestRemaining = 0;
            } else {
                manifestRemaining--;
                for (const token of extractPathTokens(line, true)) targets.add(token);
                continue;
            }
        }
        if (COMPLETION_CLAIM_PATTERN.test(line)) {
            for (const token of extractPathTokens(line, false)) targets.add(token);
        }
    }

    return Array.from(targets);
}

export function hasCompletionClaim(content: string): boolean {
    return COMPLETION_CLAIM_PATTERN.test(String(content || ''));
}

interface StringSink {
    parts: string[];
    size: number;
}

function collectStrings(value: unknown, sink: StringSink, depth = 0): void {
    if (depth > 4 || sink.size > WRITTEN_TEXT_MAX_CHARS) return;
    if (typeof value === 'string') {
        sink.parts.push(value);
        sink.size += value.length;
        return;
    }
    if (Array.isArray(value)) {
        for (const item of value) collectStrings(item, sink, depth + 1);
        return;
    }
    if (value && typeof value === 'object') {
        for (const item of Object.values(value as Record<string, unknown>)) {
            collectStrings(item, sink, depth + 1);
        }
    }
}

interface EvidenceIndex {
    /** 本轮成功执行过任何非只读工具 */
    hasMutatingEvidence: boolean;
    /** 成功调用触及的目标路径（归一化） */
    touchedPaths: Set<string>;
    /** 失败调用触及的目标路径（归一化） */
    failedPaths: Set<string>;
    /** 所有成功调用的字符串参数拼接（含写入内容、命令行），用于「目标是否被真正写入」比对 */
    writtenText: string;
}

function buildEvidenceIndex(evidence: ToolEvidence[]): EvidenceIndex {
    const touchedPaths = new Set<string>();
    const failedPaths = new Set<string>();
    let hasMutatingEvidence = false;
    const sink: StringSink = { parts: [], size: 0 };

    for (const item of evidence) {
        const name = resolveToolName(item.name);
        const isReadOnly = READ_ONLY_TOOL_NAMES.has(name);
        if (!isReadOnly && item.ok) hasMutatingEvidence = true;

        const args = item.args && typeof item.args === 'object' ? item.args : undefined;
        // 只读工具不足以支撑「已修改」：读过 ≠ 改过，因此只把写类工具计入目标覆盖。
        if (args && !isReadOnly) {
            for (const key of TARGET_PATH_KEYS) {
                const value = (args as Record<string, unknown>)[key];
                if (typeof value !== 'string' || !value.trim()) continue;
                const normalized = normalizePathToken(value);
                if (!normalized) continue;
                (item.ok ? touchedPaths : failedPaths).add(normalized);
            }
        }
        // 写入内容比对只对写类工具有意义：只读工具的参数不能证明目标被改过。
        if (args && item.ok && !isReadOnly) collectStrings(args, sink);
    }

    return {
        hasMutatingEvidence,
        touchedPaths,
        failedPaths,
        writtenText: sink.parts.join('\n').toLowerCase(),
    };
}

function isTargetCovered(claimed: string, index: EvidenceIndex): boolean {
    const target = normalizePathToken(claimed);
    if (!target) return true;

    for (const touched of index.touchedPaths) {
        if (touched === target) return true;
        if (touched.endsWith(`/${target}`)) return true;
        if (target.endsWith(`/${touched}`)) return true;
        if (target.endsWith('/') && touched.startsWith(target)) return true;
    }

    // 「X 已加入 Y」这类声明：X 本身不需要被直接写入，只要 Y 的写入内容里出现 X 即算有凭证。
    if (index.writtenText.includes(target)) return true;
    const basename = target.split('/').filter(Boolean).pop();
    if (basename && basename !== target && index.writtenText.includes(basename)) return true;

    return false;
}

function isTargetFailed(claimed: string, index: EvidenceIndex): boolean {
    const target = normalizePathToken(claimed);
    if (!target) return false;
    for (const failed of index.failedPaths) {
        if (failed === target || failed.endsWith(`/${target}`) || target.endsWith(`/${failed}`)) return true;
    }
    return false;
}

/**
 * 校验最终答复里的完成声明是否都有本轮工具凭证。
 * 返回空数组表示通过。
 */
export function evaluateCompletionClaims(
    content: string,
    evidence: ToolEvidence[],
): CompletionClaimIssue[] {
    const reply = String(content || '');
    if (!reply.trim() || !hasCompletionClaim(reply)) return [];

    const index = buildEvidenceIndex(Array.isArray(evidence) ? evidence : []);
    const issues: CompletionClaimIssue[] = [];
    const claimedTargets = extractClaimedTargets(reply);

    // 高置信拦截 1：整轮宣告完成，但一个非只读工具都没成功执行过。
    if (!index.hasMutatingEvidence && (STRONG_TASK_COMPLETION_PATTERN.test(reply) || claimedTargets.length > 0)) {
        issues.push({
            kind: 'missing_write_evidence',
            message: '答复宣告任务/变更已完成，但本轮没有任何写入类工具执行成功（仅有读取或完全没有工具调用）。',
        });
    }

    // 高置信拦截 2：声明改动了某个目标，但该目标既没被任何工具触及，也没出现在写入内容里。
    const unverified = claimedTargets.filter((target) => !isTargetCovered(target, index));
    for (const target of unverified) {
        if (isTargetFailed(target, index)) {
            issues.push({
                kind: 'unverified_claimed_target',
                message: `声明已修改变更 \`${target}\`，但本轮对该目标的写入执行失败。`,
            });
            continue;
        }
        issues.push({
            kind: 'unverified_claimed_target',
            message: `声明已修改变更 \`${target}\`，但本轮没有任何工具调用读写过该目标，写入内容中也不包含它。`,
        });
    }

    return issues;
}

/** 注入下一轮的纠正指令：要求回读核实或补做，并明确「未完成」的表述方式 */
export function buildClaimCorrectionDirective(issues: CompletionClaimIssue[]): string {
    const lines = [
        '【系统核验未通过】你上一条最终答复中的完成声明缺少工具执行凭证，系统已拦截该结论。',
        '核验发现的问题：',
        ...issues.map((issue, idx) => `${idx + 1}. ${issue.message}`),
        '处理要求（必须执行，不得跳过）：',
        '1. 逐条核实：对被声明改动的工作区文件用 `read_file` 回读确认（或 grep 检索关键字），确认目标内容确实存在。',
        '2. 确实未执行的，立即补做；补做时以用户原始指令为准，不要改写用户指定的文件名/条目名。',
        '3. 无法完成或用户指令未覆盖的部分，最终答复必须明确写「未完成：…」，禁止使用「已完成/已加入/已修改」等措辞。',
        '4. 核实完成后重新输出完整最终答复，并在「文件变更清单」中只列本轮真实发生变更的文件。',
    ];
    return lines.join('\n');
}

/** 纠正轮仍未通过时，追加到答复末尾的系统核验提示（对用户可见，避免误导） */
export function buildClaimDisclosure(issues: CompletionClaimIssue[]): string {
    const lines = [
        '',
        '',
        '---',
        '> ⚠️ **系统核验提示**：以下完成声明未能对应到本轮真实的工具执行记录，请以工作区文件的实际内容为准：',
        ...issues.map((issue) => `> - ${issue.message}`),
    ];
    return lines.join('\n');
}

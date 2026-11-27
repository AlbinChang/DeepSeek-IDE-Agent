/**
 * 用户输入/决策诉求识别
 *
 * 供主 Agent 循环判断「本轮最终回复是否在等待用户补充信息或做决策」。
 * 只做纯文本规则判断，不依赖会话状态：
 * - 先剔除围栏代码块与行内代码：mermaid/代码里的「决定」「确认」等词不代表 Agent 在向用户提问；
 * - 「是否/能否/请问/等待…」必须与请求动作词落在同一句内（40 字窗口）：
 *   交付类长回复常在中间提一句「是否…」，正文/代码块后面又出现「决定」「确认」，
 *   用无界 `.*` 跨段落匹配会把已完成的任务误判成等待用户输入，导致跳过评估Agent；
 * - 出现否定词（无需/不用/不需要…）时整体判定为否。
 */

const NEGATION_PATTERN = /(无需|不用|不需要|暂不需要|已无需|no need|not required)/i;

const QUESTION_ASK_PATTERN =
    /(?:是否|能否|可否|请问|等待(?:你|用户)?)[^。！？!?\n]{0,40}?(?:提供|确认|选择|决定|授权|上传|输入|告知)/;

const DIRECT_ASK_PATTERNS: RegExp[] = [
    /请(?:你)?(?:先|再)?(?:提供|补充|确认|选择|决定|上传|填写|输入|告知)/,
    /需要(?:你|用户)(?:提供|补充|确认|选择|决定|授权|上传|输入)/,
    /\b(?:please|kindly)\s+(?:provide|confirm|choose|decide|select|upload|input|share)\b/i,
    /\bneed your (?:input|decision|confirmation|approval|selection)\b/i,
];

/** 去掉围栏代码块、行内代码并压平空白，只保留叙述性正文 */
function stripNonProse(reply: string): string {
    return String(reply ?? "")
        .replace(/```[\s\S]*?```/g, " ")
        .replace(/`[^`\n]*`/g, " ")
        .replace(/\s+/g, " ")
        .trim();
}

/** 回复是否明确要求用户补充信息或做决策（判定为则需要立即退出循环等待新指令） */
export function requiresUserInputOrDecision(reply: string): boolean {
    const text = stripNonProse(reply);
    if (!text) return false;
    if (NEGATION_PATTERN.test(text)) return false;
    if (QUESTION_ASK_PATTERN.test(text)) return true;
    return DIRECT_ASK_PATTERNS.some((pattern) => pattern.test(text));
}

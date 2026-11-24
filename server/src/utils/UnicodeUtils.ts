/**
 * UTF-16 孤立代理码元（lone surrogate）修复工具。
 *
 * 背景：DeepSeek / OpenAI 兼容网关要求请求体是合法 JSON。Node 的 `JSON.stringify`
 * 会把未配对的 UTF-16 代理码元转义成 `\ud83d` 这类“孤立代理转义”，而服务端的
 * JSON 解析器（如 Rust serde_json）会直接拒绝整个请求：
 *   HTTP 400 `Failed to parse the request body as JSON ... unexpected end of hex escape`
 *   部分网关会本地化为 `400 请求格式不合法`。
 *
 * 孤立代理码元在本项目中的常见来源：
 *  - 按 UTF-16 解码的文件内容（字节数奇数 / 文件本身损坏）
 *  - 模型流式输出被截断、或按 code unit 截断的字符串
 *  - 工具结果、记忆文件中的截断文本
 *
 * 修复策略：把无法与相邻码元组成合法代理对的 code unit 替换为 U+FFFD，
 * 其余字符逐字保留（不做任何编码转换）。
 */

const REPLACEMENT_CHAR = "\uFFFD";
const MAX_SANITIZE_DEPTH = 8;

/** 先用原生正则快速排除绝大多数不含代理码元的字符串（请求体最大可达数 MB） */
const SURROGATE_PATTERN = /[\uD800-\uDFFF]/;

export function hasLoneSurrogate(text: string): boolean {
    if (!text || !SURROGATE_PATTERN.test(text)) return false;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF) {
            const next = text.charCodeAt(i + 1);
            if (!(next >= 0xDC00 && next <= 0xDFFF)) return true;
            i++;
        } else if (code >= 0xDC00 && code <= 0xDFFF) {
            return true;
        }
    }
    return false;
}

/**
 * 将孤立代理码元替换为 U+FFFD。字符串合法时原样返回同一引用，避免无谓拷贝。
 */
export function sanitizeLoneSurrogates(text: string): string {
    if (!hasLoneSurrogate(text)) return text;

    let result = "";
    let chunkStart = 0;
    for (let i = 0; i < text.length; i++) {
        const code = text.charCodeAt(i);
        if (code >= 0xD800 && code <= 0xDBFF) {
            const next = text.charCodeAt(i + 1);
            if (next >= 0xDC00 && next <= 0xDFFF) {
                i++;
                continue;
            }
            result += text.slice(chunkStart, i) + REPLACEMENT_CHAR;
            chunkStart = i + 1;
        } else if (code >= 0xDC00 && code <= 0xDFFF) {
            result += text.slice(chunkStart, i) + REPLACEMENT_CHAR;
            chunkStart = i + 1;
        }
    }
    return result + text.slice(chunkStart);
}

export interface SanitizeJsonStringsResult<T> {
    value: T;
    /** 被修复的字符串字段数量（用于诊断日志；0 表示请求体本来就合法） */
    repairedStrings: number;
}

/**
 * 递归修复 JSON 结构中的孤立代理码元。
 *
 * - 只在真的发生替换时才复制对象/数组，正常请求保持原引用（不破坏消息字节数缓存）。
 * - 仅递归普通对象与数组，Date/Buffer/类实例等原样保留。
 * - 深度超限时停止下钻（请求体结构远浅于该上限）。
 */
export function sanitizeJsonStrings<T>(value: T, maxDepth: number = MAX_SANITIZE_DEPTH): SanitizeJsonStringsResult<T> {
    const state = { repairedStrings: 0 };
    const sanitized = sanitizeJsonValue(value, state, 0, maxDepth);
    return { value: sanitized as T, repairedStrings: state.repairedStrings };
}

function sanitizeJsonValue(value: any, state: { repairedStrings: number }, depth: number, maxDepth: number): any {
    if (typeof value === "string") {
        const sanitized = sanitizeLoneSurrogates(value);
        if (sanitized !== value) state.repairedStrings++;
        return sanitized;
    }

    if (depth >= maxDepth) return value;

    if (Array.isArray(value)) {
        let changed = false;
        const next = new Array(value.length);
        for (let i = 0; i < value.length; i++) {
            const sanitized = sanitizeJsonValue(value[i], state, depth + 1, maxDepth);
            next[i] = sanitized;
            if (sanitized !== value[i]) changed = true;
        }
        return changed ? next : value;
    }

    if (value && typeof value === "object") {
        const proto = Object.getPrototypeOf(value);
        if (proto !== Object.prototype && proto !== null) return value;

        let changed = false;
        const next: Record<string, any> = {};
        for (const [key, entry] of Object.entries(value)) {
            const sanitized = sanitizeJsonValue(entry, state, depth + 1, maxDepth);
            next[key] = sanitized;
            if (sanitized !== entry) changed = true;
        }
        return changed ? next : value;
    }

    return value;
}

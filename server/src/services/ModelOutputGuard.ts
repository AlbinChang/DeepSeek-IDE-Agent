/**
 * 模型输出守卫：识别被当成正文输出的“模型控制 token”。
 *
 * 正常对话模型不会把 BOS/EOS 等控制标记写进正文；一旦出现，通常意味着
 * 服务端 chat template 用错/重复应用、推理后端 skip_special_tokens=false、
 * 提供的是 base 权重、或网关把请求路由到了别的模型。这类输出继续写回
 * 会话历史会污染后续上下文，因此需要在落库前拦截。
 */

export type ControlTokenFamily =
    | 'ernie'
    | 'deepseek'
    | 'qwen'
    | 'llama'
    | 'mistral'
    | 'generic';

export interface ControlTokenHit {
    token: string;
    family: ControlTokenFamily;
    count: number;
}

/** 各模型家族的控制标记；匹配时忽略大小写与常见空白变体。 */
const CONTROL_TOKEN_PATTERNS: Array<{ family: ControlTokenFamily; pattern: RegExp }> = [
    { family: 'ernie', pattern: /<\/?\s*\|?\s*(?:begin|end)_of_sentence\s*\|?\s*\/?>/gi },
    { family: 'deepseek', pattern: /<[｜|]\s*(?:begin|end)▁of▁sentence\s*[｜|]>/gi },
    { family: 'qwen', pattern: /<\|(?:im_start|im_end|endoftext)\|>/gi },
    { family: 'llama', pattern: /<\|(?:begin_of_text|end_of_text|eot_id|start_header_id|end_header_id)\|>/gi },
    { family: 'mistral', pattern: /\[\/?INST\]|<<\/?SYS>>/gi },
    { family: 'generic', pattern: /<\|(?:bos|eos|pad|unk|sep|cls)\|>/gi },
];

/** 用于判断“当前文本还只是一个控制标记的前缀”。 */
const TOKEN_LITERALS = [
    '<|begin_of_sentence|>',
    '<|end_of_sentence|>',
    '</begin_of_sentence />',
    '</begin_of_sentence>',
    '</end_of_sentence>',
    '<｜begin▁of▁sentence｜>',
    '<｜end▁of▁sentence｜>',
    '<|im_start|>',
    '<|im_end|>',
    '<|endoftext|>',
    '<|begin_of_text|>',
    '<|end_of_text|>',
    '<|eot_id|>',
    '<|start_header_id|>',
    '<|end_header_id|>',
    '[INST]',
    '[/INST]',
    '<<SYS>>',
    '<</SYS>>',
];

export interface ModelOutputDiagnostics {
    /** 配置里请求的模型 ID */
    requestedModel?: string;
    /** 供应商响应里回报的实际模型 ID（可用于识别模型替换） */
    servedModels?: string[];
    systemFingerprints?: string[];
    providerId?: string;
    baseUrlHost?: string;
}

export class ModelOutputCorruptionError extends Error {
    public readonly code = 'MODEL_OUTPUT_CORRUPTED';

    constructor(
        message: string,
        public readonly detail: {
            phase: 'prefix' | 'body';
            hit: ControlTokenHit;
            diagnostics: ModelOutputDiagnostics;
        },
    ) {
        super(message);
        this.name = 'ModelOutputCorruptionError';
    }
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 去掉可能出现在控制标记前的标题/列表/引用符号，但保留反引号（表示引用代码）。 */
function stripLeadingDecorations(text: string): string {
    return text.replace(/^[\s#*>+\-~]+/, '');
}

function matchAtStart(text: string): ControlTokenHit | undefined {
    for (const { family, pattern } of CONTROL_TOKEN_PATTERNS) {
        const regex = new RegExp(pattern.source, 'i');
        const match = regex.exec(text);
        if (match && match.index === 0) {
            return { token: match[0], family, count: 1 };
        }
    }
    return undefined;
}

function isControlTokenPrefix(text: string): boolean {
    if (!text) return true;
    const lower = text.toLowerCase();
    return TOKEN_LITERALS.some((token) => token.toLowerCase().startsWith(lower));
}

export type LeadingProbe =
    | { state: 'clean' }
    | { state: 'incomplete' }
    | { state: 'suspect'; hit: ControlTokenHit };

/**
 * 判断输出开头是否已经可以判定为“控制标记泄漏”。
 * `incomplete` 表示当前样本太短、仍可能是一个控制标记的前缀，需要继续缓冲。
 */
export function probeLeadingContent(text: string): LeadingProbe {
    const stripped = stripLeadingDecorations(text);
    if (!stripped) return { state: 'incomplete' };
    if (stripped.startsWith('`')) return { state: 'clean' };

    const hit = matchAtStart(stripped);
    if (hit) return { state: 'suspect', hit };

    if (isControlTokenPrefix(stripped)) return { state: 'incomplete' };
    return { state: 'clean' };
}

/**
 * 检测正文中同一控制标记重复出现（退化重复是故障输出的典型特征）。
 * 仅在较短输出上判定，避免误伤“讲解特殊 token”的长文。
 */
export function detectRepeatedControlToken(text: string, maxLength = 600): ControlTokenHit | undefined {
    if (text.length > maxLength) return undefined;
    for (const { family, pattern } of CONTROL_TOKEN_PATTERNS) {
        const regex = new RegExp(pattern.source, 'gi');
        const matches = text.match(regex);
        if (matches && matches.length >= 2) {
            return { token: matches[0], family, count: matches.length };
        }
    }
    return undefined;
}

export function describeControlToken(hit: ControlTokenHit): string {
    const familyHints: Record<ControlTokenFamily, string> = {
        ernie: 'ERNIE/PaddleNLP 系列',
        deepseek: 'DeepSeek 系列',
        qwen: 'Qwen 系列',
        llama: 'Llama 3 系列',
        mistral: 'Mistral 系列',
        generic: '通用特殊 token',
    };
    return `${familyHints[hit.family]} 控制标记 ${hit.token}`;
}

/**
 * 供应商常把版本号拼进 model 字段（如 deepseek-chat → deepseek-chat-0324），
 * 因此用“前缀互含”判断是否属于同一模型，避免误报模型替换。
 */
export function isModelMismatch(requested: string | undefined, served: string[]): boolean {
    if (!requested || served.length === 0) return false;
    const normalize = (value: string) => value.trim().toLowerCase();
    const target = normalize(requested);
    return !served.some((model) => {
        const current = normalize(model);
        return current === target || current.startsWith(target) || target.startsWith(current);
    });
}

export function buildCorruptionMessage(
    hit: ControlTokenHit,
    phase: 'prefix' | 'body',
    diagnostics: ModelOutputDiagnostics,
): string {
    const parts = [
        `模型返回了 ${describeControlToken(hit)}${phase === 'body' ? `（重复 ${hit.count} 次）` : ''}，属于异常的模型输出。`,
        '常见原因：服务端 chat template 不匹配/重复应用、推理后端未跳过特殊 token、提供的不是 instruct 权重，或网关路由到了其他模型。',
    ];
    const requested = diagnostics.requestedModel;
    const served = diagnostics.servedModels?.filter(Boolean) ?? [];
    if (requested) parts.push(`请求模型：${requested}。`);
    if (served.length > 0) {
        parts.push(`服务端回报模型：${served.join(', ')}。`);
        if (isModelMismatch(requested, served)) {
            parts.push('与请求模型不一致，请核查是否发生了模型替换或代理降级。');
        }
    }
    if (diagnostics.systemFingerprints?.length) {
        parts.push(`system_fingerprint：${diagnostics.systemFingerprints.join(', ')}。`);
    }
    if (diagnostics.baseUrlHost) parts.push(`接口地址：${diagnostics.baseUrlHost}。`);
    return parts.join(' ');
}

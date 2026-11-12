/**
 * 模型输出守卫：识别被当成正文/工具参数输出的“模型控制 token”。
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
    // 特殊 token 未被 skip 时，部分推理后端只会吐出裸 token 文本（不带 <｜…｜> 包装），
    // 因此包装符整体可选：`begin▁of▁sentence`、`<｜begin▁of▁sentence｜>` 都要能命中。
    { family: 'deepseek', pattern: /(?:<\/?[｜|]\s*)?▁?(?:begin|end)▁of▁sentence(?:\s*[｜|]?>)?/gi },
    { family: 'qwen', pattern: /<\|(?:im_start|im_end|endoftext)\|>/gi },
    { family: 'llama', pattern: /<\|(?:begin_of_text|end_of_text|eot_id|start_header_id|end_header_id)\|>/gi },
    { family: 'mistral', pattern: /\[\/?INST\]|<<\/?SYS>>/gi },
    { family: 'generic', pattern: /<\|(?:bos|eos|pad|unk|sep|cls)\|>/gi },
];

/** 各家族控制标记的合并正则源：热路径（工具参数增量）只需扫描一次。 */
const CONTROL_TOKEN_ANY_SOURCE = CONTROL_TOKEN_PATTERNS.map(({ pattern }) => pattern.source).join('|');

/** 用于判断“当前文本还只是一个控制标记的前缀”。 */
const TOKEN_LITERALS = [
    '<|begin_of_sentence|>',
    '<|end_of_sentence|>',
    '</begin_of_sentence />',
    '</begin_of_sentence>',
    '</end_of_sentence>',
    '<｜begin▁of▁sentence｜>',
    '<｜end▁of▁sentence｜>',
    'begin▁of▁sentence',
    'end▁of▁sentence',
    '▁begin▁of▁sentence',
    '▁end▁of▁sentence',
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

/** 控制标记出现的位置：正文/推理开头、正文中段、工具调用参数。 */
export type CorruptionPhase = 'prefix' | 'body' | 'tool_arguments';

export class ModelOutputCorruptionError extends Error {
    public readonly code = 'MODEL_OUTPUT_CORRUPTED';

    constructor(
        message: string,
        public readonly detail: {
            phase: CorruptionPhase;
            hit: ControlTokenHit;
            diagnostics: ModelOutputDiagnostics;
        },
    ) {
        super(message);
        this.name = 'ModelOutputCorruptionError';
    }
}

/**
 * 供应商回报的模型与请求模型不一致（模型替换/网关降级）。
 * 命中时本次回复尚未送到前端，可安全丢弃并重新请求。
 */
export class ModelSubstitutionError extends Error {
    public readonly code = 'MODEL_SUBSTITUTED';

    constructor(
        message: string,
        public readonly detail: {
            attempt: number;
            limit: number;
            requestedModel?: string;
            servedModels: string[];
        },
    ) {
        super(message);
        this.name = 'ModelSubstitutionError';
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

/**
 * 在文本任意位置查找控制标记。
 * 用于工具调用参数等“正常内容不可能出现控制标记”的场景：JSON 参数里出现即为响应损坏，
 * 无需等待重复出现即可判定。
 */
export function findControlToken(text: string | undefined | null): ControlTokenHit | undefined {
    if (!text) return undefined;
    // 工具参数增量检测是热路径：合并成一个正则扫描一次，避免逐个家族编译/匹配
    const matches = Array.from(text.matchAll(new RegExp(CONTROL_TOKEN_ANY_SOURCE, 'gi')));
    if (matches.length === 0) return undefined;
    const token = matches[0][0];
    const family = CONTROL_TOKEN_PATTERNS
        .find(({ pattern }) => new RegExp(pattern.source, 'i').test(token))?.family ?? 'generic';
    return { token, family, count: matches.length };
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
 * 归一化模型 ID，让“同一个模型的不同写法”可以互相比较：
 *  - 忽略大小写与分隔符：`DeepSeek-V4-Flash` → `deepseekv4flash`
 *  - 忽略网关常见的“组织/模型”前缀：`deepseek-ai/deepseek-v4-flash` → `deepseekv4flash`
 *  - 展开常见厂商缩写：`dsv4` / `ds-v4` → `deepseekv4`
 */
function canonicalModelId(value: string): string {
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return '';
    const modelPart = trimmed.slice(trimmed.lastIndexOf('/') + 1);
    return modelPart
        .replace(/[^a-z0-9]+/g, '')
        .replace(/^ds(?=[a-z0-9]|$)/, 'deepseek');
}

/**
 * 判断供应商回报的模型是否与请求模型不同。
 * 供应商常把版本号拼进 model 字段（deepseek-chat → deepseek-chat-0324），
 * 网关也常用缩写/别名（deepseek-v4-flash → dsv4）或带组织前缀（deepseek-ai/xxx），
 * 这些都属于同一模型，因此归一化后按“前缀互含”比较，避免误报模型替换。
 */
export function isModelMismatch(requested: string | undefined, served: string[]): boolean {
    if (!requested || served.length === 0) return false;
    const target = canonicalModelId(requested);
    if (!target) return false;
    return !served.some((model) => {
        const current = canonicalModelId(model);
        if (!current) return false;
        return current === target || current.startsWith(target) || target.startsWith(current);
    });
}

export function buildCorruptionMessage(
    hit: ControlTokenHit,
    phase: CorruptionPhase,
    diagnostics: ModelOutputDiagnostics,
): string {
    const phaseNote = phase === 'body'
        ? `（重复 ${hit.count} 次）`
        : phase === 'tool_arguments'
            ? '（出现在工具调用参数中）'
            : '';
    const parts = [
        `模型返回了 ${describeControlToken(hit)}${phaseNote}，属于异常的模型输出。`,
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

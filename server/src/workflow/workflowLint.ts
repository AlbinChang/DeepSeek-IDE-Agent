/**
 * Workflow 编译检查（compile check）。
 *
 * 与 `WorkflowRegistry` 的结构校验互补：结构校验只保证「字段类型对」，
 * 这里做**链接期**与**语义期**检查，确保大规模/复杂 workflow 不会在运行时
 * 才暴露引用错误、表达式错误、权限被静默裁剪或不可达步骤。
 *
 * 诊断分层：
 * - error   ：运行必然失败或语义必然错误（阻止执行）
 * - warning ：很可能是错误（前向引用、工具被静默裁剪、缺少默认分支等）
 * - info    ：提示项（不影响通过）
 */
import { checkExpressionSyntax, parseDurationMs } from '@/workflow/expressions.js';
import {
    EVALUATOR_FORBIDDEN_WRITE_TOOLS,
    FORBIDDEN_TODO_WRITE_TOOLS,
    FORBIDDEN_WORKFLOW_TOOLS,
} from '@/workflow/workflowToolPolicy.js';
import { describeLegacyToolName, isLegacyToolName, resolveToolName } from '@/tools/toolNames.js';

export type WorkflowLintSeverity = 'error' | 'warning' | 'info';

export interface WorkflowLintDiagnostic {
    code: string;
    severity: WorkflowLintSeverity;
    /** 近似 JSON Pointer，如 /do/0/step/with/prompt */
    path: string;
    message: string;
    hint?: string;
}

export interface WorkflowLintOptions {
    /** 已知工具名；提供时对 with.tools / with.tool 做链接检查 */
    knownTools?: Iterable<string>;
    /** 已知工作流名或相对路径；提供时对子工作流做链接检查 */
    knownWorkflows?: Iterable<string>;
    /** 解析子工作流目标是否存在（deep 模式优先使用） */
    subworkflowExists?: (target: string) => Promise<boolean>;
    /** 校验 .workflow 资产是否存在（deep 模式下由调用方提供） */
    fileExists?: (relativePath: string) => Promise<boolean>;
    /** 额外检查：资产存在性、子工作流存在性、传递引用 */
    deep?: boolean;
    maxIssues?: number;
    codes?: Iterable<string>;
}

export interface WorkflowLintResult {
    ok: boolean;
    /** error + warning（可执行性问题） */
    diagnostics: WorkflowLintDiagnostic[];
    /** info（提示项，不影响通过） */
    infos: WorkflowLintDiagnostic[];
    errorCount: number;
    warningCount: number;
    infoCount: number;
    stepCount: number;
}

const CALLABLE_KINDS = new Set(['agent', 'tool', 'shell', 'http', 'evaluator', 'approval', 'workflow']);
const RUN_KINDS = new Set(['shell', 'http', 'workflow']);
const OPERATION_KEYS = ['call', 'run', 'set', 'switch', 'for', 'try', 'fork', 'wait', 'raise'] as const;
const EVENT_KEYS = ['emit', 'listen'] as const;
const REFERENCEABLE_NAME = /^[A-Za-z_][A-Za-z0-9_-]*$/;
const STEP_REFERENCE = /\bsteps\.([A-Za-z_$][A-Za-z0-9_$-]*)/g;
const INPUT_REFERENCE = /\binputs\.([A-Za-z_$][A-Za-z0-9_$-]*)/g;
const TEMPLATE = /\$\{([\s\S]*?)\}/g;
const WORKFLOW_ASSET = /(?:^|[\s"'(=])(\.workflow[\\/][^\s"';|&<>)]+)/g;
const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|credential|access[_-]?key|private[_-]?key)/i;
const JSON_SCHEMA_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const MAX_NESTING_DEPTH = 8;

function asRecord(value: unknown): Record<string, any> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, any>
        : undefined;
}

function sequenceOf(value: unknown): unknown[] | undefined {
    if (Array.isArray(value)) return value;
    const record = asRecord(value);
    return Array.isArray(record?.do) ? record.do : undefined;
}

function nonEmptyString(value: unknown): boolean {
    return typeof value === 'string' && value.trim().length > 0;
}

function pointer(base: string, key: string | number): string {
    return `${base}/${String(key)}`;
}

interface StepEntry {
    name: string;
    path: string;
    definition: Record<string, any>;
    ordinal: number;
    depth: number;
    sequencePath: string;
    sequenceIndex: number;
    sequenceLength: number;
}

interface StepStrings {
    path: string;
    value: string;
}

interface LintState {
    diagnostics: WorkflowLintDiagnostic[];
    entries: StepEntry[];
    templates: Map<StepEntry, StepStrings[]>;
    expressions: { entry: StepEntry; path: string; source: string; condition: boolean }[];
    declaredInputs: Set<string>;
    inputRefs: { path: string; name: string }[];
    subworkflowRefs: { path: string; target: string }[];
    knownTools?: Set<string>;
    options: WorkflowLintOptions;
}

function collectDeclaredInputs(document: Record<string, any>): Set<string> {
    const raw = document?.document?.input?.schema
        ?? document?.document?.input
        ?? document?.document?.inputs
        ?? document?.input?.schema
        ?? document?.input
        ?? document?.inputs;
    const names = new Set<string>();
    if (!raw) return names;
    if (Array.isArray(raw)) {
        for (const item of raw) {
            if (typeof item === 'string') names.add(item);
            else if (asRecord(item)?.name && typeof (item as any).name === 'string') names.add((item as any).name);
        }
        return names;
    }
    const record = asRecord(raw);
    if (record?.properties && typeof record.properties === 'object') {
        for (const key of Object.keys(record.properties)) names.add(key);
    }
    return names;
}

/** 收集步骤（与 WorkflowRegistry 的嵌套规则保持一致）。 */
function collectSteps(
    steps: unknown[],
    basePath: string,
    depth: number,
    state: LintState,
): void {
    let exited = false;
    steps.forEach((step, index) => {
        const stepPath = pointer(basePath, index);
        const stepRecord = asRecord(step);
        if (!stepRecord) return;
        const names = Object.keys(stepRecord);
        if (!names.length) return;

        if (exited) {
            state.diagnostics.push({
                code: 'step_after_exit',
                severity: 'warning',
                path: stepPath,
                message: '该步骤位于 then:"exit" 之后，永远不会执行',
                hint: '把不可达步骤移到 exit 之前，或删除。',
            });
        }

        for (const name of names) {
            const definition = asRecord(stepRecord[name]);
            if (!definition) continue;
            const entry: StepEntry = {
                name,
                path: pointer(stepPath, name),
                definition,
                ordinal: state.entries.length,
                depth,
                sequencePath: basePath,
                sequenceIndex: index,
                sequenceLength: steps.length,
            };
            state.entries.push(entry);
            if (definition.then === 'exit') exited = true;
            if (!REFERENCEABLE_NAME.test(name)) {
                state.diagnostics.push({
                    code: 'step_name_not_referenceable',
                    severity: 'warning',
                    path: entry.path,
                    message: `步骤名 "${name}" 不是合法标识符，无法用 steps.${name} 引用`,
                    hint: '步骤名只用字母/数字/下划线/连字符，且以字母或下划线开头。',
                });
            }
            if (depth > MAX_NESTING_DEPTH) {
                state.diagnostics.push({
                    code: 'nesting_too_deep',
                    severity: 'warning',
                    path: entry.path,
                    message: `嵌套层级 ${depth} 超过 ${MAX_NESTING_DEPTH}，可读性与可调试性风险高`,
                    hint: '把深层嵌套抽成独立 workflow，用 call: workflow 复用。',
                });
            }

            const switchConfig = asRecord(definition.switch);
            const cases = Array.isArray(definition.switch)
                ? definition.switch
                : (Array.isArray(switchConfig?.cases) ? switchConfig.cases : undefined);
            if (cases) {
                cases.forEach((item: unknown, caseIndex: number) => {
                    const branch = asRecord(item);
                    if (!branch) return;
                    const branchSteps = branch.default !== undefined
                        ? sequenceOf(branch.default)
                        : sequenceOf(branch);
                    if (branchSteps) {
                        collectSteps(branchSteps, `${entry.path}/switch/case-${caseIndex}/do`, depth + 1, state);
                    }
                });
            }
            if (definition.for !== undefined) {
                const loopSteps = sequenceOf(definition.do);
                if (loopSteps) collectSteps(loopSteps, `${entry.path}/for/do`, depth + 1, state);
            }
            if (definition.try !== undefined) {
                const trySteps = sequenceOf(definition.try);
                if (trySteps) collectSteps(trySteps, `${entry.path}/try`, depth + 1, state);
                const catchSteps = sequenceOf(definition.catch);
                if (catchSteps) collectSteps(catchSteps, `${entry.path}/catch`, depth + 1, state);
            }
            if (definition.fork !== undefined) {
                const forkConfig = asRecord(definition.fork);
                const branches = Array.isArray(definition.fork)
                    ? definition.fork
                    : (Array.isArray(forkConfig?.branches) ? forkConfig.branches : []);
                branches.forEach((branch: unknown, branchIndex: number) => {
                    const branchSteps = sequenceOf(branch) ?? (asRecord(branch) ? [branch] : undefined);
                    if (branchSteps) {
                        collectSteps(branchSteps, `${entry.path}/fork/branch-${branchIndex}/do`, depth + 1, state);
                    }
                });
            }
        }
    });
}

function collectStepStrings(value: unknown, path: string, out: StepStrings[], depth = 0): void {
    if (depth > 40) return;
    if (typeof value === 'string') {
        if (value.includes('${')) out.push({ path, value });
        return;
    }
    if (Array.isArray(value)) {
        value.forEach((item, index) => collectStepStrings(item, pointer(path, index), out, depth + 1));
        return;
    }
    const record = asRecord(value);
    if (!record) return;
    for (const [key, entry] of Object.entries(record)) {
        collectStepStrings(entry, pointer(path, key), out, depth + 1);
    }
}

function collectTemplates(entry: StepEntry, state: LintState): void {
    const definition = entry.definition;
    const strings: StepStrings[] = [];
    // when/while/switch.when 是表达式，单独处理；其余字符串按模板扫描
    for (const key of ['with', 'set', 'run', 'raise', 'output', 'wait', 'for']) {
        if (definition[key] === undefined) continue;
        const target = key === 'for'
            ? { in: definition.for?.in, while: undefined }
            : definition[key];
        collectStepStrings(target, pointer(entry.path, key), strings);
    }
    state.templates.set(entry, strings);

    if (typeof definition.when === 'string' && definition.when.trim()) {
        state.expressions.push({
            entry, path: `${entry.path}/when`, source: definition.when, condition: true,
        });
    }
    const switchConfig = asRecord(definition.switch);
    const cases = Array.isArray(definition.switch)
        ? definition.switch
        : (Array.isArray(switchConfig?.cases) ? switchConfig.cases : undefined);
    cases?.forEach((item: unknown, index: number) => {
        const branch = asRecord(item);
        if (typeof branch?.when === 'string' && branch.when.trim()) {
            state.expressions.push({
                entry,
                path: `${entry.path}/switch/case-${index}/when`,
                source: branch.when,
                condition: true,
            });
        }
    });
    const whileSource = asRecord(definition.for)?.while ?? definition.while;
    if (typeof whileSource === 'string' && whileSource.trim()) {
        state.expressions.push({
            entry, path: `${entry.path}/for/while`, source: whileSource, condition: true,
        });
    }
}

function scanReferences(entry: StepEntry, path: string, source: string, state: LintState): void {
    for (const match of source.matchAll(STEP_REFERENCE)) {
        const name = match[1];
        const target = state.entries.find((item) => item.name === name);
        if (!target) {
            state.diagnostics.push({
                code: 'steps_ref_unknown',
                severity: 'error',
                path,
                message: `引用了不存在的步骤 steps.${name}`,
                hint: '检查步骤名拼写；步骤名区分大小写。',
            });
            continue;
        }
        if (target.ordinal >= entry.ordinal && target.name !== entry.name) {
            state.diagnostics.push({
                code: 'steps_ref_forward',
                severity: 'warning',
                path,
                message: `引用了尚未执行的步骤 steps.${name}（前向引用，运行时为 undefined）`,
                hint: '把引用移到该步骤之后，或用 set 步骤先占位。',
            });
        }
    }
    for (const match of source.matchAll(INPUT_REFERENCE)) {
        const name = match[1];
        state.inputRefs.push({ path, name });
        if (!state.declaredInputs.has(name)) {
            state.diagnostics.push({
                code: 'inputs_ref_undeclared',
                severity: 'warning',
                path,
                message: `引用了未声明的输入 inputs.${name}`,
                hint: '在 document.input.schema.properties 中声明该输入，或改用固定值。',
            });
        }
    }
}

function scanExpression(entry: StepEntry, path: string, source: string, state: LintState): void {
    try {
        checkExpressionSyntax(source);
    } catch (error) {
        state.diagnostics.push({
            code: 'expr_syntax',
            severity: 'error',
            path,
            message: `表达式语法错误：${(error as Error).message}`,
            hint: '表达式只支持路径/字面量/比较/布尔/算术与内置过滤器（default/json/join/upper/lower/length/keys/string/number/boolean）。',
        });
        return;
    }
    scanReferences(entry, path, source, state);
}

function checkOutputSchema(schema: unknown, path: string, state: LintState, depth = 0): void {
    if (depth > 20) return;
    const record = asRecord(schema);
    if (!record) {
        state.diagnostics.push({
            code: 'output_schema_invalid',
            severity: 'error',
            path,
            message: 'output.schema 必须是对象',
            hint: 'shape 必须是合法 JSON Schema 子集对象。',
        });
        return;
    }
    if (record.type !== undefined) {
        const types = Array.isArray(record.type) ? record.type : [record.type];
        if (types.some((type: unknown) => typeof type !== 'string' || !JSON_SCHEMA_TYPES.has(type))) {
            state.diagnostics.push({
                code: 'output_schema_invalid',
                severity: 'error',
                path: pointer(path, 'type'),
                message: `type 只支持 ${Array.from(JSON_SCHEMA_TYPES).join('/')}`,
                hint: '修正 JSON Schema 的 type 值。',
            });
        }
    }
    if (record.required !== undefined
        && (!Array.isArray(record.required) || record.required.some((key: unknown) => typeof key !== 'string'))) {
        state.diagnostics.push({
            code: 'output_schema_invalid',
            severity: 'error',
            path: pointer(path, 'required'),
            message: 'required 必须是字符串数组',
            hint: '例如 required: [fieldA, fieldB]。',
        });
    }
    if (record.properties !== undefined && !asRecord(record.properties)) {
        state.diagnostics.push({
            code: 'output_schema_invalid',
            severity: 'error',
            path: pointer(path, 'properties'),
            message: 'properties 必须是对象',
            hint: 'properties 下每个键对应一个子 schema。',
        });
    }
    if (asRecord(record.properties)) {
        for (const [key, child] of Object.entries(record.properties as Record<string, unknown>)) {
            checkOutputSchema(child, pointer(pointer(path, 'properties'), key), state, depth + 1);
        }
    }
    if (record.items !== undefined && !Array.isArray(record.items)) {
        checkOutputSchema(record.items, pointer(path, 'items'), state, depth + 1);
    }
    if (record.enum !== undefined && !Array.isArray(record.enum)) {
        state.diagnostics.push({
            code: 'output_schema_invalid',
            severity: 'error',
            path: pointer(path, 'enum'),
            message: 'enum 必须是数组',
            hint: '枚举值写成数组形式。',
        });
    }
    for (const combinator of ['allOf', 'anyOf', 'oneOf']) {
        const branches = record[combinator];
        if (branches === undefined) continue;
        if (!Array.isArray(branches) || !branches.length) {
            state.diagnostics.push({
                code: 'output_schema_invalid',
                severity: 'error',
                path: pointer(path, combinator),
                message: `${combinator} 必须是非空数组`,
                hint: '每一个元素都是一个子 schema。',
            });
            continue;
        }
        branches.forEach((child, index) => {
            checkOutputSchema(child, pointer(pointer(path, combinator), index), state, depth + 1);
        });
    }
}

function checkSecretLiterals(value: unknown, path: string, state: LintState, depth = 0): void {
    if (depth > 20) return;
    const record = asRecord(value);
    if (!record) {
        if (Array.isArray(value)) {
            value.forEach((item, index) => checkSecretLiterals(item, pointer(path, index), state, depth + 1));
        }
        return;
    }
    for (const [key, entry] of Object.entries(record)) {
        const entryPath = pointer(path, key);
        if (SECRET_KEY.test(key) && typeof entry === 'string' && entry.length >= 8 && !entry.includes('${')) {
            state.diagnostics.push({
                code: 'secret_literal',
                severity: 'warning',
                path: entryPath,
                message: `字段 "${key}" 疑似明文密钥`,
                hint: '改用 ${env.XXX} 或 secret 引用，避免把凭据写进 workflow 文件。',
            });
        }
        checkSecretLiterals(entry, entryPath, state, depth + 1);
    }
}

function resolveKind(definition: Record<string, any>): string | undefined {
    if (typeof definition.call === 'string') return definition.call;
    const run = asRecord(definition.run);
    if (!run) return undefined;
    if (run.shell !== undefined) return 'shell';
    if (run.http !== undefined) return 'http';
    if (run.workflow !== undefined) return 'workflow';
    return undefined;
}

function checkStepDefinition(entry: StepEntry, state: LintState): void {
    const definition = entry.definition;
    const push = (
        code: string,
        severity: WorkflowLintSeverity,
        path: string,
        message: string,
        hint?: string,
    ) => state.diagnostics.push({ code, severity, path, message, hint });

    const call = definition.call;
    if (typeof call === 'string' && !CALLABLE_KINDS.has(call)) {
        push('call_unknown', 'error', `${entry.path}/call`,
            `不支持的 call: ${call}`,
            `只支持 ${Array.from(CALLABLE_KINDS).join(' / ')}。`);
    }
    if (definition.run !== undefined) {
        const run = asRecord(definition.run) || {};
        if (!Object.keys(run).some((key) => RUN_KINDS.has(key))) {
            push('run_unknown', 'error', `${entry.path}/run`,
                'run 只支持 shell / http / workflow',
                'run.script / run.container 尚未启用。');
        }
    }
    if (EVENT_KEYS.some((key) => definition[key] !== undefined)) {
        push('step_event_unsupported', 'error', entry.path,
            'emit/listen 事件步骤尚未实现',
            '改用 http / tool / shell 步骤。');
    } else if (!OPERATION_KEYS.some((key) => definition[key] !== undefined)) {
        push('step_no_operation', 'error', entry.path,
            '步骤缺少可执行操作',
            '至少声明 call / run / set / switch / for / try / fork / wait / raise 之一。');
    }

    const kind = resolveKind(definition);
    const withConfig = asRecord(definition.with) || {};
    const runConfig = asRecord(definition.run) || {};
    if (kind === 'agent' && !nonEmptyString(withConfig.prompt ?? withConfig.instruction)) {
        push('with_missing_prompt', 'error', `${entry.path}/with/prompt`,
            'agent 步骤缺少 with.prompt', '补上 prompt 或 instruction。');
    }
    if (kind === 'tool') {
        const rawToolName = withConfig.tool ?? withConfig.name;
        if (!nonEmptyString(rawToolName)) {
            push('with_missing_tool', 'error', `${entry.path}/with/tool`,
                'tool 步骤缺少 with.tool', '指定要调用的工具名。');
        } else {
            const toolName = resolveToolName(String(rawToolName));
            if (isLegacyToolName(String(rawToolName))) {
                push('tool_deprecated', 'warning', `${entry.path}/with/tool`,
                    `${describeLegacyToolName(String(rawToolName))}（历史宾+动命名）`,
                    `把 with.tool 改为 ${toolName}；别名仍可执行，但新名字更符合动宾直觉。`);
            }
            if (FORBIDDEN_WORKFLOW_TOOLS.has(toolName) || FORBIDDEN_TODO_WRITE_TOOLS.has(toolName)) {
                push('tool_forbidden', 'error', `${entry.path}/with/tool`,
                    `workflow 内禁止调用工具 ${toolName}`, '改用 kg_* 或文件读写类业务工具。');
            } else if (state.knownTools && !state.knownTools.has(toolName)) {
                push('tool_unknown', 'warning', `${entry.path}/with/tool`,
                    `未注册的工具名 ${toolName}`, '检查工具名拼写或该工具是否已注册。');
            }
        }
    }
    if (kind === 'shell') {
        const command = asRecord(runConfig.shell)?.command ?? withConfig.command;
        if (!nonEmptyString(command)) {
            push('with_missing_command', 'error', `${entry.path}/run/shell/command`,
                'shell 步骤缺少 command', '补上 command（run.shell.command 或 with.command）。');
        }
    }
    if (kind === 'http') {
        const url = asRecord(runConfig.http)?.url ?? withConfig.url;
        if (!nonEmptyString(url)) {
            push('with_missing_url', 'error', `${entry.path}/run/http/url`,
                'http 步骤缺少 url', '补上 url（run.http.url 或 with.url）。');
        }
    }
    if (kind === 'evaluator' && !nonEmptyString(withConfig.target)) {
        push('with_missing_target', 'error', `${entry.path}/with/target`,
            'evaluator 步骤缺少 with.target', '指定要评估的目标文件或产物。');
    }
    if (kind === 'workflow') {
        const target = withConfig.workflow ?? withConfig.name ?? withConfig.path
            ?? asRecord(runConfig.workflow)?.workflow
            ?? asRecord(runConfig.workflow)?.name;
        if (!nonEmptyString(target)) {
            push('with_missing_workflow', 'error', `${entry.path}/with/workflow`,
                '子工作流步骤缺少目标 workflow', '用 with.workflow（名字或相对路径）指定。');
        } else {
            state.subworkflowRefs.push({ path: `${entry.path}/with/workflow`, target: String(target) });
        }
    }

    if (withConfig.tools !== undefined) {
        if (!Array.isArray(withConfig.tools)
            || withConfig.tools.some((name: unknown) => !nonEmptyString(name))) {
            push('tools_invalid', 'error', `${entry.path}/with/tools`,
                'with.tools 必须是非空字符串数组', '例如 tools: [read_file, list_files]。');
        } else {
            const rawNames = (withConfig.tools as string[]).map((name) => String(name).trim());
            const legacy = rawNames.filter((name) => isLegacyToolName(name));
            if (legacy.length) {
                push('tool_deprecated', 'warning', `${entry.path}/with/tools`,
                    `历史工具名：${legacy.map((name) => describeLegacyToolName(name)).join('；')}`,
                    '改成动宾结构的规范名；别名仍可执行。');
            }
            const names = rawNames.map((name) => resolveToolName(name));
            const dropped = names.filter((name) => (
                FORBIDDEN_WORKFLOW_TOOLS.has(name) || FORBIDDEN_TODO_WRITE_TOOLS.has(name)
            ));
            if (dropped.length) {
                push('tool_forbidden', 'warning', `${entry.path}/with/tools`,
                    `以下工具会被运行时静默移除：${dropped.join(', ')}`,
                    'workflow 步骤不允许自我管理或多写 TODO，请从 with.tools 删除。');
            }
            if (kind === 'evaluator') {
                const readonlyViolations = names.filter((name) => EVALUATOR_FORBIDDEN_WRITE_TOOLS.includes(name));
                if (readonlyViolations.length) {
                    push('tool_readonly', 'warning', `${entry.path}/with/tools`,
                        `evaluator 步骤只读，以下工具会被移除：${readonlyViolations.join(', ')}`,
                        '评估步骤只应声明读取类工具。');
                }
            }
            if (state.knownTools) {
                const unknown = names.filter((name) => !state.knownTools!.has(name));
                if (unknown.length) {
                    push('tool_unknown', 'warning', `${entry.path}/with/tools`,
                        `未注册的工具：${unknown.join(', ')}`,
                        '检查拼写；未注册的工具不会授予步骤。');
                }
            }
        }
    }

    if (definition.then !== undefined && definition.then !== 'exit') {
        push('then_unknown', 'warning', `${entry.path}/then`,
            `then 只支持 "exit"，收到 ${JSON.stringify(definition.then)}`,
            '需要继续执行时省略 then；结束整个工作流用 then: exit。');
    }

    const timeout = asRecord(definition.timeout);
    if (timeout?.after !== undefined && parseDurationMs(timeout.after) === undefined) {
        push('timeout_invalid', 'warning', `${entry.path}/timeout/after`,
            `无法解析 timeout.after: ${JSON.stringify(timeout.after)}`,
            '支持毫秒数、30s/5m/1h 或 PT30S。');
    }

    if (definition.wait !== undefined) {
        const waitRaw = asRecord(definition.wait)?.duration ?? definition.wait;
        if (typeof waitRaw === 'string' && !waitRaw.includes('${') && parseDurationMs(waitRaw) === undefined) {
            push('wait_invalid', 'error', `${entry.path}/wait`,
                `无法解析 wait 时长: ${JSON.stringify(waitRaw)}`,
                '支持毫秒数、30s/5m/1h 或 PT30S。');
        }
    }

    const retry = asRecord(asRecord(definition.catch)?.retry);
    if (retry) {
        const limit = retry.limit?.attempt?.count ?? retry.limit?.attempt ?? retry.limit?.count ?? retry.limit;
        if (limit !== undefined && limit !== null) {
            const numeric = Number(limit);
            if (!Number.isInteger(numeric) || numeric < 0) {
                push('retry_invalid', 'error', `${entry.path}/catch/retry/limit`,
                    'retry.limit 必须是非负整数',
                    '例如 retry: { limit: { attempt: 3 }, delay: 2s }。');
            }
        }
        const delay = retry.delay;
        if (typeof delay === 'string' && !delay.includes('${') && parseDurationMs(delay) === undefined) {
            push('retry_delay_invalid', 'warning', `${entry.path}/catch/retry/delay`,
                `无法解析 retry.delay: ${JSON.stringify(delay)}`,
                '支持毫秒数、30s/5m/1h 或 PT30S。');
        }
    }

    if (asRecord(definition.for) && asRecord(definition.for)?.in === undefined) {
        push('for_in_missing', 'error', `${entry.path}/for/in`,
            'for 步骤缺少 for.in 集合', '例如 for: { in: "\\${steps.pick.output.items}", each: item }。');
    }

    if (asRecord(definition.output)?.schema !== undefined) {
        checkOutputSchema(
            asRecord(definition.output)?.schema,
            `${entry.path}/output/schema`,
            state,
        );
    }
    checkSecretLiterals(definition.with, `${entry.path}/with`, state);
}

function checkSequences(entries: StepEntry[], state: LintState): void {
    const sequences = new Map<string, StepEntry[]>();
    for (const entry of entries) {
        const list = sequences.get(entry.sequencePath) || [];
        list.push(entry);
        sequences.set(entry.sequencePath, list);
    }
    for (const list of sequences.values()) {
        const lastExit = list.find((entry) => entry.definition.then === 'exit');
        if (!lastExit) continue;
        for (const entry of list) {
            if (entry.sequenceIndex <= lastExit.sequenceIndex) continue;
            // 已在 collectSteps 里按顺序提示过；这里补一个 exit 位置提示
            state.diagnostics.push({
                code: 'sequence_after_exit',
                severity: 'info',
                path: lastExit.path,
                message: `then:"exit" 之后的 ${list.filter((item) => item.sequenceIndex > lastExit.sequenceIndex).length} 个步骤不会执行`,
                hint: '确认这是预期行为。',
            });
            break;
        }
    }
}

/** 主入口：对已解析的 workflow 文档做编译检查。 */
export async function lintWorkflowDocument(
    document: Record<string, unknown>,
    options: WorkflowLintOptions = {},
): Promise<WorkflowLintResult> {
    const state: LintState = {
        diagnostics: [],
        entries: [],
        templates: new Map(),
        expressions: [],
        declaredInputs: collectDeclaredInputs(document),
        inputRefs: [],
        subworkflowRefs: [],
        options,
        knownTools: options.knownTools
            ? (options.knownTools instanceof Set ? options.knownTools : new Set(options.knownTools))
            : undefined,
    };

    const steps = Array.isArray(document?.do) ? document.do as unknown[] : [];
    collectSteps(steps, '/do', 0, state);

    // 重名：steps.<name> 是全局命名空间
    const byName = new Map<string, StepEntry[]>();
    for (const entry of state.entries) {
        const list = byName.get(entry.name) || [];
        list.push(entry);
        byName.set(entry.name, list);
    }
    for (const [name, list] of byName) {
        if (list.length < 2) continue;
        list.slice(1).forEach((entry) => {
            state.diagnostics.push({
                code: 'duplicate_step_name',
                severity: 'error',
                path: entry.path,
                message: `步骤名 "${name}" 重复（首次出现于 ${list[0].path}）`,
                hint: 'steps.<name> 是全局命名空间，重名会让引用指向错误步骤。',
            });
        });
    }

    for (const entry of state.entries) {
        checkStepDefinition(entry, state);
        collectTemplates(entry, state);
    }
    for (const entry of state.entries) {
        for (const template of state.templates.get(entry) || []) {
            for (const match of template.value.matchAll(TEMPLATE)) {
                scanExpression(entry, template.path, match[1], state);
            }
        }
    }
    for (const expression of state.expressions) {
        if (expression.condition && expression.source.includes('${')) {
            const opens = (expression.source.match(/\$\{/g) || []).length;
            const closes = (expression.source.match(/\}/g) || []).length;
            if (opens > closes) {
                state.diagnostics.push({
                    code: 'expr_syntax',
                    severity: 'error',
                    path: expression.path,
                    message: '条件表达式缺少结束 }',
                    hint: 'when 里的 ${...} 必须闭合，例如 ${ .inputs.flag == true }。',
                });
                continue;
            }
            for (const match of expression.source.matchAll(TEMPLATE)) {
                scanExpression(expression.entry, expression.path, match[1], state);
            }
            continue;
        }
        scanExpression(expression.entry, expression.path, expression.source, state);
    }
    checkSequences(state.entries, state);

    // deep：子工作流存在性
    if (options.deep && state.subworkflowRefs.length) {
        const checked = new Map<string, boolean>();
        for (const ref of state.subworkflowRefs) {
            let exists = checked.get(ref.target);
            if (exists === undefined) {
                if (options.subworkflowExists) {
                    exists = await options.subworkflowExists(ref.target);
                } else if (options.knownWorkflows) {
                    const known = new Set(Array.from(options.knownWorkflows)
                        .map((item) => String(item).replace(/\.ya?ml$/i, '')));
                    exists = known.has(ref.target.replace(/\.ya?ml$/i, ''));
                } else {
                    exists = true;
                }
                checked.set(ref.target, exists);
            }
            if (!exists) {
                state.diagnostics.push({
                    code: 'subworkflow_unknown',
                    severity: 'error',
                    path: ref.path,
                    message: `找不到子工作流 ${ref.target}`,
                    hint: '确认 .workflow 下的文件名或 document.name。',
                });
            }
        }
    }

    // 未使用的输入（info）
    const usedInputs = new Set(state.inputRefs.map((ref) => ref.name));
    for (const name of state.declaredInputs) {
        if (usedInputs.has(name)) continue;
        state.diagnostics.push({
            code: 'input_unused',
            severity: 'info',
            path: '/document/input',
            message: `声明的输入 ${name} 未被任何步骤引用`,
            hint: '确认是否漏用；无用输入可以删除。',
        });
    }

    // deep：资产文件存在性
    if (options.deep && options.fileExists) {        const checked = new Set<string>();
        for (const entry of state.entries) {
            const definition = entry.definition;
            const shellCommand = asRecord(asRecord(definition.run)?.shell)?.command
                ?? asRecord(definition.with)?.command;
            if (typeof shellCommand !== 'string') continue;
            for (const match of shellCommand.matchAll(WORKFLOW_ASSET)) {
                const relative = match[1].replace(/\\/g, '/').replace(/[),.;]+$/, '');
                if (checked.has(relative)) continue;
                checked.add(relative);
                const exists = await options.fileExists(relative);
                if (!exists) {
                    state.diagnostics.push({
                        code: 'asset_missing',
                        severity: 'error',
                        path: `${entry.path}/run/shell/command`,
                        message: `引用的资产不存在：${relative}`,
                        hint: '把脚本/资产放到 .workflow/tools 或 .workflow/assets 下，并提交到仓库。',
                    });
                }
            }
        }
    }

    const only = options.codes
        ? new Set(Array.from(options.codes))
        : undefined;
    const filtered = state.diagnostics.filter((item) => !only || only.has(item.code));
    const severityRank: Record<WorkflowLintSeverity, number> = { error: 0, warning: 1, info: 2 };
    filtered.sort((a, b) => (severityRank[a.severity] - severityRank[b.severity]) || a.path.localeCompare(b.path));

    const maxIssues = Math.min(500, Math.max(1, Number(options.maxIssues) || 100));
    const errorCount = filtered.filter((item) => item.severity === 'error').length;
    const warningCount = filtered.filter((item) => item.severity === 'warning').length;
    const infoCount = filtered.filter((item) => item.severity === 'info').length;
    return {
        ok: errorCount === 0,
        diagnostics: filtered.filter((item) => item.severity !== 'info').slice(0, maxIssues),
        infos: filtered.filter((item) => item.severity === 'info').slice(0, maxIssues),
        errorCount,
        warningCount,
        infoCount,
        stepCount: state.entries.length,
    };
}

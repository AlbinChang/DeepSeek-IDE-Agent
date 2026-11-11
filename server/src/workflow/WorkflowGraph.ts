export interface WorkflowGraph {
    mermaid: string;
    truncated: boolean;
}

const MAX_GRAPH_NODES = 200;

function record(value: unknown): Record<string, unknown> | undefined {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : undefined;
}

function label(value: unknown): string {
    return String(value ?? '')
        .replace(/[^\p{L}\p{N}_. :/-]/gu, '_')
        .slice(0, 80);
}

function sequence(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    const object = record(value);
    return Array.isArray(object?.do) ? object.do : [];
}

function stepKind(definition: Record<string, unknown>): string {
    if (typeof definition.call === 'string') return `call: ${label(definition.call)}`;
    const run = record(definition.run);
    if (run) return `run: ${label(Object.keys(run)[0] ?? 'unknown')}`;
    for (const kind of ['set', 'switch', 'for', 'try', 'fork', 'wait', 'raise', 'emit', 'listen']) {
        if (definition[kind] !== undefined) return kind;
    }
    return 'unknown';
}

/** 静态结构预览；只输出受限标签，不把用户 YAML 当作 Mermaid 指令。 */
export function buildWorkflowGraph(steps: unknown[]): WorkflowGraph {
    const lines = ['flowchart TD'];
    let nodeCount = 0;
    let truncated = false;

    const node = (text: string, shape: 'normal' | 'decision' | 'join' = 'normal'): string | undefined => {
        if (nodeCount >= MAX_GRAPH_NODES) {
            truncated = true;
            return undefined;
        }
        const id = `n${nodeCount++}`;
        const safe = label(text);
        lines.push(shape === 'decision' ? `  ${id}{"${safe}"}` : shape === 'join' ? `  ${id}(("${safe}"))` : `  ${id}["${safe}"]`);
        return id;
    };
    const connect = (from: string[], to: string, edge?: string) => {
        for (const source of from) lines.push(edge ? `  ${source} -->|"${label(edge)}"| ${to}` : `  ${source} --> ${to}`);
    };

    const walk = (entries: unknown[], incoming: string[], firstEdge?: string): string[] => {
        let previous = incoming;
        let edge = firstEdge;
        for (const entry of entries) {
            if (truncated) break;
            const step = record(entry);
            const name = step && Object.keys(step)[0];
            const definition = name ? record(step[name]) : undefined;
            if (!name || !definition) continue;
            const kind = stepKind(definition);
            const current = node(`${name} : ${kind}`, ['switch', 'for', 'fork'].includes(kind) ? 'decision' : 'normal');
            if (!current) break;
            connect(previous, current, edge);
            edge = undefined;
            previous = [current];

            if (definition.fork !== undefined) {
                const fork = record(definition.fork);
                const branches = Array.isArray(definition.fork)
                    ? definition.fork
                    : Array.isArray(fork?.branches) ? fork.branches : [];
                const ends = branches.flatMap((branch, index) => {
                    const branchSteps = sequence(branch);
                    return walk(branchSteps.length ? branchSteps : [branch], [current], `branch ${index + 1}`);
                });
                if (ends.length) {
                    const join = node('join', 'join');
                    if (join) {
                        connect(ends, join);
                        previous = [join];
                    }
                }
            } else if (definition.switch !== undefined) {
                const config = record(definition.switch);
                const cases = Array.isArray(definition.switch)
                    ? definition.switch
                    : Array.isArray(config?.cases) ? config.cases : [];
                const ends = cases.flatMap((item) => {
                    const branch = record(item);
                    if (!branch) return [];
                    const isDefault = branch.default !== undefined;
                    const branchSteps = sequence(isDefault ? branch.default : branch);
                    return branchSteps.length ? walk(branchSteps, [current], isDefault ? 'default' : `when ${label(branch.when)}`) : [];
                });
                if (ends.length) {
                    const join = node('join', 'join');
                    if (join) {
                        connect(ends, join);
                        previous = [join];
                    }
                }
            } else if (definition.for !== undefined) {
                const ends = walk(sequence(definition.do), [current], 'each');
                connect(ends.filter((end) => end !== current), current, 'next');
            } else if (definition.try !== undefined) {
                const attempt = walk(sequence(definition.try), [current], 'try');
                const recovery = walk(sequence(record(definition.catch)?.do), [current], 'catch');
                const ends = [...attempt, ...recovery].filter((end) => end !== current);
                if (ends.length) {
                    const join = node('join', 'join');
                    if (join) {
                        connect(ends, join);
                        previous = [join];
                    }
                }
            }
            if (definition.then === 'exit') break;
        }
        return previous;
    };

    walk(steps, []);
    return { mermaid: lines.join('\n'), truncated };
}

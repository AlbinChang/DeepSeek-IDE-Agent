/**
 * 词表（RDFS/OWL 子集）与语义唯一性工具函数。
 *
 * 对齐关系：
 * - `kind: 'class'`   ≈ rdfs:Class + rdfs:subClassOf（节点类型分层）
 * - `kind: 'property'`≈ rdf:Property + rdfs:subPropertyOf + rdfs:domain/range
 * - `symmetric` ≈ owl:SymmetricProperty，`transitive` ≈ owl:TransitiveProperty
 * - 属性 `unique` ≈ owl:InverseFunctionalProperty（值全局唯一）
 * - 属性 `identity` 组合 ≈ 自然键（实体同一性判定）
 */
import { DUCKDB_ERROR_CODES, DuckDbToolError } from './duckdbProtocol.js';

export const VOCAB_KINDS = ['class', 'property'] as const;
export type VocabKind = typeof VOCAB_KINDS[number];

/** 类型名/属性名：字母开头，允许字母数字与 _ . : - */
const VOCAB_NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;

export interface VocabDefinition {
    kind: VocabKind;
    name: string;
    parent?: string | null;
    domain?: string[] | null;
    range?: string[] | null;
    symmetric?: boolean;
    transitive?: boolean;
    description?: string | null;
}

export interface EffectivePropertyRule {
    name: string;
    /** 允许的起点类型闭包（含子类）；null 表示未声明约束。 */
    domain: Set<string> | null;
    /** 允许的终点类型闭包（含子类）；null 表示未声明约束。 */
    range: Set<string> | null;
    symmetric: boolean;
    transitive: boolean;
}

export function assertVocabKind(value: unknown): VocabKind {
    const kind = String(value ?? '').trim().toLowerCase();
    if (!(VOCAB_KINDS as readonly string[]).includes(kind)) {
        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.invalidRequest,
            `kind 只支持 ${VOCAB_KINDS.join(' / ')}（class=节点类型，property=关系类型）。`,
        );
    }
    return kind as VocabKind;
}

export function assertVocabName(value: unknown, label = 'name'): string {
    const name = typeof value === 'string' ? value.trim() : '';
    if (!VOCAB_NAME.test(name)) {
        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.invalidRequest,
            `${label} 不合法：${JSON.stringify(value)}。要求字母开头，仅含字母/数字/_ . : -，≤128 字符。`,
        );
    }
    return name;
}

/** 类型列表（domain/range）：去重保序，最多 50 项。 */
export function normalizeTypeList(value: unknown, label: string): string[] | null {
    if (value === undefined || value === null) return null;
    const list = Array.isArray(value) ? value : [value];
    if (!list.length) return null;
    if (list.length > 50) {
        throw new DuckDbToolError(
            DUCKDB_ERROR_CODES.limitExceeded,
            `${label} 最多 50 个类型，当前 ${list.length} 个。`,
        );
    }
    const seen = new Set<string>();
    for (const item of list) seen.add(assertVocabName(item, label));
    return Array.from(seen);
}

/**
 * 计算类型闭包：`descendants.get(type)` = 自身 + 所有（多级）子类。
 * 同时返回未知父类与成环节点，供 lint 诊断与建规则时告警。
 */
export function buildTypeClosure(
    defs: VocabDefinition[],
    kind: VocabKind,
): { descendants: Map<string, Set<string>>; unknownParents: string[]; cycles: string[] } {
    const scoped = defs.filter((def) => def.kind === kind);
    const names = new Set(scoped.map((def) => def.name));
    const parentOf = new Map<string, string>();
    const unknownParents: string[] = [];
    for (const def of scoped) {
        const parent = def.parent ? String(def.parent) : '';
        if (!parent) continue;
        parentOf.set(def.name, parent);
        if (!names.has(parent)) unknownParents.push(`${def.name} → ${parent}`);
    }

    const children = new Map<string, string[]>();
    for (const [child, parent] of parentOf) {
        const list = children.get(parent) || [];
        list.push(child);
        children.set(parent, list);
    }

    const descendants = new Map<string, Set<string>>();
    for (const name of names) {
        const seen = new Set<string>([name]);
        const queue = [name];
        while (queue.length) {
            const current = queue.shift() as string;
            for (const child of children.get(current) || []) {
                if (seen.has(child)) continue;
                seen.add(child);
                queue.push(child);
            }
        }
        descendants.set(name, seen);
    }

    const cycles = new Set<string>();
    for (const name of names) {
        const visited = new Set<string>([name]);
        let current = parentOf.get(name);
        while (current) {
            if (visited.has(current)) {
                cycles.add(`${name} → ${current}`);
                break;
            }
            visited.add(current);
            current = parentOf.get(current);
        }
    }

    return { descendants, unknownParents, cycles: Array.from(cycles) };
}

/**
 * 计算关系类型的生效 domain/range：
 * 子属性继承父属性的约束（rdfs:subPropertyOf），并把约束类型展开为子类闭包。
 */
export function buildEffectivePropertyRules(
    defs: VocabDefinition[],
    classClosure: Map<string, Set<string>>,
): Map<string, EffectivePropertyRule> {
    const properties = new Map(
        defs.filter((def) => def.kind === 'property').map((def) => [def.name, def]),
    );
    const expand = (types: string[] | null | undefined): Set<string> | null => {
        if (!types || !types.length) return null;
        const set = new Set<string>();
        for (const type of types) {
            for (const member of classClosure.get(type) || [type]) set.add(member);
            set.add(type);
        }
        return set;
    };

    const rules = new Map<string, EffectivePropertyRule>();
    for (const [name, def] of properties) {
        let domain = expand(def.domain);
        let range = expand(def.range);
        let symmetric = Boolean(def.symmetric);
        let transitive = Boolean(def.transitive);
        const seen = new Set<string>([name]);
        let parent = def.parent ? String(def.parent) : '';
        while (parent && properties.has(parent) && !seen.has(parent)) {
            seen.add(parent);
            const inherited = properties.get(parent) as VocabDefinition;
            const parentDomain = expand(inherited.domain);
            const parentRange = expand(inherited.range);
            if (parentDomain) domain = domain ? new Set([...domain, ...parentDomain]) : parentDomain;
            if (parentRange) range = range ? new Set([...range, ...parentRange]) : parentRange;
            symmetric = symmetric || Boolean(inherited.symmetric);
            transitive = transitive || Boolean(inherited.transitive);
            parent = inherited.parent ? String(inherited.parent) : '';
        }
        rules.set(name, { name, domain, range, symmetric, transitive });
    }
    return rules;
}

/**
 * 工具命名规范：`动 + 宾`（verb-object），如 `write_file` / `replace_in_file` / `list_attrs`。
 *
 * 大模型在训练语料里见到的工具名绝大多数是动宾结构，宾动结构（如 `file_write`）会削弱
 * 语义直觉、增加误用概率。历史名字保留为**别名**：老工作流/老提示词仍能执行，但
 * `validate_workflow` 会给出 `tool_deprecated` 提示，引导迁移到新名字。
 */
export const LEGACY_TOOL_ALIASES: Readonly<Record<string, string>> = Object.freeze({
    file_write: 'write_file',
    file_replace: 'replace_in_file',
    file_replace_all: 'replace_all_in_file',
    file_insert: 'insert_in_file',
    kg_attr_define: 'kg_define_attr',
    kg_attr_list: 'kg_list_attrs',
    kg_attr_delete: 'kg_delete_attr',
});

/** 把历史（宾+动）工具名解析成当前（动+宾）规范名；非别名原样返回。 */
export function resolveToolName(name: string): string {
    const normalized = String(name ?? '').trim();
    return LEGACY_TOOL_ALIASES[normalized] ?? normalized;
}

/** 是否仍是需要迁移的历史工具名。 */
export function isLegacyToolName(name: string): boolean {
    return Object.prototype.hasOwnProperty.call(LEGACY_TOOL_ALIASES, String(name ?? '').trim());
}

/** 历史工具名 → 规范名（常用于校验诊断文案）。 */
export function describeLegacyToolName(name: string): string {
    const normalized = String(name ?? '').trim();
    const replacement = LEGACY_TOOL_ALIASES[normalized];
    return replacement ? `${normalized} 已更名为 ${replacement}` : normalized;
}

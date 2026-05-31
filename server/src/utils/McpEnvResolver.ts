/**
 * MCP 环境变量占位符解析器
 * 将 ${ENV_VAR} 和 ${env:ENV_VAR} 格式的占位符替换为实际环境变量值
 */

/**
 * 解析环境变量占位符
 * 支持格式：
 *   - ${VAR_NAME}       直接引用进程环境变量
 *   - ${env:VAR_NAME}   显式 env: 前缀（兼容 Claude Code 格式）
 *
 * @param value  包含占位符的原始字符串
 * @param env    进程环境变量字典（默认 process.env）
 * @returns      替换后的字符串；若引用的变量不存在，保留原占位符并输出警告
 */
export function resolveEnvPlaceholder(
    value: string,
    env: Record<string, string | undefined> = process.env as Record<string, string | undefined>,
): string {
    return value.replace(/\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, varName: string) => {
        const resolved = env[varName];
        if (resolved !== undefined) {
            return resolved;
        }
        console.warn(`[McpEnvResolver] Environment variable "${varName}" is not set, keeping placeholder.`);
        return _match; // 保留原始占位符
    });
}

/**
 * 递归解析对象中所有字符串值的环境变量占位符
 */
export function resolveEnvPlaceholders(
    obj: Record<string, string>,
    env?: Record<string, string | undefined>,
): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
        result[key] = resolveEnvPlaceholder(value, env);
    }
    return result;
}

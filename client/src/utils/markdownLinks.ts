/**
 * Markdown 链接解析工具
 *
 * 统一用于两处 Markdown 文件链接的解析，保证行为一致：
 * 1. Markdown 预览（MarkdownPreview.tsx）：点击链接在编辑器打开对应文件。
 * 2. Monaco 编辑器内联链接（FileEditor.tsx）：Ctrl+悬停显示手型光标，Ctrl+点击打开文件。
 *
 * 解析规则：
 * - 以 / 开头：视为工作区根相对路径，去掉前导斜杠。
 * - 以 ./ 或 ../ 开头：基于当前 MD 文件所在目录解析（标准 Markdown 相对语义）。
 * - 裸相对路径（如 docs/user/guide/python-sdk.md）：按工作区根相对路径处理，
 *   符合文档内引用仓库文件（教程/规范）的惯例。
 * - 同时规范化 ../ 与 . 片段。
 */

/**
 * 将 Markdown 链接解析为「相对于 workspaceRoot 的相对路径」。
 * @param rawSrc Markdown 链接中的原始 URL
 * @param filePath 当前 MD 文件的工作区相对路径（用于解析 ./ 与 ../）
 */
export function resolveWorkspaceRelativePath(rawSrc: string, filePath?: string): string {
  const raw = String(rawSrc || '').trim();
  if (!raw) return '';
  // / 开头 → 工作区根相对
  if (raw.startsWith('/')) return raw.replace(/^\/+/, '');

  // ./ 或 ../ 开头 → 相对当前 MD 文件所在目录；其余视为工作区根相对（base 为空）
  let base = '';
  if (raw.startsWith('./') || raw.startsWith('../')) {
    base = filePath ? filePath.replace(/[/\\][^/\\]*$/, '') : '';
  }

  const joined = (base ? `${base}/${raw}` : raw).replace(/\/+/g, '/');
  const parts = joined.split('/');
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      resolved.pop();
    } else if (part !== '.' && part !== '') {
      resolved.push(part);
    }
  }
  return resolved.join('/');
}

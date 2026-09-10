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
 * - 裸相对路径（如 images/01.png）：
 *   - 优先按标准 Markdown 语义相对当前 MD 文件所在目录解析；
 *   - 若该候选不存在，回退为工作区根相对路径（兼容「文档引用仓库文件」的惯例）。
 * - 同时规范化 ../ 与 . 片段。
 */

/**
 * 提取文件路径所在的目录；位于工作区根目录的文件（无路径分隔符）返回空串。
 */
function dirnameOf(filePath: string): string {
  return filePath.includes('/') || filePath.includes('\\')
    ? filePath.replace(/[/\\][^/\\]*$/, '')
    : '';
}

/**
 * 规范化拼接后的路径（统一斜杠、折叠 ../ 与 . 片段）。
 */
function normalizeRelPath(joined: string): string {
  const parts = joined.replace(/\\/g, '/').split('/');
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

/**
 * 将 Markdown 链接解析为「相对于 workspaceRoot 的相对路径」。
 * @param rawSrc Markdown 链接中的原始 URL
 * @param filePath 当前 MD 文件的工作区相对路径（用于解析 ./ 与 ../）
 *
 * 旧语义（兼容文档间跨目录引用惯例）：
 * - / 开头 → 工作区根相对（去前导斜杠）
 * - ./ 或 ../ 开头 → 相对当前 MD 文件所在目录
 * - 裸相对路径 → 按工作区根相对处理
 *
 * 注意：新代码优先使用 resolveMarkdownLinkCandidates，
 * 它会在点击/加载时按「标准 Markdown 语义优先、工作区根兜底」做存在性校验。
 */
export function resolveWorkspaceRelativePath(rawSrc: string, filePath?: string): string {
  const raw = String(rawSrc || '').trim();
  if (!raw) return '';
  // / 开头 → 工作区根相对
  if (raw.startsWith('/')) return raw.replace(/^\/+/, '');

  // ./ 或 ../ 开头 → 相对当前 MD 文件所在目录；其余视为工作区根相对（base 为空）
  let base = '';
  if (raw.startsWith('./') || raw.startsWith('../')) {
    base = filePath ? dirnameOf(filePath) : '';
  }

  const joined = (base ? `${base}/${raw}` : raw).replace(/\/+/g, '/');
  return normalizeRelPath(joined);
}

/**
 * 解析 Markdown 链接的「候选路径」列表（均为相对于 workspaceRoot 的相对路径）。
 * 按优先级排列，调用方可借助文件存在性检查选取第一个真实存在的候选：
 * 1. / 开头 → 工作区根相对（唯一候选）
 * 2. ./ 或 ../ 开头 → 标准 Markdown 语义：相对当前 MD 文件所在目录
 * 3. 裸相对路径（如 images/01.png）→ 先按标准 Markdown 语义相对 MD 目录解析，
 *    再回退工作区根相对（兼容「文档引用仓库文件」的惯例）
 */
export function resolveMarkdownLinkCandidates(rawSrc: string, filePath?: string): string[] {
  const raw = String(rawSrc || '').trim();
  if (!raw) return [];

  if (raw.startsWith('/')) {
    const rootRel = raw.replace(/^\/+/, '');
    return rootRel ? [rootRel] : [];
  }

  const mdDir = filePath ? dirnameOf(filePath) : '';

  if (raw.startsWith('./') || raw.startsWith('../')) {
    const joined = (mdDir ? `${mdDir}/${raw}` : raw).replace(/\/+/g, '/');
    const resolved = normalizeRelPath(joined);
    return resolved ? [resolved] : [];
  }

  // 裸相对路径：MD 目录相对优先（标准 Markdown），工作区根相对兜底
  const candidates: string[] = [];
  if (mdDir) {
    const mdRel = normalizeRelPath(`${mdDir}/${raw}`.replace(/\/+/g, '/'));
    if (mdRel) candidates.push(mdRel);
  }
  const rootRel = normalizeRelPath(raw);
  if (rootRel && rootRel !== candidates[0]) candidates.push(rootRel);
  return candidates;
}

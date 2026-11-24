/**
 * 文件路径归一化工具
 *
 * 背景：Agent 工具事件里的 path 是「相对路径」（如 src/index.ts），
 * 而编辑器 activeFile 可能是绝对路径（文件树/搜索，如 D:/ws/src/index.ts），
 * 也可能是相对路径（源码管理面板，simple-git 返回相对路径）。
 * 直接做字符串比较必然失配，导致 Agent 改完文件后编辑器不刷新。
 *
 * 本模块提供统一的路径归一化 + 同文件判定，供前端刷新链路使用。
 */

/** 统一分隔符为 '/'，去除 './' 前缀与首尾斜杠 */
function cleanPath(p: string): string {
  let norm = String(p).replace(/\\/g, '/');
  while (norm.startsWith('./')) norm = norm.slice(2);
  norm = norm.replace(/^\/+/, '').replace(/\/+$/, '');
  return norm;
}

/** 是否为绝对路径（Windows 盘符形式或 POSIX / 开头） */
function isAbsolutePath(p: string): boolean {
  return /^[a-zA-Z]:\//.test(p) || p.startsWith('/');
}

/**
 * 归一化工作区根路径，作为 IndexedDB 的稳定分区键。
 *
 * 同一个工作区在重启后可能以不同字符串出现（`D:\mall` / `D:/mall` /
 * 末尾带斜杠 / 盘符大小写不同）。若直接用原始字符串做索引，历史记录会
 * “查不到 → 前端看起来被清空”。此函数只做与平台无关的等价归一化：
 * - 反斜杠统一为 '/'
 * - 去掉首尾空白与末尾斜杠
 * - Windows 盘符统一小写（路径其余部分保留大小写）
 */
export function normalizeWorkspaceKey(p: string | null | undefined): string {
  if (!p) return '';
  let norm = String(p).trim().replace(/\\/g, '/');
  norm = norm.replace(/\/+$/, '');
  norm = norm.replace(/^([a-zA-Z]):/, (_match, drive: string) => `${drive.toLowerCase()}:`);
  return norm;
}

/**
 * 归一化文件路径为「相对于 workspaceRoot 的相对路径」。
 * - 统一分隔符为 '/'
 * - 去除 './' 前缀
 * - 若为绝对路径且位于 workspaceRoot 内，则转为相对路径
 * - 保留原始大小写（用于展示/读取），比较请用 isSameFilePath
 */
export function normalizeFilePath(p: string, workspaceRoot?: string | null): string {
  if (!p) return '';
  let norm = cleanPath(p);

  const root = workspaceRoot ? cleanPath(String(workspaceRoot)) : '';
  if (root && isAbsolutePath(norm)) {
    const rootLower = root.toLowerCase();
    const normLower = norm.toLowerCase();
    if (normLower === rootLower) {
      norm = '';
    } else if (normLower.startsWith(rootLower + '/')) {
      norm = norm.slice(root.length + 1);
    }
  }

  return cleanPath(norm);
}

/**
 * 判断两个文件路径是否指向同一文件。
 * 基于 workspaceRoot 归一化后比较；Windows 下大小写不敏感。
 */
export function isSameFilePath(a: string, b: string, workspaceRoot?: string | null): boolean {
  if (!a || !b) return false;
  const na = normalizeFilePath(a, workspaceRoot);
  const nb = normalizeFilePath(b, workspaceRoot);
  if (!na || !nb) return false;

  const rootOrA = String(workspaceRoot || a).replace(/\\/g, '/');
  const isWindows =
    /^[a-zA-Z]:/.test(rootOrA) ||
    (typeof navigator !== 'undefined' && /win/i.test(navigator.platform || ''));

  return isWindows ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

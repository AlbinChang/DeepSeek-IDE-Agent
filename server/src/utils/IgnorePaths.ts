/**
 * 目录过滤的单一真值来源。
 *
 * 编辑器文件树（Electron `file:list`）、内容搜索（`file:search`）与 Agent 侧的
 * 目录枚举共用这里的集合，避免同一份“忽略目录”清单在多处漂移。
 */

/** 内容搜索时忽略的目录（依赖、构建产物、缓存、虚拟环境等）。 */
export const SEARCH_SKIP_DIRS: ReadonlySet<string> = new Set([
    // 版本控制
    '.git', '.svn', '.hg', '.bzr', 'CVS',
    // 依赖与包管理器
    'node_modules', 'bower_components', 'jspm_packages', 'vendor', 'Pods', '.pnpm-store',
    // 构建产物与缓存
    'dist', 'build', 'out', 'target', '.next', '.nuxt', '.turbo', '.cache', '.output',
    '.svelte-kit', '.parcel-cache', '.docusaurus', 'storybook-static', 'coverage', '.nyc_output',
    // 虚拟环境
    '.venv', 'venv', 'env', '.env', 'virtualenv', '.conda', 'conda-meta',
    // IDE 与 Agent 内部目录
    '.idea', '.vscode', '.vs', '.ide-agent', '.llm', '.tools', '.memory', '.cursor',
    // 语言与框架缓存
    '__pycache__', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.gradle', '.cargo', 'tmp', 'temp',
]);

/**
 * 文件树中隐藏的目录（点目录）。
 * 非点目录（如 dist、node_modules）仍会作为条目展示，只是不向下递归，
 * 以免大仓库遍历爆炸；递归控制见 {@link FILE_TREE_SKIP_RECURSION}。
 */
export const FILE_TREE_SKIP_DIRS: ReadonlySet<string> = new Set([
    '.git', 'node_modules', '.ide-agent', '.llm', '.tools',
    '.memory', '__pycache__', '.vscode', 'dist', '.next',
]);

/** 文件树可展示但不再向下递归的目录。 */
export const FILE_TREE_SKIP_RECURSION: ReadonlySet<string> = new Set(['node_modules']);

/** 文件树是否隐藏该目录项（与既有语义一致：仅对点目录生效）。 */
export function shouldHideInFileTree(name: string): boolean {
    return name.startsWith('.') && FILE_TREE_SKIP_DIRS.has(name);
}

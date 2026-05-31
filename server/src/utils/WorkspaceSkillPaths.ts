export const WORKSPACE_SKILL_DIRECTORIES = [
    '.claude/skills',
    '.github/skills',
    '.agents/skills',
    '.skills',
] as const;

export type WorkspaceSkillDirectory = typeof WORKSPACE_SKILL_DIRECTORIES[number];

export const WORKSPACE_SKILL_CONTAINER_DIRECTORIES = Array.from(
    new Set(WORKSPACE_SKILL_DIRECTORIES.map((directory) => directory.split('/')[0]))
);

export function normalizeWorkspaceRelativePath(relativePath: string): string {
    const normalized = relativePath
        .replace(/\\/g, '/')
        .replace(/^\.\//, '')
        .replace(/\/+/g, '/')
        .replace(/\/$/, '');

    return normalized || '.';
}

export function isWorkspaceSkillPath(relativePath: string): boolean {
    const normalized = normalizeWorkspaceRelativePath(relativePath);

    return WORKSPACE_SKILL_DIRECTORIES.some((directory) => (
        normalized === directory || normalized.startsWith(`${directory}/`)
    ));
}
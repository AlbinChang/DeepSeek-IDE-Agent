/**
 * Git Operations IPC Handler
 * 
 * 替换 REST Git 路由，直接使用 simple-git 操作 Git 仓库。
 */
import { IpcMain } from 'electron';
import * as path from 'path';
import { PROJECT_ROOT } from '../index.js';

// 懒加载 simple-git
let simpleGit: any = null;
async function getSimpleGit() {
    if (simpleGit) return simpleGit;
    simpleGit = await import('simple-git');
    return simpleGit;
}

function resolveRepoPath(root?: string): string {
    return root || PROJECT_ROOT;
}

export function registerGitIpc(ipcMain: IpcMain) {
    
    // ── Git Status ──
    ipcMain.handle('git:status', async (_event, params: { root?: string } = {}) => {
        try {
            const repoPath = resolveRepoPath(params?.root);
            const { default: simpleGitFn } = await getSimpleGit();
            const git = simpleGitFn(repoPath);
            
            const status = await git.status();
            
            // 显式提取可序列化字段，避免 simple-git 内部对象 (getter/原型属性) 无法被 structured clone
            return {
                success: true,
                not_added: status.not_added ?? [],
                conflicted: status.conflicted ?? [],
                created: status.created ?? [],
                deleted: status.deleted ?? [],
                modified: status.modified ?? [],
                renamed: status.renamed ?? [],
                staged: status.staged ?? [],
                files: (status.files || []).map((f: any) => ({
                    path: f.path,
                    index: f.index,
                    working_dir: f.working_dir,
                })),
                current: status.current ?? '',
                tracking: status.tracking ?? '',
                ahead: status.ahead ?? 0,
                behind: status.behind ?? 0,
            };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── Git Log ──
    ipcMain.handle('git:log', async (_event, params: { root?: string; maxCount?: number } = {}) => {
        try {
            const repoPath = resolveRepoPath(params?.root);
            const { default: simpleGitFn } = await getSimpleGit();
            const git = simpleGitFn(repoPath);
            
            const log = await git.log({ maxCount: params?.maxCount || 50 });
            
            return {
                success: true,
                all: (log.all || []).map((c: any) => ({
                    hash: c.hash,
                    shortHash: c.hash?.slice(0, 7) || '',
                    author: c.author_name || c.author || '',
                    date: c.date || '',
                    message: c.message || '',
                })),
                total: log.total ?? 0,
                latest: log.latest ? {
                    hash: log.latest.hash,
                    message: log.latest.message || '',
                    date: log.latest.date || '',
                } : null,
            };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── Git Diff ──
    ipcMain.handle('git:diff', async (_event, params: { root?: string; file?: string } = {}) => {
        try {
            const repoPath = resolveRepoPath(params?.root);
            const { default: simpleGitFn } = await getSimpleGit();
            const git = simpleGitFn(repoPath);
            
            const diffOptions: string[] = [];
            if (params?.file) diffOptions.push('--', params.file);
            
            const diff = await git.diff(diffOptions);
            
            return {
                success: true,
                diff,
            };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── Git File History ──
    ipcMain.handle('git:fileHistory', async (_event, params: { root?: string; filePath: string }) => {
        try {
            const repoPath = resolveRepoPath(params?.root);
            const { default: simpleGitFn } = await getSimpleGit();
            const git = simpleGitFn(repoPath);
            
            const log = await git.log({ file: params.filePath, maxCount: 30 });
            
            return {
                success: true,
                all: (log.all || []).map((c: any) => ({
                    hash: c.hash,
                    shortHash: c.hash?.slice(0, 7) || '',
                    author: c.author_name || c.author || '',
                    date: c.date || '',
                    message: c.message || '',
                })),
                total: log.total ?? 0,
            };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── Git Init ──
    ipcMain.handle('git:init', async (_event, params: { root?: string } = {}) => {
        try {
            const repoPath = resolveRepoPath(params?.root);
            const { default: simpleGitFn } = await getSimpleGit();
            const git = simpleGitFn(repoPath);
            
            await git.init();
            
            return { success: true, root: repoPath };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    // ── Git Branches ──
    ipcMain.handle('git:branches', async (_event, params: { root?: string } = {}) => {
        try {
            const repoPath = resolveRepoPath(params?.root);
            const { default: simpleGitFn } = await getSimpleGit();
            const git = simpleGitFn(repoPath);
            
            const branches = await git.branch();
            
            return {
                success: true,
                ...branches,
            };
        } catch (err: any) {
            return { success: false, error: err?.message || String(err) };
        }
    });

    console.log('[GitIPC] Git IPC handlers registered');
}

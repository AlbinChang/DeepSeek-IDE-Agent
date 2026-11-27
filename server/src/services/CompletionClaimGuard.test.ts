import { describe, expect, it } from 'vitest';
import {
    buildClaimCorrectionDirective,
    buildClaimDisclosure,
    evaluateCompletionClaims,
    extractClaimedTargets,
    looksLikePathToken,
    toToolEvidence,
    type ToolEvidence,
} from '@/services/CompletionClaimGuard.js';

const writeOk = (path: string, content: string): ToolEvidence => ({
    name: 'write_file',
    ok: true,
    args: { path, content },
});

describe('looksLikePathToken', () => {
    it('accepts workspace file and directory tokens', () => {
        expect(looksLikePathToken('gitcode访问令牌.txt')).toBe(true);
        expect(looksLikePathToken('.gitignore')).toBe(true);
        expect(looksLikePathToken('docs/历史案例/a.md')).toBe(true);
    });

    it('rejects prose, numbers, versions and urls', () => {
        expect(looksLikePathToken('write_file')).toBe(false);
        expect(looksLikePathToken('1.5')).toBe(false);
        expect(looksLikePathToken('v1.0.0')).toBe(false);
        expect(looksLikePathToken('https://example.com/a.md')).toBe(false);
        expect(looksLikePathToken('多个 文件')).toBe(false);
    });
});

describe('evaluateCompletionClaims', () => {
    it('flags a claimed target that the write did not actually contain', () => {
        // 回归：模型一边说「已被加入 .gitignore」，一边只写了别的忽略项
        const reply = [
            '本次任务已经完成：`gitcode访问令牌.txt` 已加入 `.gitignore`。',
            '',
            '## 文件变更清单',
            '- 修改: .gitignore',
        ].join('\n');
        const evidence = [writeOk('.gitignore', '~$*\n*.duckdb\n*.duckdb.wal\ndata/kg_backup/\n')];

        const issues = evaluateCompletionClaims(reply, evidence);

        expect(issues).toHaveLength(1);
        expect(issues[0].kind).toBe('unverified_claimed_target');
        expect(issues[0].message).toContain('gitcode访问令牌.txt');
    });

    it('passes when the written content really contains the claimed entry', () => {
        const reply = '本次任务已经完成：`gitcode访问令牌.txt` 已加入 `.gitignore`。';
        const evidence = [writeOk('.gitignore', 'gitcode访问令牌.txt\n*.duckdb\n')];

        expect(evaluateCompletionClaims(reply, evidence)).toEqual([]);
    });

    it('passes when every claimed file was written this round', () => {
        const reply = [
            '已完成修改：`src/a.ts`、`src/b.ts`。',
            '',
            '## 文件变更清单',
            '- 修改: src/a.ts',
            '- 修改: src/b.ts',
        ].join('\n');
        const evidence = [
            writeOk('src/a.ts', 'export const a = 1;'),
            writeOk('src/b.ts', 'export const b = 2;'),
        ];

        expect(evaluateCompletionClaims(reply, evidence)).toEqual([]);
    });

    it('flags a whole-task completion claim when no mutating tool ran', () => {
        const reply = '本次任务已经完成，所有变更均已提交。';

        const issues = evaluateCompletionClaims(reply, [
            { name: 'read_file', ok: true, args: { path: 'a.md' } },
        ]);

        expect(issues.map((issue) => issue.kind)).toContain('missing_write_evidence');
    });

    it('does not flag an answer that makes no completion claim', () => {
        const reply = '这个报错是因为缺少依赖，安装后即可解决。';

        expect(evaluateCompletionClaims(reply, [])).toEqual([]);
    });

    it('flags a claim whose write failed this round', () => {
        const reply = '已修改 `config.yaml` 并补上端口配置。';
        const evidence: ToolEvidence[] = [
            { name: 'replace_in_file', ok: false, args: { path: 'config.yaml' } },
        ];

        const issues = evaluateCompletionClaims(reply, evidence);

        expect(issues.map((issue) => issue.message).join('\n')).toContain('写入执行失败');
    });

    it('does not accept a read as proof of a modification', () => {
        const reply = '已修改 `config.yaml`，把端口改成 8080。';
        const evidence: ToolEvidence[] = [
            { name: 'read_file', ok: true, args: { path: 'config.yaml' } },
        ];

        const issues = evaluateCompletionClaims(reply, evidence);

        expect(issues.map((issue) => issue.kind)).toContain('unverified_claimed_target');
    });

    it('treats a shell command mentioning the target as evidence', () => {
        const reply = '已把 `gitcode访问令牌.txt` 加入 `.gitignore`。';
        const evidence: ToolEvidence[] = [{
            name: 'run_powershell_command',
            ok: true,
            args: { command: 'Add-Content .gitignore "gitcode访问令牌.txt"' },
        }];

        expect(evaluateCompletionClaims(reply, evidence)).toEqual([]);
    });
});

describe('extractClaimedTargets', () => {
    it('only picks targets from claim lines and the change manifest', () => {
        const reply = [
            '参考 `docs/reference.md` 的写法（只读查看，不算变更）。',
            '已更新 `src/main.ts`。',
            '## 文件变更清单',
            '- 修改: src/util.ts',
        ].join('\n');

        expect(extractClaimedTargets(reply)).toEqual(['src/main.ts', 'src/util.ts']);
    });
});

describe('toToolEvidence', () => {
    it('keeps evidence bounded by truncating oversized argument strings', () => {
        const huge = 'x'.repeat(200 * 1024);
        const evidence = toToolEvidence('write_file', true, { path: 'a.txt', content: huge });

        expect(evidence.args?.path).toBe('a.txt');
        expect(String(evidence.args?.content).length).toBe(64 * 1024);
    });
});

describe('claim guard messages', () => {
    const issues = evaluateCompletionClaims('已修改 `a.ts`。', []);

    it('tells the model to read back and how to phrase unfinished work', () => {
        const directive = buildClaimCorrectionDirective(issues);

        expect(directive).toContain('read_file');
        expect(directive).toContain('未完成');
        expect(directive).toContain('a.ts');
    });

    it('marks unverified claims in the user-visible disclosure', () => {
        expect(buildClaimDisclosure(issues)).toContain('系统核验提示');
    });
});

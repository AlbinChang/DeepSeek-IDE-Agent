import { describe, expect, it } from 'vitest';

import { sortFileEntries } from '@/utils/FileOrdering.js';

describe('file entry ordering', () => {
    it('sorts Chinese chapter numerals by their numeric value', () => {
        const names = [
            'DeepSeek-Harness源码学习教程-第二章.md',
            'DeepSeek-Harness源码学习教程-第十一章.md',
            'DeepSeek-Harness源码学习教程-第一章.md',
            'DeepSeek-Harness源码学习教程-第十章.md',
            'DeepSeek-Harness源码学习教程-第九章.md',
        ];

        const sorted = sortFileEntries(names.map((name) => ({ name, isDirectory: false })));

        expect(sorted.map(({ name }) => name)).toEqual([
            'DeepSeek-Harness源码学习教程-第一章.md',
            'DeepSeek-Harness源码学习教程-第二章.md',
            'DeepSeek-Harness源码学习教程-第九章.md',
            'DeepSeek-Harness源码学习教程-第十章.md',
            'DeepSeek-Harness源码学习教程-第十一章.md',
        ]);
    });

    it('naturally orders ordinary digit sequences and keeps directories first', () => {
        const entries = [
            { name: 'file10.txt', isDirectory: false },
            { name: 'docs10', isDirectory: true },
            { name: 'file2.txt', isDirectory: false },
            { name: 'docs2', isDirectory: true },
            { name: 'file1.txt', isDirectory: false },
        ];

        const sorted = sortFileEntries(entries);

        expect(sorted.map(({ name }) => name)).toEqual([
            'docs2',
            'docs10',
            'file1.txt',
            'file2.txt',
            'file10.txt',
        ]);
        expect(entries.map(({ name }) => name)).toEqual([
            'file10.txt',
            'docs10',
            'file2.txt',
            'docs2',
            'file1.txt',
        ]);
    });

    it('sorts Arabic chapter numbers naturally as well', () => {
        const names = ['教程-第10章.md', '教程-第2章.md', '教程-第1章.md'];

        const sorted = sortFileEntries(names.map((name) => ({ name, isDirectory: false })));

        expect(sorted.map(({ name }) => name)).toEqual([
            '教程-第1章.md',
            '教程-第2章.md',
            '教程-第10章.md',
        ]);
    });
});

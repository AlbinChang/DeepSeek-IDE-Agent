export interface FileEntryForSorting {
    name: string;
    isDirectory: boolean;
}

const FILE_NAME_COLLATOR = new Intl.Collator('zh-CN', {
    numeric: true,
    sensitivity: 'base',
});

const CHAPTER_PATTERN = /第([0-9零〇一二两三四五六七八九十百千万亿]+)章/u;

const CHINESE_DIGITS: Record<string, number> = {
    零: 0,
    〇: 0,
    一: 1,
    二: 2,
    两: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
};

const CHINESE_UNITS: Record<string, number> = {
    十: 10,
    百: 100,
    千: 1_000,
    万: 10_000,
    亿: 100_000_000,
};

interface ChapterFileName {
    series: string;
    number: number;
}

function parseChapterNumber(value: string): number | null {
    if (/^\d+$/u.test(value)) {
        const number = Number(value);
        return Number.isSafeInteger(number) ? number : null;
    }

    const characters = [...value];
    if (characters.every((character) => character in CHINESE_DIGITS)) {
        const number = Number(characters.map((character) => CHINESE_DIGITS[character]).join(''));
        return Number.isSafeInteger(number) ? number : null;
    }

    let total = 0;
    let section = 0;
    let currentDigit = 0;

    for (const character of characters) {
        const digit = CHINESE_DIGITS[character];
        if (digit !== undefined) {
            currentDigit = digit;
            continue;
        }

        const unit = CHINESE_UNITS[character];
        if (unit >= 10_000) {
            section += currentDigit;
            total += (section || 1) * unit;
            section = 0;
            currentDigit = 0;
        } else {
            section += (currentDigit || (unit === 10 ? 1 : 0)) * unit;
            currentDigit = 0;
        }
    }

    const number = total + section + currentDigit;
    return Number.isSafeInteger(number) ? number : null;
}

function getChapterFileName(name: string): ChapterFileName | null {
    const normalizedName = name.normalize('NFKC');
    const match = CHAPTER_PATTERN.exec(normalizedName);
    if (!match || match.index === undefined) return null;

    const number = parseChapterNumber(match[1]);
    if (number === null) return null;

    const prefix = normalizedName.slice(0, match.index).toLowerCase();
    const suffix = normalizedName.slice(match.index + match[0].length).toLowerCase();
    return { series: `${prefix}\u0000${suffix}`, number };
}

export function compareFileNames(leftName: string, rightName: string): number {
    const leftChapter = getChapterFileName(leftName);
    const rightChapter = getChapterFileName(rightName);

    if (
        leftChapter &&
        rightChapter &&
        leftChapter.series === rightChapter.series &&
        leftChapter.number !== rightChapter.number
    ) {
        return leftChapter.number - rightChapter.number;
    }

    const localizedOrder = FILE_NAME_COLLATOR.compare(leftName, rightName);
    if (localizedOrder !== 0) return localizedOrder;
    return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
}

export function compareFileSystemEntries(
    leftName: string,
    leftIsDirectory: boolean,
    rightName: string,
    rightIsDirectory: boolean,
): number {
    if (leftIsDirectory !== rightIsDirectory) return leftIsDirectory ? -1 : 1;
    return compareFileNames(leftName, rightName);
}

export function sortFileEntries<T extends FileEntryForSorting>(entries: readonly T[]): T[] {
    return [...entries].sort((left, right) =>
        compareFileSystemEntries(left.name, left.isDirectory, right.name, right.isDirectory),
    );
}

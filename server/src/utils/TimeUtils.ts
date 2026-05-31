export const BEIJING_TIME_ZONE = 'Asia/Shanghai';

interface BeijingDateParts {
    year: string;
    month: string;
    day: string;
    hour: string;
    minute: string;
    second: string;
}

function getBeijingDateParts(date: Date = new Date()): BeijingDateParts {
    const formatter = new Intl.DateTimeFormat('zh-CN', {
        timeZone: BEIJING_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    });

    const partMap = new Map<string, string>();
    for (const part of formatter.formatToParts(date)) {
        if (part.type !== 'literal') {
            partMap.set(part.type, part.value);
        }
    }

    return {
        year: partMap.get('year') || '0000',
        month: partMap.get('month') || '00',
        day: partMap.get('day') || '00',
        hour: partMap.get('hour') || '00',
        minute: partMap.get('minute') || '00',
        second: partMap.get('second') || '00',
    };
}

function getMilliseconds(date: Date = new Date()): string {
    return String(date.getMilliseconds()).padStart(3, '0');
}

export function formatBeijingDate(date: Date = new Date()): string {
    const parts = getBeijingDateParts(date);
    return `${parts.year}-${parts.month}-${parts.day}`;
}

export function formatBeijingDateTime(date: Date = new Date(), includeMs = false): string {
    const parts = getBeijingDateParts(date);
    const base = `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
    return includeMs ? `${base}.${getMilliseconds(date)}` : base;
}

export function formatBeijingIso(date: Date = new Date(), includeMs = true): string {
    const parts = getBeijingDateParts(date);
    const base = `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
    return includeMs ? `${base}.${getMilliseconds(date)}+08:00` : `${base}+08:00`;
}

export function formatBeijingFileStamp(date: Date = new Date()): string {
    const parts = getBeijingDateParts(date);
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}-${parts.minute}-${parts.second}-${getMilliseconds(date)}`;
}

export function getBeijingLogTimePrefix(date: Date = new Date()): string {
    const parts = getBeijingDateParts(date);
    return `[${parts.hour}:${parts.minute}:${parts.second}.${getMilliseconds(date)}]`;
}

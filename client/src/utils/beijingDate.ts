/**
 * 北京时间自然日 key（`YYYY-MM-DD`）。
 *
 * 单独成模块，方便不依赖 Dexie 的纯逻辑（用量分日统计、状态栏日期切换）复用与测试。
 */

const beijingDateFormatter = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
});

export const getBeijingDateKey = (timestamp: number): string => {
    const parts = beijingDateFormatter.formatToParts(new Date(timestamp));
    const year = parts.find(part => part.type === 'year')?.value || '0000';
    const month = parts.find(part => part.type === 'month')?.value || '00';
    const day = parts.find(part => part.type === 'day')?.value || '00';
    return `${year}-${month}-${day}`;
};

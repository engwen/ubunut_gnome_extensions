// SPDX-License-Identifier: GPL-2.0-or-later
//
// LRC 歌词解析。
// 支持：普通 LRC（[mm:ss.xx]）、一行多个时间标签、元数据标签（ti/ar/al/offset…）、
//       增强 LRC 的逐字时间戳（<mm:ss.xx>），后者可让卡拉 OK 更精准。

const TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const WORD_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;
const META_RE = /^\[(ti|ar|al|au|by|offset|length|re|ve):(.*)\]$/i;

/**
 * @param {string} min 分钟
 * @param {string} sec 秒
 * @param {string} [frac] 小数部分（1~3 位）
 * @returns {number} 毫秒
 */
function toMs(min, sec, frac) {
    const ms = frac ? Number(frac.padEnd(3, '0').slice(0, 3)) : 0;
    return Number(min) * 60000 + Number(sec) * 1000 + ms;
}

/**
 * 剥离增强 LRC 的逐字标签，同时记录每个词的起始字符与长度。
 * @param {string} body
 * @returns {{text: string, words: {time: number, start: number, length: number}[]}}
 */
function splitWords(body) {
    const words = [];
    let text = '';
    let cursor = 0;
    let match;

    WORD_RE.lastIndex = 0;
    while ((match = WORD_RE.exec(body)) !== null) {
        text += body.slice(cursor, match.index);
        words.push({time: toMs(match[1], match[2], match[3]), start: text.length, length: 0});
        cursor = WORD_RE.lastIndex;
    }
    text += body.slice(cursor);

    for (let i = 0; i < words.length; i++) {
        const end = i + 1 < words.length ? words[i + 1].start : text.length;
        words[i].length = Math.max(0, end - words[i].start);
    }

    return {text, words};
}

/**
 * 解析 LRC 文本。
 * @param {string} source
 * @returns {{meta: object, lines: {time: number, text: string, words: object[]}[]}}
 */
export function parseLrc(source) {
    const meta = {};
    const lines = [];
    const rawLines = String(source ?? '').split(/\r?\n/);

    for (const rawLine of rawLines) {
        const line = rawLine.trim();
        if (!line)
            continue;

        const metaMatch = META_RE.exec(line);
        if (metaMatch) {
            const key = metaMatch[1].toLowerCase();
            const value = metaMatch[2].trim();
            if (key === 'offset')
                meta.offset = Number.parseInt(value, 10) || 0;
            else
                meta[key] = value;
            continue;
        }

        // 行首可能连续出现多个时间标签：[00:10.00][01:20.00]歌词
        const stamps = [];
        let cursor = 0;
        let match;
        TIME_RE.lastIndex = 0;
        while ((match = TIME_RE.exec(line)) !== null) {
            if (match.index !== cursor)
                break;
            stamps.push(toMs(match[1], match[2], match[3]));
            cursor = TIME_RE.lastIndex;
        }
        if (stamps.length === 0)
            continue;

        const parsed = splitWords(line.slice(cursor));
        const text = parsed.text.trim();
        // 纯空行放进时间轴只会造成“空屏”，直接丢弃
        if (!text)
            continue;

        const shift = parsed.text.length - parsed.text.trimStart().length;
        const words = parsed.words.length > 1
            ? parsed.words.map(word => ({...word, start: Math.max(0, word.start - shift)}))
            : null;

        for (const time of stamps)
            lines.push({time, text, words});
    }

    lines.sort((a, b) => a.time - b.time);

    // [offset:+500] 表示歌词整体提前 500ms。
    // 同一段文字可能被多个时间标签复用（共享同一个 words 数组），只平移一次。
    const offset = meta.offset ?? 0;
    if (offset) {
        const shifted = new Set();
        for (const line of lines) {
            line.time -= offset;
            if (line.words && !shifted.has(line.words)) {
                shifted.add(line.words);
                for (const word of line.words)
                    word.time -= offset;
            }
        }
    }

    return {meta, lines};
}

/**
 * 二分查找当前时间对应的行号。
 * @param {{time: number}[]} lines
 * @param {number} ms
 * @returns {number} 行号，早于第一行时返回 -1
 */
export function lineIndexAt(lines, ms) {
    let low = 0;
    let high = lines.length - 1;
    let found = -1;

    while (low <= high) {
        const mid = (low + high) >> 1;
        if (lines[mid].time <= ms) {
            found = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }

    return found;
}

/**
 * 计算当前行已“唱到”的浮点进度（单位：字符），用于卡拉 OK 渐变着色。
 * @param {{time: number, text: string, words?: object[]}[]} lines
 * @param {number} index 当前行号
 * @param {number} ms 播放位置
 * @returns {number} 0..行长度 的浮点数；行无效时返回 -1
 */
export function karaokeProgressAt(lines, index, ms) {
    if (index < 0 || index >= lines.length)
        return -1;

    const line = lines[index];
    const length = line.text.length;
    if (!length)
        return -1;

    // 有逐字时间戳时按词推进，精度更高
    if (line.words && line.words.length > 1) {
        let current = 0;
        for (let i = 0; i < line.words.length; i++) {
            if (line.words[i].time <= ms)
                current = i;
            else
                break;
        }

        const word = line.words[current];
        const next = line.words[current + 1];
        const end = next ? next.time : word.time + Math.max(400, word.length * 90);
        const progress = end > word.time
            ? Math.max(0, Math.min(1, (ms - word.time) / (end - word.time)))
            : 1;

        return Math.max(0, Math.min(length, word.start + progress * word.length));
    }

    // 普通 LRC：在当前行与下一行之间线性推进
    const next = lines[index + 1];
    const start = line.time;
    const end = next ? next.time : start + Math.max(1200, length * 120);

    if (ms <= start)
        return 0;

    const progress = end > start ? Math.min(1, (ms - start) / (end - start)) : 1;
    return Math.max(0, Math.min(length, progress * length));
}

/**
 * 计算当前行已“唱到”的字符数（整数版，等价于对 karaokeProgressAt 四舍五入）。
 * @param {{time: number, text: string, words?: object[]}[]} lines
 * @param {number} index 当前行号
 * @param {number} ms 播放位置
 * @returns {number} 0..行长度
 */
export function karaokeIndexAt(lines, index, ms) {
    const progress = karaokeProgressAt(lines, index, ms);
    return progress < 0 ? -1 : Math.round(progress);
}

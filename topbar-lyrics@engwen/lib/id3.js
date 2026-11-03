// SPDX-License-Identifier: GPL-2.0-or-later
//
// 本地音频内嵌歌词读取（ID3v2）。
//
// 支持的歌词帧（按优先级）：
//   SYLT  v2.3/2.4  同步歌词（带时间轴）→ 直接转 LRC
//   SLT   v2.2      同步歌词（v2.2 的 SYLT 对应帧）
//   USLT  v2.3/2.4  非同步歌词（纯文本）→ 若文本本身是 LRC 则按同步处理
//   ULT   v2.2      非同步歌词
//   TXXX / COMM     描述里含 "lyric*" 的自定义帧（部分打标工具把歌词塞这里）
//
// 兼容 ID3v2.2（3 字节帧 ID）、v2.3（帧长 32 位普通整数）、
// v2.4（帧长 syncsafe）。只读取标签字节，不碰音频数据流。
//
// 对外接口：
//   readEmbeddedLyrics(path) → {text, synced, format} | null
//   readSyltLrc(path)        → string(LRC) | null      （旧接口，仅 SYLT）

import Gio from 'gi://Gio';

import {logger} from './logger.js';

const TAG_MAX_BYTES = 16 * 1024 * 1024; // ID3 标签上限，防止异常文件

// --------------------------------------------------------------- 位读取辅助

/** syncsafe 整数（每字节仅 7 位）→ 普通整数 */
function syncsafe(bytes, offset) {
    return ((bytes[offset] & 0x7f) << 21) |
           ((bytes[offset + 1] & 0x7f) << 14) |
           ((bytes[offset + 2] & 0x7f) << 7) |
           (bytes[offset + 3] & 0x7f);
}

function uint32be(bytes, offset) {
    return ((bytes[offset] << 24) | (bytes[offset + 1] << 16) |
            (bytes[offset + 2] << 8) | bytes[offset + 3]) >>> 0;
}

function uint24be(bytes, offset) {
    return (bytes[offset] << 16) | (bytes[offset + 1] << 8) | bytes[offset + 2];
}

/** 反同步：把 0xFF 0x00 还原成 0xFF */
function deunsynchronise(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
        out.push(bytes[i]);
        if (bytes[i] === 0xff && bytes[i + 1] === 0x00)
            i++;
    }
    return new Uint8Array(out);
}

// --------------------------------------------------------------- 文本解码

/**
 * encoding=0（名义 latin1）的兜底解码。
 * 中文打标工具常把 GBK 字节硬标成 latin1，直接按 latin1 解会全是乱码。
 * 先尝试 GB18030（严格模式），只有确实解出中日韩字符才采用，否则退回 latin1。
 * @param {Uint8Array} bytes
 * @returns {string}
 */
function decodeLegacyText(bytes) {
    try {
        const text = new TextDecoder('gb18030', {fatal: true}).decode(bytes);
        if (/[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]/.test(text))
            return text;
    } catch {
        // 不是合法 GB18030
    }

    try {
        return new TextDecoder('latin1').decode(bytes);
    } catch {
        return '';
    }
}

/**
 * @param {Uint8Array} bytes
 * @param {number} encoding 0=latin1 1=utf16(BOM) 2=utf16be 3=utf8
 * @returns {string}
 */
function decodeText(bytes, encoding) {
    try {
        switch (encoding) {
        case 1: {
            // 有 BOM 就按 BOM，没有按小端（Windows 习惯）
            const hasBom = bytes.length >= 2 &&
                ((bytes[0] === 0xff && bytes[1] === 0xfe) ||
                 (bytes[0] === 0xfe && bytes[1] === 0xff));
            const label = bytes[0] === 0xfe && bytes[1] === 0xff
                ? 'utf-16be' : 'utf-16le';
            return new TextDecoder(label).decode(hasBom ? bytes.subarray(2) : bytes);
        }
        case 2:
            return new TextDecoder('utf-16be').decode(bytes);
        case 3:
            return new TextDecoder('utf-8').decode(bytes);
        default:
            return decodeLegacyText(bytes);
        }
    } catch {
        return decodeLegacyText(bytes);
    }
}

/** 多字节编码（utf16）的字符串以 00 00 结尾，单字节以 00 结尾 */
function isWideEncoding(encoding) {
    return encoding === 1 || encoding === 2;
}

/**
 * 从 data[pos] 起读一个以 0 结尾的字符串。
 * @param {Uint8Array} data
 * @param {number} pos
 * @param {number} encoding
 * @returns {{text: string, next: number}}
 */
function readTerminated(data, pos, encoding) {
    const wide = isWideEncoding(encoding);
    // UTF-16 必须按 2 字节步进扫描：逐字节找 00 00 会把最后一个 ASCII 字符的
    // 高位 0 与终止符拼成假终止符，导致后续偏移整体错位（解出乱码）。
    const step = wide ? 2 : 1;
    let end = data.length;

    for (let i = pos; i < data.length; i += step) {
        if (wide) {
            if (data[i] === 0x00 && data[i + 1] === 0x00) {
                end = i;
                break;
            }
        } else if (data[i] === 0x00) {
            end = i;
            break;
        }
    }

    return {
        text: decodeText(data.subarray(pos, end), encoding),
        next: Math.min(data.length, wide ? end + 2 : end + 1),
    };
}

/** 去掉首尾空白与零字节，统一换行 */
function normalizeLyricsText(text) {
    return String(text ?? '')
        .replace(/\u0000/g, '')
        .replace(/\r\n?/g, '\n')
        .replace(/^\n+/, '')
        .replace(/\n+$/, '');
}

// --------------------------------------------------------------- 歌词帧解析

/**
 * 解析 SYLT 帧 → [{timeMs, text}]
 * @param {Uint8Array} data
 * @returns {Array<{timeMs: number, text: string}>|null}
 */
function parseSyltFrame(data) {
    if (data.length < 7)
        return null;

    const encoding = data[0];
    // data[1..3] 语言，data[4] 时间格式，data[5] 内容类型
    const timeFormat = data[4];

    if (timeFormat !== 2) {
        // 1 = MPEG frames，无法可靠换算时间，放弃内嵌歌词
        logger.debug('id3', 'SYLT 时间格式非毫秒，跳过', {timeFormat});
        return null;
    }

    const wide = isWideEncoding(encoding);
    const step = wide ? 2 : 1;
    const entries = [];
    let pos = 6;

    while (pos + 4 < data.length) {
        let end = -1;
        // 同 readTerminated：UTF-16 按 2 字节对齐扫描，避免假终止符
        for (let i = pos; i < data.length; i += step) {
            if (wide) {
                if (data[i] === 0x00 && data[i + 1] === 0x00) {
                    end = i;
                    break;
                }
            } else if (data[i] === 0x00) {
                end = i;
                break;
            }
        }
        if (end < 0)
            break;

        const text = decodeText(data.subarray(pos, end), encoding)
            .replace(/^[\r\n]+/, '')
            .replace(/[\r\n]+$/, '');

        pos = wide ? end + 2 : end + 1;
        if (pos + 4 > data.length)
            break;

        const timeMs = uint32be(data, pos);
        pos += 4;

        if (text)
            entries.push({timeMs, text});
    }

    return entries.length ? entries : null;
}

/**
 * 解析 USLT 帧 → 纯文本歌词。
 * 结构：[编码 1][语言 3][描述(0 结尾)][歌词正文]
 * @param {Uint8Array} data
 * @returns {string|null}
 */
function parseUsltFrame(data) {
    if (data.length < 4)
        return null;

    const encoding = data[0];
    const {next} = readTerminated(data, 4, encoding);
    const text = normalizeLyricsText(decodeText(data.subarray(next), encoding));

    return text || null;
}

/**
 * 解析 TXXX / COMM 帧，只有描述里含 "lyric" 时才当歌词。
 * TXXX: [编码][描述(0结尾)][值]
 * COMM: [编码][语言3][描述(0结尾)][文本]
 * @param {Uint8Array} data
 * @param {boolean} hasLanguage COMM 有 3 字节语言字段
 * @returns {string|null}
 */
function parseDescribedFrame(data, hasLanguage) {
    if (data.length < 4)
        return null;

    const encoding = data[0];
    const start = hasLanguage ? 4 : 1;
    const desc = readTerminated(data, start, encoding);

    if (!/lyric/i.test(desc.text))
        return null;

    const text = normalizeLyricsText(decodeText(data.subarray(desc.next), encoding));
    return text || null;
}

/** SYLT 条目 → 标准 LRC 文本 */
function entriesToLrc(entries) {
    return entries
        .slice()
        .sort((a, b) => a.timeMs - b.timeMs)
        .map(({timeMs, text}) => {
            const total = Math.max(0, Math.floor(timeMs));
            const m = String(Math.floor(total / 60000)).padStart(2, '0');
            const s = String(Math.floor((total % 60000) / 1000)).padStart(2, '0');
            const cs = String(Math.floor((total % 1000) / 10)).padStart(2, '0');
            return `[${m}:${s}.${cs}]${text}`;
        })
        .join('\n');
}

// --------------------------------------------------------------- 帧遍历

/**
 * 计算帧区起点（跳过扩展头）。
 * @param {Uint8Array} body
 * @param {number} major
 * @param {number} headerFlags ID3 头部标志字节
 * @returns {number}
 */
function frameStart(body, major, headerFlags) {
    const hasExtended = (headerFlags & 0x40) !== 0;
    if (major === 4) {
        if (!hasExtended)
            return 0;
        const size = syncsafe(body, 0);
        return size > 0 && size < body.length ? size : 0;
    }
    if (major === 3) {
        if (!hasExtended)
            return 0;
        // v2.3 扩展头长度字段本身不含这 4 字节
        const size = uint32be(body, 0);
        const start = 4 + size;
        return size > 0 && start < body.length ? start : 0;
    }
    return 0; // v2.2 无扩展头（0x40 表示压缩，不支持）
}

/**
 * 遍历标签体里的帧，把歌词候选收集起来。
 * @param {Uint8Array} body
 * @param {number} major
 * @param {number} headerFlags
 * @param {boolean} tagUnsync
 * @returns {{synced: boolean, text: string, format: string}|null}
 */
function findLyrics(body, major, headerFlags, tagUnsync) {
    let pos = frameStart(body, major, headerFlags);

    const idLen = major === 2 ? 3 : 4;
    const headerLen = major === 2 ? 6 : 10;

    let sylt = null;   // {text}
    let uslt = null;   // {text, looksSynced}

    while (pos + headerLen <= body.length) {
        const id = String.fromCharCode(...body.subarray(pos, pos + idLen));
        if (!new RegExp(`^[A-Z0-9]{${idLen}}$`).test(id))
            break; // 填充区或损坏

        let size;
        let formatFlags = 0;
        if (major === 2) {
            size = uint24be(body, pos + 3);
        } else {
            size = major === 4 ? syncsafe(body, pos + 4) : uint32be(body, pos + 4);
            formatFlags = body[pos + 9];
        }

        if (size > TAG_MAX_BYTES || pos + headerLen + size > body.length)
            break;

        const compressed = major === 4
            ? (formatFlags & 0x08) !== 0
            : major === 3 ? (formatFlags & 0x80) !== 0 : false;
        const encrypted = major === 4
            ? (formatFlags & 0x04) !== 0
            : major === 3 ? (formatFlags & 0x40) !== 0 : false;
        const frameUnsync = major === 4 && (formatFlags & 0x02) !== 0;
        const hasDataLength = major === 4 && (formatFlags & 0x01) !== 0;
        const grouped = major === 4
            ? (formatFlags & 0x40) !== 0
            : major === 3 ? (formatFlags & 0x20) !== 0 : false;

        let data = body.subarray(pos + headerLen, pos + headerLen + size);

        const isLyricId = id === 'SYLT' || id === 'SLT' ||
                          id === 'USLT' || id === 'ULT' ||
                          id === 'TXXX' || id === 'TXX' ||
                          id === 'COMM' || id === 'COM';

        if (isLyricId) {
            if (compressed || encrypted) {
                logger.debug('id3', `歌词帧 ${id} 被压缩/加密，跳过`);
            } else {
                if (frameUnsync || (tagUnsync && major === 3))
                    data = deunsynchronise(data);
                if (hasDataLength && data.length > 4)
                    data = data.subarray(4);
                if (grouped && data.length > 1)
                    data = data.subarray(1);

                try {
                    if (id === 'SYLT' || id === 'SLT') {
                        const entries = parseSyltFrame(data);
                        if (entries && !sylt)
                            sylt = {text: entriesToLrc(entries), format: 'SYLT'};
                    } else if (id === 'USLT' || id === 'ULT') {
                        const text = parseUsltFrame(data);
                        if (text && !uslt) {
                            uslt = {
                                text,
                                looksSynced: /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text),
                            };
                        }
                    } else {
                        const text = parseDescribedFrame(data, id === 'COMM' || id === 'COM');
                        if (text && !uslt) {
                            uslt = {
                                text,
                                looksSynced: /\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/.test(text),
                            };
                        }
                    }
                } catch (error) {
                    logger.warn('id3', `解析 ${id} 帧失败`, error);
                }
            }
        }

        pos += headerLen + size;
    }

    if (sylt)
        return {text: sylt.text, synced: true, format: sylt.format};

    if (uslt) {
        return {
            text: uslt.text,
            synced: uslt.looksSynced,
            format: uslt.looksSynced ? 'USLT/LRC' : 'USLT',
        };
    }

    return null;
}

// ----------------------------------------------------------------- 文件读取

function readExact(stream, count) {
    const result = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
        const chunk = stream.read_bytes(count - filled, null).get_data();
        if (!chunk || chunk.length === 0)
            break;
        result.set(chunk, filled);
        filled += chunk.length;
    }
    return filled === count ? result : result.subarray(0, filled);
}

/**
 * 读取本地音频文件的内嵌歌词。
 * @param {string} path 本地文件路径
 * @returns {{text: string, synced: boolean, format: string}|null}
 */
export function readEmbeddedLyrics(path) {
    if (!path)
        return null;

    let stream;
    try {
        stream = Gio.File.new_for_path(path).read(null);
    } catch (error) {
        logger.debug('id3', '打开文件失败', {path, error: error.message});
        return null;
    }

    try {
        const header = readExact(stream, 10);
        if (header.length < 10)
            return null;

        if (header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33) {
            logger.debug('id3', '没有 ID3v2 头', {path});
            return null;
        }

        const major = header[3];
        if (major < 2 || major > 4) {
            logger.debug('id3', `不支持的 ID3 版本 2.${major}`, {path});
            return null;
        }

        const headerFlags = header[5];
        const tagUnsync = (headerFlags & 0x80) !== 0;
        const size = syncsafe(header, 6);
        if (size <= 0 || size > TAG_MAX_BYTES)
            return null;

        const body = readExact(stream, size);
        if (body.length < 10)
            return null;

        const found = findLyrics(body, major, headerFlags, tagUnsync);
        if (!found) {
            logger.debug('id3', '标签存在但没有可用歌词帧', {path, version: `2.${major}`});
            return null;
        }

        logger.debug('id3', '读到内嵌歌词', {
            path,
            version: `2.${major}`,
            format: found.format,
            synced: found.synced,
            chars: found.text.length,
        });

        return found;
    } catch (error) {
        logger.warn('id3', '读取 ID3 失败', error);
        return null;
    } finally {
        try {
            stream.close(null);
        } catch {
            // 忽略关闭错误
        }
    }
}

/**
 * 旧接口：只取内嵌的同步歌词（SYLT），输出 LRC 文本。
 * @param {string} path
 * @returns {string|null}
 */
export function readSyltLrc(path) {
    const found = readEmbeddedLyrics(path);
    return found && found.synced ? found.text : null;
}

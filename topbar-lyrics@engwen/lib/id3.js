// SPDX-License-Identifier: GPL-2.0-or-later
//
// ID3v2 SYLT（同步歌词）解析。
// 仅支持 ID3v2.3 / ID3v2.4（ID3v1 没有 SYLT，直接跳过）。
//
// 用法：readSyltLrc(path) 返回标准 LRC 文本（每行 "[mm:ss.xx]歌词"），
//       没有内嵌歌词或格式不支持时返回 null。

import Gio from 'gi://Gio';

const TAG_MAX_BYTES = 16 * 1024 * 1024; // ID3 标签上限，防止异常文件

// --------------------------------------------------------------- 位读取辅助

/** syncsafe 整数（每个字节只含 7 位）→ 普通整数 */
function syncsafe(bytes, offset) {
    return ((bytes[offset] & 0x7f) << 21) |
           ((bytes[offset + 1] & 0x7f) << 14) |
           ((bytes[offset + 2] & 0x7f) << 7) |
           (bytes[offset + 3] & 0x7f);
}

function uint32(bytes, offset) {
    return (bytes[offset] << 24) | (bytes[offset + 1] << 16) |
           (bytes[offset + 2] << 8) | bytes[offset + 3];
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
 * @param {Uint8Array} bytes
 * @param {number} encoding 0=latin1 1=utf16(带BOM) 2=utf16be 3=utf8
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
            return new TextDecoder('latin1').decode(bytes);
        }
    } catch {
        return new TextDecoder('latin1').decode(bytes);
    }
}

// --------------------------------------------------------------- SYLT 帧

/**
 * 解析 SYLT 帧内容 → [{timeMs, text}]
 * @param {Uint8Array} data 帧体（已做反同步）
 * @returns {Array<{timeMs: number, text: string}>|null}
 */
function parseSyltFrame(data) {
    if (data.length < 7)
        return null;

    const encoding = data[0];
    // data[1..3] = 语言，data[4] = 时间格式，data[5] = 内容类型
    const timeFormat = data[4];

    if (timeFormat !== 2) {
        // 1 = MPEG frames，无法可靠换算成时间，放弃内嵌歌词走下一优先级
        return null;
    }

    // 多字节编码（utf16）以 00 00 结尾，单字节以 00 结尾
    const wide = encoding === 1 || encoding === 2;
    const entries = [];
    let pos = 6;

    while (pos + 4 < data.length) {
        // 找字符串结尾
        let end = -1;
        for (let i = pos; i < data.length; i++) {
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

        const timeMs = uint32(data, pos);
        pos += 4;

        if (text)
            entries.push({timeMs, text});
    }

    return entries.length ? entries : null;
}

// --------------------------------------------------------------- 标签遍历

/**
 * 在 ID3v2 标签体里找 SYLT 帧。
 * @param {Uint8Array} body 标签头之后的字节
 * @param {number} major 主版本号（3 或 4）
 * @param {boolean} tagUnsync 整个标签的反同步标志
 * @returns {Array<{timeMs: number, text: string}>|null}
 */
function findSylt(body, major, tagUnsync) {
    // 跳过扩展头
    let pos = 0;
    if (major === 3) {
        const size = uint32(body, 0);
        if (size > 0 && size < body.length)
            pos = 4 + size;
    } else if (major === 4) {
        const size = syncsafe(body, 0);
        if (size > 0 && size < body.length)
            pos = size;
    }

    const frameIdLen = 4;
    const id322 = false; // 不支持 v2.2（3 字节帧 ID）

    while (pos + frameIdLen + 4 <= body.length) {
        const id = String.fromCharCode(...body.subarray(pos, pos + frameIdLen));
        if (!/^[A-Z0-9]{4}$/.test(id))
            break; // 填充区或损坏

        let size;
        let flags1;
        if (major === 4) {
            size = syncsafe(body, pos + 4);
            flags1 = body[pos + 8];
        } else {
            size = uint32(body, pos + 4);
            flags1 = body[pos + 9];
        }

        if (size <= 0 || pos + 10 + size > body.length)
            break;

        const compressed = major === 3 ? (flags1 & 0x80) !== 0 : (flags1 & 0x08) !== 0;
        const encrypted = major === 3 ? (flags1 & 0x40) !== 0 : (flags1 & 0x04) !== 0;
        const frameUnsync = major === 4 && (flags1 & 0x02) !== 0;
        const hasDataLength = major === 4 && (flags1 & 0x01) !== 0;

        let data = body.subarray(pos + 10, pos + 10 + size);
        if (hasDataLength && data.length > 4)
            data = data.subarray(4);

        if (id === 'SYLT' && !compressed && !encrypted) {
            if (frameUnsync || (tagUnsync && major === 3))
                data = deunsynchronise(data);
            const entries = parseSyltFrame(data);
            if (entries)
                return entries;
        }

        pos += 10 + size;
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
 * 读取本地音频文件的内嵌 SYLT 歌词，输出标准 LRC 文本。
 * @param {string} path 本地文件路径
 * @returns {string|null} LRC 文本，无内嵌歌词时为 null
 */
export function readSyltLrc(path) {
    let stream;
    try {
        stream = Gio.File.new_for_path(path).read(null);
    } catch {
        return null;
    }

    try {
        const header = readExact(stream, 10);
        if (header.length < 10)
            return null;

        if (header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33)
            return null; // 没有 "ID3"

        const major = header[3];
        if (major !== 3 && major !== 4)
            return null; // 只支持 v2.3 / v2.4

        const flags = header[5];
        const tagUnsync = (flags & 0x80) !== 0;
        const size = syncsafe(header, 6);
        if (size <= 0 || size > TAG_MAX_BYTES)
            return null;

        const body = readExact(stream, size);
        if (body.length < 10)
            return null;

        const entries = findSylt(body, major, tagUnsync);
        if (!entries)
            return null;

        entries.sort((a, b) => a.timeMs - b.timeMs);

        return entries
            .map(({timeMs, text}) => {
                const total = Math.max(0, Math.floor(timeMs));
                const m = String(Math.floor(total / 60000)).padStart(2, '0');
                const s = String(Math.floor((total % 60000) / 1000)).padStart(2, '0');
                const cs = String(Math.floor((total % 1000) / 10)).padStart(2, '0');
                return `[${m}:${s}.${cs}]${text}`;
            })
            .join('\n');
    } catch {
        return null;
    } finally {
        try {
            stream.close(null);
        } catch {
            // 忽略关闭错误
        }
    }
}

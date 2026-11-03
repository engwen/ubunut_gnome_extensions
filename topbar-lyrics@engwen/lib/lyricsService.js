// SPDX-License-Identifier: GPL-2.0-or-later
//
// 歌词获取服务：按优先级串行调用若干「provider」，命中即停。
//
// 每个 provider 彼此独立、各自 try/catch —— 任何一个抛错都只记一条日志并
// 继续尝试下一个，绝不会让整条链路（乃至插件）崩掉。
//
// 优先级（可直接对照代码里的 _buildProviders）：
//   1. embedded    本地音频内嵌歌词（MP3 的 SYLT / USLT / TXXX…）
//   2. user-dir    设置里指定的歌词目录（同名 .lrc，支持子目录与模糊匹配）
//   3. cache-file  歌词缓存目录里已下载的 .lrc
//   4. sidecar     音频文件所在目录的同名 .lrc（支持子目录与模糊匹配）
//   5. music-dir   系统音乐目录里的同名 .lrc
//   6. network     LRCLIB 联网搜索（精确 → 搜索降级），成功后写缓存
//
// 内存缓存（命中即同步返回）在最外层先查。
// 所有 .lrc 匹配都是"同名"（xxx.mp3 → xxx.lrc）；流媒体没有本地路径，
// 会自动跳过 1/4 两步。

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {readEmbeddedLyrics} from './id3.js';
import {looksLikeLrc, parseLrc, parsePlainLyrics} from './lrc.js';
import {logger} from './logger.js';

const API_BASE = 'https://lrclib.net/api';
const CACHE_LIMIT = 50;          // 内存缓存条目上限
const DIR_SCAN_LIMIT = 3000;     // 单目录枚举上限，防止超大目录卡死
const LRC_SUBDIRS = ['Lyrics', 'lyrics', 'LRC', 'lrc', '歌词'];

/**
 * @typedef {object} Track
 * @property {string} title
 * @property {string} artist
 * @property {string} album
 * @property {number} length 微秒
 * @property {string} url
 */

export class LyricsService {
    /**
     * @param {Gio.Settings} settings
     * @param {string|null} [cacheDir] 缓存目录覆盖（测试用；默认 ~/.cache/topbar-lyrics）
     */
    constructor(settings, cacheDir = null) {
        this._settings = settings;
        this._http = null;
        /** @type {Map<string, {doc: object, source: string}>} */
        this._memory = new Map();
        this._cacheDir = cacheDir ??
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'topbar-lyrics']);
        this._providers = this._buildProviders();

        logger.debug('service', '初始化完成', {
            cacheDir: this._cacheDir,
            lyricsDir: this._settings.get_string('lyrics-dir') || '(未设置)',
            cacheEnabled: this._cacheEnabled(),
        });
    }

    /**
     * 定义 provider 链。顺序即优先级。
     * 每个 run(ctx, cancellable) 返回 {doc, source} 或 null。
     * @returns {Array<{name: string, run: Function}>}
     */
    _buildProviders() {
        return [
            {name: 'embedded', run: ctx => this._fromEmbedded(ctx)},
            {name: 'user-dir', run: ctx => this._fromUserDir(ctx)},
            {name: 'cache-file', run: ctx => this._fromCacheFile(ctx)},
            {name: 'sidecar', run: ctx => this._fromSidecar(ctx)},
            {name: 'music-dir', run: ctx => this._fromMusicDir(ctx)},
            {name: 'network', run: (ctx, cancellable) => this._fromNetwork(ctx, cancellable)},
        ];
    }

    // ------------------------------------------------------------- 内存缓存

    /** 缓存唯一标识：本地文件用全路径，流媒体用元数据组合 */
    _memoryKey(track) {
        if (track.url?.startsWith('file://'))
            return track.url;

        return `net|${track.artist ?? ''}|${track.title ?? ''}|` +
               `${track.album ?? ''}|${Math.round((track.length ?? 0) / 1e6)}`;
    }

    /**
     * 主线程同步查内存缓存（无 IO）。
     * @param {Track} track
     * @returns {{doc: object, source: string}|null}
     */
    peekMemory(track) {
        if (!track)
            return null;
        return this._memory.get(this._memoryKey(track)) ?? null;
    }

    _remember(key, doc, source) {
        if (this._memory.size >= CACHE_LIMIT) {
            const oldest = this._memory.keys().next().value;
            this._memory.delete(oldest);
        }
        this._memory.set(key, {doc, source});
    }

    clearMemory() {
        this._memory.clear();
    }

    // ------------------------------------------------------------------ 加载

    /**
     * @param {Track} track
     * @param {Gio.Cancellable|null} [cancellable]
     * @returns {Promise<{doc: object, source: string}|null>}
     */
    async load(track, cancellable = null) {
        if (!track?.title) {
            logger.debug('service', '曲目缺少标题，跳过');
            return null;
        }

        // 内存缓存
        const key = this._memoryKey(track);
        const hit = this._memory.get(key);
        if (hit) {
            logger.debug('service', '内存缓存命中', {key});
            return hit;
        }

        const ctx = this._context(track);
        logger.info('service', '开始查找歌词', {
            title: track.title,
            artist: track.artist,
            local: ctx.local,
            path: ctx.path || '(无)',
        });

        for (const provider of this._providers) {
            if (cancellable?.is_cancelled?.()) {
                logger.debug('service', '已取消，停止查找');
                return null;
            }

            let result = null;
            try {
                result = await provider.run(ctx, cancellable);
            } catch (error) {
                // 关键：单个 provider 出错只记录，绝不中断整条链
                logger.warn('service', `provider ${provider.name} 抛错，跳过`, error);
                continue;
            }

            if (result) {
                logger.info('service', `命中 ${provider.name}`, {
                    source: result.source,
                    lines: result.doc?.lines?.length ?? 0,
                });
                this._remember(key, result.doc, result.source);
                return result;
            }

            logger.debug('service', `provider ${provider.name} 无结果`);
        }

        logger.info('service', '所有来源均未找到歌词', {title: track.title});
        return null;
    }

    /**
     * 预计算一次查找上下文，避免每个 provider 重复算路径/候选名。
     * @param {Track} track
     */
    _context(track) {
        const path = this._pathOf(track);
        return {
            track,
            path,
            local: !!path,
            durationMs: Math.round((track.length ?? 0) / 1000),
            candidates: [...new Set([
                path ? this._baseName(path) : null,
                this._netBaseName(track),
                this._plainTitle(track),
            ].filter(Boolean))],
        };
    }

    // -------------------------------------------------------------- providers

    /** ① 音频文件内嵌歌词（MP3 ID3 的 SYLT / USLT / TXXX…） */
    _fromEmbedded(ctx) {
        if (!ctx.local) {
            logger.debug('embedded', '非本地文件，跳过');
            return null;
        }

        const found = readEmbeddedLyrics(ctx.path);
        if (!found)
            return null;

        const doc = found.synced || looksLikeLrc(found.text)
            ? parseLrc(found.text)
            : parsePlainLyrics(found.text, ctx.durationMs);

        if (!doc.lines.length) {
            logger.warn('embedded', '内嵌歌词解析后 0 行，放弃', {format: found.format});
            return null;
        }

        const source = found.synced
            ? `mp3:${found.format}`
            : `mp3:${found.format}(合成时间轴)`;
        return {doc, source};
    }

    /** ② 设置里指定的歌词目录 */
    _fromUserDir(ctx) {
        const dir = (this._settings.get_string('lyrics-dir') ?? '').trim();
        if (!dir) {
            logger.debug('user-dir', '未设置歌词目录，跳过');
            return null;
        }

        const hit = this._findLrcInDir(dir, ctx.candidates, {fuzzy: true, subdirs: true});
        if (!hit) {
            logger.debug('user-dir', '目录内未找到匹配 .lrc', {dir});
            return null;
        }

        logger.debug('user-dir', '命中', {dir, file: hit.file, how: hit.how});
        return this._docFromText(hit.text, 'user-dir', ctx.durationMs);
    }

    /** ③ 歌词缓存目录 */
    _fromCacheFile(ctx) {
        if (!this._cacheEnabled()) {
            logger.debug('cache-file', '缓存已关闭，跳过');
            return null;
        }

        const hit = this._findLrcInDir(this._cacheDir, ctx.candidates, {fuzzy: true});
        if (!hit) {
            logger.debug('cache-file', '缓存内未找到匹配 .lrc');
            return null;
        }

        logger.debug('cache-file', '命中', {file: hit.file, how: hit.how});
        return this._docFromText(hit.text, 'cache-file', ctx.durationMs);
    }

    /** ④ 音频文件同目录（含 Lyrics/lrc 子目录、模糊匹配） */
    _fromSidecar(ctx) {
        if (!ctx.local) {
            logger.debug('sidecar', '非本地文件，跳过');
            return null;
        }

        const dir = GLib.path_get_dirname(ctx.path);
        const hit = this._findLrcInDir(dir, ctx.candidates, {fuzzy: true, subdirs: true});
        if (!hit) {
            logger.debug('sidecar', '同目录未找到匹配 .lrc', {dir});
            return null;
        }

        logger.debug('sidecar', '命中', {dir, file: hit.file, how: hit.how});
        return this._docFromText(hit.text, 'sidecar', ctx.durationMs);
    }

    /** ⑤ 系统音乐目录（只做精确匹配，避免扫描过多文件） */
    _fromMusicDir(ctx) {
        const dir = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_MUSIC);
        if (!dir) {
            logger.debug('music-dir', '系统音乐目录不可用，跳过');
            return null;
        }

        const hit = this._findLrcInDir(dir, ctx.candidates, {fuzzy: false, subdirs: true});
        if (!hit)
            return null;

        logger.debug('music-dir', '命中', {dir, file: hit.file});
        return this._docFromText(hit.text, 'music-dir', ctx.durationMs);
    }

    /** ⑥ 联网兜底（LRCLIB），成功后写缓存 */
    async _fromNetwork(ctx, cancellable) {
        const http = await this._getHttp();
        if (!http) {
            logger.warn('network', 'HTTP 模块不可用，跳过');
            return null;
        }

        const track = ctx.track;
        const duration = Math.round((track.length ?? 0) / 1e6);
        let text = null;
        let via = '';

        // 精确匹配：/api/get 必须带 album_name 或 duration，否则直接 400
        if ((track.album ?? '').trim() || duration > 0) {
            try {
                const exact = await http.getJSON(
                    this._exactUrl(track, duration), cancellable);
                text = exact?.syncedLyrics || exact?.plainLyrics || null;
                if (text)
                    via = 'get';
            } catch (error) {
                logger.debug('network', '/api/get 未命中或失败，转 search', error);
            }
        }

        // 搜索降级
        if (!text) {
            try {
                const best = await this._search(http, track, duration, cancellable);
                text = best?.syncedLyrics || best?.plainLyrics || null;
                if (text)
                    via = 'search';
            } catch (error) {
                logger.warn('network', '/api/search 失败', error);
                return null;
            }
        }

        if (!text) {
            logger.info('network', 'LRCLIB 未找到歌词', {
                title: track.title, artist: track.artist,
            });
            return null;
        }

        logger.info('network', 'LRCLIB 命中', {via, chars: text.length});

        if (this._cacheEnabled() && ctx.candidates[0])
            this._writeCachedLrc(ctx.candidates[0], text);

        return this._docFromText(text, `lrclib:${via}`, ctx.durationMs);
    }

    // ------------------------------------------------------------ 文本 → doc

    /**
     * 统一把歌词文本转成视图要的 doc 结构。
     * 有 LRC 时间标签按时间轴解析；纯文本按曲长铺合成时间轴。
     * @param {string} text
     * @param {string} source
     * @param {number} durationMs
     * @returns {{doc: object, source: string}|null}
     */
    _docFromText(text, source, durationMs = 0) {
        if (!text)
            return null;

        const doc = looksLikeLrc(text)
            ? parseLrc(text)
            : parsePlainLyrics(text, durationMs);

        if (!doc.lines.length) {
            logger.warn('service', `${source} 文本解析后 0 行`, {chars: text.length});
            return null;
        }

        return {doc, source};
    }

    // --------------------------------------------------------- 目录 / 文件 IO

    _cacheEnabled() {
        return this._settings.get_boolean('cache-enabled');
    }

    _pathOf(track) {
        try {
            return Gio.File.new_for_uri(track.url).get_path() ?? '';
        } catch {
            return '';
        }
    }

    /** xxx.mp3 → xxx */
    _baseName(path) {
        return GLib.path_get_basename(path).replace(/\.[^./\\]+$/, '');
    }

    /** 流媒体的候选名：歌手 - 歌名 */
    _netBaseName(track) {
        const raw = `${track.artist ?? ''} - ${track.title ?? ''}`
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
        return raw || null;
    }

    /** 纯歌名候选 */
    _plainTitle(track) {
        const raw = String(track.title ?? '')
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
        return raw || null;
    }

    /** 文件名归一化，用于模糊匹配（去扩展名、空格、常见标点、统一小写） */
    _normalizeName(name) {
        return String(name ?? '')
            .replace(/\.[^.]+$/, '')
            .toLowerCase()
            .replace(/[\s\-_·.,()（）\[\]【】]/g, '');
    }

    /**
     * 解码 .lrc 文件字节：BOM → 严格 UTF-8 → GB18030/GBK → Big5 → 宽松 UTF-8。
     * 中文歌词文件大量是 GBK 编码，直接按 UTF-8 解会整片乱码，必须先探测。
     * @param {Uint8Array} bytes
     * @returns {string|null}
     */
    _decodeBytes(bytes) {
        if (!bytes?.length)
            return null;

        if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
            return new TextDecoder('utf-8').decode(bytes.subarray(3));
        if (bytes[0] === 0xff && bytes[1] === 0xfe)
            return new TextDecoder('utf-16le').decode(bytes.subarray(2));
        if (bytes[0] === 0xfe && bytes[1] === 0xff)
            return new TextDecoder('utf-16be').decode(bytes.subarray(2));

        try {
            return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
        } catch {
            logger.debug('fs', '歌词文件不是 UTF-8，尝试 GB18030 / Big5');
        }

        for (const encoding of ['gb18030', 'gbk', 'big5']) {
            try {
                return new TextDecoder(encoding, {fatal: true}).decode(bytes);
            } catch {
                // 试下一个编码
            }
        }

        return new TextDecoder('utf-8').decode(bytes);
    }

    _readFile(path) {
        try {
            const [ok, contents] = Gio.File.new_for_path(path).load_contents(null);
            if (ok && contents?.length)
                return this._decodeBytes(contents);
        } catch {
            // 文件不存在或读不了
        }
        return null;
    }

    _dirExists(path) {
        try {
            return Gio.File.new_for_path(path).query_exists(null);
        } catch {
            return false;
        }
    }

    /**
     * 列出目录下的 .lrc 文件名（不递归）。
     * @param {string} dir
     * @returns {string[]}
     */
    _listLrcFiles(dir) {
        const out = [];
        try {
            const file = Gio.File.new_for_path(dir);
            if (!file.query_exists(null))
                return out;

            const enumerator = file.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);

            let count = 0;
            while (true) {
                const info = enumerator.next_file(null);
                if (!info)
                    break;
                if (++count > DIR_SCAN_LIMIT) {
                    logger.warn('fs', '目录条目过多，提前停止扫描', {dir});
                    break;
                }
                if (info.get_file_type() !== Gio.FileType.REGULAR)
                    continue;
                const name = info.get_name();
                if (/\.lrc$/i.test(name))
                    out.push(name);
            }
            enumerator.close(null);
        } catch (error) {
            logger.debug('fs', '枚举目录失败', {dir, error: error.message});
        }
        return out;
    }

    /**
     * 在目录（及常见 Lyrics 子目录）里找同名 .lrc。
     * @param {string} dir
     * @param {string[]} candidates 不带扩展名的候选文件名
     * @param {{fuzzy?: boolean, subdirs?: boolean}} [options]
     * @returns {{text: string, file: string, how: string}|null}
     */
    _findLrcInDir(dir, candidates, options = {}) {
        if (!dir || !candidates?.length)
            return null;

        const {fuzzy = false, subdirs = false} = options;

        const dirs = [dir];
        if (subdirs) {
            for (const sub of LRC_SUBDIRS) {
                const path = GLib.build_filenamev([dir, sub]);
                if (this._dirExists(path))
                    dirs.push(path);
            }
        }

        // 第一轮：精确同名（含大小写扩展名变体）
        for (const target of dirs) {
            for (const name of candidates) {
                for (const ext of ['.lrc', '.Lrc', '.LRC']) {
                    const file = `${name}${ext}`;
                    const text = this._readFile(GLib.build_filenamev([target, file]));
                    if (text)
                        return {text, file, how: 'exact'};
                }
            }
        }

        if (!fuzzy)
            return null;

        // 第二轮：归一化后模糊匹配（应对 "01. 歌名.lrc"、"歌名 - 歌手.lrc" 之类）
        const wanted = candidates
            .map(name => this._normalizeName(name))
            .filter(name => name.length >= 2);

        for (const target of dirs) {
            for (const name of this._listLrcFiles(target)) {
                const normalized = this._normalizeName(name);
                if (!normalized)
                    continue;

                const matched = wanted.some(w => normalized === w ||
                    normalized.includes(w) || w.includes(normalized));
                if (!matched)
                    continue;

                const text = this._readFile(GLib.build_filenamev([target, name]));
                if (text)
                    return {text, file: name, how: 'fuzzy'};
            }
        }

        return null;
    }

    // ----------------------------------------------------------- 缓存写 / 清

    _cachedLrcPath(name) {
        return GLib.build_filenamev([this._cacheDir, `${name}.lrc`]);
    }

    _writeCachedLrc(name, text) {
        try {
            const dir = Gio.File.new_for_path(this._cacheDir);
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);

            dir.get_child(`${name}.lrc`).replace_contents(
                new TextEncoder().encode(text),
                null, false, Gio.FileCreateFlags.NONE, null);
        } catch (error) {
            logger.warn('cache', '写入歌词缓存失败', error);
        }
    }

    /** 清空缓存目录（首选项「清空歌词缓存」调用） */
    static clearCache() {
        const dir = Gio.File.new_for_path(
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'topbar-lyrics']));
        try {
            const enumerator = dir.enumerate_children('standard::name',
                Gio.FileQueryInfoFlags.NONE, null);
            while (true) {
                const info = enumerator.next_file(null);
                if (!info)
                    break;
                enumerator.get_child(info).delete(null);
            }
            enumerator.close(null);
        } catch {
            // 目录不存在就算清空了
        }
    }

    // ------------------------------------------------------------------ 联网

    /**
     * 动态加载 HTTP 模块：即使缺少 libsoup 也不会让插件加载失败。
     * @returns {Promise<object|null>}
     */
    async _getHttp() {
        if (this._http)
            return this._http;

        try {
            this._http = await import('./http.js');
        } catch (error) {
            logger.error('network', 'HTTP 模块加载失败', error);
            this._http = null;
        }

        return this._http;
    }

    /**
     * @param {Track} track
     * @param {number} duration 秒
     * @returns {string}
     */
    _exactUrl(track, duration) {
        let url = `${API_BASE}/get?artist_name=${encodeURIComponent(track.artist ?? '')}` +
                  `&track_name=${encodeURIComponent(track.title ?? '')}`;
        if (track.album)
            url += `&album_name=${encodeURIComponent(track.album)}`;
        if (duration > 0)
            url += `&duration=${duration}`;
        return url;
    }

    /**
     * @param {object} http
     * @param {Track} track
     * @param {number} duration 秒
     * @param {Gio.Cancellable|null} cancellable
     * @returns {Promise<object|null>}
     */
    async _search(http, track, duration, cancellable) {
        const url = `${API_BASE}/search?track_name=${encodeURIComponent(track.title)}` +
                    `&artist_name=${encodeURIComponent(track.artist ?? '')}`;

        const list = await http.getJSON(url, cancellable);
        if (!Array.isArray(list) || list.length === 0)
            return null;

        const normalize = value =>
            String(value ?? '').toLowerCase().replace(/[\s\-_()[\]]/g, '');
        const wantTitle = normalize(track.title);
        const wantArtist = normalize(track.artist);

        let best = null;
        let bestScore = -Infinity;

        for (const item of list) {
            if (!item?.syncedLyrics && !item?.plainLyrics)
                continue;

            let score = 0;
            if (normalize(item.trackName) === wantTitle)
                score += 5;
            if (wantArtist && normalize(item.artistName) === wantArtist)
                score += 5;
            if (duration > 0 && item.duration > 0) {
                const diff = Math.abs(item.duration - duration);
                score += Math.max(0, 3 - diff / 5);
            }
            if (item.hasWordSync)
                score += 0.5;

            if (score > bestScore) {
                bestScore = score;
                best = item;
            }
        }

        return best;
    }
}

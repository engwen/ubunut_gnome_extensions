// SPDX-License-Identifier: GPL-2.0-or-later
//
// 歌词获取服务。加载顺序（命中即停）：
//   0. 内存缓存命中 → 直接返回（同步、只做匹配）
//   1. 解析本地音频 ID3v2 头部标签的内嵌 SYLT 同步歌词
//      （只读 ID3 标签字节，绝不读音频数据流）
//   2. 【用户歌词目录】找同名 .lrc（设置项 lyrics-dir）
//   3. 【歌词缓存子目录】找同名 .lrc
//   4. mp3 所在目录找同名 .lrc
//   5. 联网搜索兜底（5s 超时），成功后写入缓存目录并更新内存缓存
//   6. 全部落空 → 返回 null，顶栏显示「未找到歌词」
//
// 所有 .lrc 查找都是同名匹配（xxx.mp3 → xxx.lrc）。流媒体（http/https）
// 没有本地路径，跳过 1–4 步直接联网。
//
// 快速切歌保护：load() 接受 Gio.Cancellable，新任务发起前取消上一个
// 未完成的网络请求；回调侧再按 token 校验（见 extension.js）。
// LRCLIB 是一个免费、无需 API Key 的开放歌词库（https://lrclib.net）。

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {readSyltLrc} from './id3.js';
import {parseLrc} from './lrc.js';

const API_BASE = 'https://lrclib.net/api';

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
     */
    /**
     * @param {Gio.Settings} settings
     * @param {string|null} [cacheDir] 缓存目录覆盖（测试用；默认 ~/.cache/topbar-lyrics）
     */
    constructor(settings, cacheDir = null) {
        this._settings = settings;
        this._http = null;
        /** @type {Map<string, {doc: object, source: string}>} 内存缓存 */
        this._memory = new Map();
        this._cacheDir = cacheDir ??
            GLib.build_filenamev([GLib.get_user_cache_dir(), 'topbar-lyrics']);
    }

    // ------------------------------------------------------------- 内存缓存

    /**
     * 缓存唯一标识：本地文件用全路径，流媒体用元数据组合。
     * @param {Track} track
     * @returns {string}
     */
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
        if (this._memory.size >= 50) {
            // 淘汰最早写入的一条
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
     * @param {Gio.Cancellable|null} [cancellable] 新任务发起前应先取消上一个
     * @returns {Promise<{doc: object, source: string}|null>}
     *          null = 全部落空，顶栏显示「未找到歌词」
     */
    async load(track, cancellable = null) {
        if (!track?.title)
            return null;

        // ---- 第 0 步：内存缓存 ----
        const key = this._memoryKey(track);
        const hit = this._memory.get(key);
        if (hit)
            return hit;

        const found = await this._loadChain(track, cancellable);

        if (found)
            this._remember(key, found.doc, found.source);

        return found;
    }

    /**
     * @param {Track} track
     * @param {Gio.Cancellable|null} cancellable
     * @returns {Promise<{doc: object, source: string}|null>}
     */
    async _loadChain(track, cancellable) {
        const isLocal = track.url?.startsWith('file://');
        const path = isLocal ? this._pathOf(track) : '';

        // ---- 第 1 步：ID3 内嵌 SYLT（只读标签，不读音频流）----
        if (path) {
            const sylt = readSyltLrc(path);
            if (sylt)
                return {doc: parseLrc(sylt), source: 'sylt'};
        }

        // 同名候选：本地文件名 > 「歌手 - 歌名」> 歌名。
        // 网页播放器（Chromium 等）不给 xesam:url，只能靠元数据拼文件名。
        const candidates = [...new Set([
            path ? this._baseName(path) : null,
            this._netBaseName(track),
            this._plainTitle(track),
        ].filter(Boolean))];

        // 搜索目录（去重）：用户歌词目录 > 缓存目录 > mp3 所在目录 > 系统音乐目录
        const sources = [];
        const pushDir = (dir, source) => {
            if (dir && !sources.some(s => s.dir === dir))
                sources.push({dir, source});
        };
        pushDir(this._settings.get_string('lyrics-dir'), 'user-dir');
        if (this._cacheEnabled())
            pushDir(this._cacheDir, 'cache-file');
        if (path)
            pushDir(GLib.path_get_dirname(path), 'sidecar');
        pushDir(GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_MUSIC),
            'music-dir');

        // ---- 第 2–4 步：各目录按候选名找同名 .lrc，命中即停 ----
        for (const {dir, source} of sources) {
            for (const name of candidates) {
                const text = this._findSameNameLrc(dir, name);
                if (text)
                    return {doc: parseLrc(text), source};
            }
        }

        // ---- 第 5 步：联网兜底（5s 超时），成功写入缓存目录 ----
        const text = await this._fetchRemoteLrc(track, cancellable);
        if (!text)
            return null; // 第 6 步：顶栏显示「未找到歌词」

        if (this._cacheEnabled() && candidates[0])
            this._writeCachedLrc(candidates[0], text);

        return {doc: parseLrc(text), source: 'lrclib'};
    }

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

    /** xxx.mp3 → xxx（去扩展名，供同名匹配） */
    _baseName(path) {
        return GLib.path_get_basename(path).replace(/\.[^./\\]+$/, '');
    }

    /** 流媒体的缓存文件名：歌手 - 歌名 */
    _netBaseName(track) {
        const raw = `${track.artist ?? ''} - ${track.title ?? ''}`
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
        return raw || null;
    }

    /** 只有歌名的候选（纯标题，同样做文件名净化） */
    _plainTitle(track) {
        const raw = String(track.title ?? '')
            .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 120);
        return raw || null;
    }

    /**
     * 在目录中找同名 .lrc（只做文件名匹配，含大小写变体）。
     * @param {string} dir
     * @param {string} name 不带扩展名的文件名
     * @returns {string|null} lrc 文本
     */
    _findSameNameLrc(dir, name) {
        if (!dir || !name)
            return null;

        for (const candidate of [`${name}.lrc`, `${name}.Lrc`, `${name}.LRC`]) {
            try {
                const [ok, contents] = Gio.File.new_for_path(
                    GLib.build_filenamev([dir, candidate])).load_contents(null);
                if (ok && contents?.length)
                    return new TextDecoder().decode(contents);
            } catch {
                // 继续尝试下一个候选
            }
        }

        return null;
    }

    // ------------------------------------------------------- 缓存子目录读写

    _cachedLrcPath(name) {
        return GLib.build_filenamev([this._cacheDir, `${name}.lrc`]);
    }

    _readCachedLrc(name) {
        if (!name)
            return null;

        try {
            const [ok, contents] = Gio.File.new_for_path(this._cachedLrcPath(name))
                .load_contents(null);
            if (ok && contents?.length)
                return new TextDecoder().decode(contents);
        } catch {
            // 没有缓存
        }

        return null;
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
            logError(error, 'TopBarLyrics: 写入歌词缓存失败');
        }
    }

    /**
     * 清空缓存子目录（首选项「清空歌词缓存」调用）。
     */
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
            logError(error, 'TopBarLyrics: HTTP 模块加载失败');
            this._http = null;
        }

        return this._http;
    }

    /**
     * 联网取歌词文本：/api/get 精确匹配失败（404、400、超时等）时
     * 无条件降级到 /api/search，保证 search 兜底永远有机会执行。
     * @param {Track} track
     * @param {Gio.Cancellable|null} cancellable
     * @returns {Promise<string|null>} syncedLyrics 文本
     */
    async _fetchRemoteLrc(track, cancellable) {
        const http = await this._getHttp();
        if (!http)
            return null;

        const duration = Math.round((track.length ?? 0) / 1e6);

        // /api/get 要求必须带 album_name 或 duration，缺了会直接 400
        if ((track.album ?? '').trim() || duration > 0) {
            try {
                const exact = await http.getJSON(this._exactUrl(track, duration), cancellable);
                if (exact?.syncedLyrics)
                    return exact.syncedLyrics;
            } catch {
                // 精确匹配挂了不算失败，继续走 search
            }
        }

        try {
            const best = await this._search(http, track, duration, cancellable);
            return best?.syncedLyrics ?? null;
        } catch {
            return null;
        }
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

        const normalize = value => String(value ?? '').toLowerCase().replace(/[\s\-_()[\]]/g, '');
        const wantTitle = normalize(track.title);
        const wantArtist = normalize(track.artist);

        let best = null;
        let bestScore = -Infinity;

        for (const item of list) {
            if (!item?.syncedLyrics)
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

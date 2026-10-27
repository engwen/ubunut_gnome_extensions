// SPDX-License-Identifier: GPL-2.0-or-later
//
// MPRIS 播放器监听。
// 负责：发现/跟踪 org.mpris.MediaPlayer2.* 播放器、选出“当前该显示谁”、
//       读取曲目元数据、维护播放进度（本机插值 + 定期校准，避免频繁 DBus 调用）。

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const NAME_PREFIX = 'org.mpris.MediaPlayer2.';
const OBJECT_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const ROOT_IFACE = 'org.mpris.MediaPlayer2';

// 同时有多个播放器时，按这个顺序优先（越靠前越优先）
const BUILTIN_ORDER = [
    'spotify', 'yesplaymusic', 'netease-cloud-music', 'feishin', 'listen1',
    'tauon', 'strawberry', 'rhythmbox', 'lollypop', 'amberol', 'elisa',
    'audacious', 'clementine', 'deadbeef', 'cmus', 'mpd', 'mpv', 'vlc',
    'firefox', 'chromium', 'chrome', 'brave', 'edge',
];

const POLL_INTERVAL_MS = 1000;
const RESCAN_INTERVAL_MS = 10000;
const DRIFT_TOLERANCE_US = 400000;

/**
 * gjs 的 deep_unpack() 遇到 v（variant）类型时仍会交出 GLib.Variant 对象，
 * 这里统一再剥一层。
 * @param {any} value
 * @returns {any}
 */
function unpackValue(value) {
    return value instanceof GLib.Variant ? value.deep_unpack() : value;
}

/**
 * 把 a{sv} 字典的每个值都剥掉 variant 外壳。
 * @param {object} dict
 * @returns {object}
 */
function unpackDict(dict) {
    if (!dict || typeof dict !== 'object')
        return {};

    const result = {};
    for (const [key, value] of Object.entries(dict))
        result[key] = unpackValue(value);
    return result;
}

export class MprisWatcher {
    constructor() {
        /** @type {Map<string, object>} */
        this._players = new Map();
        this._active = null;
        this._preferred = '';
        this._onChange = null;
        this._lastKey = null;
        this._lastScanSignature = null;
        this._nameSubId = 0;
        this._pollId = 0;
        this._rescanId = 0;
        this._destroyed = false;
    }

    // ------------------------------------------------------------- 生命周期

    /**
     * @param {(state: object|null) => void} onChange
     */
    start(onChange) {
        this._onChange = onChange;

        try {
            this._nameSubId = Gio.DBus.session.signal_subscribe(
                'org.freedesktop.DBus',
                'org.freedesktop.DBus',
                'NameOwnerChanged',
                '/org/freedesktop/DBus',
                null,
                Gio.DBusSignalFlags.NONE,
                (connection, sender, path, iface, signal, params) => {
                    const [name, oldOwner, newOwner] = params.deep_unpack();
                    if (!name.startsWith(NAME_PREFIX) || this._destroyed)
                        return;
                    if (newOwner)
                        this._addPlayer(name);
                    else
                        this._removePlayer(name);
                });
        } catch (error) {
            logError(error, 'TopBarLyrics: 无法监听 D-Bus');
        }

        this._listExisting();

        this._pollId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, POLL_INTERVAL_MS, () => {
            this._pollPosition();
            return GLib.SOURCE_CONTINUE;
        });

        // 自愈：NameOwnerChanged 有可能漏收（会话唤醒、播放器注册顺序异常等），
        // 定期重新扫描一次总线，把漏掉的播放器补上。已有条目会被跳过，开销极小。
        this._rescanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RESCAN_INTERVAL_MS, () => {
            this._listExisting();
            return GLib.SOURCE_CONTINUE;
        });
    }

    destroy() {
        this._destroyed = true;

        if (this._pollId) {
            GLib.Source.remove(this._pollId);
            this._pollId = 0;
        }

        if (this._rescanId) {
            GLib.Source.remove(this._rescanId);
            this._rescanId = 0;
        }

        if (this._nameSubId) {
            Gio.DBus.session.signal_unsubscribe(this._nameSubId);
            this._nameSubId = 0;
        }

        for (const entry of this._players.values())
            entry.proxy?.run_dispose?.();

        this._players.clear();
        this._active = null;
        this._onChange = null;
    }

    /**
     * @param {string} name 播放器名称（可带或不带 org.mpris.MediaPlayer2. 前缀）
     */
    setPreferred(name) {
        const value = (name ?? '').trim();
        if (value === this._preferred)
            return;

        this._preferred = value;
        this._updateActive();
        this._emit();
    }

    // --------------------------------------------------------------- 查询接口

    /** @returns {number} 当前播放位置（微秒） */
    getPosition() {
        const entry = this._active ? this._players.get(this._active) : null;
        return entry ? this._computePosition(entry) : 0;
    }

    // ------------------------------------------------------------- 播放器集合

    _listExisting() {
        try {
            Gio.DBus.session.call(
                'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
                'ListNames', null, null, Gio.DBusCallFlags.NONE, 1000, null,
                (connection, result) => {
                    if (this._destroyed)
                        return;
                    try {
                        const [names] = connection.call_finish(result).deep_unpack();
                        const found = (names ?? []).filter(name => name.startsWith(NAME_PREFIX));
                        // 只在集合变化时打日志，避免 10s 一次的扫描刷屏
                        const signature = found.join(',');
                        if (signature !== this._lastScanSignature) {
                            this._lastScanSignature = signature;
                            console.log(`TopBarLyrics: 总线扫描到 ${found.length} 个播放器` +
                                        (found.length ? ` (${signature})` : ''));
                        }
                        for (const name of found)
                            this._addPlayer(name);
                    } catch (error) {
                        logError(error, 'TopBarLyrics: 枚举播放器失败');
                    }
                });
        } catch (error) {
            logError(error, 'TopBarLyrics: 枚举播放器失败');
        }
    }

    /**
     * @param {string} name
     */
    _addPlayer(name) {
        if (this._players.has(name))
            return;

        console.log(`TopBarLyrics: 发现播放器 ${name}`);

        const entry = {
            name,
            proxy: null,
            identity: '',
            metadata: {},
            status: 'Stopped',
            basePosition: 0,
            baseTime: GLib.get_monotonic_time(),
            lastPlayingAt: 0,
        };
        this._players.set(name, entry);

        Gio.DBusProxy.new(
            Gio.DBus.session,
            Gio.DBusProxyFlags.GET_INVALIDATED_PROPERTIES | Gio.DBusProxyFlags.DO_NOT_AUTO_START,
            null, name, OBJECT_PATH, PLAYER_IFACE, null,
            (source, result) => {
                if (this._destroyed || !this._players.has(name))
                    return;

                let proxy;
                try {
                    proxy = Gio.DBusProxy.new_finish(result);
                } catch (error) {
                    console.log(`TopBarLyrics: 播放器代理创建失败 ${name}: ${error.message}`);
                    this._players.delete(name);
                    return;
                }

                entry.proxy = proxy;
                this._readInitialProperties(entry);
                this._fetchIdentity(entry);

                // 某些播放器（典型如 Chromium）的 GetAll 会返回空缓存，
                // 导致 status 停留在 Stopped、metadata 为空。这里显式再拉一次。
                const cached = proxy.get_cached_property_names() ?? [];
                if (cached.length === 0 || !entry.metadata['xesam:title'])
                    this._pullCoreProperties(entry);

                proxy.connect('g-properties-changed', (p, changed) => {
                    if (this._destroyed)
                        return;
                    this._onPropertiesChanged(entry, changed.deep_unpack());
                    this._updateActive();
                    this._emit();
                });

                proxy.connect('g-signal', (p, sender, signalName, params) => {
                    if (this._destroyed || signalName !== 'Seeked')
                        return;
                    const [position] = params.deep_unpack();
                    this._setPosition(entry, position);
                });

                this._updateActive();
                this._emit();
            });
    }

    /**
     * @param {string} name
     */
    _removePlayer(name) {
        const entry = this._players.get(name);
        if (!entry)
            return;

        entry.proxy?.run_dispose?.();
        this._players.delete(name);
        this._updateActive();
        this._emit();
    }

    /**
     * @param {object} entry
     */
    _readInitialProperties(entry) {
        const proxy = entry.proxy;
        const names = proxy.get_cached_property_names() ?? [];

        for (const property of names) {
            const value = proxy.get_cached_property(property);
            if (!value)
                continue;
            this._applyProperty(entry, property, unpackValue(value));
        }

        // 插件启动时就已经在播放的播放器，也要有“最新播放”时间戳
        if (entry.status === 'Playing')
            entry.lastPlayingAt = GLib.get_monotonic_time();

        this._setPosition(entry, Number(proxy.get_cached_property('Position')?.deep_unpack() ?? 0));
    }

    /**
     * 显式向播放器要 PlaybackStatus / Metadata。
     * 用于 getAll 缓存为空的播放器（Chromium 系常见），只发两次 Get，开销可忽略。
     * @param {object} entry
     */
    _pullCoreProperties(entry) {
        if (!entry?.proxy)
            return;

        for (const property of ['PlaybackStatus', 'Metadata']) {
            entry.proxy.call(
                'org.freedesktop.DBus.Properties.Get',
                new GLib.Variant('(ss)', [PLAYER_IFACE, property]),
                Gio.DBusCallFlags.NONE, 800, null,
                (proxy, result) => {
                    if (this._destroyed)
                        return;
                    try {
                        const [wrapped] = proxy.call_finish(result).deep_unpack();
                        this._applyProperty(entry, property, unpackValue(wrapped));
                        if (property === 'Metadata')
                            this._requestPosition(entry);
                        this._updateActive();
                        this._emit();
                    } catch (error) {
                        console.log(`TopBarLyrics: 读取 ${property} 失败 ${entry.name}: ${error.message}`);
                    }
                });
        }
    }

    /**
     * @param {object} entry
     */
    _fetchIdentity(entry) {
        entry.proxy.call(
            'org.freedesktop.DBus.Properties.Get',
            new GLib.Variant('(ss)', [ROOT_IFACE, 'Identity']),
            Gio.DBusCallFlags.NONE, 800, null,
            (proxy, result) => {
                if (this._destroyed)
                    return;
                try {
                    const [identity] = proxy.call_finish(result).deep_unpack();
                    entry.identity = String(unpackValue(identity) ?? '');
                    this._emit();
                } catch {
                    // 某些播放器没实现 Identity，忽略
                }
            });
    }

    /**
     * @param {object} entry
     * @param {object} changed 已经 deep_unpack 的属性字典
     */
    _onPropertiesChanged(entry, changed) {
        for (const [property, value] of Object.entries(changed ?? {}))
            this._applyProperty(entry, property, unpackValue(value));

        // 换歌或播放/暂停切换后，立刻向播放器要一次真实进度，
        // 避免本地插值在一秒内显示旧位置。
        if ('Metadata' in (changed ?? {}) || 'PlaybackStatus' in (changed ?? {}))
            this._requestPosition(entry);
    }

    /**
     * @param {object} entry
     * @param {string} property
     * @param {any} value
     */
    _applyProperty(entry, property, value) {
        switch (property) {
        case 'Metadata':
            entry.metadata = unpackDict(value);
            // 先归零，紧接着的 _requestPosition 会用播放器的真实进度覆盖
            this._setPosition(entry, 0);
            break;
        case 'PlaybackStatus': {
            // 用旧状态结算当前位置，暂停时才能准确停在原地
            const current = this._computePosition(entry);
            const wasPlaying = entry.status === 'Playing';
            entry.status = String(value ?? 'Stopped');
            if (!wasPlaying && entry.status === 'Playing')
                entry.lastPlayingAt = GLib.get_monotonic_time();
            this._setPosition(entry, current);
            break;
        }
        case 'Position':
            this._setPosition(entry, Number(value ?? 0));
            break;
        default:
            break;
        }
    }

    // ----------------------------------------------------------------- 进度

    /**
     * @param {object} entry
     * @param {number} position 微秒
     */
    _setPosition(entry, position) {
        entry.basePosition = Math.max(0, Number(position) || 0);
        entry.baseTime = GLib.get_monotonic_time();
    }

    /**
     * @param {object} entry
     * @returns {number} 微秒
     */
    _computePosition(entry) {
        if (entry.status !== 'Playing')
            return entry.basePosition;

        const elapsed = GLib.get_monotonic_time() - entry.baseTime;
        const position = entry.basePosition + Math.max(0, elapsed);
        const length = Number(entry.metadata['mpris:length'] ?? 0);

        return length > 0 ? Math.min(position, length) : position;
    }

    _pollPosition() {
        const entry = this._active ? this._players.get(this._active) : null;
        if (!entry?.proxy || entry.status !== 'Playing')
            return;

        this._requestPosition(entry);
    }

    /**
     * 主动向播放器要一次真实进度。
     * @param {object} entry
     */
    _requestPosition(entry) {
        if (!entry?.proxy || this._destroyed)
            return;

        entry.proxy.call(
            'org.freedesktop.DBus.Properties.Get',
            new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
            Gio.DBusCallFlags.NONE, 800, null,
            (proxy, result) => {
                if (this._destroyed)
                    return;
                try {
                    const [position] = proxy.call_finish(result).deep_unpack();
                    const reported = Number(position ?? 0);
                    // 只有明显漂移时才重新对表，避免把细腻的本地插值打断
                    if (Math.abs(reported - this._computePosition(entry)) > DRIFT_TOLERANCE_US)
                        this._setPosition(entry, reported);
                } catch {
                    // 播放器可能在请求期间退出
                }
            });
    }

    // ------------------------------------------------------------- 选择播放器

    /**
     * @param {object} entry
     * @returns {number}
     */
    _score(entry) {
        let score = 0;

        if (this._preferred) {
            const preferred = this._preferred.replace(/^org\.mpris\.MediaPlayer2\./, '');
            if (entry.name === `${NAME_PREFIX}${preferred}` || entry.name.endsWith(`.${preferred}`))
                score += 1000;
        }

        if (entry.status === 'Playing')
            score += 300;
        else if (entry.status === 'Paused')
            score += 60;

        const lower = entry.name.toLowerCase();
        const index = BUILTIN_ORDER.findIndex(key => lower.includes(key));
        if (index >= 0)
            score += 100 - index;

        if (entry.metadata['xesam:title'])
            score += 10;

        return score;
    }

    _updateActive() {
        // 多个播放器同时在播时，取“最新开始播放”的那一个
        let latestPlayingAt = 0;
        for (const entry of this._players.values()) {
            if (entry.status === 'Playing' && entry.lastPlayingAt > latestPlayingAt)
                latestPlayingAt = entry.lastPlayingAt;
        }

        let best = null;
        let bestScore = -Infinity;

        for (const entry of this._players.values()) {
            const score = this._score(entry) +
                (entry.status === 'Playing' && entry.lastPlayingAt === latestPlayingAt && latestPlayingAt > 0
                    ? 250 : 0);
            if (score > bestScore) {
                bestScore = score;
                best = entry;
            }
        }

        this._active = best?.name ?? null;
    }

    // ----------------------------------------------------------------- 通知

    _emit() {
        const entry = this._active ? this._players.get(this._active) : null;

        if (!entry) {
            if (this._lastKey !== 'none') {
                this._lastKey = 'none';
                this._onChange?.(null);
            }
            return;
        }

        const artist = entry.metadata['xesam:artist'];
        const state = {
            busName: entry.name,
            identity: entry.identity,
            title: String(entry.metadata['xesam:title'] ?? ''),
            artist: Array.isArray(artist) ? artist.join(', ') : String(artist ?? ''),
            album: String(entry.metadata['xesam:album'] ?? ''),
            length: Number(entry.metadata['mpris:length'] ?? 0),
            url: String(entry.metadata['xesam:url'] ?? ''),
            // mpris:trackid 是歌曲唯一 ID，用它判断切歌（同名曲目也能区分）
            trackid: String(entry.metadata['mpris:trackid'] ?? ''),
            status: entry.status,
        };

        const key = [state.busName, state.trackid, state.title, state.artist,
            state.album, state.length, state.status].join('|');
        if (key === this._lastKey)
            return;

        this._lastKey = key;
        console.log(`TopBarLyrics: 曲目 ${state.artist || '?'} - ${state.title || '?'} ` +
                    `[${state.status}] ${state.busName}`);
        this._onChange?.(state);
    }
}

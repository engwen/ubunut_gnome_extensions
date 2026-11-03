// SPDX-License-Identifier: GPL-2.0-or-later
//
// 统一日志。
// 目标：出任何问题都能凭日志定位，但日志本身绝不能拖垮插件。
//
// 特性：
//   - 落盘到 ~/.cache/topbar-lyrics/logs/topbar-lyrics-YYYY-MM-DD.log（按天分文件）
//   - 内存缓冲 + 定时批量写，避免每次 log 都做一次磁盘 IO
//   - 每天一个文件，超过 MAX_DAILY_BYTES 自动停止写入（防爆盘）
//   - 启动 + 每天检查一次，删除 RETENTION_DAYS 天之前的旧日志
//   - 所有磁盘操作都 try/catch，写日志失败也只会在控制台降级，绝不影响主流程
//   - warn/error 同时镜像到 console，方便 journalctl / 扩展调试面板查看
//
// 用法：
//   import {logger} from './logger.js';
//   logger.init();                       // 扩展 enable 时调用一次
//   logger.info('provider:embedded', '命中', {lines: 42});
//   logger.warn('provider:cache', '读取失败', error);
//   logger.destroy();                    // 扩展 disable 时调用

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const RETENTION_DAYS = 3;                 // 只保留最近 3 天
const MAX_DAILY_BYTES = 3 * 1024 * 1024;  // 单日单文件上限 3MB
const FLUSH_INTERVAL_MS = 1200;
const DAILY_CHECK_MS = 6 * 60 * 60 * 1000; // 每 6 小时检查一次是否跨天

export const LEVELS = Object.freeze({
    debug: 0,
    info: 1,
    warn: 2,
    error: 3,
});

const LEVEL_TAG = ['DEBUG', 'INFO', 'WARN', 'ERROR'];

/**
 * 把任意错误对象压成一行可读文本。
 * @param {any} error
 * @returns {string}
 */
function describeError(error) {
    if (error == null)
        return '';
    if (error instanceof Error)
        return `${error.message}${error.stack ? `\n${error.stack}` : ''}`;
    try {
        return typeof error === 'string' ? error : JSON.stringify(error);
    } catch {
        return String(error);
    }
}

/**
 * 把附加信息压成  key=value  形式。
 * @param {object|undefined} detail
 * @returns {string}
 */
function describeDetail(detail) {
    if (detail == null)
        return '';
    if (detail instanceof Error)
        return describeError(detail);
    try {
        return Object.entries(detail)
            .map(([k, v]) => `${k}=${v instanceof Error ? v.message : JSON.stringify(v)}`)
            .join(' ');
    } catch {
        return String(detail);
    }
}

class Logger {
    constructor() {
        this._buffer = [];
        this._timerId = 0;
        this._dailyId = 0;
        this._dirPath = GLib.build_filenamev([
            GLib.get_user_cache_dir(), 'topbar-lyrics', 'logs',
        ]);
        this._dirReady = false;
        this._minLevel = LEVELS.debug;
        this._cappedDay = null;   // 已触发大小上限的日期，避免反复写
        this._destroyed = false;
        this._currentDay = null;
    }

    // ------------------------------------------------------------- 生命周期

    /** @param {number} [level] LEVELS 之一，低于此级别的日志不落盘 */
    init(level = LEVELS.debug) {
        this._minLevel = level;
        this._destroyed = false;
        this._ensureDir();
        this.cleanup();

        if (!this._dailyId) {
            this._dailyId = GLib.timeout_add(
                GLib.PRIORITY_LOW, DAILY_CHECK_MS, () => {
                    this.flush();
                    this.cleanup();
                    return GLib.SOURCE_CONTINUE;
                });
        }

        this.info('logger', '日志已启动', {
            dir: this._dirPath,
            retentionDays: RETENTION_DAYS,
        });
    }

    destroy() {
        this.flush();
        this._destroyed = true;

        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        if (this._dailyId) {
            GLib.Source.remove(this._dailyId);
            this._dailyId = 0;
        }
    }

    // ----------------------------------------------------------------- 写入

    debug(scope, message, detail) {
        this._write(LEVELS.debug, scope, message, detail);
    }

    info(scope, message, detail) {
        this._write(LEVELS.info, scope, message, detail);
    }

    warn(scope, message, detail) {
        this._write(LEVELS.warn, scope, message, detail);
    }

    error(scope, message, detail) {
        this._write(LEVELS.error, scope, message, detail);
    }

    /**
     * @param {number} level
     * @param {string} scope
     * @param {string} message
     * @param {any} [detail]
     */
    _write(level, scope, message, detail) {
        if (this._destroyed || level < this._minLevel)
            return;

        const line = `${this._timestamp()} ${LEVEL_TAG[level]} ` +
                     `[${scope}] ${message}` +
                     (detail !== undefined ? ` :: ${describeDetail(detail)}` : '');

        this._buffer.push(line);

        // warn/error 立刻镜像到控制台，方便 journalctl 实时看
        try {
            if (level === LEVELS.error)
                console.error(line);
            else if (level === LEVELS.warn)
                console.warn(line);
        } catch {
            // console 不可用时忽略
        }

        this._scheduleFlush();
    }

    _timestamp() {
        try {
            return GLib.DateTime.new_now_local().format('%Y-%m-%dT%H:%M:%S');
        } catch {
            return new Date().toISOString();
        }
    }

    _today() {
        try {
            return GLib.DateTime.new_now_local().format('%Y-%m-%d');
        } catch {
            return new Date().toISOString().slice(0, 10);
        }
    }

    _scheduleFlush() {
        if (this._timerId || this._destroyed)
            return;

        this._timerId = GLib.timeout_add(
            GLib.PRIORITY_LOW, FLUSH_INTERVAL_MS, () => {
                this._timerId = 0;
                this.flush();
                return GLib.SOURCE_REMOVE;
            });
    }

    // ----------------------------------------------------------------- 落盘

    _ensureDir() {
        if (this._dirReady)
            return true;
        try {
            const dir = Gio.File.new_for_path(this._dirPath);
            if (!dir.query_exists(null))
                dir.make_directory_with_parents(null);
            this._dirReady = true;
        } catch {
            // 缓存目录不可写：只降级到控制台，不抛
        }
        return this._dirReady;
    }

    _logPathFor(day) {
        return GLib.build_filenamev([this._dirPath, `topbar-lyrics-${day}.log`]);
    }

    flush() {
        if (this._buffer.length === 0 || !this._ensureDir())
            return;

        const day = this._today();
        const lines = this._buffer.join('\n') + '\n';
        this._buffer = [];

        // 跨天时切文件，并顺手清理一次
        if (this._currentDay !== day) {
            this._currentDay = day;
            this._cappedDay = null;
            this.cleanup();
        }

        if (this._cappedDay === day)
            return;

        try {
            const file = Gio.File.new_for_path(this._logPathFor(day));

            // 超过单日上限就停写（仍然保留已有内容）。
            // 注意：文件首次写入前并不存在，query_info 会抛错，必须先判断存在性。
            let existing = 0;
            try {
                if (file.query_exists(null)) {
                    existing = file.query_info('standard::size',
                        Gio.FileQueryInfoFlags.NONE, null).get_size();
                }
            } catch {
                existing = 0;
            }

            if (existing + lines.length > MAX_DAILY_BYTES) {
                this._cappedDay = day;
                try {
                    console.warn(`TopBarLyrics: 当日日志已达 ${MAX_DAILY_BYTES} 字节，暂停写入`);
                } catch {}
                return;
            }

            const stream = file.append_to(
                Gio.FileCreateFlags.NONE, null);
            stream.write_bytes(new TextEncoder().encode(lines), null);
            stream.close(null);
        } catch {
            // 写不进去就算了，绝不影响插件
        }
    }

    // ----------------------------------------------------------------- 清理

    /**
     * 删除 RETENTION_DAYS 天之前的日志文件。
     * 文件名形如 topbar-lyrics-2026-11-03.log，按日期字符串比较即可。
     */
    cleanup() {
        if (!this._ensureDir())
            return;

        let cutoff;
        try {
            cutoff = GLib.DateTime.new_now_local()
                .add_days(-RETENTION_DAYS)
                .format('%Y-%m-%d');
        } catch {
            return;
        }

        let removed = 0;
        try {
            const dir = Gio.File.new_for_path(this._dirPath);
            const enumerator = dir.enumerate_children(
                'standard::name,standard::type',
                Gio.FileQueryInfoFlags.NONE, null);

            const victims = [];
            while (true) {
                const info = enumerator.next_file(null);
                if (!info)
                    break;
                const name = info.get_name();
                const match = /^topbar-lyrics-(\d{4}-\d{2}-\d{2})\.log(?:\.\d+)?$/.exec(name);
                if (match && match[1] < cutoff)
                    victims.push(name);
            }
            enumerator.close(null);

            for (const name of victims) {
                try {
                    dir.get_child(name).delete(null);
                    removed++;
                } catch {
                    // 单个删不掉不影响其它
                }
            }
        } catch {
            // 目录枚举失败忽略
        }

        if (removed > 0) {
            this.info('logger', `清理旧日志 ${removed} 个（保留 ${RETENTION_DAYS} 天）`, {
                cutoff,
            });
        }
    }
}

/** 全局单例 */
export const logger = new Logger();

// SPDX-License-Identifier: GPL-2.0-or-later
//
// 极简 HTTP 取文本模块。
// 首选 libsoup3（GNOME 桌面自带），若当前环境缺少 Soup-3.0 typelib，
// 自动退回用 curl 子进程，保证插件在任何 GNOME 桌面都能联网取歌词。

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

const USER_AGENT = 'TopBarLyrics/1.0 (GNOME Shell extension; +https://lrclib.net)';
const TIMEOUT_SECONDS = 5;

/** @type {any} undefined = 尚未探测，null = 不可用 */
let _soup;
let _session = null;

/**
 * 懒加载 libsoup。动态 import 失败不会影响插件加载。
 * @returns {Promise<any|null>}
 */
async function loadSoup() {
    if (_soup !== undefined)
        return _soup;

    _soup = null;
    try {
        const module = await import('gi://Soup?version=3.0');
        _soup = module.default;
    } catch (error) {
        console.warn(`TopBarLyrics: 无法加载 libsoup3（${error.message}），改用 curl`);
    }

    return _soup;
}

/**
 * @param {any} Soup
 * @param {string} url
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<string|null>} 404 时返回 null
 */
function soupGet(Soup, url, cancellable) {
    _session ??= new Soup.Session({
        timeout: TIMEOUT_SECONDS,
        idle_timeout: 15,
        user_agent: USER_AGENT,
    });

    return new Promise((resolve, reject) => {
        let message;
        try {
            message = new Soup.Message({
                method: 'GET',
                uri: GLib.Uri.parse(url, GLib.UriFlags.NONE),
            });
        } catch (error) {
            reject(error);
            return;
        }

        _session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, cancellable, (session, result) => {
            try {
                const bytes = session.send_and_read_finish(result);
                const status = message.get_status();
                if (status === 404) {
                    resolve(null);
                    return;
                }
                if (status !== 200) {
                    reject(new Error(`HTTP ${status} ${message.get_reason_phrase()}`));
                    return;
                }
                resolve(new TextDecoder().decode(bytes.get_data()));
            } catch (error) {
                reject(error);
            }
        });
    });
}

/**
 * @param {string} url
 * @param {Gio.Cancellable|null} cancellable
 * @returns {Promise<string|null>}
 */
function curlGet(url, cancellable) {
    return new Promise((resolve, reject) => {
        let process;
        try {
            process = Gio.Subprocess.new(
                ['curl', '-fsSL', '--max-time', String(TIMEOUT_SECONDS), '-A', USER_AGENT, url],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (error) {
            reject(error);
            return;
        }

        process.communicate_utf8_async(null, cancellable, (proc, result) => {
            try {
                const [, stdout] = proc.communicate_utf8_finish(result);
                // curl -f 在 404 时以非 0 退出，这里等同于“没找到”
                resolve(proc.get_successful() ? stdout : null);
            } catch (error) {
                reject(error);
            }
        });
    });
}

/**
 * GET 一个 URL 并返回文本。
 * @param {string} url
 * @param {Gio.Cancellable|null} [cancellable]
 * @returns {Promise<string|null>}
 */
export async function getText(url, cancellable = null) {
    const Soup = await loadSoup();
    return Soup ? soupGet(Soup, url, cancellable) : curlGet(url, cancellable);
}

/**
 * GET 一个 URL 并解析为 JSON。
 * @param {string} url
 * @param {Gio.Cancellable|null} [cancellable]
 * @returns {Promise<any|null>}
 */
export async function getJSON(url, cancellable = null) {
    const text = await getText(url, cancellable);
    if (!text)
        return null;

    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`JSON 解析失败：${error.message}`);
    }
}

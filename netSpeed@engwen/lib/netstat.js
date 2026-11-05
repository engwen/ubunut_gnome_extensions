// SPDX-License-Identifier: GPL-2.0-or-later
//
// 网速采集与换算。
//
// 数据来源：/proc/net/dev 里每块网卡的累计收发字节数。速率 = 两次采样的字节
// 差值 ÷ 两次采样之间真实流逝的秒数（用单调时钟，不用「设定的间隔」，否则
// 主循环被阻塞或休眠唤醒后算出来的速率会偏）。
//
// 为什么按「接口名」逐个做差、再求和，而不是只比较总量：
//   1. 网卡热插拔、VPN 新建时，新接口的累计值会让「总量」突增，产生巨大的假峰值；
//   2. 接口重连后计数器可能归零，总量差会变成负数。
// 逐接口做差可以同时规避这两种情况：只统计两次采样都存在且计数器未回退的接口。

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const PROC_NET_DEV = '/proc/net/dev';

// 回环永远不计入（它只是本机内部流量，不代表网络吞吐）。
const SKIP_EXACT = new Set(['lo']);

// 常见的虚拟 / 隧道接口前缀。这些要么是容器内部流量（docker/veth/br-/virbr），
// 要么会和物理网卡重复计数（VPN 的 tun0/wg0 与 wlan0 算的是同一份流量）。
const SKIP_PREFIXES = [
    'docker', 'veth', 'br-', 'virbr', 'vnet', 'vmnet', 'vboxnet',
    'tun', 'tap', 'utun', 'wg', 'zt', 'tailscale', 'lxc', 'lxd', 'podman',
    'cni', 'flannel', 'kube', 'dummy', 'ifb',
    'ipsec', 'nordlynx', 'mullvad',
];

/**
 * 判断某个网卡是否应当被排除在统计之外。
 *
 * @param {string} name 接口名，例如 eth0 / wlan0 / docker0
 * @returns {boolean}
 */
export function isSkippedInterface(name) {
    if (SKIP_EXACT.has(name))
        return true;
    return SKIP_PREFIXES.some(prefix => name.startsWith(prefix));
}

/**
 * 解析 /proc/net/dev 的文本内容。
 *
 * 格式（前两行是表头，每行 `接口名: 16 个计数`）：
 *   eth0: 1234567 890 0 0 0 0 0 0  7654321 678 0 0 0 0 0 0
 *   └ 第 1 个数是收字节，第 9 个数是发字节（中间夹着收方的包/错误/丢弃等计数）
 *
 * @param {string} text
 * @returns {Map<string, {rx: number, tx: number}>}
 */
export function parseNetDev(text) {
    const interfaces = new Map();

    for (const rawLine of String(text ?? '').split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('Inter-') || line.startsWith('face'))
            continue;

        const colon = line.indexOf(':');
        if (colon <= 0)
            continue;

        const name = line.slice(0, colon).trim();
        if (!name)
            continue;

        const fields = line.slice(colon + 1).trim().split(/\s+/);
        // 收字节 = fields[0]，发字节 = fields[8]；不足 9 个字段说明行不完整
        if (fields.length < 9)
            continue;

        const rx = Number.parseInt(fields[0], 10);
        const tx = Number.parseInt(fields[8], 10);
        if (!Number.isFinite(rx) || !Number.isFinite(tx))
            continue;

        interfaces.set(name, {rx, tx});
    }

    return interfaces;
}

/**
 * 读取并解码 /proc/net/dev。
 *
 * @returns {string}
 */
export function readNetDevText() {
    const [ok, bytes] = Gio.File.new_for_path(PROC_NET_DEV).load_contents(null);
    if (!ok || !bytes?.length)
        throw new Error(`无法读取 ${PROC_NET_DEV}`);
    return new TextDecoder().decode(bytes);
}

/**
 * 速率采样器：每次 sample() 返回距上次采样之间的平均收发速率（字节/秒）。
 */
export class SpeedMeter {
    /**
     * @param {object} [options]
     * @param {() => number} [options.now] 返回单调时钟微秒数，测试时可注入
     * @param {() => string} [options.read] 返回 /proc/net/dev 文本，测试时可注入
     */
    constructor({now = () => GLib.get_monotonic_time(), read = readNetDevText} = {}) {
        this._now = now;
        this._read = read;
        this._previous = null;
        this._previousAt = 0;
    }

    /** 丢弃基准，下次 sample() 只重新采样、不产出速率。 */
    reset() {
        this._previous = null;
        this._previousAt = 0;
    }

    /**
     * @param {string} [text] 可选的 /proc/net/dev 内容（测试用）
     * @returns {{rx: number, tx: number, seconds: number}|null} 首次采样返回 null
     */
    sample(text = null) {
        let counters;
        try {
            counters = parseNetDev(text ?? this._read());
        } catch {
            return null;
        }

        const nowAt = this._now();
        const previous = this._previous;
        const previousAt = this._previousAt;

        this._previous = counters;
        this._previousAt = nowAt;

        if (!previous)
            return null;

        const seconds = (nowAt - previousAt) / 1e6;
        if (!(seconds > 0.01))
            return null;

        let rx = 0;
        let tx = 0;

        for (const [name, current] of counters) {
            if (isSkippedInterface(name))
                continue;

            const before = previous.get(name);
            if (!before)
                continue; // 刚出现的接口：跳过本次，避免把它的历史累计值算成峰值

            // 计数器回退（接口重连 / 32 位溢出）时按 0 计，不产生负数
            rx += Math.max(0, current.rx - before.rx);
            tx += Math.max(0, current.tx - before.tx);
        }

        return {rx: rx / seconds, tx: tx / seconds, seconds};
    }
}

const KIB = 1024;

// 达到这个 K/s 值就切到 M/s。用 999 而不是 1024，是为了让 K/s 的显示宽度
// 有上界（最长就是 "999K/s"），顶栏宽度因此可以做固定的最小宽度，
// 数字在 0 ↔ 999 之间跳动时箭头不会左右飘。
export const SWITCH_K = 999;

// K/s 模式下的最长文案。顶栏按它的像素宽度给数值标签设 min-width。
export const WIDEST_VALUE = `${SWITCH_K}K/s`;

/**
 * 把字节/秒格式化为顶栏要显示的数字与单位。
 *
 * 规则（按需求）：不足 999K/s 显示 K/s，达到 999K/s 自动切换为 M/s。
 * 数字位数控制在 2–4 个字符，避免顶栏宽度频繁跳动：
 *   < 10   → 保留 1 位小数（0.4K/s、9.9K/s）
 *   >= 10  → 取整（57K/s、999K/s）
 *
 * @param {number} bytesPerSecond
 * @returns {{value: string, unit: string}}
 */
export function formatSpeed(bytesPerSecond) {
    const bps = Number.isFinite(bytesPerSecond) ? Math.max(0, bytesPerSecond) : 0;
    const kb = bps / KIB;

    if (kb < SWITCH_K) {
        // 998.6K/s 取整后是 999，正好落在「999K/s」这个上界上，不会溢出成四位数
        return {value: formatNumber(roundSpeed(kb)), unit: 'K/s'};
    }

    return {value: formatNumber(roundSpeed(kb / KIB)), unit: 'M/s'};
}

/**
 * @param {number} value
 * @returns {number}
 */
function roundSpeed(value) {
    return value < 10 ? Math.round(value * 10) / 10 : Math.round(value);
}

/**
 * @param {number} value
 * @returns {string}
 */
function formatNumber(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

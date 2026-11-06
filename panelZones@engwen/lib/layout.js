// SPDX-License-Identifier: GPL-2.0-or-later
//
// 纯逻辑层：决定"某个图标该进哪个区、区内排第几"。
//
// 这里不碰任何 Clutter/St 对象，只吃 {id} 列表和配置，吐出排序结果，
// 这样可以用 gjs 直接单测（顶栏 UI 没法在 shell 外跑）。
//
// 图标身份 = role 字符串（Main.panel.statusArea 的键）。之所以不用对象引用：
// appindicator 托盘图标每次更新都会被 destroy 再重建，引用会失效；role 是稳定的。

export const ZONES = ['left', 'middle', 'right'];

// 不该被拖走的图标：它们是 shell 的主控面板/锚点。
export const LOCKED_ROLES = new Set(['quickSettings', 'dateMenu', 'activities']);

/**
 * 配置项支持简单通配：`*` 匹配全部，`appindicator-*` 匹配前缀。
 *
 * @param {string} entry
 * @param {string} id
 * @returns {boolean}
 */
export function matchesEntry(entry, id) {
    if (!entry)
        return false;
    if (entry === '*')
        return true;
    if (entry.endsWith('*'))
        return id.startsWith(entry.slice(0, -1));
    return entry === id;
}

/**
 * 返回 id 在某个列表里的排序权重；没命中返回最大值（排到最后）。
 *
 * @param {string} id
 * @param {string[]} list
 * @returns {number}
 */
export function rankInList(id, list) {
    for (let i = 0; i < list.length; i++) {
        if (matchesEntry(list[i], id))
            return i;
    }
    return Number.MAX_SAFE_INTEGER;
}

/**
 * 分区归属。优先级：锁定项 → 左区 → 右区 → 其余全部进中区。
 * 中区是"弹性区"：没有配置过的图标（新装的扩展、新出现的托盘图标）都落这里。
 *
 * @param {string} id
 * @param {{left: string[], middle: string[], right: string[]}} config
 * @returns {'left'|'middle'|'right'}
 */
export function resolveZone(id, config) {
    if (LOCKED_ROLES.has(id))
        return 'right';

    const missing = Number.MAX_SAFE_INTEGER;
    if (rankInList(id, config.left ?? []) !== missing)
        return 'left';
    if (rankInList(id, config.right ?? []) !== missing)
        return 'right';
    return 'middle';
}

/**
 * 区内排序。
 *
 * 默认：配置里列出的按列表顺序在前，未列出的保持原有相对顺序排在后面。
 * `unrankedFirst`：未列出的排在最前（中区用这个）。中区是浮动区，按 Windows
 * 通知区域的习惯，没配置过的新图标应该出现在浮动区最左边，已有的整体右移。
 *
 * 两种情况都保持输入数组里的相对顺序（sort 是稳定的），所以"当前实际顺序"
 * 不会被兜底纠偏打乱。锁定项一律强制排到最末尾。
 *
 * @param {string[]} ids
 * @param {string[]} list
 * @param {string[]} [lockLast]
 * @param {{unrankedFirst?: boolean}} [options]
 * @returns {string[]}
 */
export function planZone(ids, list, lockLast = [], {unrankedFirst = false} = {}) {
    const missing = Number.MAX_SAFE_INTEGER;
    const isUnranked = id => rankInList(id, list) === missing;

    const sorted = ids.slice().sort((a, b) => {
        if (unrankedFirst && isUnranked(a) !== isUnranked(b))
            return isUnranked(a) ? -1 : 1;
        return rankInList(a, list) - rankInList(b, list);
    });

    const rest = sorted.filter(id => !lockLast.includes(id));
    const locked = sorted.filter(id => lockLast.includes(id));
    return [...rest, ...locked];
}

/**
 * 完整布局计划：输入按发现顺序排列的图标 id，输出三个区的有序 id 数组。
 *
 * 中区（浮动区）用 `unrankedFirst`：没配置过的新图标排在区内最左边。
 *
 * @param {Array<{id: string}>} items
 * @param {{left: string[], middle: string[], right: string[]}} config
 * @param {{locked?: string[]}} [options]
 * @returns {{left: string[], middle: string[], right: string[]}}
 */
export function planLayout(items, config, {locked = [...LOCKED_ROLES]} = {}) {
    const buckets = {left: [], middle: [], right: []};

    for (const item of items) {
        const zone = resolveZone(item.id, config);
        buckets[zone].push(item.id);
    }

    return {
        left: planZone(buckets.left, config.left ?? [], locked),
        middle: planZone(buckets.middle, config.middle ?? [], locked, {unrankedFirst: true}),
        right: planZone(buckets.right, config.right ?? [], locked),
    };
}

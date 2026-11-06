// SPDX-License-Identifier: GPL-2.0-or-later
//
// Panel Zones — 把顶栏右侧图标分成"最左 / 中间（弹性）/ 最右"三段，并支持拖拽换位。
//
// 结构：
//   Main.panel._rightBox
//        ├─ zone-left    （固定在最左，例如网速）
//        ├─ zone-middle  （弹性区：没配置过的图标都落这里）
//        └─ zone-right   （最右，例如 owlshot/天气/壁纸/输入法/系统菜单）
//
// 关键事实（GNOME 50 实测）：
//   1. 右侧图标都是 _rightBox 的子项，顺序 = 索引；换位就是摘出来再插进去。
//   2. 没有任何"记住顺序"的原生机制：每个扩展启动时自己调 addToStatusArea(role, btn, index, box)。
//      壁纸/蓝牙扩展不给 index（默认 0，插最前）；appindicator 每次更新都 destroy 再插到 index 1。
//      → 所以这里必须常驻纠偏，而不是排一次就完事。
//   3. 天气这类扩展绕开 addToStatusArea，直接 insert 到 _rightBox，statusArea 里没有它
//      → 没有 role，只能按"类名 + 同类序号"临时识别（orphan:*）。
//   4. 想让图标"不闪"，就不能先让它插进 _rightBox 再搬走——中间会画出一帧错误位置。
//      所以这里拦在插入那一刻：把 Panel._addToPanelBox 的 box 参数换成目标分区容器，
//      图标出生即在正确位置（详见 _installInsertHooks）。

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {LOCKED_ROLES, ZONES, planLayout, rankInList, resolveZone} from './lib/layout.js';

const SAFETY_POLL_SECONDS = 1;
const DRAG_OPACITY = 128;

/**
 * 去掉样式串里由我们接管的那几条声明（padding / -natural-hpadding /
 * -minimum-hpadding），其余原样保留。
 *
 * 为什么要剥：St 对内联样式里重复声明的处理很怪（只认其中一条），
 * 所以每次都得拿"干净的基准样式"重新拼一条，不能叠加。
 *
 * @param {string} style
 * @returns {string}
 */
function stripOwned(style) {
    if (!style)
        return '';

    return style
        .replace(/(^|;)\s*padding\s*:[^;]*;?/gi, '$1')
        .replace(/(^|;)\s*-natural-hpadding\s*:[^;]*;?/gi, '$1')
        .replace(/(^|;)\s*-minimum-hpadding\s*:[^;]*;?/gi, '$1')
        .replace(/;;+/g, ';')
        .replace(/^\s*;+\s*|\s*;+\s*$/g, '')
        .trim();
}

export default class PanelZonesExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._applying = false;
        this._idleId = 0;
        this._pollId = 0;
        this._dragging = null;
        this._overlay = null;
        this._zoneSignals = [];

        // 被我们接管的原始方法（disable 时要原样还回去）
        this._origAddToPanelBox = null;
        this._origInsertChild = null;
        this._origAddChild = null;

        // 无 role 的"野"图标（如天气）只能按对象记 id
        this._orphanIds = new WeakMap();
        this._orphanCounters = new Map();

        // 每个 id 上次落在区内的第几位。托盘图标（appindicator）每次更新都会
        // destroy 再重建，没有这份记忆的话每次重建都会跑到末尾，看起来就是乱跳。
        this._lastIndex = new Map();

        // 间距：我们改写了每个图标按钮的内联 padding，得记下原始值才能还原
        this._baseStyles = new WeakMap();
        this._appliedStyles = new WeakMap();
        this._styledButtons = new Set();

        this._buildZones();
        this._initLayoutIfNeeded();
        this._apply();

        this._installInsertHooks();
        this._watchRightBox();
        this._startSafetyPoll();

        this._settings.connectObject(
            'changed::zone-left', () => this._scheduleApply(),
            'changed::zone-middle', () => this._scheduleApply(),
            'changed::zone-right', () => this._scheduleApply(),
            'changed::gap-left', () => this._scheduleApply(),
            'changed::gap-middle', () => this._scheduleApply(),
            'changed::gap-right', () => this._scheduleApply(),
            'changed::layout-version', () => {
                this._initLayoutIfNeeded();
                this._scheduleApply();
            },
            'changed::edit-mode', () => {
                if (this._settings.get_boolean('edit-mode'))
                    this._enterEditMode();
                else
                    this._exitEditMode();
            },
            this);

        if (this._settings.get_boolean('edit-mode'))
            this._enterEditMode();
    }

    disable() {
        this._exitEditMode();
        this._stopSafetyPoll();
        this._disconnectRightBox();

        if (this._idleId) {
            GLib.source_remove(this._idleId);
            this._idleId = 0;
        }

        this._settings?.disconnectObject(this);
        this._settings = null;

        // 必须先还原拦截，否则 _destroyZones 把图标搬回 rightBox 时会被自己拦下来
        this._removeInsertHooks();
        this._restoreSpacing();
        this._destroyZones();
        this._orphanIds = null;
        this._orphanCounters = null;
        this._lastIndex = null;
    }

    // ------------------------------------------------------------ 分区容器

    _buildZones() {
        this._zones = {};

        for (const zone of ZONES) {
            this._zones[zone] = new St.BoxLayout({
                name: `panelzones-${zone}`,
                style_class: 'pz-zone',
                reactive: false,
            });
        }

        const rightBox = Main.panel._rightBox;
        let index = 0;
        for (const zone of ZONES)
            rightBox.insert_child_at_index(this._zones[zone], index++);
    }

    _destroyZones() {
        if (!this._zones)
            return;

        const rightBox = Main.panel._rightBox;
        const firstZone = this._zones[ZONES[0]];
        const base = Math.max(0, rightBox.get_children().indexOf(firstZone));

        // 把图标按当前顺序搬回 _rightBox，避免卸载后图标消失或乱序
        const ordered = [];
        for (const zone of ZONES)
            ordered.push(...this._zones[zone].get_children());

        let offset = 0;
        for (const actor of ordered) {
            actor.get_parent()?.remove_child(actor);
            rightBox.insert_child_at_index(actor, base + offset);
            offset++;
        }

        for (const zone of ZONES)
            this._zones[zone].destroy();

        this._zones = null;
    }

    /**
     * 套用三个区的图标间距。
     *
     * 压的是**图标自己的留白**，不是外层容器。
     *
     * 面板按钮（PanelMenu.ButtonBox）的宽度不由 CSS `padding` 决定，而是
     * `vfunc_get_preferred_width()` 里算的：
     *     内容宽度 + 2 × `_natHPadding`，而 `_natHPadding` 来自样式里的
     *     `-natural-hpadding`（默认 12px，配套 `-minimum-hpadding` 默认 6px）。
     * 所以只给外层 St_Bin 加 padding，等于把容器往两边撑开，图标本身还是
     * 松松垮垮；真正让图标紧凑的开关是按钮内联样式上的这两个属性——写进去
     * 会触发 style-changed，ButtonBox 立刻重算 `_natHPadding`。
     *
     * 相邻两个图标各出一半留白，合起来正好等于设置的间距：
     *   gap = 2 * floor(gap/2) + 余数（余数交给容器 spacing，奇数也精确）。
     *
     * 好处：主题（Yaru / Adwaita / 第三方）自带的 12px 留白会被我们的内联
     * 样式整体覆盖，结果可预期。
     */
    _applySpacing() {
        if (!this._zones || !this._settings)
            return;

        for (const zone of ZONES) {
            const gap = Math.max(0, this._settings.get_int(`gap-${zone}`));
            const half = Math.floor(gap / 2);
            const rest = gap - half * 2;
            const box = this._zones[zone];

            // 奇数间距的 1px 用容器 spacing 补，保证总量精确
            const boxStyle = rest > 0 ? `spacing: ${rest}px;` : '';
            if ((box.get_style() ?? '') !== boxStyle)
                box.set_style(boxStyle);

            for (const child of box.get_children())
                this._styleItem(child, half);
        }
    }

    /**
     * 收紧单个图标。
     *
     * 分区里的直接子项是包着按钮的那层 `St_Bin`（`statusArea[role].container`），
     * 真正决定宽度的是里面的 `panel-button`。能改内层就改内层——那才叫图标变
     * 紧凑；改不动（第三方扩展塞的自定义 actor、天气这类没有 ButtonBox 的）
     * 才退回给外层容器加 padding，至少保证间距仍可控。
     *
     * @param {Clutter.Actor} actor 分区容器的直接子项
     * @param {number} pad 单侧留白，像素
     */
    _styleItem(actor, pad) {
        if (!actor)
            return;

        const button = actor.get_first_child();
        // `_natHPadding` 是 ButtonBox 自己算宽度用的缓存值，有这个字段才说明
        // 内层留白由 `-natural-hpadding` 控制
        const inner = button && typeof button._natHPadding === 'number' ? button : null;

        if (inner) {
            this._writeStyle(inner,
                `-natural-hpadding: ${pad}px; -minimum-hpadding: ${pad}px;`);
            // 内层已经给出留白，外层再补就是双份
            this._writeStyle(actor, '');
            return;
        }

        this._writeStyle(actor, `padding: 0 ${pad}px;`);
    }

    /**
     * 把我们的声明写进 actor 的内联样式，同时记住原始值以便还原。
     *
     * 两条纪律：
     *   1. 别人改过这个 actor 的样式（当前值不是我们上次写的）→ 以它为新基准，
     *      不能把 appindicator 之类后写的东西覆盖掉。
     *   2. 每次都从剥离后的基准重新拼，绝不叠加（St 只认其中一条）。
     *
     * @param {Clutter.Actor} actor
     * @param {string} declarations 空串表示"只还原、不加声明"
     */
    _writeStyle(actor, declarations) {
        const current = actor.get_style() ?? '';

        if (!this._baseStyles.has(actor))
            this._baseStyles.set(actor, current);

        const last = this._appliedStyles.get(actor);
        if (last !== undefined && current !== last)
            this._baseStyles.set(actor, current);

        const base = stripOwned(this._baseStyles.get(actor) ?? '');
        const next = !declarations ? base
            : (base ? `${declarations} ${base}` : declarations);

        if (current !== next) {
            actor.set_style(next);
            this._appliedStyles.set(actor, next);

            // 必需：ButtonBox 在 style-changed 里只更新 `_natHPadding` 这个字段，
            // 并没有让自己的 preferred-size 缓存失效。于是"活着"的图标（网速这类
            // 每秒刷新标签的）会因为子节点重排而顺带重算，静态图标却一直沿用旧宽度
            // —— 表现就是"设了没反应"。手动排一次即可，实测立即生效。
            actor.queue_relayout();
        }

        this._styledButtons.add(actor);
    }

    /**
     * 还原所有被改过的内联样式（停用扩展时必须做，不然图标会带着我们的 padding 留下）。
     */
    _restoreSpacing() {
        for (const button of this._styledButtons ?? []) {
            try {
                button.set_style(this._baseStyles.get(button) ?? '');
            } catch {
                // 图标可能已经被销毁
            }
        }

        this._styledButtons = new Set();
        this._baseStyles = new WeakMap();
        this._appliedStyles = new WeakMap();
    }

    // ---------------------------------------------------------------- 身份

    /**
     * 找出某个容器对应的 role；找不到就是没注册的野图标。
     *
     * @param {Clutter.Actor} actor
     * @returns {string}
     */
    _idFor(actor) {
        for (const role in Main.panel.statusArea) {
            const indicator = Main.panel.statusArea[role];
            if (indicator && indicator.container === actor)
                return role;
        }

        let id = this._orphanIds?.get(actor);
        if (id)
            return id;

        const className = actor.constructor?.name ?? 'Unknown';
        const ordinal = (this._orphanCounters.get(className) ?? 0) + 1;
        this._orphanCounters.set(className, ordinal);
        id = `orphan:${className}#${ordinal}`;
        this._orphanIds.set(actor, id);
        return id;
    }

    _isZoneActor(actor) {
        return ZONES.some(zone => this._zones[zone] === actor);
    }

    /**
     * 收集当前所有图标。顺序很重要：先按三个区现有的视觉顺序收，
     * 再收还留在 _rightBox 里的"新来的"。区内排序会保持这个相对顺序
     * （sort 是稳定的），所以兜底纠偏不会打乱当前实际排列。
     *
     * @returns {Array<{actor: Clutter.Actor, id: string}>}
     */
    _collectItems() {
        const items = [];
        const seen = new Set();

        const push = actor => {
            if (seen.has(actor))
                return;
            seen.add(actor);
            items.push({actor, id: this._idFor(actor)});
        };

        for (const zone of ZONES) {
            for (const child of this._zones[zone].get_children())
                push(child);
        }

        for (const child of Main.panel._rightBox.get_children()) {
            if (this._isZoneActor(child))
                continue;
            push(child);
        }

        return items;
    }

    // ------------------------------------------------------------ 插入拦截

    /**
     * 拦在"图标被插进右侧面板"的那一刻，让它直接落在目标分区里。
     *
     * 为什么不能事后搬：`child-added` 之后统一交给 idle 处理，等它跑起来时
     * 这一帧已经画完了——图标先在 _rightBox 的错误位置露一帧，下一帧才跳到位，
     * 这就是肉眼看到的闪烁。落子即到位才是根治。
     *
     * 两个拦截点：
     *
     * 1. `Panel._addToPanelBox`（shell 唯一的注册入口，`addToStatusArea` 和内置
     *    indicator 的 `_updateBox` 都走它）。实测它的入参 `box` **只用于一次
     *    `box.insert_child_at_index`**，写 statusArea、destroy 回调、menu-set
     *    全部在 panel/indicator 上完成。所以把 box 换成目标分区容器即可，
     *    不需要复制它的任何记账逻辑，也就不会跟着 shell 版本漂移。
     *
     * 2. `_rightBox.insert_child_at_index` / `add_child`——给绕过 shell 直接插的
     *    扩展兜底（天气就是这一类，statusArea 里根本查不到它，没有 role）。
     */
    _installInsertHooks() {
        const panel = Main.panel;
        const rightBox = panel._rightBox;

        this._origAddToPanelBox = panel._addToPanelBox;
        panel._addToPanelBox = (role, indicator, position, box) => {
            // 只接管右侧；左/中区、以及分区还没建好时，原样放行
            if (!this._zones || box !== rightBox)
                return this._origAddToPanelBox.call(panel, role, indicator, position, box);

            const zone = resolveZone(role, this._config());
            const index = this._insertIndex(role, zone);
            const box2 = this._zones[zone];

            const result = this._origAddToPanelBox.call(panel, role, indicator, index, box2);

            // 这条路径不走 _moveItem，得当场记下位置；否则要等下一秒的轮询，
            // 期间这个图标若被重建（appindicator 常态）就会被当成"新图标"。
            // 整区重记而不是只记它自己：新图标插到 0 会把别人的索引整体推后，
            // 只记自己的话别人重建时会带着过期索引回到错的位置。
            this._rememberZone(zone);
            this._applySpacing();

            return result;
        };

        this._origInsertChild = rightBox.insert_child_at_index;
        rightBox.insert_child_at_index = (actor, index) => {
            if (this._redirectToZone(actor))
                return;
            this._origInsertChild.call(rightBox, actor, index);
        };

        this._origAddChild = rightBox.add_child;
        rightBox.add_child = actor => {
            if (this._redirectToZone(actor))
                return;
            this._origAddChild.call(rightBox, actor);
        };
    }

    /**
     * 还原被接管的三个方法。
     *
     * @param {object} target
     * @param {string} name
     * @param {Function|null} original
     */
    _removeMethod(target, name, original) {
        if (!original)
            return;

        try {
            delete target[name]; // 删掉自有属性，回到原型上的原方法
        } catch {
            // 某些 GObject wrapper 不允许删自有属性，下面直接赋回去
        }

        if (target[name] !== original)
            target[name] = original;
    }

    _removeInsertHooks() {
        const panel = Main.panel;
        if (!panel)
            return;

        this._removeMethod(panel, '_addToPanelBox', this._origAddToPanelBox);
        this._removeMethod(panel._rightBox, 'insert_child_at_index', this._origInsertChild);
        this._removeMethod(panel._rightBox, 'add_child', this._origAddChild);

        this._origAddToPanelBox = null;
        this._origInsertChild = null;
        this._origAddChild = null;
    }

    /**
     * 直接把 actor 塞进它该去的分区。
     *
     * @param {Clutter.Actor} actor
     * @returns {boolean} true 表示已经代为插入，调用方不要再走原路径
     */
    _redirectToZone(actor) {
        if (!this._zones || this._applying || this._isZoneActor(actor))
            return false;

        const id = this._idFor(actor);
        const zone = resolveZone(id, this._config());
        this._moveItem(actor, zone, this._insertIndex(id, zone));
        this._rememberZone(zone);
        this._applySpacing();
        return true;
    }

    /**
     * 算出 id 在某区里应该插到第几位。
     *
     * - 锁定项（快速设置、日期菜单）：永远垫底。
     * - 配置里有的：数一下"排在它前面的、已经在区里"的有几个。
     * - 之前出现过但配置里没有的：回到上次的位置。托盘图标（appindicator）每次
     *   更新都会 destroy 再重建，不记位置的话它每次都会跑到别处。
     * - 从没见过的新图标：按 Windows 通知区域的习惯，插到浮动区（中区）最左边，
     *   已有图标整体右移，最右侧的系统菜单不受影响。
     *
     * @param {string} id
     * @param {'left'|'middle'|'right'} zone
     * @returns {number}
     */
    _insertIndex(id, zone) {
        const box = this._zones[zone];
        const list = this._config()[zone] ?? [];
        const rank = rankInList(id, list);

        // 第一个锁定项之前的位置 = 可自由排列的范围末尾
        const unlockedLimit = () => {
            let limit = 0;
            for (const child of box.get_children()) {
                if (LOCKED_ROLES.has(this._idFor(child)))
                    break;
                limit++;
            }
            return limit;
        };

        if (rank === Number.MAX_SAFE_INTEGER) {
            if (LOCKED_ROLES.has(id))
                return box.get_n_children(); // 快速设置等永远垫底

            const remembered = this._lastIndex?.get(id);
            if (remembered !== undefined && remembered >= 0)
                return Math.max(0, Math.min(remembered, unlockedLimit()));

            // 全新图标：浮动区插到最左边（Windows 通知区域的行为）。
            // 锁定项恒在末尾，所以通常就是 0；唯有整个区都是锁定项时才退到 1。
            if (zone === 'middle') {
                const first = box.get_child_at_index(0);
                return first && LOCKED_ROLES.has(this._idFor(first)) ? 1 : 0;
            }

            return unlockedLimit();
        }

        let index = 0;
        for (const child of box.get_children()) {
            if (rankInList(this._idFor(child), list) < rank)
                index++;
        }
        return index;
    }

    // ---------------------------------------------------------------- 配置

    _config() {
        return {
            left: this._settings.get_strv('zone-left'),
            middle: this._settings.get_strv('zone-middle'),
            right: this._settings.get_strv('zone-right'),
        };
    }

    /**
     * 首次启用（layout-version = 0）时以"当前实际顺序"为基准接管，
     * 只把网速挪到最左区，其余保持原样——避免一装上就把面板打乱。
     */
    _initLayoutIfNeeded() {
        if (!this._settings || this._settings.get_int('layout-version') >= 1)
            return;

        const left = [];
        const right = [];

        for (const {id} of this._collectItems()) {
            if (LOCKED_ROLES.has(id))
                continue;
            if (id === 'netspeed')
                left.push(id);
            else
                right.push(id);
        }

        this._applying = true;
        this._settings.set_strv('zone-left', left);
        this._settings.set_strv('zone-middle', []);
        this._settings.set_strv('zone-right', right);
        this._settings.set_int('layout-version', 1);
        this._applying = false;
    }

    _persistFromPanel() {
        const lists = {left: [], middle: [], right: []};

        for (const zone of ZONES) {
            for (const actor of this._zones[zone].get_children()) {
                const id = this._idFor(actor);
                if (LOCKED_ROLES.has(id))
                    continue;
                lists[zone].push(id);
            }
        }

        this._settings.set_strv('zone-left', lists.left);
        this._settings.set_strv('zone-middle', lists.middle);
        this._settings.set_strv('zone-right', lists.right);
        this._settings.set_int('layout-version', 2); // 2 = 已手工调过
    }

    // ---------------------------------------------------------------- 应用

    /**
     * 兜底纠偏（正常路径由 _installInsertHooks 处理，这里只兜漏网的）。
     *
     * 优先级必须高于 Clutter 的重绘源 CLUTTER_PRIORITY_REDRAW（= 110），
     * 否则这一帧已经画完，搬动就成了"慢一拍"的闪烁。PRIORITY_HIGH_IDLE（= 100）
     * 会在下一次绘制之前跑完，所以即便走这里也不会有可见跳变。
     */
    _scheduleApply() {
        if (this._idleId)
            return;

        this._idleId = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this._idleId = 0;
            try {
                this._apply();
            } catch (error) {
                logError(error, 'panelZones: 应用布局失败');
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    _apply() {
        if (this._applying || this._dragging || !this._zones || !this._settings)
            return;

        this._applying = true;
        try {
            const items = this._collectItems();
            const plan = planLayout(items, this._config());
            const actors = new Map(items.map(item => [item.id, item.actor]));

            for (const zone of ZONES) {
                const box = this._zones[zone];

                plan[zone].forEach((id, index) => {
                    const actor = actors.get(id);
                    if (!actor)
                        return;

                    const parent = actor.get_parent();
                    const currentIndex = parent === box
                        ? box.get_children().indexOf(actor)
                        : -1;

                    if (currentIndex === index)
                        return;

                    parent?.remove_child(actor);
                    box.insert_child_at_index(actor, Math.min(index, box.get_n_children()));
                });
            }

            this._rememberPositions();
            this._applySpacing();
        } finally {
            this._applying = false;
        }
    }

    /**
     * 记下某个区里每个图标当前在第几位，供"重建后回到原位"使用。
     *
     * @param {'left'|'middle'|'right'} zone
     */
    _rememberZone(zone) {
        const box = this._zones?.[zone];
        if (!box)
            return;

        box.get_children().forEach((child, index) => {
            this._lastIndex.set(this._idFor(child), index);
        });
    }

    /**
     * 记下每个图标当前在各自区内第几位，供"重建后回到原位"使用。
     */
    _rememberPositions() {
        for (const zone of ZONES)
            this._rememberZone(zone);
    }

    _watchRightBox() {
        const rightBox = Main.panel._rightBox;

        // 正常插入已被 _installInsertHooks 就地接管，这里只兜"确实漏进 rightBox"
        // 的情况（例如别的扩展用 C 层接口直接 add child）。
        for (const signal of ['child-added', 'child-removed']) {
            try {
                const id = rightBox.connect(signal, () => this._scheduleApply());
                this._zoneSignals.push({target: rightBox, id});
            } catch (error) {
                // 老版本 Clutter 没有这个信号，靠安全轮询兜底
                log(`panelZones: 无法监听 ${signal}: ${error.message}`);
            }
        }
    }

    _disconnectRightBox() {
        for (const {target, id} of this._zoneSignals) {
            try {
                target.disconnect(id);
            } catch {
                // 目标已被销毁时忽略
            }
        }
        this._zoneSignals = [];
    }

    _startSafetyPoll() {
        this._pollId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, SAFETY_POLL_SECONDS, () => {
            // 有的扩展（如天气）会在运行时重插自己的图标，轮询确保最终一致
            try {
                if (!this._dragging)
                    this._apply();
            } catch (error) {
                logError(error, 'panelZones: 轮询纠偏失败');
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopSafetyPoll() {
        if (this._pollId) {
            GLib.source_remove(this._pollId);
            this._pollId = 0;
        }
    }

    // ------------------------------------------------------------ 编辑模式

    _enterEditMode() {
        if (this._overlay || !this._zones)
            return;

        const panelHeight = Math.max(Main.panel.height || 0, 32);
        const monitor = Main.layoutManager.primaryMonitor;
        const [panelX, panelY] = Main.panel.get_transformed_position();

        const overlay = new St.Widget({
            name: 'panelzones-overlay',
            style_class: 'pz-overlay',
            reactive: true,
        });
        overlay.set_position(panelX, panelY);
        overlay.set_size(monitor?.width ?? global.stage.width, panelHeight);

        Main.uiGroup.add_child(overlay);
        this._overlay = overlay;

        for (const zone of ZONES)
            this._zones[zone].add_style_class_name('pz-zone-editing');

        overlay.connect('button-press-event', (_actor, event) => this._onPress(event));
        overlay.connect('motion-event', (_actor, event) => this._onMotion(event));
        overlay.connect('button-release-event', (_actor, event) => this._onRelease(event));
    }

    _exitEditMode() {
        if (this._dragging) {
            this._dragging.actor.opacity = 255;
            this._dragging = null;
        }

        if (this._overlay) {
            this._overlay.destroy();
            this._overlay = null;
        }

        if (this._zones) {
            for (const zone of ZONES)
                this._zones[zone].remove_style_class_name('pz-zone-editing');
        }
    }

    /**
     * @param {Clutter.Event} event
     * @returns {boolean}
     */
    _onPress(event) {
        // 编辑态下右键直接退出，省得为了关掉它专门开一次设置窗口
        if (event.get_button() === 3 && this._settings) {
            this._settings.set_boolean('edit-mode', false);
            return true;
        }

        const [x, y] = event.get_coords();
        const hit = this._hitTest(x, y);

        if (!hit || LOCKED_ROLES.has(hit.id))
            return true;

        this._dragging = hit;
        hit.actor.opacity = DRAG_OPACITY;
        return true;
    }

    /**
     * @param {Clutter.Event} event
     * @returns {boolean}
     */
    _onMotion(event) {
        if (!this._dragging)
            return true;

        const [x] = event.get_coords();
        const slot = this._slotAt(x);
        if (slot)
            this._moveItem(this._dragging.actor, slot.zone, slot.index);

        return true;
    }

    /**
     * @param {Clutter.Event} event
     * @returns {boolean}
     */
    _onRelease(_event) {
        if (!this._dragging)
            return true;

        this._dragging.actor.opacity = 255;
        this._dragging = null;
        this._persistFromPanel();
        return true;
    }

    /**
     * 把某个图标插到 指定区 / 指定位置。
     *
     * @param {Clutter.Actor} actor
     * @param {'left'|'middle'|'right'} zone
     * @param {number} index
     */
    _moveItem(actor, zone, index) {
        const box = this._zones?.[zone];
        if (!box)
            return;

        // 已经在本区时，索引上限要减 1：摘出去之后子项数会少一个
        const sameParent = actor.get_parent() === box;
        const max = sameParent ? box.get_n_children() - 1 : box.get_n_children();
        const target = Math.max(0, Math.min(index, max));

        if (!sameParent || box.get_children().indexOf(actor) !== target) {
            actor.get_parent()?.remove_child(actor);
            box.insert_child_at_index(actor, target);
        }

        this._lastIndex?.set(this._idFor(actor), target);
    }

    /**
     * @param {number} x
     * @param {number} y
     * @returns {{actor: Clutter.Actor, id: string}|null}
     */
    _hitTest(x, y) {
        for (const item of this._collectItems()) {
            const [ax, ay] = item.actor.get_transformed_position();
            if (x >= ax && x <= ax + item.actor.width &&
                y >= ay && y <= ay + item.actor.height)
                return item;
        }
        return null;
    }

    /**
     * 指针 x 落在哪个"插入槽"。槽 = 每个区里每个子项的左边界 + 该区末尾，
     * 取"最后一个不超过指针位置"的槽，这样拖到两区交界处会落到后面的区（
     * 空区也能被命中，方便把图标拖进空的中区）。
     *
     * @param {number} x
     * @returns {{zone: string, index: number}|null}
     */
    _slotAt(x) {
        const slots = [];

        for (const zone of ZONES) {
            const box = this._zones[zone];
            const kids = box.get_children().filter(a => a !== this._dragging?.actor);

            if (kids.length === 0) {
                const [bx] = box.get_transformed_position();
                slots.push({zone, index: 0, x: bx});
                continue;
            }

            for (let i = 0; i < kids.length; i++) {
                const [cx] = kids[i].get_transformed_position();
                slots.push({
                    zone,
                    index: i,
                    x: i === 0 ? cx : cx + kids[i].width / 2,
                });
            }

            const last = kids[kids.length - 1];
            const [lx] = last.get_transformed_position();
            slots.push({zone, index: kids.length, x: lx + last.width});
        }

        if (slots.length === 0)
            return null;

        let best = slots[0];
        for (const slot of slots) {
            if (slot.x <= x + 4)
                best = slot;
        }
        return best;
    }
}

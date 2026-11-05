// SPDX-License-Identifier: GPL-2.0-or-later
//
// Net Speed — 在 GNOME 顶栏实时显示上下行网速。
//
// 结构：
//   SpeedMeter（读 /proc/net/dev，逐接口做差换算速率）
//        └─> formatSpeed（字节/秒 → K/s 或 M/s）
//              └─> PanelMenu.Button（↓ 下行  ↑ 上行，纯显示，不响应点击）
//
// 顶栏布局（间距都可配置，单位 px）：
//   ┌──────── pair ────────┐ ┌──────── pair ────────┐
//   │ ↓   12K/s            │ │ ↑   3.4K/s           │
//   │ arrow  value         │ │                      │
//   │      └ value 的 margin-left = 箭头与数字的间距
//   └──────────────────────┘ └──────────────────────┘
//     └ 第二个 pair 的 margin-left = 下载与上传的间距
// 合并模式下只保留第一对，箭头变成 ⇅，数值是下载 + 上传的合计。
//
// 注意：间距**不能**用 St.BoxLayout 的 spacing。它在 St 里不是真正的 GObject
// 属性，赋值只会挂一个 JS 变量、布局完全不变（实测：箭头宽 15、数值 x 偏移 15，
// 间隙始终是 0）。所以间距一律用 margin，St 会把它算进 preferred size。

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {SpeedMeter, formatSpeed, WIDEST_VALUE} from './lib/netstat.js';

const ROLE = 'netspeed';
const SECTIONS = ['left', 'center', 'right'];
const MIN_INTERVAL = 1;
const MAX_INTERVAL = 10;
const MAX_GROUP_GAP = 40;
const MAX_ARROW_GAP = 20;

// 位置守卫：扩展加载时别的扩展可能也在往顶栏插条目，把我们先挤开。
// 启动后的 30 秒内反复校准（别的扩展加载有快有慢），稳定后自动停。
const POSITION_GUARD_INTERVAL = 500; // ms
const POSITION_GUARD_TICKS = 60; // 约 30 秒

const ARROW_DOWN = '↓';
const ARROW_UP = '↑';
const ARROW_BOTH = '⇅';

export default class NetSpeedExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._meter = new SpeedMeter();
        this._timerId = 0;
        this._positionTimerId = 0;
        this._indicator = null;
        this._box = null;
        this._down = null;
        this._up = null;
        this._valueMinWidth = 0;
        this._speed = {rx: 0, tx: 0};

        // 先取一次基准值，否则第一次 tick 一定返回 null（白等一个周期）
        this._rebaseline();

        this._buildIndicator();
        this._restartTimer();

        this._settings.connectObject(
            'changed::refresh-interval', () => {
                this._rebaseline();
                this._restartTimer();
            },
            'changed::position', () => this._buildIndicator(),
            'changed::position-index', () => this._buildIndicator(),
            'changed::display-mode', () => this._applyLayout(),
            'changed::group-gap', () => this._applyLayout(),
            'changed::arrow-gap', () => this._applyLayout(),
            this);
    }

    disable() {
        this._removeTimer();
        this._stopPositionGuard();

        this._settings?.disconnectObject(this);
        this._settings = null;

        this._destroyIndicator();

        this._meter = null;
        this._speed = {rx: 0, tx: 0};
    }

    // ------------------------------------------------------------ 顶栏组件

    _buildIndicator() {
        this._destroyIndicator();

        // 第三个参数 true：不创建菜单，配合 reactive = false 让它彻底不响应点击
        const button = new PanelMenu.Button(0.0, this.metadata.name, true);
        button.add_style_class_name('netspeed-button');
        button.reactive = false;
        button.can_focus = false;

        this._box = new St.BoxLayout({
            style_class: 'netspeed-box',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });

        this._down = this._createPair(ARROW_DOWN);
        this._up = this._createPair(ARROW_UP);
        this._box.add_child(this._down.pair);
        this._box.add_child(this._up.pair);

        button.add_child(this._box);

        const section = this._section();
        Main.panel.addToStatusArea(ROLE, button, this._clampIndex(section), section);

        this._indicator = button;

        // 数值宽度必须先量再上样式：一旦 label 带了 inline 的 margin/min-width，
        // get_preferred_width() 会把它们一起算进去，每调一次就宽一点点。
        this._valueMinWidth = this._measureValueWidth();

        // 切位置会重建组件，先按当前设置贴回间距和数值，避免闪一下占位符
        this._applyLayout();
        this._startPositionGuard();
    }

    /**
     * 一组「箭头 + 数值」。
     *
     * @param {string} arrowText
     * @returns {{pair: St.BoxLayout, arrow: St.Label, value: St.Label}}
     */
    _createPair(arrowText) {
        const pair = new St.BoxLayout({
            style_class: 'netspeed-pair',
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });

        const arrow = new St.Label({
            style_class: 'netspeed-label netspeed-arrow',
            text: arrowText,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });

        const value = new St.Label({
            style_class: 'netspeed-label netspeed-value',
            text: '0K/s',
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.CENTER,
        });

        pair.add_child(arrow);
        pair.add_child(value);

        return {pair, arrow, value};
    }

    _destroyIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._box = null;
        this._down = null;
        this._up = null;
        this._valueMinWidth = 0;
    }

    // ------------------------------------------------------------ 位置

    /**
     * @returns {string} 已校验的区域名
     */
    _section() {
        const value = this._settings.get_string('position');
        return SECTIONS.includes(value) ? value : 'right';
    }

    /**
     * @param {string} section
     * @returns {St.BoxLayout|null}
     */
    _sectionBox(section) {
        const boxes = {
            left: Main.panel._leftBox,
            center: Main.panel._centerBox,
            right: Main.panel._rightBox,
        };
        return boxes[section] ?? null;
    }

    /**
     * 把设置里的排序值夹到该区域现有子项数量范围内，超出会插到末尾。
     *
     * @param {string} section
     * @returns {number}
     */
    _clampIndex(section) {
        const requested = Math.max(0, this._settings.get_int('position-index'));
        const container = this._sectionBox(section);
        if (!container)
            return requested;

        return Math.min(requested, container.get_n_children());
    }

    _startPositionGuard() {
        this._stopPositionGuard();

        let ticks = 0;
        this._positionTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT,
            POSITION_GUARD_INTERVAL, () => {
                if (!this._indicator) {
                    this._positionTimerId = 0;
                    return GLib.SOURCE_REMOVE;
                }

                this._reassertPosition();

                if (++ticks >= POSITION_GUARD_TICKS) {
                    this._positionTimerId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            });
    }

    _stopPositionGuard() {
        if (this._positionTimerId > 0) {
            GLib.source_remove(this._positionTimerId);
            this._positionTimerId = 0;
        }
    }

    /**
     * 把条目挪回设置里的位置。
     *
     * 加载时别的扩展可能在我们之后往同一个区域插入，把我们挤到后面去，
     * 所以启动后的一段时间反复校准。只在「还在同一个区域」时动手，
     * 避免把用户/其他扩展有意挪到别处的条目硬搬回来。
     */
    _reassertPosition() {
        const holder = this._indicator?.container ?? this._indicator;
        if (!holder)
            return;

        const parent = holder.get_parent();
        const container = this._sectionBox(this._section());
        if (!parent || !container || parent !== container)
            return;

        const wanted = Math.min(
            Math.max(0, this._settings.get_int('position-index')),
            Math.max(0, container.get_n_children() - 1));

        if (container.get_children().indexOf(holder) !== wanted)
            container.set_child_at_index(holder, wanted);
    }

    // ---------------------------------------------------------------- 布局

    _isCombined() {
        return this._settings.get_string('display-mode') === 'combined';
    }

    _applyLayout() {
        if (!this._box || !this._down || !this._up)
            return;

        const groupGap = clamp(this._settings.get_int('group-gap'), 0, MAX_GROUP_GAP);
        const arrowGap = clamp(this._settings.get_int('arrow-gap'), 0, MAX_ARROW_GAP);
        const combined = this._isCombined();

        // 数值宽度按「999K/s」定死（K/s 的最大显示值），这样数字在 0K/s ↔ 999K/s
        // 之间跳动时宽度不变，两边的箭头不会跟着左右飘。
        const valueWidth = this._valueMinWidth || 0;
        const valueStyle = `margin-left: ${arrowGap}px; min-width: ${valueWidth}px;`;

        this._down.value.set_style(valueStyle);
        this._up.value.set_style(valueStyle);

        // 组间距：第二组整体左移一个 margin（合并模式下这组是隐藏的，无所谓）
        this._up.pair.set_style(`margin-left: ${groupGap}px;`);

        this._down.arrow.set_text(combined ? ARROW_BOTH : ARROW_DOWN);
        this._down.pair.visible = true;
        this._up.pair.visible = !combined;

        this._render();
    }

    /**
     * 量出「最宽的数值」在当前字体下的像素宽度。
     *
     * 只在建组件时调用一次（此时 label 还没有 inline 样式）。带着 margin /
     * min-width 量会把它们算进返回值，越量越宽——所以量之前也先把样式清掉。
     *
     * @returns {number}
     */
    _measureValueWidth() {
        const label = this._down?.value;
        if (!label)
            return 0;

        const savedText = label.text;
        label.set_style('');
        label.set_text(WIDEST_VALUE);
        const [, natural] = label.get_preferred_width(-1);
        label.set_text(savedText);

        return Math.ceil(natural);
    }

    // ---------------------------------------------------------------- 采样

    _rebaseline() {
        if (!this._meter)
            return;

        this._meter.reset();
        try {
            this._meter.sample();
        } catch (error) {
            logError(error, 'netSpeed: 初始化采样失败');
        }
    }

    _restartTimer() {
        this._removeTimer();

        if (!this._settings)
            return;

        const seconds = Math.min(MAX_INTERVAL,
            Math.max(MIN_INTERVAL, this._settings.get_int('refresh-interval')));

        this._timerId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, seconds, () => {
            try {
                this._tick();
            } catch (error) {
                // 单次采样失败不应让插件挂掉，也不该让定时器停摆
                logError(error, 'netSpeed: 刷新失败');
            }
            return GLib.SOURCE_CONTINUE;
        });
    }

    _removeTimer() {
        if (this._timerId > 0) {
            GLib.source_remove(this._timerId);
            this._timerId = 0;
        }
    }

    _tick() {
        const speed = this._meter?.sample();
        if (!speed)
            return;

        this._speed = speed;
        this._render();
    }

    _render() {
        if (!this._down || !this._up)
            return;

        if (this._isCombined()) {
            // 合并显示：一个数字就是下载 + 上传的合计
            this._down.value.set_text(textOf(formatSpeed(this._speed.rx + this._speed.tx)));
            return;
        }

        this._down.value.set_text(textOf(formatSpeed(this._speed.rx)));
        this._up.value.set_text(textOf(formatSpeed(this._speed.tx)));
    }
}

/**
 * @param {{value: string, unit: string}} speed
 * @returns {string}
 */
function textOf(speed) {
    return `${speed.value}${speed.unit}`;
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
    if (!Number.isFinite(value))
        return min;
    return Math.min(max, Math.max(min, Math.round(value)));
}

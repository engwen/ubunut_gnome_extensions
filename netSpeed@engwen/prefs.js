// SPDX-License-Identifier: GPL-2.0-or-later
//
// 首选项：刷新间隔、顶栏区域与排序。

import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const SECTIONS = ['left', 'center', 'right'];
const SECTION_LABELS = ['左侧', '中间', '右侧'];

const MODES = ['split', 'combined'];
const MODE_LABELS = ['分开显示（↓ ↑）', '合并显示（⇅）'];

/**
 * 绑定一个整数设置到 Adw.SpinRow（双向同步）。
 *
 * @param {Adw.PreferencesGroup} group
 * @param {Gio.Settings} settings
 * @param {string} key
 * @param {{title: string, subtitle?: string, min: number, max: number}} options
 */
function addSpinRow(group, settings, key, {title, subtitle, min, max}) {
    const adjustment = new Gtk.Adjustment({
        lower: min,
        upper: max,
        step_increment: 1,
        page_increment: 5,
        value: settings.get_int(key),
    });

    const row = new Adw.SpinRow({title, subtitle, adjustment, digits: 0});

    row.connect('notify::value', () => {
        const value = Math.round(row.value);
        if (settings.get_int(key) !== value)
            settings.set_int(key, value);
    });

    settings.connect(`changed::${key}`, () => {
        const value = settings.get_int(key);
        if (Math.round(row.value) !== value)
            row.value = value;
    });

    group.add(row);
    return row;
}

export default class NetSpeedPreferences extends ExtensionPreferences {
    /**
     * @param {Adw.PreferencesWindow} window
     */
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: '网速',
            icon_name: 'network-transmit-receive-symbolic',
        });
        window.add(page);

        // ------------------------------------------------------------ 刷新
        const refresh = new Adw.PreferencesGroup({
            title: '刷新',
            description: '两次采样的间隔。间隔越短越灵敏，顶栏数字也越活跃。',
        });
        page.add(refresh);

        addSpinRow(refresh, settings, 'refresh-interval', {
            title: '刷新间隔',
            subtitle: '秒，1 – 10，默认 2',
            min: 1,
            max: 10,
        });

        // -------------------------------------------------------- 显示方式
        const display = new Adw.PreferencesGroup({
            title: '显示方式',
            description: '分开显示能同时看上下行；合并显示只占一个数字的位置。',
        });
        page.add(display);

        const modeRow = new Adw.ComboRow({
            title: '显示方式',
            subtitle: '两组数值 / 一个合计数值',
            model: Gtk.StringList.new(MODE_LABELS),
        });
        modeRow.selected = Math.max(0, MODES.indexOf(settings.get_string('display-mode')));
        modeRow.connect('notify::selected', () => {
            const value = MODES[modeRow.selected] ?? 'split';
            if (settings.get_string('display-mode') !== value)
                settings.set_string('display-mode', value);
        });
        settings.connect('changed::display-mode', () => {
            const index = Math.max(0, MODES.indexOf(settings.get_string('display-mode')));
            if (modeRow.selected !== index)
                modeRow.selected = index;
        });
        display.add(modeRow);

        const gaps = new Adw.PreferencesGroup({
            title: '间距',
            description: '单位像素，改完立刻反映到顶栏。',
        });
        page.add(gaps);

        addSpinRow(gaps, settings, 'arrow-gap', {
            title: '箭头与数字的间距',
            subtitle: '0 – 20 像素，默认 6',
            min: 0,
            max: 20,
        });

        addSpinRow(gaps, settings, 'group-gap', {
            title: '下载与上传的间距',
            subtitle: '0 – 40 像素，默认 10；合并显示时无效',
            min: 0,
            max: 40,
        });

        // ------------------------------------------------------------ 位置
        const placement = new Adw.PreferencesGroup({
            title: '顶栏位置',
            description: '默认在右侧区域的第一个位置。',
        });
        page.add(placement);

        const sectionRow = new Adw.ComboRow({
            title: '区域',
            subtitle: '左侧 / 中间 / 右侧',
            model: Gtk.StringList.new(SECTION_LABELS),
        });
        sectionRow.selected = Math.max(0, SECTIONS.indexOf(settings.get_string('position')));
        sectionRow.connect('notify::selected', () => {
            const value = SECTIONS[sectionRow.selected] ?? 'right';
            if (settings.get_string('position') !== value)
                settings.set_string('position', value);
        });
        settings.connect('changed::position', () => {
            const index = Math.max(0, SECTIONS.indexOf(settings.get_string('position')));
            if (sectionRow.selected !== index)
                sectionRow.selected = index;
        });
        placement.add(sectionRow);

        addSpinRow(placement, settings, 'position-index', {
            title: '排列位置',
            subtitle: '0 = 该区域最前面，1 = 第二个，依此类推',
            min: 0,
            max: 20,
        });

        // ------------------------------------------------------------ 说明
        const about = new Adw.PreferencesGroup({title: '说明'});
        page.add(about);

        about.add(new Adw.ActionRow({
            title: '合并显示',
            subtitle: '⇅ 后面的数字是下载 + 上传的总和，换算规则与分开显示一致。',
            activatable: false,
        }));

        about.add(new Adw.ActionRow({
            title: '单位切换',
            subtitle: '低于 999K/s 显示 K/s，达到 999K/s 自动变成 M/s（1K = 1024 字节）。',
            activatable: false,
        }));

        about.add(new Adw.ActionRow({
            title: '数值宽度',
            subtitle: '数值区域按「999K/s」的宽度固定，网速跳动时箭头不会左右飘。',
            activatable: false,
        }));

        about.add(new Adw.ActionRow({
            title: '统计范围',
            subtitle: '所有物理网卡收发的总和；已排除 lo 与 docker、veth、tun、wg 等虚拟接口，避免重复计数。',
            activatable: false,
        }));
    }
}

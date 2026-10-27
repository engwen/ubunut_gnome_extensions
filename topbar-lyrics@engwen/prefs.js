// SPDX-License-Identifier: GPL-2.0-or-later
//
// 首选项窗口：位置/排序、面板长度、卡拉 OK 效果、歌词来源。

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {LyricsService} from './lib/lyricsService.js';

const POSITIONS = ['left', 'center', 'right'];
const POSITION_LABELS = ['左侧', '中间', '右侧'];
const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';

/**
 * @param {string} text
 * @returns {string}
 */
function escapeMarkup(text) {
    return String(text)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;');
}

/**
 * 绑定一个整数设置到 Adw.SpinRow。
 */
function addSpinRow(group, settings, key, {title, subtitle, min, max, step}) {
    const adjustment = new Gtk.Adjustment({
        lower: min,
        upper: max,
        step_increment: step,
        page_increment: step * 5,
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

/**
 * Gdk.RGBA → '#rrggbb'。
 * Gtk 颜色选择器的 to_string() 产出 rgb()/rgba() 格式，Pango markup 的
 * foreground 不认这种格式，会把整条标签渲染成空白，所以统一存十六进制。
 * @param {Gdk.RGBA} rgba
 * @returns {string}
 */
function rgbaToHex(rgba) {
    const byte = v =>
        Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
    return `#${byte(rgba.red)}${byte(rgba.green)}${byte(rgba.blue)}`;
}

/**
 * 颜色选择行。
 */
function addColorRow(group, settings, key, title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle});

    const dialog = new Gtk.ColorDialog({with_alpha: false, title});
    const button = new Gtk.ColorDialogButton({dialog, valign: Gtk.Align.CENTER});

    const initial = new Gdk.RGBA();
    initial.parse(settings.get_string(key));
    button.set_rgba(initial);

    button.connect('notify::rgba', () => {
        const value = rgbaToHex(button.get_rgba());
        if (settings.get_string(key) !== value)
            settings.set_string(key, value);
    });

    settings.connect(`changed::${key}`, () => {
        const value = new Gdk.RGBA();
        value.parse(settings.get_string(key));
        if (!button.get_rgba().equal(value))
            button.set_rgba(value);
    });

    row.add_suffix(button);
    row.activatable_widget = button;
    group.add(row);
    return row;
}

/**
 * 列出当前正在运行的 MPRIS 播放器（去掉前缀）。
 * @returns {string[]}
 */
function listPlayers() {
    try {
        const reply = Gio.DBus.session.call_sync(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListNames', null, null, Gio.DBusCallFlags.NONE, 1000, null);

        const [names] = reply.deep_unpack();
        return (names ?? [])
            .filter(name => name.startsWith(MPRIS_PREFIX))
            .map(name => name.slice(MPRIS_PREFIX.length))
            .sort();
    } catch {
        return [];
    }
}

/**
 * 带卡拉 OK 动画的效果预览。
 * @returns {{box: Gtk.Widget, stop: () => void}}
 */
function buildPreview(settings) {
    const box = new Gtk.Box({
        css_classes: ['card'],
        height_request: 60,
        margin_top: 6,
        margin_bottom: 6,
    });

    const label = new Gtk.Label({
        hexpand: true,
        halign: Gtk.Align.CENTER,
        valign: Gtk.Align.CENTER,
        css_classes: ['title-3'],
    });
    box.append(label);

    const text = '歌词会随播放进度从蓝色变成绿色';
    const cycle = 6.0;
    const started = GLib.get_monotonic_time();

    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 60, () => {
        const elapsed = (GLib.get_monotonic_time() - started) / 1e6;
        const progress = Math.min(1, (elapsed % cycle) / (cycle - 1.2));

        // 兼容历史数据：设置里可能存过 rgb()/rgba() 格式，markup 里必须先转 hex
        const toHex = value => {
            const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(String(value));
            if (!m)
                return String(value ?? '#4aa3ff');
            const byte = v => Math.max(0, Math.min(255, Number(v))).toString(16).padStart(2, '0');
            return `#${byte(m[1])}${byte(m[2])}${byte(m[3])}`;
        };
        const inactive = toHex(settings.get_string('color-inactive'));
        const active = toHex(settings.get_string('color-active'));
        const fontSize = settings.get_int('font-size');
        const chars = settings.get_boolean('karaoke')
            ? Math.round(progress * text.length)
            : 0;

        const body = chars > 0
            ? `<span foreground="${active}">${escapeMarkup(text.slice(0, chars))}</span>` +
              `<span foreground="${inactive}">${escapeMarkup(text.slice(chars))}</span>`
            : `<span foreground="${inactive}">${escapeMarkup(text)}</span>`;

        // font_size 单位是 1/1000 磅，px 转磅约 * 0.75
        label.set_markup(`<span font_size="${Math.round(fontSize * 750)}">${body}</span>`);
        return GLib.SOURCE_CONTINUE;
    });

    return {
        box,
        stop: () => {
            if (id)
                GLib.Source.remove(id);
        },
    };
}

export default class TopBarLyricsPreferences extends ExtensionPreferences {
    /**
     * @param {Adw.PreferencesWindow} window
     */
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: '歌词',
            icon_name: 'preferences-desktop-font-symbolic',
        });
        window.add(page);

        // ------------------------------------------------------ 位置与排序
        const placement = new Adw.PreferencesGroup({
            title: '位置与排序',
            description: '决定歌词出现在顶栏的哪个区域，以及在同一区域内排第几位。',
        });
        page.add(placement);

        const positionRow = new Adw.ComboRow({
            title: '显示位置',
            subtitle: '左侧 / 中间 / 右侧',
            model: Gtk.StringList.new(POSITION_LABELS),
        });
        const currentPosition = Math.max(0, POSITIONS.indexOf(settings.get_string('position')));
        positionRow.selected = currentPosition;
        positionRow.connect('notify::selected', () => {
            const value = POSITIONS[positionRow.selected] ?? POSITIONS[0];
            if (settings.get_string('position') !== value)
                settings.set_string('position', value);
        });
        settings.connect('changed::position', () => {
            const index = Math.max(0, POSITIONS.indexOf(settings.get_string('position')));
            if (positionRow.selected !== index)
                positionRow.selected = index;
        });
        placement.add(positionRow);

        addSpinRow(placement, settings, 'position-index', {
            title: '显示顺序',
            subtitle: '0 表示排在该区域最前面',
            min: 0,
            max: 30,
            step: 1,
        });

        // ------------------------------------------------------------- 尺寸
        const sizing = new Adw.PreferencesGroup({
            title: '面板长度',
            description: '固定显示区域的宽度；歌词超出后自动滚动。',
        });
        page.add(sizing);

        addSpinRow(sizing, settings, 'panel-width', {
            title: '面板长度',
            subtitle: '像素，80 – 800',
            min: 80,
            max: 800,
            step: 10,
        });

        addSpinRow(sizing, settings, 'font-size', {
            title: '字号',
            subtitle: '像素，8 – 24',
            min: 8,
            max: 24,
            step: 1,
        });

        const hideRow = new Adw.SwitchRow({
            title: '无播放时隐藏',
            subtitle: '没有播放器时让顶栏保持干净',
        });
        settings.bind('hide-when-idle', hideRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        sizing.add(hideRow);

        // --------------------------------------------------------- 卡拉 OK
        const karaoke = new Adw.PreferencesGroup({
            title: '卡拉 OK',
            description: '开启后，当前行会从底色逐渐变为高亮色。',
        });
        page.add(karaoke);

        const karaokeRow = new Adw.SwitchRow({title: '启用卡拉 OK 模式'});
        settings.bind('karaoke', karaokeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        karaoke.add(karaokeRow);

        const preview = buildPreview(settings);
        karaoke.add(preview.box);

        window.connect('close-request', () => {
            preview.stop();
            return false;
        });

        addColorRow(karaoke, settings, 'color-inactive', '未唱到的颜色', '默认蓝色');
        addColorRow(karaoke, settings, 'color-active', '已唱到的颜色', '默认绿色');

        addSpinRow(karaoke, settings, 'lyrics-offset', {
            title: '歌词偏移（毫秒）',
            subtitle: '正数让歌词提前，负数让歌词延后',
            min: -20000,
            max: 20000,
            step: 100,
        });

        // ------------------------------------------------------------- 滚动
        const scrolling = new Adw.PreferencesGroup({
            title: '滚动',
            description: '卡拉 OK 模式下会跟随高亮自动滚动，其余情况按此处的速度匀速滚动。',
        });
        page.add(scrolling);

        const marqueeRow = new Adw.SwitchRow({
            title: '超长自动滚动',
            subtitle: '关闭后超长歌词只显示省略号',
        });
        settings.bind('marquee', marqueeRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        scrolling.add(marqueeRow);

        addSpinRow(scrolling, settings, 'marquee-speed', {
            title: '滚动速度',
            subtitle: '像素 / 秒，10 – 200',
            min: 10,
            max: 200,
            step: 5,
        });

        // --------------------------------------------------------- 歌词来源
        const source = new Adw.PreferencesGroup({
            title: '歌词来源',
            description: '按顺序查找：内嵌歌词 → 歌词文件夹 → 缓存 → mp3 同目录 → LRCLIB 联网兜底。',
        });
        page.add(source);

        // ---- 用户歌词目录（同名 .lrc 的第一优先目录）----
        const dirRow = new Adw.ActionRow({
            title: '歌词文件夹',
            subtitle: settings.get_string('lyrics-dir') || '未设置——选择存放 .lrc 歌词的目录',
        });
        const dirButton = new Gtk.Button({
            label: settings.get_string('lyrics-dir') ? '更改' : '选择目录',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        const dirDialog = new Gtk.FileDialog({title: '选择歌词文件夹'});
        dirButton.connect('clicked', () => {
            dirDialog.select_folder(window, null, (dialog, result) => {
                try {
                    const file = dialog.select_folder_finish(result);
                    if (file?.get_path())
                        settings.set_string('lyrics-dir', file.get_path());
                } catch {
                    // 用户取消选择
                }
            });
        });
        dirRow.add_suffix(dirButton);
        dirRow.activatable_widget = dirButton;
        settings.connect('changed::lyrics-dir', () => {
            const dir = settings.get_string('lyrics-dir');
            dirRow.subtitle = dir || '未设置——选择存放 .lrc 歌词的目录';
            dirButton.label = dir ? '更改' : '选择目录';
        });
        source.add(dirRow);

        const players = listPlayers();
        const stored = settings.get_string('preferred-player');
        const values = ['', ...players];
        if (stored && !players.includes(stored))
            values.push(stored);
        const labels = ['自动（推荐）', ...values.slice(1).map(name => name.replace(/-/g, ' '))];

        const playerRow = new Adw.ComboRow({
            title: '优先的播放器',
            subtitle: '同时有多个播放器时优先显示哪一路',
            model: Gtk.StringList.new(labels),
        });
        playerRow.selected = Math.max(0, values.indexOf(stored));
        playerRow.connect('notify::selected', () => {
            const value = values[playerRow.selected] ?? '';
            if (settings.get_string('preferred-player') !== value)
                settings.set_string('preferred-player', value);
        });
        source.add(playerRow);

        const cacheRow = new Adw.SwitchRow({
            title: '缓存歌词',
            subtitle: '缓存已下载的歌词，重复播放时无需联网',
        });
        settings.bind('cache-enabled', cacheRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        source.add(cacheRow);

        const clearRow = new Adw.ActionRow({
            title: '清空歌词缓存',
            subtitle: '删除本地已缓存的歌词文件',
        });
        const clearButton = new Gtk.Button({
            label: '清空',
            valign: Gtk.Align.CENTER,
            css_classes: ['flat'],
        });
        clearButton.connect('clicked', () => {
            LyricsService.clearCache();
            window.add_toast(new Adw.Toast({title: '歌词缓存已清空', timeout: 3}));
        });
        clearRow.add_suffix(clearButton);
        source.add(clearRow);

        const templateRow = new Adw.EntryRow({
            title: '前奏/间奏的文案',
            text: settings.get_string('fallback-template'),
        });
        templateRow.connect('changed', () => {
            if (settings.get_string('fallback-template') !== templateRow.text)
                settings.set_string('fallback-template', templateRow.text);
        });
        source.add(templateRow);

        const hintRow = new Adw.ActionRow({
            title: '可用占位符',
            subtitle: '{artist} {title} {album} {player}',
            activatable: false,
        });
        source.add(hintRow);
    }
}

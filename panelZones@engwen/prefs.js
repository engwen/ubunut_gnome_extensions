// SPDX-License-Identifier: GPL-2.0-or-later
//
// 设置：编辑模式开关、三个区的内容预览、重置。

import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

const ZONES = [
    ['left', '最左区'],
    ['middle', '中间（弹性）'],
    ['right', '最右区'],
];

/**
 * 把 role 列表变成人能看懂的一行。
 *
 * @param {string[]} list
 * @returns {string}
 */
function describe(list) {
    if (!list || list.length === 0)
        return '（空）';
    return list.join('、');
}

export default class PanelZonesPreferences extends ExtensionPreferences {
    /**
     * @param {Adw.PreferencesWindow} window
     */
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

        const page = new Adw.PreferencesPage({
            title: '顶栏分区',
            icon_name: 'view-grid-symbolic',
        });
        window.add(page);

        // ------------------------------------------------------------ 编辑
        const editing = new Adw.PreferencesGroup({
            title: '编辑',
            description: '打开编辑模式后，直接在顶栏上拖动图标即可换位；此时点击图标不会打开它原来的菜单。',
        });
        page.add(editing);

        const editRow = new Adw.SwitchRow({
            title: '编辑模式',
            subtitle: '打开后直接在顶栏拖动图标，松手自动保存；在顶栏右键即可退出',
        });
        settings.bind('edit-mode', editRow, 'active', Gio.SettingsBindFlags.DEFAULT);
        editing.add(editRow);

        // ------------------------------------------------------------ 间距
        const spacing = new Adw.PreferencesGroup({
            title: '图标间距',
            description: '相邻图标之间的像素间隔，三个区可以分别设置。' +
                '这里压的是图标按钮自身的留白（-natural-hpadding），' +
                '所以调小真的会变紧凑，而不只是把外面的容器撑开。',
        });
        page.add(spacing);

        for (const [key, label] of ZONES) {
            const adjustment = new Gtk.Adjustment({
                lower: 0,
                upper: 48,
                step_increment: 1,
                page_increment: 4,
                value: settings.get_int(`gap-${key}`),
            });

            const row = new Adw.SpinRow({
                title: `${label}图标间距`,
                subtitle: '0 = 图标内容紧贴边缘，12 左右接近系统默认',
                adjustment,
                digits: 0,
            });

            row.connect('notify::value', () => {
                const value = Math.round(row.value);
                if (settings.get_int(`gap-${key}`) !== value)
                    settings.set_int(`gap-${key}`, value);
            });

            settings.connect(`changed::gap-${key}`, () => {
                const value = settings.get_int(`gap-${key}`);
                if (Math.round(row.value) !== value)
                    row.value = value;
            });

            spacing.add(row);
        }

        // ------------------------------------------------------------ 当前布局
        const layout = new Adw.PreferencesGroup({
            title: '当前布局',
            description: '下面是实际生效的顺序，role 名就是图标在 shell 里的身份。',
        });
        page.add(layout);

        const rows = new Map();
        for (const [key, label] of ZONES) {
            const row = new Adw.ActionRow({
                title: label,
                subtitle: describe(settings.get_strv(`zone-${key}`)),
                activatable: false,
            });
            rows.set(key, row);
            layout.add(row);

            settings.connect(`changed::zone-${key}`, () => {
                row.subtitle = describe(settings.get_strv(`zone-${key}`));
            });
        }

        const resetRow = new Adw.ActionRow({
            title: '重置布局',
            subtitle: '按当前顶栏顺序重新接管；网速仍会留在最左区',
            activatable: true,
        });
        resetRow.add_suffix(new Gtk.Image({icon_name: 'edit-undo-symbolic'}));
        resetRow.connect('activated', () => {
            settings.set_strv('zone-left', []);
            settings.set_strv('zone-middle', []);
            settings.set_strv('zone-right', []);
            settings.set_int('layout-version', 0);
        });
        layout.add(resetRow);

        // ------------------------------------------------------------ 说明
        const about = new Adw.PreferencesGroup({title: '说明'});
        page.add(about);

        about.add(new Adw.ActionRow({
            title: '中间是弹性区',
            subtitle: '没有配置过的图标 —— 新装的扩展、新出现的托盘程序（QQ、微信、VPN 等）—— 都会自动落在这里，' +
                '并插在本区最左边（和 Windows 通知区域一样），已有图标依次右移。',
            activatable: false,
        }));

        about.add(new Adw.ActionRow({
            title: '系统菜单锁定',
            subtitle: '快速设置固定在最右侧且不可拖动，避免消息横幅对齐和键盘导航出问题。',
            activatable: false,
        }));

        about.add(new Adw.ActionRow({
            title: '图标身份',
            subtitle: '按 role 识别，所以托盘图标重建后顺序依然有效；没有注册 role 的图标（例如天气）会显示成 orphan:类名#序号。',
            activatable: false,
        }));
    }
}

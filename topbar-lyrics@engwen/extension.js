// SPDX-License-Identifier: GPL-2.0-or-later
//
// Top Bar Lyrics — 在 GNOME 顶栏显示当前播放音乐的同步歌词。
//
// 数据流：
//   MprisWatcher（发现播放器 / 曲目 / 进度）
//        └─> LyricsService（本地 .lrc → 缓存 → LRCLIB）
//              └─> LyricsView（跟唱高亮 + 定宽滚动）
//                    └─> PanelMenu.Button（纯显示，不响应点击）

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {LyricsService} from './lib/lyricsService.js';
import {LyricsView} from './lib/lyricsView.js';
import {MprisWatcher} from './lib/mpris.js';

const ROLE = 'topbar-lyrics';

export default class TopBarLyricsExtension extends Extension {
    enable() {
        this._destroyed = false;
        this._settings = this.getSettings();
        this._service = new LyricsService(this._settings);
        this._mpris = new MprisWatcher();
        this._mpris.setPreferred(this._settings.get_string('preferred-player'));

        this._indicator = null;
        this._view = null;
        this._state = null;
        this._doc = null;
        this._trackKey = null;
        this._loadToken = 0;
        this._cancellable = null;

        this._buildIndicator();

        this._settings.connectObject(
            'changed::position', () => this._buildIndicator(),
            'changed::position-index', () => this._buildIndicator(),
            'changed::hide-when-idle', () => this._updateVisibility(),
            'changed::preferred-player',
            () => this._mpris?.setPreferred(this._settings.get_string('preferred-player')),
            'changed::panel-width', () => this._applyConfig(),
            'changed::font-size', () => this._applyConfig(),
            'changed::karaoke', () => this._applyConfig(),
            'changed::color-inactive', () => this._applyConfig(),
            'changed::color-active', () => this._applyConfig(),
            'changed::marquee', () => this._applyConfig(),
            'changed::marquee-speed', () => this._applyConfig(),
            'changed::lyrics-offset', () => this._applyConfig(),
            'changed::fallback-template', () => this._applyConfig(),
            this);

        this._mpris.start(state => this._onPlayerState(state));
    }

    disable() {
        this._destroyed = true;
        this._loadToken++;
        this._cancellable?.cancel();
        this._cancellable = null;

        this._settings?.disconnectObject(this);
        this._mpris?.destroy();
        this._mpris = null;

        this._destroyIndicator();

        this._service = null;
        this._settings = null;
        this._state = null;
        this._doc = null;
        this._trackKey = null;
    }

    // ------------------------------------------------------------- 顶栏组件

    _buildIndicator() {
        this._destroyIndicator();

        // 第三个参数 true：不创建菜单，配合 setSensitive(false) 让它彻底不响应点击
        const button = new PanelMenu.Button(0.0, this.metadata.name, true);
        button.add_style_class_name('topbar-lyrics-button');
        button.setSensitive(false);

        const view = new LyricsView(this._config(), () => this._mpris?.getPosition() ?? null);
        button.add_child(view);

        const box = this._settings.get_string('position');
        const index = this._clampIndex(box);

        Main.panel.addToStatusArea(ROLE, button, index, box);

        this._indicator = button;
        this._view = view;

        // 重建后把当前状态贴回去，避免切位置时闪一下空白
        view.setTrack(this._state);
        view.setLyrics(this._doc);
        view.setPlaying(this._state?.status === 'Playing');

        this._updateVisibility();
    }

    _destroyIndicator() {
        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }
        this._view = null;
    }

    /**
     * 排序索引不能超过该区域现有的子项数量，否则 Clutter 会直接拒绝插入。
     * @param {string} box
     * @returns {number}
     */
    _clampIndex(box) {
        const requested = Math.max(0, this._settings.get_int('position-index'));

        const boxes = {
            left: Main.panel._leftBox,
            center: Main.panel._centerBox,
            right: Main.panel._rightBox,
        };
        const container = boxes[box] ?? Main.panel._rightBox;
        const count = container?.get_n_children?.() ?? requested;

        return Math.min(requested, count);
    }

    // ---------------------------------------------------------------- 配置

    _config() {
        return {
            width: this._settings.get_int('panel-width'),
            fontSize: this._settings.get_int('font-size'),
            karaoke: this._settings.get_boolean('karaoke'),
            marquee: this._settings.get_boolean('marquee'),
            speed: this._settings.get_int('marquee-speed'),
            colorInactive: this._settings.get_string('color-inactive'),
            colorActive: this._settings.get_string('color-active'),
            offset: this._settings.get_int('lyrics-offset'),
            fallback: this._settings.get_string('fallback-template'),
        };
    }

    _applyConfig() {
        this._view?.setConfig(this._config());
    }

    // ------------------------------------------------------------- 播放状态

    /**
     * @param {object|null} state
     */
    _onPlayerState(state) {
        if (this._destroyed)
            return;

        if (!state) {
            this._state = null;
            this._doc = null;
            this._trackKey = null;
            this._view?.setTrack(null);
            this._view?.setLyrics(null);
            this._view?.setPlaying(false);
            this._updateVisibility();
            return;
        }

        this._state = state;

        const key = [
            state.busName, state.trackid ?? '', state.title, state.artist,
            state.album, Math.round((state.length ?? 0) / 1e6),
        ].join('|');

        if (key !== this._trackKey) {
            this._trackKey = key;
            this._doc = null;
            this._view?.setTrack(state);
            this._view?.setLyrics(null);
            this._loadLyrics(state);
        }

        this._view?.setPlaying(state.status === 'Playing');
        this._updateVisibility();
    }

    /**
     * 加载歌词。快速切歌保护：
     *   1. 主线程同步查内存缓存，命中直接渲染
     *   2. 异步任务发起前，取消上一个未完成的网络请求
     *   3. 回调校验 token：只有仍是当前歌曲才更新 UI，过期结果直接丢弃
     *
     * @param {object} state
     */
    _loadLyrics(state) {
        const token = ++this._loadToken;

        // ---- 内存缓存命中：同步返回，不进异步链 ----
        const memory = this._service.peekMemory(state);
        if (memory) {
            this._doc = memory.doc;
            this._view?.setTrack(state);
            this._view?.setLyrics(memory.doc);
            return;
        }

        // ---- 取消上一个未完成的网络请求，再发起新任务 ----
        this._cancellable?.cancel();
        this._cancellable = new Gio.Cancellable();
        const cancellable = this._cancellable;

        this._view?.setLyrics(null);

        this._service.load(state, cancellable)
            .then(result => {
                if (this._destroyed || token !== this._loadToken)
                    return; // 已切歌：丢弃过期回调

                this._doc = result?.doc ?? null;
                console.log(`TopBarLyrics: 歌词来源=${result?.source ?? '未找到'} ` +
                            `行数=${this._doc?.lines?.length ?? 0}`);
                this._view?.setTrack(state);
                this._view?.setLyrics(this._doc, !this._doc);
            })
            .catch(error => {
                if (error instanceof Gio.IOErrorEnum &&
                    error.code === Gio.IOErrorEnum.CANCELLED)
                    return; // 被新任务取消，静默
                logError(error, 'TopBarLyrics: 歌词加载失败');
            });
    }

    _updateVisibility() {
        if (!this._indicator)
            return;

        if (this._settings.get_boolean('hide-when-idle'))
            this._indicator.visible = !!this._state;
        else
            this._indicator.visible = true;
    }
}

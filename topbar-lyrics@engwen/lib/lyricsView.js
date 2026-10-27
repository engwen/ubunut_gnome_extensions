// SPDX-License-Identifier: GPL-2.0-or-later
//
// 顶栏歌词控件。只负责“画”，不处理任何鼠标/键盘交互。
//
// 布局：外层 St.Widget 用 Clutter.FixedLayout + clip_to_allocation 当作一个
// 定宽视口，内部 St.Label 保持文字自然宽度，靠 translation_x 实现滚动裁剪。
//
// 三种横向模式：
//   fit        文字放得下，居中显示
//   marquee    超长且未开卡拉 OK：来回匀速滚动
//   follow     超长且开了卡拉 OK：跟着高亮位置滚动，保证当前唱到的字始终可见
// 卡拉 OK 着色用 Pango markup 按渐变级别拆段：已唱/未唱边界前后各约
// 一个字符宽度内连续插值出中间色，视觉上是平滑的渐变而非单字跳变。

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {karaokeProgressAt, lineIndexAt} from './lrc.js';

const MARQUEE_GAP = 48;      // 滚到末尾后额外留白
const MARQUEE_PAUSE_MS = 900;
const TICK_FAST_MS = 40;     // 卡拉 OK / 跟随滚动
const TICK_SLOW_MS = 250;    // 纯静态显示时的低频校准

// 卡拉 OK 渐变：颜色边界不是“单字瞬变”，而是在边界前后各约半个窗口内
// 连续插值；量化成 GRADIENT_STEPS 级，用若干段 <span> 表达。
const GRADIENT_WINDOW = 2.0;   // 过渡窗口宽度（字符数）
const GRADIENT_STEPS = 12;     // 渐变量化级数（越大越平滑，开销略增）

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

/** @returns {[number, number, number]} */
function hexToRgb(hex) {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
    if (!m)
        return [255, 255, 255];
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * 把颜色规范化为 Pango markup 安全的 #rrggbb。
 * GTK 颜色选择器（Gdk.RGBA.to_string）存的是 rgb()/rgba() 格式，
 * 而 Pango 的 foreground 只认 #hex 和颜色名，直接塞 rgb() 会导致
 * 整条 markup 解析失败、标签空白（实测踩坑）。
 * @param {string} color
 * @param {string} fallback 解析失败时的兜底色
 * @returns {string}
 */
function normalizeColor(color, fallback) {
    const s = String(color ?? '').trim();
    if (/^#[0-9a-f]{6}$/i.test(s))
        return s;
    if (/^#[0-9a-f]{3}$/i.test(s))
        return '#' + [...s.slice(1)].map(c => c + c).join('');
    const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(s);
    if (m) {
        const byte = v =>
            Math.max(0, Math.min(255, Number(v))).toString(16).padStart(2, '0');
        return `#${byte(m[1])}${byte(m[2])}${byte(m[3])}`;
    }
    return fallback;
}

/** @returns {string} #rrggbb */
function rgbToHex([r, g, b]) {
    const byte = v =>
        Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
    return `#${byte(r)}${byte(g)}${byte(b)}`;
}

/**
 * 生成卡拉 OK 渐变 markup：把整行按量化后的颜色级别拆成若干段。
 * @param {string} text 行文本
 * @param {number} f 已唱到的浮点字符位置（0..text.length）
 * @returns {string} Pango markup
 */
function buildGradientMarkup(text, f, colorActive, colorInactive) {
    const act = hexToRgb(colorActive);
    const ina = hexToRgb(colorInactive);
    const gradient = level => {
        if (level <= 0)
            return colorInactive;
        if (level >= GRADIENT_STEPS)
            return colorActive;
        return rgbToHex([
            ina[0] + (act[0] - ina[0]) * level / GRADIENT_STEPS,
            ina[1] + (act[1] - ina[1]) * level / GRADIENT_STEPS,
            ina[2] + (act[2] - ina[2]) * level / GRADIENT_STEPS,
        ]);
    };

    let out = '';
    let run = '';
    let runLevel = -1;
    const flush = () => {
        if (!run)
            return;
        out += `<span foreground="${gradient(runLevel)}">${escapeMarkup(run)}</span>`;
        run = '';
    };

    for (let i = 0; i < text.length; i++) {
        // 已唱程度：边界落在字符中间时取中间色，前后 ±半个窗口过渡
        const unit = text.charCodeAt(i);
        let level;
        if (unit >= 0xDC00 && unit <= 0xDFFF) {
            level = runLevel > 0 ? runLevel : 0; // 低位代理跟随前一单元，避免拆散 emoji
        } else {
            const mix = Math.max(0, Math.min(1, (f - i) / GRADIENT_WINDOW + 0.5));
            level = Math.round(mix * GRADIENT_STEPS);
        }
        if (level !== runLevel) {
            flush();
            runLevel = level;
        }
        run += text[i];
    }
    flush();

    return out;
}

export const LyricsView = GObject.registerClass(
class LyricsView extends St.Widget {
    /**
     * @param {object} config 见 extension.js 的 _config()
     * @param {() => (number|null)} positionFn 返回当前播放位置（微秒）
     */
    _init(config, positionFn) {
        super._init({
            layout_manager: new Clutter.FixedLayout(),
            clip_to_allocation: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            reactive: false,
            style_class: 'topbar-lyrics',
        });

        this._config = config;
        this._positionFn = positionFn;

        this._doc = null;
        this._track = null;
        this._playing = false;

        this._timerId = 0;
        this._lineIndex = -2;
        this._charProgress = -1;
        this._displayText = '';
        this._paintMarkup = null;
        this._notFound = false;
        
        this._naturalWidth = 0;
        this._mode = 'fit';

        // 跑马灯状态：0 → -range 往返，两端各停留一次
        this._marqueeOffset = 0;
        this._marqueeDir = -1;
        this._holdMs = MARQUEE_PAUSE_MS;
        this._lastTickUs = 0;

        this._label = new St.Label({
            style_class: 'topbar-lyrics-label',
            reactive: false,
        });
        this._label.clutter_text.x_align = Clutter.ActorAlign.START;
        this._label.clutter_text.y_align = Clutter.ActorAlign.CENTER;
        this.add_child(this._label);

        this._applyConfig();
        this.connect('destroy', () => this._onDestroy());
    }

    // ------------------------------------------------------------- 对外接口

    /**
     * @param {object|null} track
     */
    setTrack(track) {
        this._track = track;
        if (!this._doc)
            this._setLineIndex(-1);
    }

    /**
     * @param {{lines: object[]}|null} doc 解析后的歌词
     * @param {boolean} [notFound] 本地与联网都落空，显示「未找到歌词」
     */
    setLyrics(doc, notFound = false) {
        this._doc = doc?.lines?.length ? doc : null;
        this._notFound = !this._doc && !!notFound;
        this._lineIndex = -2;
        this._charProgress = -1;
        this._paintMarkup = null;
        this._sync();
    }

    /**
     * @param {boolean} playing
     */
    setPlaying(playing) {
        if (playing === this._playing)
            return;

        this._playing = playing;

        if (playing)
            this._startTimer();
        else
            this._stopTimer();

        this._sync();
    }

    /**
     * @param {object} config
     */
    setConfig(config) {
        const karaokeChanged = config.karaoke !== this._config.karaoke;
        const marqueeChanged = config.marquee !== this._config.marquee;
        this._config = config;

        this._paint();
        this._applyConfig();

        if ((karaokeChanged || marqueeChanged) && this._timerId) {
            this._stopTimer();
            this._startTimer();
        }
    }

    // --------------------------------------------------------------- 渲染细节

    _applyConfig() {
        const {width, fontSize} = this._config;
        const height = Math.ceil(fontSize * 1.5);

        this.set_width(width);
        this.set_height(height);
        this._label.set_height(height);
        this._label.set_style(`font-size: ${fontSize}px;`);

        this._paintMarkup = null;
        this._paint();
        this._relayoutText();
    }

    /**
     * 测量文字宽度并选择横向模式。
     */
    _relayoutText() {
        const width = this._config.width;

        // 先放开约束，拿到文字的自然宽度
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        this._label.set_width(-1);
        this._label.translation_x = 0;

        const natural = this._textWidth();
        this._naturalWidth = natural;

        if (!this._displayText || natural <= width + 1) {
            this._mode = 'fit';
            this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            this._label.set_width(width);
            return;
        }

        if (this._config.karaoke) {
            this._mode = 'follow';
            this._updateFollow();
            return;
        }

        if (this._config.marquee) {
            // 由 tick 定时器推进，不依赖 Clutter 动画，
            // 这样系统关闭动画时也能正常滚动
            this._mode = 'marquee';
            this._marqueeOffset = 0;
            this._marqueeDir = -1;
            this._holdMs = MARQUEE_PAUSE_MS;
            return;
        }

        this._mode = 'ellipsize';
        this._label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._label.set_width(width);
    }

    /**
     * @returns {number} 当前文字的自然宽度（像素）
     */
    _textWidth() {
        const [, natural] = this._label.clutter_text.get_preferred_width(-1);
        return natural ?? 0;
    }

    _paint() {
        const text = this._displayText ?? '';
        const inactive = normalizeColor(this._config.colorInactive, '#4aa3ff');
        const active = normalizeColor(this._config.colorActive, '#2ee66b');

        // 卡拉 OK：按浮点进度生成渐变 markup；否则整行单色
        const markup = this._config.karaoke && this._charProgress > 0 && text
            ? buildGradientMarkup(text, this._charProgress, active, inactive)
            : `<span foreground="${inactive}">${escapeMarkup(text)}</span>`;

        if (markup === this._paintMarkup)
            return; // 量化后无变化，跳过重排

        this._paintMarkup = markup;
        this._label.clutter_text.set_markup(markup);
    }

    // --------------------------------------------------------------- 滚动逻辑

    /**
     * 跑马灯推进一步。往返滚动：滚到末尾停留，再滚回开头停留。
     * @param {number} dtMs 距上次 tick 的毫秒数
     */
    _advanceMarquee(dtMs) {
        if (this._holdMs > 0) {
            this._holdMs -= dtMs;
            return;
        }

        const range = Math.max(1, this._naturalWidth - this._config.width + MARQUEE_GAP);
        this._marqueeOffset += this._marqueeDir * this._config.speed * dtMs / 1000;

        if (this._marqueeOffset <= -range) {
            this._marqueeOffset = -range;
            this._marqueeDir = 1;
            this._holdMs = MARQUEE_PAUSE_MS;
        } else if (this._marqueeOffset >= 0) {
            this._marqueeOffset = 0;
            this._marqueeDir = -1;
            this._holdMs = MARQUEE_PAUSE_MS;
        }

        this._label.translation_x = this._marqueeOffset;
    }

    _updateFollow() {
        const width = this._config.width;
        const max = Math.max(0, this._naturalWidth - width);
        const length = this._displayText.length;
        const progress = length > 0 ? Math.max(0, this._charProgress) / length : 0;
        const target = Math.max(0, Math.min(max, progress * this._naturalWidth - width * 0.35));
        const current = -this._label.translation_x;

        // 轻微缓动，避免逐字跳动
        this._label.translation_x = -(current + (target - current) * 0.3);
    }

    // --------------------------------------------------------------- 时间驱动

    _startTimer() {
        if (this._timerId)
            return;

        // 卡拉 OK 和跑马灯都需要较高的刷新率
        const interval = this._config.karaoke || this._config.marquee
            ? TICK_FAST_MS
            : TICK_SLOW_MS;
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, interval, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timerId) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
    }

    /** @returns {number|null} 毫秒 */
    _positionMs() {
        const micros = this._positionFn?.();
        if (micros == null || !Number.isFinite(micros))
            return null;
        return micros / 1000 + this._config.offset;
    }

    _tick() {
        if (!this.visible || !this._playing)
            return;

        const now = GLib.get_monotonic_time();
        const dtMs = this._lastTickUs ? Math.min(200, (now - this._lastTickUs) / 1000) : 0;
        this._lastTickUs = now;

        const position = this._positionMs();
        if (position != null && this._doc) {
            const index = lineIndexAt(this._doc.lines, position);
            if (index !== this._lineIndex)
                this._setLineIndex(index);

            this._updateKaraoke(position);
        }

        if (this._mode === 'follow')
            this._updateFollow();
        else if (this._mode === 'marquee')
            this._advanceMarquee(dtMs);
    }

    /**
     * @param {number} position 毫秒
     */
    _updateKaraoke(position) {
        if (!this._config.karaoke) {
            if (this._charProgress !== -1) {
                this._charProgress = -1;
                this._paint();
            }
            return;
        }

        // 浮点进度每 tick 都在变，直接重画；_paint 内部按量化后的
        // markup 去重，只有渐变级别真正变化时才会触发重排。
        this._charProgress = karaokeProgressAt(
            this._doc.lines, this._lineIndex, position);
        this._paint();
    }

    /** 立即按当前位置刷新一次（切歌、暂停、加载完歌词时调用）。 */
    _sync() {
        const position = this._positionMs();

        if (!this._doc || position == null) {
            this._setLineIndex(-1);
            return;
        }

        this._setLineIndex(lineIndexAt(this._doc.lines, position));
        this._updateKaraoke(position);

        if (this._mode === 'follow')
            this._updateFollow();
    }

    /**
     * @param {number} index
     */
    _setLineIndex(index) {
        this._lineIndex = index;
        this._displayText = this._composeText(index);
        this._charProgress = -1;
        this._paintMarkup = null;

        this._paint();
        this._relayoutText();
    }

    /**
     * @param {number} index
     * @returns {string}
     */
    _composeText(index) {
        const line = this._doc?.lines?.[index];
        if (line?.text)
            return line.text;

        // 本地与联网都落空：明确提示，不空白
        if (this._notFound)
            return '未找到歌词';

        // 前奏、间奏时，退回「歌手 - 曲名」
        const track = this._track ?? {};
        const template = this._config.fallback || '{artist} · {title}';
        const text = template
            .replaceAll('{artist}', track.artist ?? '')
            .replaceAll('{title}', track.title ?? '')
            .replaceAll('{album}', track.album ?? '')
            .replaceAll('{player}', track.identity ?? '')
            .trim()
            .replace(/^[·\-–—|]\s*/, '')
            .replace(/\s*[·\-–—|]$/, '')
            .trim();

        return text || String(track.title ?? '');
    }

    _onDestroy() {
        this._stopTimer();
        this._label?.remove_all_transitions();
        this._label = null;
        this._doc = null;
        this._track = null;
    }
});

# Top Bar Lyrics（topbar-lyrics@engwen）

在 GNOME 顶栏显示当前播放音乐的**同步歌词**。纯显示组件：不响应鼠标、键盘，不弹菜单。

- 适用：Ubuntu 26.04 LTS / GNOME Shell 49–50（Wayland、X11 均可）
- 歌词来源（按优先级，命中即停；**每个来源独立隔离，单个出错只记日志、不影响其它**）：
  0. 内存缓存（同步、无 IO）
  1. **音频内嵌歌词**（MP3 的 ID3v2 `USLT` / `SYLT` / `TXXX` / `COMM`；兼容 ID3v2.2 / 2.3 / 2.4，只读标签、不读音频流）
     - `USLT` 若本身是 LRC 文本 → 按时间轴处理；纯文本 → 按曲长生成“合成时间轴”
  2. **歌词文件夹**（设置里指定；支持 `Lyrics/`、`lrc/` 等子目录；先精确同名，失败再模糊匹配）
  3. 歌词缓存子目录（`~/.cache/topbar-lyrics/`）
  4. 音频文件所在目录（支持子目录与模糊匹配）
  5. 系统音乐目录
  6. LRCLIB 联网兜底（**5 秒超时**；`/api/get` 失败自动降级 `/api/search`，成功后写入缓存目录）
  7. 全部落空 → 顶栏显示 `未找到歌词`
- `.lrc` 先按同名匹配（`xxx.mp3` → `xxx.lrc`），失败后按归一化文件名模糊匹配（如 `01 - 歌名.lrc`）
- `.lrc` 编码自动探测：UTF-8 / UTF-16(BOM) / GB18030 / GBK / Big5（中文歌词文件常见 GBK）
- 快速切歌保护：新任务发起前取消上一个网络请求（Gio.Cancellable），回调按歌曲标识校验，过期结果直接丢弃
- 播放器：任何实现 MPRIS 的播放器（Spotify、YesPlayMusic、Rhythmbox、mpv、VLC、Firefox…）；多播放器同时播放时取**最新开始播放**的一个
- UI：纯文字，无背景、无胶囊样式；默认放在顶栏右侧

## 功能

| 需求 | 实现 |
| --- | --- |
| 歌词位置与显示顺序 | 「显示位置」= 顶栏左 / 中 / 右区域；「显示顺序」= 同一区域内排第几位（0 最靠前） |
| 面板长度 | 80–800px 固定宽度；超出自动滚动（卡拉 OK 开启时改为**跟随高亮滚动**） |
| 卡拉 OK 模式 | 当前行随播放进度从蓝色（未唱）渐变为绿色（已唱）；两种颜色均可在设置里改 |
| 纯显示 | 按钮不创建菜单、不响应点击、不参与焦点；无背景无胶囊，纯文字 |
| 无歌词 / 前奏 | 找不到歌词显示 `未找到歌词`；前奏/间奏显示 `歌手 - 曲名`（模板可自定义） |
| 歌词文件夹 | 首选项里指定一个目录，作为外挂 `.lrc` 的第一优先查找位置 |

其他：字号、滚动速度、歌词偏移（毫秒，校正延迟）、优先播放器、歌词缓存、无播放时隐藏。

## 安装

```bash
cd topbar-lyrics@engwen
./install.sh
```

或在「扩展」App 中启用 `Top Bar Lyrics`：

```bash
gnome-extensions enable topbar-lyrics@engwen
gnome-extensions prefs topbar-lyrics@engwen   # 打开设置
```

> GNOME 50 的 Wayland 会话无需重启即可生效；若未出现，注销重登一次。

## 设置项说明

- **显示位置 / 显示顺序**：`position`（left/center/right）+ `position-index`（0–30）
- **面板长度**：`panel-width`，超出即滚动；关闭「超长自动滚动」后只显示省略号
- **卡拉 OK**：`karaoke`、`color-inactive`（默认 `#4aa3ff` 蓝）、`color-active`（默认 `#2ee66b` 绿）
- **歌词偏移**：`lyrics-offset`，正数提前、负数延后
- **优先的播放器**：`preferred-player`，同时开多个播放器时优先显示哪一路；留空自动选「正在播放」的

## 本地歌词

播放本地文件（`file://`）时按以下顺序找词：

1. **音频内嵌歌词**：直接读 MP3 的 ID3v2 标签。支持
   `SYLT`（同步歌词）、`USLT`（普通歌词，最常见）、`TXXX`/`COMM`（描述含 `lyric` 的自定义帧），
   以及 ID3v2.2 的 `SLT`/`ULT` 别名。纯文本歌词会按曲长生成合成时间轴，所以顶栏能正常推进。
2. **同目录 `.lrc`**：先精确同名（`Yellow.flac` → `Yellow.lrc`），失败后模糊匹配
   （`Yellow.flac` → `01 - Yellow.lrc`），并会检查 `Lyrics/`、`lrc/` 等子目录。
3. **指定的歌词文件夹**：同上，优先级高于同目录。

`.lrc` 支持 UTF-8 / UTF-16(BOM) / GB18030 / GBK / Big5，中文 GBK 歌词文件可直接用。

## 日志与排查

所有运行日志写在：

```
~/.cache/topbar-lyrics/logs/topbar-lyrics-YYYY-MM-DD.log
```

- 按天分文件，单日上限 3MB；**自动删除 3 天前的旧日志**（启动时与每 6 小时各检查一次）
- 首选项 →「运行日志（自动保留 3 天）」可直接打开该目录
- 每个歌词来源的命中/落空、编码探测、ID3 解析结果、网络请求失败都会留下记录；
  `grep` 一个歌名即可看到它依次尝试了哪些来源、最后命中哪一条：

```bash
grep "歌名" ~/.cache/topbar-lyrics/logs/topbar-lyrics-*.log
```

- `WARN` / `ERROR` 会同时镜像到控制台，可用 `journalctl -f | grep TopBarLyrics` 实时观察
- 任意单个来源（内嵌标签损坏、目录不可读、网络超时…）出错都只记一条 `WARN` 并继续，
  不会让插件崩溃；`ERROR` 会附带堆栈，方便定位

## 目录结构

```
topbar-lyrics@engwen/
├── metadata.json                          # uuid / shell-version / schema
├── extension.js                           # 入口：装配 MPRIS → 歌词服务 → 顶栏控件
├── prefs.js                               # Adw 首选项窗口（含卡拉 OK 动画预览）
├── stylesheet.css
├── lib/
│   ├── mpris.js                           # 播放器发现 / 元数据 / 进度插值
│   ├── lyricsService.js                   # 歌词来源编排（6 个隔离的 provider 链）
│   ├── id3.js                             # ID3v2 内嵌歌词（USLT/SYLT/TXXX，v2.2–2.4）
│   ├── logger.js                          # 落盘日志 + 3 天自动清理
│   ├── http.js                            # libsoup3（任何异常自动退回 curl）
│   ├── lrc.js                             # LRC 解析 + 纯文本合成时间轴
│   └── lyricsView.js                      # 渲染：卡拉 OK 着色 / 跟随滚动 / 跑马灯
└── schemas/                               # GSettings schema
```

## 开发与验证

`../tools/headless-test/` 提供了无需桌面的端到端验证脚本（headless GNOME Shell +
假 MPRIS 播放器 + Shell 内部截图），详见该目录 README。

## 已知限制

- 卡拉 OK 的逐字精度取决于歌词源；普通 LRC 在行内按时间线性推进（增强 LRC 可逐字）
- 纯文本内嵌歌词（`USLT` 无时间轴）按曲长**均匀铺**一条合成时间轴，进度是估算值，不是逐句精确
- LRCLIB 没有的冷门歌曲会退回显示「歌手 - 曲名」
- 顶栏歌词宽度固定，不随文字伸缩（这正是“面板长度”的语义）

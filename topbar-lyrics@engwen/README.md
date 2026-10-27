# Top Bar Lyrics（topbar-lyrics@engwen）

在 GNOME 顶栏显示当前播放音乐的**同步歌词**。纯显示组件：不响应鼠标、键盘，不弹菜单。

- 适用：Ubuntu 26.04 LTS / GNOME Shell 49–50（Wayland、X11 均可）
- 歌词来源（按优先级，命中即停）：
  0. 内存缓存（同步、无 IO）
  1. 本地音频内嵌 **SYLT 同步歌词**（只解析 ID3v2.3 / ID3v2.4 头部标签，不读音频数据流）
  2. **歌词文件夹**（设置里指定，第一优先的外挂目录）找同名 `.lrc`
  3. 歌词缓存子目录（`~/.cache/topbar-lyrics/`）找同名 `.lrc`
  4. mp3 所在目录找同名 `.lrc`
  5. LRCLIB 联网兜底（**5 秒超时**；`/api/get` 失败自动降级 `/api/search`，成功后写入缓存目录）
  6. 全部落空 → 顶栏显示 `未找到歌词`
- 所有 `.lrc` 查找均为**同名匹配**（`xxx.mp3` → `xxx.lrc`）；流媒体（http/https）跳过本地步骤直接联网
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

播放本地文件（`file://`）时会自动寻找同目录同名 `.lrc`，例如
`/music/Coldplay - Yellow.flac` → `/music/Coldplay - Yellow.lrc`。

## 目录结构

```
topbar-lyrics@engwen/
├── metadata.json                          # uuid / shell-version / schema
├── extension.js                           # 入口：装配 MPRIS → 歌词服务 → 顶栏控件
├── prefs.js                               # Adw 首选项窗口（含卡拉 OK 动画预览）
├── stylesheet.css
├── lib/
│   ├── mpris.js                           # 播放器发现 / 元数据 / 进度插值
│   ├── lyricsService.js                   # SYLT → 同名 .lrc → 缓存 → LRCLIB
│   ├── id3.js                             # ID3v2 SYLT 内嵌歌词解析
│   ├── http.js                            # libsoup3（缺 typelib 自动退回 curl）
│   ├── lrc.js                             # LRC 解析（含增强 LRC 逐字时间戳）
│   └── lyricsView.js                      # 渲染：卡拉 OK 着色 / 跟随滚动 / 跑马灯
└── schemas/                               # GSettings schema
```

## 开发与验证

`../tools/headless-test/` 提供了无需桌面的端到端验证脚本（headless GNOME Shell +
假 MPRIS 播放器 + Shell 内部截图），详见该目录 README。

## 已知限制

- 卡拉 OK 的逐字精度取决于歌词源；普通 LRC 在行内按时间线性推进（增强 LRC 可逐字）
- LRCLIB 没有的冷门歌曲会退回显示「歌手 - 曲名」
- 顶栏歌词宽度固定，不随文字伸缩（这正是“面板长度”的语义）

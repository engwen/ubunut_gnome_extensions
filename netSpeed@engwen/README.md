# Net Speed

GNOME 顶栏实时网速。只做一件事：在顶栏显示 `↓ 下行  ↑ 上行`，数字带 K/s 或 M/s 单位。

- 适用：Ubuntu 26.04 LTS / GNOME Shell **49–50**（Wayland、X11 均可）
- 显示：`↓ 12K/s  ↑ 3.4K/s`，纯文字、无背景，不响应点击
- 两种显示方式：**分开显示**（下行、上行各一个数）或 **合并显示**（`⇅ 12.4K/s`，只显示下载 + 上传的合计）
- 间距可调：**箭头与数字的间距**、**下载与上传之间的间距**，都是像素级设置
- 单位：不足 **999K/s** 显示 `K/s`，达到 999K/s 自动切换为 `M/s`（1K = 1024 字节）
- 宽度稳定：数值区域按 `999K/s` 的像素宽度定死，网速跳动时箭头不会左右飘
- 刷新：**1–10 秒**可调，默认 **2 秒**，改完立即生效
- 位置：区域（左 / 中 / 右）+ 区域内排序，默认 **右侧第一个**；加载时被别的扩展插队会自动挪回

## 安装

```bash
cd netSpeed@engwen
./install.sh
```

脚本会把扩展复制到 `~/.local/share/gnome-shell/extensions/netSpeed@engwen`、编译 schema，
并尝试启用。若自动启用失败（常见于脚本没有会话总线），手动来一次：

```bash
gnome-extensions enable netSpeed@engwen
```

GNOME 50 不缓存扩展代码，**改了 `.js` 必须重新登录或重启扩展**；改设置项则即时生效。

```bash
gnome-extensions prefs netSpeed@engwen          # 打开设置
gnome-extensions disable netSpeed@engwen && \
gnome-extensions enable netSpeed@engwen         # 重载代码
```

## 设置项

| 设置 | 键 | 取值 | 默认 |
|---|---|---|---|
| 刷新间隔 | `refresh-interval` | 1–10 秒 | 2 |
| 显示方式 | `display-mode` | `split` / `combined` | `split` |
| 箭头与数字的间距 | `arrow-gap` | 0–20 px | 6 |
| 下载与上传的间距 | `group-gap` | 0–40 px | 10 |
| 顶栏区域 | `position` | `left` / `center` / `right` | `right` |
| 排列位置 | `position-index` | 0 起，0 = 该区域最前 | 0 |

`position-index` 会被夹到该区域现有子项数量以内（设得太大就落到末尾），
避免往不存在的槽位里插。`group-gap` 只在分开显示时可见。

### 位置会被"插队"，所以有守卫

顶栏各区是个 BoxLayout，谁后插入、插第几个，谁就排在前面。扩展加载时别的扩展
（比如系统托盘、背景类插件）可能也正在往同一区域插条目，把我们挤到后面去。

所以 `enable()` 之后会启动一个 30 秒的守卫：每 500ms 检查一次自己的下标，
与 `position-index` 不符就 `set_child_at_index()` 挪回去。只在"还在同一个区域"时动手，
不会把用户有意放到别处的条目硬搬回来。稳定后守卫自动停止，不留常驻定时器。

### 两种显示方式

两者共用同一套「箭头 + 数值」结构，区别只是显示几组：

```
分开显示：  ↓ 12K/s    ↑ 3.4K/s        （↓ 下载、↑ 上传，各一个数）
合并显示：  ⇅ 15.4K/s                  （⇅ 后面是 下载 + 上传 的合计）
```

合并显示的合计值同样走 1024 进制换算，所以两个 800K/s 加起来会显示 `1.6M/s`。

## 实现说明

### 数据来源

`/proc/net/dev`，每块网卡一行，第 1 个字段是累计收字节、第 9 个是累计发字节。
速率 = 两次采样的字节差 ÷ 两次采样之间**真实流逝**的秒数。

用单调时钟（`GLib.get_monotonic_time()`）而不是直接除以"设定的间隔"，
因为主循环被阻塞、系统休眠唤醒后，实际间隔和设定值不一样，后者会算出偏差很大的速率。

### 为什么按接口逐个做差

不是简单比较"总字节数"，而是按**接口名**分别记录上一次的计数、逐个做差再求和。
这样能规避两个常见假象：

1. **新接口出现**：网卡热插拔、VPN 建立时，新接口带着几十 GB 的历史累计值出现，
   若直接比较总量会产生一个巨大的假峰值。只统计两次采样都存在的接口即可避免。
2. **计数器回退**：接口重连或 32 位溢出后计数变小，差值为负。负差按 0 计。

### 统计范围

默认排除 `lo` 以及常见虚拟 / 隧道接口（`docker*`、`veth*`、`br-*`、`virbr*`、`tun*`、
`utun*`、`tap*`、`wg*`、`tailscale*`、`zt*`、`lxc*`、`podman*`、`cni*`、`flannel*`、
`kube*`、`ipsec*`、`nordlynx*`、`mullvad*`）。

排除的原因：回环是纯本机流量；VPN 隧道（如 `utun7`）与物理网卡统计的是同一份流量，
都算会翻倍。注意 `br0` 这类真实网桥不在排除名单里（只排除 `br-` 前缀）。

### 布局与间距

`St.BoxLayout` **没有** `spacing` 这个 GObject 属性。给 `box.spacing = 12` 赋值不会报错，
但只是挂了一个 JS 变量，布局完全不变——踩过一次：设置改了、测试也"通过"了
（测试把这个值读回来了），界面上却一动不动。

所以间距用 `margin-left` 实现，St 会把它算进 preferred size：

```
button
└── box
    ├── pair ↓                 value.margin-left = arrow-gap（箭头 与 数字 之间）
    │   ├── label  ↓
    │   └── label  12K/s
    └── pair ↑                 pair.margin-left  = group-gap（下载组 与 上传组 之间）
        ├── label  ↑
        └── label  3.4K/s
```

改间距/显示方式只走 `_applyLayout()`，不重建组件，所以改设置不会闪。
箭头标签不设固定宽度（多出来的空白会变成看不见的间隔，让间距看起来比设置值大）。

### 数字格式

- `< 10` 保留 1 位小数（`0.4K/s`、`9.9K/s`）
- `>= 10` 取整（`57K/s`、`999K/s`）
- `>= 999K/s` 直接切 M/s（`999K/s` → `1M/s`），所以 K/s 下最多只有 3 位整数
- M/s 同理（`1.5M/s`、`120M/s`）

数值标签的 `min-width` 是**运行时实测**的「999K/s」像素宽度（不是写死的数字，
换字体/缩放也能自适应）。所以 `0K/s` 和 `999K/s` 占的宽度一样，两边的箭头不会左右飘。

代价：数字较短时右侧会留一段空白（最长约 16px），这段空白算在"下载与上传的间距"里。
想要视觉上精确贴合，把 `group-gap` 适当调小；`arrow-gap` 永远是精确的。

## 目录

```
netSpeed@engwen/
├── metadata.json
├── extension.js                 # 顶栏组件 / 定时采样 / 位置重建
├── prefs.js                     # 设置窗口
├── stylesheet.css
├── lib/
│   └── netstat.js               # /proc/net/dev 解析、速率计算、单位换算
├── schemas/
│   └── org.gnome.shell.extensions.netspeed.gschema.xml
└── install.sh
```

## 测试

```bash
# 逻辑单测（单位换算、999 切换点、解析、逐接口做差、假峰值、计数器回退）—— 43 项
gjs --module tools/netspeed-test/test.js

# 无头端到端（真实启动 GNOME Shell）—— 41 项
dbus-run-session -- bash tools/netspeed-e2e/e2e.sh
```

端到端会截图到 `tools/netspeed-e2e/out/`，日志在 `tools/netspeed-e2e/e2e.log`。

它断言的间距是**组件的真实几何位置**（`value.x - (arrow.x + arrow.width)`），
不是把设置值读回来——`St.BoxLayout` 没有 `spacing` 属性这件事，就是靠这个抓出来的。
另外还会模拟"别的扩展往同一区域插队"，验证位置守卫能把条目挪回第一位。

## 已知限制

- 速率是**采样区间内的平均值**，所以刷新间隔设得越大，数字越"平滑"、越滞后于瞬时波动
- 只统计 IPv4/IPv6 网卡的总字节，不区分协议；`lo` 上的本机服务流量不计入
- 数字短时右侧会留空白（宽度按 `999K/s` 预留），所以两个组之间的**视觉**距离会比
  `group-gap` 稍大；`arrow-gap` 不受影响
- 超过 999M/s（约 8Gbps）的极端速度下宽度会超出预留值，会有一点点伸缩
- 界面跟随系统主题，没有单独配色选项

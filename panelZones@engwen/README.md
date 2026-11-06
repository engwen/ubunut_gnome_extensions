# Panel Zones

把 GNOME 顶栏**右侧图标**分成三段，并支持直接拖动换位。

```
[ Activities ]                     [ 最左区 ][ 中间（弹性） ][ 最右区 ]
                                      网速      QQ 微信 VPN     owlshot 天气 壁纸 输入法 系统菜单
```

- 适用：Ubuntu 26.04 LTS / GNOME Shell **49–50**
- 分区：最左 / 中间（弹性）/ 最右，三个区各自有序
- 中间是**弹性区**：没配置过的新图标（新装扩展、新出现的托盘程序）自动落进来
- 拖拽：设置里打开「编辑模式」，直接在顶栏拖；松手保存，**在顶栏右键退出**
- 系统菜单（快速设置）锁定在最右、不可拖动

## 安装

```bash
cd panelZones@engwen
./install.sh
gnome-extensions enable panelZones@engwen
```

GNOME 50 不缓存扩展代码，**改了 `.js` 必须重载**：

```bash
gnome-extensions disable panelZones@engwen && gnome-extensions enable panelZones@engwen
```

## 用法

1. `gnome-extensions prefs panelZones@engwen` 打开设置，打开「编辑模式」。
2. 关掉设置窗口，顶栏右侧的三个区会浮现一层淡底色。
3. 拖着图标左右移动，跨区也行；松手即写入配置。
4. 在顶栏空白处**右键**退出编辑模式（也可以回设置里关掉开关）。

## 三个区怎么决定

每个图标用 `role`（`Main.panel.statusArea` 的键）作为身份。首次启用时会**按你当前的实际顺序接管**，只把 `netspeed` 挪到最左区，其余保持原样——不会一装上就把面板打乱。

| 区 | 默认内容 | 说明 |
|---|---|---|
| 最左 | `netspeed` | 固定贴在最左边 |
| 中间（浮动） | 空 | 未匹配到任何配置的图标都进这里；**新图标插到本区最左边**，已有图标整体右移（和 Windows 通知区域一致） |
| 最右 | 现有全部图标 | 系统菜单强制最后 |

匹配支持简单通配：`appindicator-*` 命中所有托盘图标，`*` 命中全部。

## 图标间距

三个区各有一个独立设置：`gap-left` / `gap-middle` / `gap-right`，范围 0–48 像素，默认 12。0 表示图标内容紧贴边缘。

**压的是图标自身，不是外层容器。** 面板按钮 `PanelMenu.ButtonBox` 的宽度不是 CSS `padding` 算出来的，而是它重写的 `vfunc_get_preferred_width()`：

```
内容宽度 + 2 × _natHPadding
```

而 `_natHPadding` 来自样式属性 `-natural-hpadding`（默认 12px，配套 `-minimum-hpadding` 默认 6px）。所以：

- 给外层 `St_Bin` 写 `padding` 只是把**容器**往两边撑，图标本身还是松的——"看着调了但没变紧凑"。
- 给内层 `panel-button` 写 `padding` 完全没用，因为上面的公式里根本不读 `padding`。

正确做法是给按钮内联 `-natural-hpadding: Npx; -minimum-hpadding: Npx;`。相邻两个图标各出一半，合起来正好等于设置值；奇数间距的 1px 用容器 `spacing` 补足。没有 ButtonBox 的自定义 actor（部分第三方扩展直接塞 widget）退回给外层容器加 `padding`，保证间距仍可控。

两个实测坑：

1. **写完样式必须对按钮调一次 `queue_relayout()`**。shell 的 `_onStyleChanged()` 只更新 `_natHPadding` 字段，没有让自己的 preferred-size 缓存失效。活着的图标（比如网速，每秒刷新标签）会因为子节点重排顺带重算，静态图标则一直沿用旧宽度——同一个设置有的图标生效、有的不生效，很难查。
2. **内联样式里不能有两条同类声明**，St 只认其中一条。所以每次都先剥掉基准样式里的 `padding` / `-natural-hpadding` / `-minimum-hpadding` 再拼，不叠加。

图标自己的内联样式（背景色、高度等）会原样保留，停用时也全部还原，不留痕迹。

## 为什么不会闪

顺序不是 GNOME 的原生能力——每个扩展启动时自己调 `addToStatusArea(role, btn, index, box)`，`ubuntu-appindicators` 每次更新还 `destroy` 再重插到 index 1。如果只是"等它插进 `_rightBox` 再搬走"，中间必然画出一帧错误位置，就是肉眼看到的闪烁。

所以本扩展**拦在插入那一刻**，让图标出生就在正确位置：

1. **接管 `Panel._addToPanelBox`**（`addToStatusArea` 和内置 indicator 的唯一入口）。实测它的 `box` 入参只用于一次 `box.insert_child_at_index`，写 `statusArea`、destroy 回调、`menu-set` 都在 panel/indicator 上——所以把 `box` 换成目标分区容器即可，shell 自己会把记账做对，不需要复制它的逻辑，也就不会跟着 shell 版本漂移。
2. **接管 `_rightBox.insert_child_at_index` / `add_child`**，兜住绕过 shell 直接插的扩展（天气就是这一类）。
3. **记住每个图标上次的位置**。托盘图标会频繁重建，若不记位置，每次重建都会被当成"新图标"插到浮动区最左，看起来像乱跳。重建时按记忆回原位；只有真的从没出现过的图标才享受"插到最左"。
4. `child-added` + 1 秒轮询仍然保留，作为漏网情况的最后兜底；它们的 idle 优先级提到 `PRIORITY_HIGH_IDLE`（100 < Clutter 重绘的 110），就算走这条路也会在下一帧绘制前完成，不产生跳变。

**新图标为什么在最左而不是最右**：`_insertIndex` 对中区的未配置图标返回 0（插到最左），`planLayout` 里中区也用 `unrankedFirst` 排序，两处口径一致——否则插入时在最左、下一秒兜底轮询又把它挪回末尾，会看到一次跳动。

停用时会把这几个方法原样还回去（见"已知限制"第 5 条）。

## 已知限制（重要）

1. **顺序靠常驻维护。** 别的扩展会在运行时重新插入自己的图标，所以分区不是"设一次就永久"，而是由插入拦截 + 兜底轮询持续维持。正常路径下看不到任何跳变；只有绕过 JS 接口（C 层直接 add child）的极端情况会落到兜底路径。
2. **没有 role 的图标只能临时识别。** 例如天气扩展绕开 `addToStatusArea`，直接 `Main.panel._rightBox.insert_child_at_index()`，`statusArea` 里查不到它，只能记成 `orphan:类名#序号`。重新登录后序号可能变，顺序会回落到默认——重新拖一次即可。
3. **系统菜单锁定。** `quickSettings` / `dateMenu` / `activities` 不允许拖动，且强制排在右区末尾；否则消息横幅对齐、键盘导航会出小毛病。
4. **编辑模式会接管面板点击。** 覆盖层存在时，点图标不会打开它原来的菜单——这是刻意的，否则拖拽会被菜单打断。
5. **卸载/停用是干净的**：先还原被接管的方法，再把所有图标按当前顺序还回 `_rightBox` 并销毁分区容器，不留下"图标消失"的烂摊子。

## 目录

```
panelZones@engwen/
├── metadata.json
├── extension.js           # 分区容器 / 纠偏 / 编辑模式拖拽
├── prefs.js               # 编辑开关、当前布局预览、重置
├── stylesheet.css
├── lib/
│   └── layout.js          # 纯逻辑：分区归属 + 区内排序（可单测）
├── schemas/
│   └── org.gnome.shell.extensions.panelzones.gschema.xml
└── install.sh
```

## 测试

```bash
# 纯逻辑单测：分区归属、通配、区内排序、锁定项、幂等（28 项）
gjs --module tools/panelzones-test/layout-test.js

# 无头端到端：真实启动 GNOME Shell，验证分区、插入拦截、编辑态、间距、持久化、卸载还原（37 项）
dbus-run-session -- bash tools/panelzones-test/e2e.sh
```

端到端里最关键的三条断言（对应"不闪"）：

- 注册后**同一个 tick 内**取父容器 → 已经是目标分区，说明从未进过 `_rightBox`
- 绕过 shell 直接 `insert_child_at_index` → 同样当场落进分区
- 图标 `destroy` 后重建 → 当场落回原位置，且顺序不变

另外全程校验 `_rightBox` 子项数恒为 3（三个分区容器），任何一次异常插入都会被这条抓到。

间距也是量真实宽度断言的：把 `gap-middle` 从 0 改到 20，图标宽度必须正好 +20；`gap-left` 改到 4，网速宽度必须 +4（验证三个区互不干扰）；`gap=0` 时按钮宽度必须**等于图标内容宽度**（这条才是"图标真的紧凑了"，只改外层容器是过不了的）；同时断言图标自己的内联样式没被冲掉、停用后 `padding` 和 `-natural-hpadding` 都已还原。

截图在 `tools/panelzones-test/out/`，日志在 `tools/panelzones-test/e2e.log`。

> 注意：端到端能验证"拖拽落位 + 持久化"的逻辑（直接调 `_moveItem` / `_persistFromPanel`），
> 但**真实指针拖拽手感**需要人在桌面上试——无头环境没法可靠合成指针事件。

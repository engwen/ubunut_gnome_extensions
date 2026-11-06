#!/bin/bash
# 安装 / 更新 Panel Zones，并编译 schema
set -e

UUID="panelZones@engwen"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST"
cp -r "$SRC/metadata.json" "$SRC/extension.js" "$SRC/prefs.js" "$SRC/stylesheet.css" \
      "$SRC/lib" "$SRC/schemas" "$DEST"/
glib-compile-schemas "$DEST/schemas"

echo "已安装到: $DEST"
echo

if command -v gnome-extensions > /dev/null 2>&1; then
    # 注意：没有会话总线时 gnome-extensions enable 仍然返回 0（只往 stderr 吐 dconf 警告），
    # 所以不能用它的退出码判断，必须用 info 回查。
    gnome-extensions enable "$UUID" > /dev/null 2>&1 || true

    if gnome-extensions info "$UUID" > /dev/null 2>&1; then
        echo "已启用。打开设置进入编辑模式即可拖动图标。"
    else
        echo "现在连不上 GNOME Shell 的会话总线，没法替你启用。请在自己的桌面终端执行："
        echo "  gnome-extensions enable $UUID"
    fi
fi

echo
echo "打开设置：  gnome-extensions prefs $UUID"
echo "重载扩展：  gnome-extensions disable $UUID && gnome-extensions enable $UUID"
echo
echo "注意：扩展代码改动后必须重载（GNOME 50 不缓存破坏），改设置则即时生效。"

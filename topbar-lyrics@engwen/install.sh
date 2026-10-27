#!/bin/bash
# 安装 / 更新 topbar-lyrics 到当前用户，并编译 schema
set -e

UUID="topbar-lyrics@engwen"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST"
cp -r metadata.json extension.js prefs.js stylesheet.css lib schemas "$DEST"/
glib-compile-schemas "$DEST/schemas"

echo "已安装到: $DEST"
echo

# 尝试直接启用（需要当前用户自己的会话总线）
if command -v gnome-extensions > /dev/null 2>&1; then
    if gnome-extensions enable "$UUID" 2> /dev/null; then
        echo "已启用扩展，顶栏应该马上出现歌词。"
    else
        echo "自动启用失败，请手动启用："
        echo "  gnome-extensions enable $UUID"
        echo "或打开「扩展」App，把 Top Bar Lyrics 打开。"
    fi
fi

echo
echo "打开设置：  gnome-extensions prefs $UUID"

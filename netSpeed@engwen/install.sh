#!/bin/bash
# 安装 / 更新 Net Speed 到当前用户，并编译 schema
set -e

UUID="netSpeed@engwen"
SRC="$(cd "$(dirname "$0")" && pwd)"
DEST="$HOME/.local/share/gnome-shell/extensions/$UUID"

mkdir -p "$DEST"
cp -r "$SRC/metadata.json" "$SRC/extension.js" "$SRC/prefs.js" "$SRC/stylesheet.css" \
      "$SRC/lib" "$SRC/schemas" "$DEST"/
glib-compile-schemas "$DEST/schemas"

echo "已安装到: $DEST"
echo

if command -v gnome-extensions > /dev/null 2>&1; then
    # 没有会话总线时 enable 的退出码依然是 0，只能靠 info 回查真实状态
    gnome-extensions enable "$UUID" > /dev/null 2>&1 || true

    if gnome-extensions info "$UUID" > /dev/null 2>&1; then
        echo "已启用，顶栏应该马上出现网速。"
    else
        echo "自动启用失败（多半是当前 shell 读不到你的会话总线），请手动启用："
        echo "  gnome-extensions enable $UUID"
        echo "或打开「扩展」App，把 Net Speed 打开。"
    fi
fi

echo
echo "打开设置：  gnome-extensions prefs $UUID"
echo "重载扩展：  gnome-extensions disable $UUID && gnome-extensions enable $UUID"

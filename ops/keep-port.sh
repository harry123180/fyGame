#!/bin/sh
# 每 10 分鐘向路由器（UPnP）重新登記：外部 443 → 本機 3443（fyGame HTTPS 直連）
# 路由器重開機或 m8s 區網 IP 變動都會自動補回
cd "$HOME" || exit 1
IP=$(ip -4 route get 192.168.0.1 | grep -oE "src [0-9.]+" | cut -d" " -f2)
python3 -I "$HOME/services/fygame/net/upnp.py" add 443 "$IP" 3443 fygame-direct 3600

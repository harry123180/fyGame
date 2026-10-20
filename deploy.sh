#!/usr/bin/env bash
# 把 site/ 與 server/ 推到 harry-m8s-server，網址 https://fygame.qianpro.shop
# - site/ 是 bind mount，只改前端時不會重啟容器，玩家不會斷線
# - server/ 有變動時才會重建映像檔並重啟（玩家會自動重連）
set -euo pipefail
cd "$(dirname "$0")"

HOST=harry-m8s-server
REMOTE=/home/tsic/services/fygame

ssh -o ConnectTimeout=10 "$HOST" "mkdir -p $REMOTE/html && rm -f $REMOTE/nginx.conf"
scp -q -o ConnectTimeout=10 server/docker-compose.yml server/Dockerfile server/package.json server/server.js "$HOST:$REMOTE/"

# 最高準則是不快取（伺服器送 no-store）；這裡再替 index.html 引用的本地 .js/.css 加版本號做雙重保險
STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT
cp -r site/. "$STAGE/"
VER=$(date +%s)
sed -i -E "s#((src|href)=\"[^\":]+\.(js|css))\"#\1?v=$VER\"#g" "$STAGE/index.html"
# 伺服器看到 version.txt 變了會通知所有玩家自動重新整理
echo "$VER" > "$STAGE/version.txt"
tar -C "$STAGE" -cf - . | ssh "$HOST" "rm -rf $REMOTE/html/* && tar -C $REMOTE/html -xf -"

ssh "$HOST" "cd $REMOTE && docker compose up -d --build --quiet-pull 2>&1 | grep -vE '^ *(#|=>)' || true"
ssh "$HOST" "curl -fsS http://127.0.0.1:3190/healthz" && echo
echo "已部署 → https://fygame.qianpro.shop"

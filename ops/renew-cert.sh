#!/bin/sh
# 每週檢查 Let's Encrypt 憑證，30 天內到期就續期（Cloudflare DNS 驗證）；遊戲伺服器每 12 小時自動重讀
docker run --rm -v "$HOME/services/fygame/letsencrypt:/etc/letsencrypt" -v "$HOME/services/fygame/net/cf.ini:/cf.ini:ro" certbot/dns-cloudflare:latest renew --quiet

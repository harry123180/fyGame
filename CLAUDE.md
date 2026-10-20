# fyGaming

手機瀏覽器多人連線遊戲，現場約 40 人同時連線。使用者與玩家都是繁體中文使用者。

## ⚠️ 最高準則

### 1. 完全不快取

這個專案會快速迭代，**任何一層都不能快取**，部署後重新整理一定要看到新版。

- `server/server.js` 對所有回應送 `Cache-Control: no-store, no-cache, must-revalidate, max-age=0`。不要移除或放寬。
- `no-store` 是必要的：只送 `no-cache` 的話，Cloudflare 會把 js/css 改成 `max-age=14400`（zone 的 Browser Cache TTL），手機會吃到 4 小時前的舊版。cert.pem 的 token 沒有 Cache Rules 權限，只能從 origin 控制。
- `deploy.sh` 另外會在 `index.html` 引用的本地 `.js`/`.css` 後面加 `?v=<時間戳>`，雙重保險。新增 js/css 時請放在 `index.html` 用 `src=`/`href=` 直接引用。
- `site/sw.js` 只為了讓 PWA 可安裝：**不准用 Cache Storage**、fetch 一律 `cache: 'no-store'` 走網路。不要加離線快取、預先快取、`localStorage` 快取資源等任何會留舊版的機制。
- 驗證：`curl -sI https://fygame.qianpro.shop/game.js` 的 Cache-Control 要含 `no-store`。（現在直連不經過 Cloudflare；若切回 tunnel，js 要看到 `cf-cache-status: BYPASS`、html 是 `DYNAMIC`）

### 2. 手機瀏覽器優先、PWA、響應式

- 主要裝置是手機瀏覽器（iOS Safari、Android Chrome），要能「加到主畫面」以 standalone 執行（`manifest.webmanifest` + `sw.js` + `icons/`）。
- 直式、橫式、平板、電腦都要能玩：
  - 世界畫面依螢幕短邊自動縮放（`VIEW_SHORT_SIDE`），不同螢幕看到的範圍差不多。
  - UI 尺寸用 `clamp()`／`vmin`；橫式矮螢幕（`max-height: 500px`）有專用排版。
  - 所有固定在邊緣的 UI 都要加 `env(safe-area-inset-*)`（瀏海、圓角、Home 條）。
- 輸入框字體至少 16px（iOS 才不會自動放大）；虛擬鍵盤彈出時用 `visualViewport` 把聊天列頂上去。
- 操作以觸控為主（Pointer Events），鍵盤 WASD 只是電腦測試用。

### 3. 繁體中文

- 全程 UTF-8：伺服器每個文字類型的 Content-Type 都要帶 `charset=utf-8`，HTML 有 `<meta charset="utf-8">`、`lang="zh-Hant"`。
- 中文輸入法：選字時按 Enter 是確認選字，不能觸發送出（檢查 `isComposing`／`compositionstart`／`keyCode 229`）。
- 文字長度以「字」計算：伺服器用 `Array.from()` 切，前端換行用 `Intl.Segmenter`，不要用 `.slice()`／`.length` 直接切 UTF-16。
- 伺服器 `cleanText()` 做 NFC 正規化並濾掉控制字元、零寬字元、方向覆寫字元；ID 比對用 NFKC（全形半形視為同一個）。
- 字型：`system-ui, -apple-system, "PingFang TC", "Noto Sans TC", sans-serif`。
- 介面文字、註解、commit 訊息都用繁體中文。

## 遊戲設計主軸：PVE 組隊打 BOSS

- 玩家都是「黃色奶龍」（參考圖 `assets-src/nailong/reference.jpg`），進場選職業：
  **補師奶龍**、**戰士奶龍**、**弓箭手奶龍**、**法師奶龍**
- 核心玩法是現場約 40 人一起組隊合作打 BOSS（PVE），不是玩家互打
- 素材路線：先做基礎奶龍精靈圖（待機＋走路），再以它為參考，用 codex 生成四個職業的變體
  （各自的武器／裝備＋攻擊動畫），保持同一隻角色、同一套像素風與色盤
- 精靈圖後製：`tools/make_sprite.py`（切格、去洋紅背景、縮成真正 32×32 像素、腳底對齊）

## 設計原則

- **少用 emoji**：圖示、表情、道具等之後都會換成遊戲素材貼圖（codex 生成）。介面與遊戲內不要用 emoji 當圖示。
- 伺服器權威：客戶端只送搖桿方向，位置由伺服器計算後廣播（20Hz），客戶端內插顯示。
- 文字一律用 `textContent`／canvas `fillText` 顯示，不用 `innerHTML`。

## 架構

設計意圖、協定、職業與 BOSS 數值的說明都在 **DESIGN.md**，改設計時要同步更新它。

| 項目 | 值 |
|---|---|
| 網址 | https://fygame.qianpro.shop |
| 原始碼 | https://github.com/harry123180/fyGame（公開） |
| 主機 | `harry-m8s-server`（`~/services/fygame`） |
| 容器 | `fygame`（node:22-alpine + ws），`127.0.0.1:3190` → 3000；`html/` 為 bind mount |
| 對外 | **直連**（2026-10-20 起）：DNS `fygame.qianpro.shop` A → 家用固定 IP 122.117.223.77（不經過 Cloudflare 代理，TTL 60）；路由器 TP-Link Archer AX73 用 UPnP 把外部 443 → m8s 3443；容器內 Node 直接提供 HTTPS（Let's Encrypt，Cloudflare DNS 驗證）。原因：Cloudflare 免費方案把台灣流量繞到美國，延遲 280ms → 直連 4～50ms |
| 直連維運 | `~/services/fygame/net/`：`keep-port.sh`（cron 每 10 分鐘向路由器重新登記轉發）、`renew-cert.sh`（cron 每週一續期）、`upnp.py list/add/del`；憑證在 `~/services/fygame/letsencrypt/`；腳本副本在 repo 的 `ops/`。Cloudflare token 只在伺服器 `net/cf.ini`、`net/cf.json`（不進 git） |
| 備援（還原成 Cloudflare） | tunnel `qianpro-tunnel` 的 ingress 仍保留 `fygame → localhost:3190`。直連出問題時在 m8s 執行 `cloudflared tunnel route dns --overwrite-dns qianpro-tunnel fygame.qianpro.shop` 就切回去（原紀錄備份在 `net/dns_backup.json`） |
| BOSS 聊天 | LiteLLM（ai.qianpro.shop）`gemma4-31b`，專用 key alias `fygame-boss`；key 只在伺服器 `~/services/fygame/.env`，**不可進 git** |
| 健康檢查 | `/healthz`；職業表 `/api/classes` |
| 備援主機 | QianProServer（m8s 撐不住時再搬；3190 已被占用要換 port） |

- `site/`：前端（純 HTML/CSS/JS + Canvas，PWA）
- `server/`：Node 伺服器（靜態檔 + WebSocket `/ws`）、Dockerfile、compose
- `tools/`：`make_sprite.py`（生成圖 → 像素精靈圖）、`make_icons.py`、`loadtest.mjs`
- `assets-src/`：素材原始檔與 brief；素材生成一律派 subagent 用 codex 做
- `deploy.sh`：一鍵部署。只改 `site/` 不重啟容器；改到 `server/` 才重建。部署會寫 `version.txt`，所有手機自動重新整理並重新進場

### 本機測試

本機 3000 port 被別的程式占用，用 `PORT=3999 node server.js` 跑（把 `site/` 複製成旁邊的 `html/`）。

### 壓力測試

```bash
scp tools/loadtest.mjs harry-m8s-server:/tmp/ && ssh harry-m8s-server   'docker cp /tmp/loadtest.mjs fygame:/app/ && docker exec fygame node loadtest.mjs wss://fygame.qianpro.shop/ws 40 30'
```

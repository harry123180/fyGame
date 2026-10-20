# fyGame：奶龍組隊打 BOSS

手機瀏覽器就能玩的多人合作遊戲。大家都是黃色奶龍，選職業（戰士、弓箭手、法師、補師），一起打地圖中央的 BOSS「舞王」。這是一個在課堂上用 AI 快速迭代（vibe coding）做出來的開源教學專案。

- 線上試玩：<https://fygame.qianpro.shop>（手機打開，可以「加到主畫面」）
- 設計意圖與架構：[DESIGN.md](DESIGN.md)

## 功能

- 輸入遊戲 ID、選職業進場，斷線會自動接回原角色
- 浮動搖桿移動；三個技能按鈕（普攻按住連發）
- 四個職業各有三招：嘲諷、衝鋒、多重箭、翻滾、隕石、閃現、治療、復活
- BOSS 三招：閃身步、狗熊哆嗦毛、浪子踢球，每招都先顯示紅色預警，看得到就閃得掉
- HP／MP／EXP、等級制、經驗球、補血果實
- 聊天室與頭頂對話泡泡；BOSS 會用 Gemma4 加顏文字回應大家
- PWA、響應式（直式、橫式、平板、電腦），全程繁體中文
- 部署後所有手機自動更新

## 本機執行

需要 Node.js 22。

```bash
cd server
npm install
mkdir -p html && cp -r ../site/. html/       # 或改用符號連結
PORT=3000 node server.js
```

打開 <http://localhost:3000>。電腦上可以用 WASD 移動、J／空白鍵普攻、K／L 放技能。

BOSS 聊天需要 OpenAI 相容的 LLM API（選用），沒設定時 BOSS 就不說話：

```bash
LLM_BASE_URL=https://your-gateway/v1 LLM_MODEL=gemma4-31b LLM_API_KEY=sk-... node server.js
```

## 專案結構

```
site/            前端（純 HTML/CSS/JS + Canvas，不用 build）
  sprites/       遊戲用像素精靈圖
server/          Node 伺服器（靜態檔 + WebSocket）、Dockerfile、docker-compose
tools/           make_sprite.py（生成圖 → 像素精靈圖）、make_icons.py、loadtest.mjs
assets-src/      素材原始檔：參考圖、codex 生成的原圖、brief、後製結果
deploy.sh        一鍵部署到伺服器
DESIGN.md        設計意圖
CLAUDE.md        給 AI 助手看的專案準則
```

## 壓力測試

```bash
cp tools/loadtest.mjs server/ && cd server && node loadtest.mjs wss://your-host/ws 40 30   # 40 個機器人、30 秒（借用 server 的 ws 套件）
```

## 素材來源與版權

- 程式碼以 MIT 授權釋出（見 [LICENSE](LICENSE)）。
- `assets-src/` 與 `site/sprites/` 的圖是用 codex（ChatGPT 圖片生成）生成的像素圖。**MIT 授權不涵蓋這些素材。**
- 「奶龍」角色屬於原作者的 IP；BOSS 的動作取材自網路流行的舞台表演迷因，`assets-src/*/ref/` 與 `assets-src/nailong/reference.jpg` 是網路上的參考圖與影片拆格。這些只作為課堂教學示範之用，權利屬於原權利人。如有侵權疑慮，請開 issue，我們會移除。

// fyGame 客戶端：選職業、浮動搖桿移動、技能、組隊打 BOSS、聊天與頭頂對話泡泡
const $ = (id) => document.getElementById(id);
const canvas = $('game');
const ctx = canvas.getContext('2d');
const mini = $('minimap');
const mctx = mini.getContext('2d');

const SEND_INTERVAL_MS = 50;
const CHATLOG_SHOW = 5;
const BUBBLE_MAX_W = 180;
const VIEW_SHORT_SIDE = 640; // 螢幕短邊固定看到約這麼多世界單位，大小螢幕視野一致（要看得到 BOSS 的震波範圍）
const FONT = 'system-ui, -apple-system, "PingFang TC", "Noto Sans TC", sans-serif';

let ws = null, myId = null, map = { w: 2400, h: 1600, r: 22 };
let joined = false, myName = '', myCls = 'warrior', myChar = 'nailong', reconnectTimer = null;
let CLASSES = null, CHARS = null, bossCfg = { name: 'BOSS', r: 60 };
const players = new Map(); // id -> { id, name, hue, cls, x, y, tx, ty, hp, mp, flags, ... }
const orbs = new Map();
const xpOrbs = new Map();    // 經驗球
let myExp = { lv: 1, exp: 0, next: 50, catchup: 1 };
let mySpeedMult = 1.5;
const balls = [];
const effects = [];        // 畫面特效（預警、震波、投射物、傷害數字…）
const boss = { x: 1200, y: 800, tx: 1200, ty: 800, hp: 0, maxHp: 1, level: 0, alive: false, anim: 0, animStart: 0 };
const cam = { x: 0, y: 0 };
const readyAt = [0, 0, 0];
const cdTotal = [0, 0, 0];   // 實際冷卻時間（前三名有冷卻縮減，以伺服器回的為準）
let top3 = [], topBuff = [];
const topRank = (id) => top3.indexOf(id); // -1 表示不在前三名
let deadSince = 0;

// ---------- PWA ----------
// sw.js 不快取任何東西，只讓瀏覽器把網站當成可安裝的 App
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => {});
}
let installPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPrompt = e;
  $('installbtn').hidden = false;
});
$('installbtn').addEventListener('click', async () => {
  if (!installPrompt) return;
  installPrompt.prompt();
  await installPrompt.userChoice;
  installPrompt = null;
  $('installbtn').hidden = true;
});
const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
if (/iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone) $('iosinstall').hidden = false;

// ---------- 精靈圖 ----------
// 每張都是 4 欄；格子大小由圖寬 / 4 算出，腳底對齊在格子底部往上 2px（tools/make_sprite.py 的規則）
// 職業圖 sprites/<職業>.png：3 列（待機、走路、攻擊）；沒有的話退回基礎奶龍 nailong.png（2 列）
function loadSheet(src, cols = 4) {
  const s = { img: new Image(), ready: false, failed: false, size: 0, rows: 0, top: 0 };
  s.img.onerror = () => { s.failed = true; };
  s.img.onload = () => {
    s.size = s.img.width / cols;
    s.rows = Math.round(s.img.height / s.size);
    // 量出第一列裡角色最高的位置（用來放血條和對話泡泡）
    const c = document.createElement('canvas');
    c.width = s.img.width; c.height = s.size;
    const g = c.getContext('2d');
    g.drawImage(s.img, 0, 0);
    const d = g.getImageData(0, 0, c.width, c.height).data;
    for (let y = 0; y < c.height; y++) {
      let hit = false;
      for (let x = 0; x < c.width && !hit; x++) hit = d[(y * c.width + x) * 4 + 3] > 0;
      if (hit) { s.top = y; break; }
    }
    s.ready = true;
    renderClassCards();
  };
  s.img.src = src;
  return s;
}
const sheets = {
  base: loadSheet('sprites/nailong.png'),
  warrior: loadSheet('sprites/warrior.png'),
  archer: loadSheet('sprites/archer.png'),
  mage: loadSheet('sprites/mage.png'),
  healer: loadSheet('sprites/healer.png'),
  boss: loadSheet('sprites/boss.png'),
  ball: loadSheet('sprites/ball.png'),
};
// 技能特效精靈圖：每張 6 欄，每列一個特效（出現→最大→消散），由 codex 生成、make_sprite.py --align none 後製
const fxSheets = Object.fromEntries(['warrior', 'archer', 'mage', 'healer', 'boss', 'cast']
  .map((k) => [k, loadSheet(`sprites/fx/fx_${k}.png`, 6)]));
const PLAYER_CELL = 76;   // 玩家一格在世界裡的大小（40px 圖 × 1.9）
const BOSS_CELL = 240;    // BOSS 一格在世界裡的大小（約玩家的 3 倍）
// 角色＋職業的精靈圖：吉伊卡哇等角色在 sprites/<角色>/<職業>.png，用到時才載入；
// 還沒生成好（載入失敗）時退回奶龍的職業圖，再退回基礎奶龍
const charSheets = {};
function sheetFor(cls, char = 'nailong') {
  if (char && char !== 'nailong') {
    const key = `${char}/${cls}`;
    const s = charSheets[key] ??= loadSheet(`sprites/${key}.png`);
    if (s.ready) return s;
  }
  return sheets[cls]?.ready ? sheets[cls] : sheets.base;
}
const charName = (char) => CHARS?.[char]?.name ?? '奶龍';
// BOSS 各招的動畫長度（毫秒），4 格平均分配
const BOSS_ANIM_MS = [0, 1300, 1800, 1400];

// ---------- 畫面尺寸 ----------
let W = 0, H = 0, zoom = 1, dpr = 1;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = canvas.clientWidth; H = canvas.clientHeight;
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  zoom = Math.max(0.5, Math.min(1.4, Math.min(W, H) / VIEW_SHORT_SIDE));
  mini.width = Math.round(mini.clientWidth * dpr); mini.height = Math.round(mini.clientHeight * dpr);
}
window.addEventListener('resize', resize);
window.addEventListener('orientationchange', () => setTimeout(resize, 200));
resize();

// 虛擬鍵盤彈出時，把聊天列頂到鍵盤上方
const chatbar = $('chatbar');
function placeChatbar() {
  const vv = window.visualViewport;
  if (!vv) return;
  const offset = window.innerHeight - vv.height - vv.offsetTop;
  chatbar.style.transform = offset > 0 ? `translateY(${-offset}px)` : '';
}
window.visualViewport?.addEventListener('resize', placeChatbar);
window.visualViewport?.addEventListener('scroll', placeChatbar);
$('chatinput').addEventListener('focus', () => document.body.classList.add('typing'));
$('chatinput').addEventListener('blur', () => document.body.classList.remove('typing'));

// ---------- 選職業 ----------
fetch('api/classes').then((r) => r.json()).then((c) => { CLASSES = c; renderClassCards(); }).catch(() => {});
fetch('api/chars').then((r) => r.json()).then((c) => { CHARS = c; renderCharCards(); renderClassCards(); }).catch(() => {});
try { myCls = localStorage.getItem('lastCls') || myCls; myChar = localStorage.getItem('lastChar') || myChar; } catch {}

function renderCharCards() {
  if (!CHARS) return;
  const box = $('chars');
  box.replaceChildren();
  for (const [key, c] of Object.entries(CHARS)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'char' + (key === myChar ? ' on' : '');
    const img = document.createElement('img');
    img.src = `sprites/chars/${key}.png`;
    img.alt = '';
    const name = document.createElement('span');
    name.textContent = c.name;
    b.append(img, name);
    b.addEventListener('click', () => {
      myChar = key;
      try { localStorage.setItem('lastChar', key); } catch {}
      renderCharCards();
      renderClassCards();
    });
    box.append(b);
  }
}

function renderClassCards() {
  if (!CLASSES) return;
  const box = $('classes');
  box.replaceChildren();
  for (const [key, c] of Object.entries(CLASSES)) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'cls' + (key === myCls ? ' on' : '');
    const cv = document.createElement('canvas');
    cv.width = 48; cv.height = 48;
    const s = sheetFor(key, myChar);
    if (s.ready) {
      const g = cv.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(s.img, 0, 0, s.size, s.size, 0, 0, 48, 48);
    }
    const t = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = `${c.name}${charName(myChar)}`;
    const role = document.createElement('small');
    role.textContent = `${c.role}｜HP ${c.hp}・MP ${c.mp}`;
    const desc = document.createElement('small');
    desc.textContent = c.desc;
    t.append(name, role, desc);
    b.append(cv, t);
    b.addEventListener('click', () => {
      myCls = key;
      try { localStorage.setItem('lastCls', key); } catch {}
      renderClassCards();
    });
    box.append(b);
  }
}

// ---------- 連線 ----------
// 身分 token 存在 localStorage：手機把分頁丟掉重開也還在，30 分鐘內用同一個 ID 回來會接回原本的角色
const tokenKey = () => 'token:' + myName.normalize('NFKC').toLowerCase();
function loadToken() {
  try { return localStorage.getItem(tokenKey()) || sessionStorage.getItem(tokenKey()); } catch { return null; }
}
function saveToken(t) {
  try { localStorage.setItem(tokenKey(), t); } catch { try { sessionStorage.setItem(tokenKey(), t); } catch {} }
}

let lastMsgAt = 0, retries = 0;
// 延遲與 FPS：每 2 秒量一次來回時間，連同 FPS 回報給伺服器（/api/netstats 可查每個人）
let myRtt = 0, fps = 0, fpsFrames = 0, fpsAt = performance.now();
// 手機效能保護：FPS 連續偏低就關掉發光（shadowBlur 在手機上很吃效能），恢復後再打開
let lowFx = false, lowFxScore = 0;
const glow = (b) => (lowFx ? 0 : b);
setInterval(() => {
  if (!joined || ws?.readyState !== 1) return;
  ws.send(JSON.stringify({ t: 'ping', c: performance.now(), rtt: Math.round(myRtt), fps, ua: navigator.userAgent.slice(0, 80) }));
}, 2000);
function connect() {
  if (ws) { ws.onclose = null; ws.onmessage = null; try { ws.close(); } catch {} }
  clearTimeout(reconnectTimer);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const sock = new WebSocket(`${proto}://${location.host}/ws`);
  ws = sock;
  lastMsgAt = performance.now();
  sock.onopen = () => {
    setStatus(true);
    sock.send(JSON.stringify({ t: 'join', name: myName, cls: myCls, char: myChar, auto: autoAtk, token: loadToken() }));
  };
  sock.onmessage = (e) => { lastMsgAt = performance.now(); retries = 0; handle(JSON.parse(e.data)); };
  sock.onclose = (e) => {
    if (ws !== sock) return;
    setStatus(false);
    // 4001：同一個 ID 在別的分頁或裝置登入，這邊停止重連，不然兩邊會無限互踢
    if (e.code === 4001) { kickedOut('這個 ID 在別的分頁或裝置登入了'); return; }
    // 已進入遊戲的人自動重連
    // 第一次 0.5 秒後重連，之後逐步拉長到最多 5 秒（伺服器重啟期間不要狂敲）
    if (joined) reconnectTimer = setTimeout(connect, Math.min(5000, 500 * 2 ** retries++));
  };
}

// 假連線偵測：伺服器每秒送 20 次快照，超過 4 秒沒收到任何訊息就當作斷了，直接重連。
// iOS 從背景回來時 WebSocket 常常還顯示 OPEN，其實早就被伺服器斷掉，不這樣做會卡住不動
const STALE_MS = 4000;
let lastWatch = performance.now();
setInterval(() => {
  const now = performance.now();
  // 這次檢查本身遲到很久＝網頁自己卡住了（例如語音合成、分頁在背景），訊息其實還排在後面等處理，
  // 不是伺服器沒送；這種情況先不重連，下一輪再看
  const stalled = now - lastWatch > 2000;
  lastWatch = now;
  if (stalled) return;
  if (joined && ws?.readyState === 1 && now - lastMsgAt > STALE_MS) { diag('stale-reconnect'); setStatus(false); connect(); }
}, 1000);

// 診斷：網頁出錯、重新整理、被踢回進場畫面時，把原因回報給伺服器記錄（/api/diag）
function diag(kind, detail = '') {
  try {
    const body = JSON.stringify({ kind, detail: String(detail).slice(0, 300), name: myName, joined, ua: navigator.userAgent.slice(0, 120) });
    navigator.sendBeacon?.('api/diag', new Blob([body], { type: 'text/plain' }));
  } catch {}
}
window.addEventListener('error', (e) => diag('error', `${e.message} @${e.filename?.split('/').pop()}:${e.lineno}`));
window.addEventListener('unhandledrejection', (e) => diag('rejection', e.reason?.message ?? e.reason));
let leaveReason = '';
window.addEventListener('pagehide', () => { if (joined || leaveReason) diag('pagehide', leaveReason || 'unknown'); });

// 手機切回前景：連線不正常就立刻重連，不用等
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !joined) return;
  if (ws?.readyState !== 1 || performance.now() - lastMsgAt > 1500) connect();
});
window.addEventListener('online', () => { if (joined) connect(); });

function kickedOut(msg) {
  diag('kicked', msg);
  joined = false;
  clearTimeout(reconnectTimer);
  if (ws) { ws.onclose = null; try { ws.close(); } catch {} }
  $('netmsg').hidden = true;
  $('joinerr').textContent = msg;
  $('join').classList.remove('hidden');
}

function setStatus(on) {
  $('dot').classList.toggle('on', on);
  $('netmsg').hidden = on || !joined;
}

// ---------- 自動更新 ----------
// 部署新版後伺服器會通知；重新整理後用同一個 ID、職業自動進場（token 在 localStorage，會接回原本的角色）
let myVer = '', justUpdated = false;
// 網頁一打開就記住自己是哪一版（deploy.sh 寫的 version.txt），之後跟伺服器比對
const fetchVer = () => fetch('version.txt', { cache: 'no-store' }).then((r) => (r.ok ? r.text() : '')).then((v) => v.trim()).catch(() => '');
fetchVer().then((v) => { if (!myVer) myVer = v; });
// 還停在進場畫面（沒有 WebSocket 通知）時，每 5 秒自己檢查一次，有新版就直接重新整理
setInterval(async () => {
  if (joined || !myVer || document.visibilityState !== 'visible') return;
  const v = await fetchVer();
  if (v && v !== myVer) location.reload();
}, 5000);
function reloadForUpdate() {
  leaveReason = 'update';
  try { sessionStorage.setItem('autojoin', JSON.stringify({ name: myName, cls: myCls, char: myChar })); } catch {}
  joined = false;
  ws.onclose = null;
  ws.close();
  banner('更新中…');
  setTimeout(() => location.reload(), 300 + Math.random() * 1500); // 錯開，40 支手機不要同一瞬間重連
}

function handle(m) {
  switch (m.t) {
    case 'error':
      $('joinerr').textContent = m.msg;
      diag('join-error', m.msg);
      // 重連時被拒（例如超過 30 分鐘、ID 被別人用走）：回到進場畫面讓玩家換 ID
      joined = false;
      ws.onclose = null; ws.close(); setStatus(false);
      $('join').classList.remove('hidden');
      break;
    case 'ver': if (myVer && m.v !== myVer) reloadForUpdate(); break;
    case 'kicked': kickedOut(m.msg); break;
    case 'feedbackok':
      $('feedback').hidden = true;
      fbStars = 0; $('fbtext').value = ''; $('fbidea').value = ''; renderStars();
      toast('謝謝你的回饋！');
      break;
    case 'pong': myRtt = performance.now() - m.c; break;
    case 'welcome': {
      // 斷線重連時發現伺服器已經是新版（例如部署重啟），也要重新整理
      if (myVer && m.ver && m.ver !== myVer) return reloadForUpdate();
      myVer = m.ver || myVer;
      if (justUpdated) { justUpdated = false; setTimeout(() => toast('已更新到最新版'), 300); }
      joined = true; myId = m.id; map = m.map; CLASSES = m.classes; CHARS = m.chars; bossCfg = m.bossCfg;
      saveToken(m.token);
      try { localStorage.setItem('lastName', myName); } catch {}
      players.clear(); orbs.clear(); xpOrbs.clear(); balls.length = 0; effects.length = 0;
      for (const p of m.players) addPlayer(p);
      for (const o of m.orbs) orbs.set(o.id, o);
      for (const o of m.xpOrbs) xpOrbs.set(o.id, o);
      stageIdx = m.stageIdx ?? -1; terrainFx = m.terrainFx || {}; loadStages();
      powerups.clear(); for (const u of m.powerups || []) powerups.set(u.id, u);
      setBoss(m.boss, true);
      m.cds.forEach((ms, k) => { readyAt[k] = performance.now() + ms; cdTotal[k] = ms; });
      top3 = m.top3 || []; topBuff = m.topBuff || [];
      $('chatlog').replaceChildren();
      for (const c of m.chat) addChat(c, false);
      $('join').classList.add('hidden');
      setupSkills();
      resize();
      const me = players.get(myId);
      cam.x = me.x; cam.y = me.y;
      updateOnline();
      break;
    }
    case 'join': addPlayer(m.p); updateOnline(); break;
    case 'leave': players.delete(m.id); updateOnline(); break;
    case 'chat': addChat(m, true); break;
    case 'cd': readyAt[m.k] = performance.now() + m.ms; cdTotal[m.k] = m.ms; break;
    case 'toast': toast(m.msg); if (m.speedMult) mySpeedMult = m.speedMult; break;
    case 'exp': myExp = m; break;
    case 'rank': rankData = m; renderRank(); break;
    case 's': {
      const now = performance.now();
      for (let i = 0; i < m.s.length; i += 6) {
        const p = players.get(m.s[i]);
        if (!p) continue;
        const dx = m.s[i + 1] - p.tx, dy = m.s[i + 2] - p.ty;
        if (Math.abs(dx) > 0.5) p.face = dx < 0 ? -1 : 1;
        if (Math.hypot(dx, dy) > 1) p.movingUntil = now + 150;
        p.tx = m.s[i + 1]; p.ty = m.s[i + 2];
        p.hp = m.s[i + 3]; p.mp = m.s[i + 4]; p.flags = m.s[i + 5];
      }
      setBoss(m.b, false);
      if (m.fx) for (const f of m.fx) onFx(f, now);
      break;
    }
  }
}

function addPlayer(p) {
  const c = CLASSES?.[p.cls];
  players.set(p.id, {
    ...p, tx: p.x, ty: p.y, hp: p.maxHp ?? c?.hp ?? 100, mp: p.maxMp ?? c?.mp ?? 100, flags: 0,
    bubble: null, bubbleUntil: 0, face: 1, movingUntil: 0, atkUntil: 0,
  });
}
function updateOnline() { $('online').textContent = players.size; }

function setBoss(b, snap) {
  if (b.anim !== boss.anim || snap) boss.animStart = performance.now() - b.animMs;
  Object.assign(boss, { tx: b.x, ty: b.y, hp: b.hp, maxHp: b.maxHp, level: b.level, alive: b.alive, anim: b.anim });
  if (snap) { boss.x = b.x; boss.y = b.y; }
}

// ---------- 特效事件 ----------
// 加一個精靈圖特效。anchor：center（以 x,y 為中心）或 feet（圖的底部貼在 y）；layer：ground 畫在角色下面
function spr(sheet, row, x, y, size, life, now, o = {}) {
  effects.push({ k: 'spr', sheet, row, x, y, size, life, born: now + (o.delay || 0), anchor: o.anchor || 'center', layer: o.layer || 'air', loop: o.loop, flip: o.flip, fall: o.fall });
}

// 施放特效：出手當下在施法者身上
function castFx(p, skill, now) {
  const feet = p.y + map.r;
  if (p.cls === 'warrior' && skill === 0) spr('cast', 0, p.x + p.face * 24, p.y - 10, 90, 300, now, { flip: p.face < 0 });
  else if (p.cls === 'archer' && skill < 2) spr('cast', 1, p.x + p.face * 22, p.y - 14, 80, 320, now);
  else if (p.cls === 'mage' && skill < 2) spr('cast', 2, p.x, feet + 8, 120, 420, now, { anchor: 'feet', layer: 'ground' });
  else if (p.cls === 'healer') spr('cast', 3, p.x, feet + 8, 120, 420, now, { anchor: 'feet', layer: 'ground' });
}

function onFx(f, now) {
  const p = f.id != null ? players.get(f.id) : null;
  // 華麗特效（精靈圖）；原本的圓圈與線條保留，因為它們標示的是實際的判定範圍
  switch (f.k) {
    case 'atk': if (p && !(p.id === myId && now - (p.localAtkAt ?? 0) < 600)) castFx(p, f.s, now); break;
    case 'slash': {
      const flip = p ? p.x > f.x : false;
      spr('warrior', 0, f.x + (flip ? 30 : -30), f.y - 40, 160, 320, now, { flip });
      spr('cast', 4, f.x, f.y - 50, 100, 300, now, { delay: 60 });
      break;
    }
    case 'taunt': if (p) spr('warrior', 1, p.x, p.y - 10, 220, 600, now); break;
    case 'dash':
      if (f.kind === 'charge') spr('warrior', 2, f.x, f.y + map.r + 6, 130, 450, now, { anchor: 'feet', layer: 'ground', flip: f.dx < 0 });
      else spr('archer', 2, f.x, f.y - 6, 120, 450, now);
      break;
    case 'proj':
      // 飛到 BOSS 時播命中特效（延後 dur 才出現）
      if (f.kind === 'arrow') spr('archer', 1, boss.x, boss.y - 50, 110, 350, now, { delay: f.dur });
      else spr('cast', 5, boss.x, boss.y - 50, 100, 320, now, { delay: f.dur });
      break;
    case 'mark': spr('mage', 1, f.x, f.y - 30, 130, f.dur, now, { fall: 420 }); break;
    case 'boom': spr('mage', 2, f.x, f.y - 30, f.r * 2.4, 520, now); break;
    case 'blink':
      spr('mage', 3, f.x1, f.y1 + map.r + 8, 110, 420, now, { anchor: 'feet', layer: 'ground' });
      spr('mage', 3, f.x2, f.y2 + map.r + 8, 110, 420, now, { anchor: 'feet', layer: 'ground' });
      break;
    case 'healwave': spr('healer', 1, f.x, f.y + map.r, f.r * 1.6, 650, now, { anchor: 'feet' }); break;
    case 'revive': if (p) spr('healer', 2, p.x, p.y + map.r + 6, 140, 900, now, { anchor: 'feet' }); break;
    case 'wave':
      if (f.kind === 'bear') spr('boss', 0, f.x, f.y + bossCfg.r * 0.6, f.r * 2.3, 520, now, { layer: 'ground' });
      else if (f.kind === 'flash') spr('boss', 1, f.x, f.y + bossCfg.r * 0.6 + 10, 260, 520, now, { anchor: 'feet' });
      break;
    case 'lv': if (p) spr('boss', 2, p.x, p.y + map.r + 6, 140, 900, now, { anchor: 'feet' }); break;
  }
  switch (f.k) {
    case 'atk': if (p) { if (!(p.id === myId && now - (p.localAtkAt ?? 0) < 600)) p.atkUntil = now + 400; p.face = boss.x < p.x ? -1 : 1; } break;
    case 'ball': balls.push({ ...f, born: now }); break;
    case 'orb+': orbs.set(f.id, f); break;
    case 'orb-': orbs.delete(f.id); break;
    case 'xp+': xpOrbs.set(f.id, f); break;
    case 'pu+': powerups.set(f.id, f); break;
    case 'pu-': powerups.delete(f.id); if (players.get(f.by)) effects.push({ k: 'buffget', id: f.by, kind: f.kind, born: now, life: 700 }); break;
    case 'ballx': {
      // 足球撞到障礙物
      const i = balls.findIndex((b) => b.id === f.id);
      if (i >= 0) balls.splice(i, 1);
      spr('boss', 1, f.x, f.y + 20, 90, 380, now, { anchor: 'feet' });
      break;
    }
    case 'stage': stageIdx = f.idx; loadStages(); break;
    case 'xp-': xpOrbs.delete(f.id); break;
    case 'lv':
      if (p) { p.lv = f.lv; p.maxHp = f.maxHp; p.maxMp = f.maxMp; }
      effects.push({ k: 'lvup', id: f.id, born: now, life: 1200 });
      if (f.id === myId) toast(`升級！Lv.${f.lv}`);
      break;
    case 'down': if (f.id === myId) deadSince = now; break;
    case 'cast': bossCast(f.name, now); break;
    case 'top': {
      const was = topRank(myId);
      top3 = f.ids;
      const r = topRank(myId);
      if (r >= 0 && r !== was) toast(`你是全服第 ${r + 1} 名！移速 +${Math.round((topBuff[r].speed - 1) * 100)}%、冷卻 -${Math.round((1 - topBuff[r].cd) * 100)}%`);
      break;
    }
    case 'bossspawn': banner(`第 ${f.level} 輪　${stage()?.name ? `【${stage().name}】` : ''}${bossCfg.name}出現！`); break;
    case 'victory': banner(`擊敗${bossCfg.name}！`); break;
    case 'dmg':
      // 打 BOSS 的數字只顯示自己打的，40 人一起打才不會滿畫面都是數字
      if (f.c === 'boss' && f.by !== myId) break;
      effects.push({ ...f, born: now, life: 900 });
      break;
    default: {
      const life = { tele: f.dur, mark: f.dur, wave: 450, boom: 500, proj: f.dur, slash: 220, taunt: 700, blink: 350, healwave: 600, revive: 900, afterimage: 700 }[f.k];
      if (life) effects.push({ ...f, born: now, life });
    }
  }
}

// ---------- BOSS 喊招：跑馬燈 + 頭上大字 + 語音 ----------
let soundOn = true;
try { soundOn = localStorage.getItem('sound') !== 'off'; } catch {}
function updateSoundBtn() { $('soundbtn').textContent = soundOn ? '聲音 開' : '聲音 關'; }
updateSoundBtn();

// 自動攻擊：站在 BOSS 射程內會自動普攻（伺服器判斷）；預設開，可以關掉自己按
let autoAtk = true;
try { autoAtk = localStorage.getItem('autoAtk') !== 'off'; } catch {}
function updateAutoBtn() {
  $('autobtn').textContent = autoAtk ? '自動攻擊 開' : '自動攻擊 關';
  $('autobtn').classList.toggle('off', !autoAtk);
}
updateAutoBtn();
$('autobtn').addEventListener('click', () => {
  autoAtk = !autoAtk;
  try { localStorage.setItem('autoAtk', autoAtk ? 'on' : 'off'); } catch {}
  updateAutoBtn();
  if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'auto', on: autoAtk }));
  toast(autoAtk ? '自動攻擊：靠近 BOSS 就會自動普攻' : '自動攻擊已關閉，按普攻鍵攻擊');
});
$('soundbtn').addEventListener('click', () => {
  soundOn = !soundOn;
  try { localStorage.setItem('sound', soundOn ? 'on' : 'off'); } catch {}
  if (!soundOn) speechSynthesis?.cancel();
  updateSoundBtn();
});

function bossCast(name, now) {
  // 跑馬燈：每次重建元素，CSS 動畫才會從頭播
  const box = $('marquee');
  const span = document.createElement('span');
  span.textContent = `${bossCfg.name}：「${name}」！`;
  box.replaceChildren(span);
  boss.shout = name; boss.shoutUntil = now + 1600;
  // 語音放到下一個空檔再講，不跟收訊息、畫畫面搶同一個時間點；出錯就自動關掉語音，不影響遊戲
  if (soundOn && 'speechSynthesis' in window) {
    setTimeout(() => {
      try {
        const t0 = performance.now();
        speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(name);
        u.lang = 'zh-TW'; u.rate = 1.15; u.pitch = 0.7; u.volume = 1;
        speechSynthesis.speak(u);
        const cost = performance.now() - t0;
        if (cost > 500) diag('speech-slow', `${Math.round(cost)}ms`);
      } catch (e) { diag('speech-error', e.message); soundOn = false; updateSoundBtn(); }
    }, 50);
  }
}

// 頭上大字：紅框白底，比聊天泡泡更醒目
function drawShout(text, x, y, now) {
  const t = Math.max(0, Math.min(1, 1 - (boss.shoutUntil - now) / 1600));
  const scale = t < 0.15 ? 0.6 + t / 0.15 * 0.5 : 1.1 - Math.min(0.1, (t - 0.15));
  ctx.save();
  ctx.translate(x, y - 30);
  ctx.scale(scale, scale);
  ctx.font = `900 30px ${FONT}`;
  const w = ctx.measureText(text).width + 30;
  ctx.fillStyle = '#fff';
  ctx.beginPath(); ctx.roundRect(-w / 2, -26, w, 52, 12); ctx.fill();
  ctx.lineWidth = 4; ctx.strokeStyle = '#dc2626'; ctx.stroke();
  ctx.fillStyle = '#dc2626'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(text, 0, 1);
  ctx.restore();
}

function banner(text) {
  const el = $('banner');
  el.textContent = text; el.hidden = false;
  clearTimeout(banner.t);
  banner.t = setTimeout(() => { el.hidden = true; }, 2500);
}
function toast(text) {
  const el = $('toast');
  el.textContent = text; el.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { el.hidden = true; }, 1200);
}

// ---------- 聊天 ----------
function addChat(c, live) {
  const log = $('chatlog');
  const row = document.createElement('div');
  if (c.id === 0) {
    row.className = 'sys';
    row.textContent = c.text;
  } else {
    const b = document.createElement('b');
    b.textContent = c.name;
    b.style.color = c.id === -1 ? '#f87171' : `hsl(${c.hue} 90% 70%)`;
    row.append(b, document.createTextNode(c.text));
    // id -1 是 BOSS（LLM 產生的台詞），泡泡畫在 BOSS 頭上
    const p = c.id === -1 ? boss : players.get(c.id);
    if (p && live) { p.bubble = wrapText(c.text); p.bubbleUntil = performance.now() + (c.ttl || 5000); }
  }
  log.append(row);
  while (log.children.length > CHATLOG_SHOW) log.firstChild.remove();
  [...log.children].forEach((el, i) => el.classList.toggle('fade', i < log.children.length - 2));
}

// 中文輸入法：選字中（composition）按 Enter 是確認選字，不能當成送出
let composing = false;
for (const id of ['chatinput', 'nameinput']) {
  $(id).addEventListener('compositionstart', () => { composing = true; });
  $(id).addEventListener('compositionend', () => { setTimeout(() => { composing = false; }, 0); });
  $(id).addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.isComposing || composing || e.keyCode === 229)) e.preventDefault();
  });
}

$('chatbar').addEventListener('submit', (e) => {
  e.preventDefault();
  if (composing) return;
  const input = $('chatinput');
  const text = input.value.trim();
  if (text && ws?.readyState === 1) ws.send(JSON.stringify({ t: 'chat', text }));
  input.value = '';
});

$('joinform').addEventListener('submit', (e) => {
  e.preventDefault();
  if (composing || joined) return; // 已經在遊戲裡就不要重新進場
  document.activeElement?.blur();
  myName = Array.from($('nameinput').value.normalize('NFC').trim()).slice(0, 12).join('');
  if (!myName) { $('joinerr').textContent = '請輸入遊戲 ID'; return; }
  $('joinerr').textContent = '連線中…';
  $('nameinput').blur();
  // iOS 要在使用者點擊時先講一次（空字串），之後 BOSS 喊招才發得出聲音
  try { if (soundOn) speechSynthesis.speak(new SpeechSynthesisUtterance('')); } catch {}
  connect();
});
try { $('nameinput').value = localStorage.getItem('lastName') || ''; } catch {}
try {
  const auto = JSON.parse(sessionStorage.getItem('autojoin') || 'null');
  sessionStorage.removeItem('autojoin');
  if (auto?.name) {
    myName = auto.name; myCls = auto.cls || myCls; myChar = auto.char || myChar;
    $('joinerr').textContent = '已更新，重新進場中…';
    justUpdated = true;
    connect();
  }
} catch {}

// ---------- 浮動搖桿：手指按在哪，搖桿就出現在哪 ----------
const stick = { active: false, id: null, bx: 0, by: 0, kx: 0, ky: 0 };
const stickMax = () => Math.max(45, Math.min(75, Math.min(W, H) * 0.12));
let inputX = 0, inputY = 0;

canvas.addEventListener('pointerdown', (e) => {
  if (!joined || stick.active) return;
  document.activeElement?.blur(); // 點畫面時收起鍵盤
  stick.active = true; stick.id = e.pointerId;
  stick.bx = stick.kx = e.clientX; stick.by = stick.ky = e.clientY;
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener('pointermove', (e) => {
  if (!stick.active || e.pointerId !== stick.id) return;
  const max = stickMax();
  let dx = e.clientX - stick.bx, dy = e.clientY - stick.by;
  const d = Math.hypot(dx, dy);
  if (d > max) { dx = dx / d * max; dy = dy / d * max; }
  stick.kx = stick.bx + dx; stick.ky = stick.by + dy;
  // 小幅度死區，避免手指輕抖
  if (Math.min(d, max) / max < 0.12) { inputX = 0; inputY = 0; }
  else { inputX = dx / max; inputY = dy / max; }
});
const endStick = (e) => {
  if (e.pointerId !== stick.id) return;
  stick.active = false; stick.id = null; inputX = 0; inputY = 0;
};
canvas.addEventListener('pointerup', endStick);
canvas.addEventListener('pointercancel', endStick);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// 電腦測試用：WASD／方向鍵移動，空白鍵或 J 普攻、K／L 技能
const keys = new Set();
window.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.isComposing) return;
  const k = e.key.toLowerCase();
  // 遊戲中按空白鍵／Enter 不能觸發畫面上（或隱藏的進場表單裡）有焦點的按鈕，否則會重新送出進場、看起來像被踢出去
  if (joined && (k === ' ' || k === 'enter')) e.preventDefault();
  keys.add(k);
  if (k === ' ' || k === 'j') keyAttack = true;
  if (k === 'k') castSkill(1);
  if (k === 'l') castSkill(2);
});
window.addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  keys.delete(k);
  if (k === ' ' || k === 'j') keyAttack = false;
});
let keyAttack = false; // 空白鍵或 J 按住＝連續普攻
window.addEventListener('blur', () => { keys.clear(); keyAttack = false; });
function keyInput() {
  let x = 0, y = 0;
  if (keys.has('a') || keys.has('arrowleft')) x--;
  if (keys.has('d') || keys.has('arrowright')) x++;
  if (keys.has('w') || keys.has('arrowup')) y--;
  if (keys.has('s') || keys.has('arrowdown')) y++;
  const l = Math.hypot(x, y);
  return l ? [x / l, y / l] : null;
}
const moveDir = () => keyInput() ?? [inputX, inputY];

let lastSent = { x: 0, y: 0 }, lastSendTime = 0;
function sendInput(now) {
  const [x, y] = moveDir();
  const changed = Math.abs(x - lastSent.x) > 0.02 || Math.abs(y - lastSent.y) > 0.02;
  // 停下來要立刻送；其他變化最多每 50ms 送一次
  const stopping = x === 0 && y === 0 && (lastSent.x || lastSent.y);
  if (!changed || ws?.readyState !== 1) return;
  if (!stopping && now - lastSendTime < SEND_INTERVAL_MS) return;
  ws.send(JSON.stringify({ t: 'input', x: +x.toFixed(2), y: +y.toFixed(2) }));
  lastSent = { x, y }; lastSendTime = now;
}

// ---------- 技能按鈕 ----------
const skillBtns = [...document.querySelectorAll('.skill')];
let mainHeld = false;
const pendingUntil = [0, 0, 0];

function setupSkills() {
  const c = CLASSES[players.get(myId)?.cls ?? myCls];
  for (const b of skillBtns) {
    const sk = c.skills[b.dataset.k];
    b.querySelector('.name').textContent = sk.name;
    const mp = b.querySelector('.mp');
    if (mp) mp.textContent = sk.mp ? `MP ${sk.mp}` : '';
    b.title = sk.desc;
  }
}

function castSkill(k) {
  const now = performance.now();
  if (!joined || ws?.readyState !== 1 || now < readyAt[k] || now < pendingUntil[k]) return;
  pendingUntil[k] = now + 250; // 等伺服器回 cd 之前先擋住連點
  const me = players.get(myId), sk = CLASSES?.[me?.cls]?.skills[k];
  if (me && sk && !(me.flags & 1) && me.mp >= sk.mp) {
    me.atkUntil = now + 400;
    castFx(me, k, now);
    me.localAtkAt = now;   // 伺服器的 atk 事件晚點才到，到時候不要重播
  }
  const [dx, dy] = moveDir();
  ws.send(JSON.stringify({ t: 'skill', k, dx: +dx.toFixed(2), dy: +dy.toFixed(2) }));
}

for (const b of skillBtns) {
  const k = +b.dataset.k;
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    b.blur();
    b.classList.add('held');
    if (k === 0) mainHeld = true;
    castSkill(k);
  });
  const up = () => { b.classList.remove('held'); if (k === 0) mainHeld = false; };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
  b.addEventListener('pointerleave', up);
  b.addEventListener('contextmenu', (e) => e.preventDefault());
}

// ---------- 評分回饋（1～5 星、心得、idea） ----------
let fbStars = 0;
function renderStars() {
  for (const b of document.querySelectorAll('#fbstars button')) b.classList.toggle('on', Number(b.dataset.v) <= fbStars);
}
for (const b of document.querySelectorAll('#fbstars button')) b.addEventListener('click', () => { fbStars = Number(b.dataset.v); renderStars(); });
$('fbbtn').addEventListener('click', (e) => { e.stopPropagation(); $('feedback').hidden = false; });
$('fbclose').addEventListener('click', () => { $('feedback').hidden = true; });
$('feedback').addEventListener('click', (e) => { if (e.target.id === 'feedback') $('feedback').hidden = true; });
$('fbbox').addEventListener('submit', (e) => {
  e.preventDefault();
  if (composing) return;
  if (!fbStars && !$('fbtext').value.trim() && !$('fbidea').value.trim()) { toast('請先選星星或寫點東西'); return; }
  if (ws?.readyState !== 1) { toast('連線中斷，等一下再送'); return; }
  ws.send(JSON.stringify({ t: 'feedback', stars: fbStars, text: $('fbtext').value, idea: $('fbidea').value }));
});
// 中文輸入法選字中按 Enter 不要送出（textarea 本來就是換行，這裡只擋表單送出）
for (const id of ['fbtext', 'fbidea']) {
  $(id).addEventListener('compositionstart', () => { composing = true; });
  $(id).addEventListener('compositionend', () => { setTimeout(() => { composing = false; }, 0); });
}

// ---------- 排行榜（點左上角頭像打開） ----------
let rankData = null, rankTab = 'total', rankTimer = null;
const requestRank = () => { if (ws?.readyState === 1) ws.send(JSON.stringify({ t: 'rank' })); };
$('statpanel').addEventListener('click', () => {
  $('rank').hidden = false;
  requestRank();
  clearInterval(rankTimer);
  rankTimer = setInterval(requestRank, 2000); // 開著的時候每 2 秒更新
});
const closeRank = () => { $('rank').hidden = true; clearInterval(rankTimer); };
$('rankclose').addEventListener('click', closeRank);
$('rank').addEventListener('click', (e) => { if (e.target.id === 'rank') closeRank(); });
for (const b of document.querySelectorAll('#ranktabs button')) {
  b.addEventListener('click', () => {
    rankTab = b.dataset.tab;
    for (const x of document.querySelectorAll('#ranktabs button')) x.classList.toggle('on', x === b);
    renderRank();
  });
}

const RANK_LABEL = { total: '綜合貢獻', dmg: '傷害', heal: '治療' };

function renderRank() {
  if (!rankData) return;
  const d = rankData[rankTab];
  const list = $('ranklist');
  list.replaceChildren();
  if (!d.list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = rankTab === 'heal' ? '還沒有人補過血' : '還沒有人打到 BOSS';
    list.append(li);
  }
  d.list.forEach((r, i) => {
    const li = document.createElement('li');
    if (r.name === myName) li.className = 'me';
    if (!r.on) li.classList.add('off');
    const no = document.createElement('span'); no.className = 'no'; no.textContent = i + 1;
    const who = document.createElement('span'); who.className = 'who';
    who.textContent = `Lv.${r.lv ?? 1} ${r.name}`;
    const cls = document.createElement('small'); cls.textContent = `${CLASSES?.[r.cls]?.name ?? ''}${charName(r.char)}`;
    who.append(cls);
    const v = document.createElement('span'); v.className = 'v'; v.textContent = r.v.toLocaleString('zh-TW');
    li.append(no, who, v);
    list.append(li);
  });
  $('rankme').textContent = d.me
    ? `你是第 ${d.me.rank} 名（共 ${d.total} 人），${RANK_LABEL[rankTab]} ${d.me.v.toLocaleString('zh-TW')}`
    : `你還沒有${rankTab === 'heal' ? '補過血' : '打到 BOSS'}`;
}

// 頭像：目前職業精靈圖的第一格
let avatarKey = '';
function drawAvatar(cls, char) {
  const s = sheetFor(cls, char);
  const key = `${cls}:${s.ready}:${s.img.src}`;
  if (key === avatarKey || !s.ready) return;
  avatarKey = key;
  const g = $('avatar').getContext('2d');
  g.clearRect(0, 0, 40, 40);
  g.imageSmoothingEnabled = false;
  g.drawImage(s.img, 0, 0, s.size, s.size, 0, 0, 40, 40);
}

// ---------- HUD ----------
function updateHud(now) {
  const me = players.get(myId);
  if (!me || !CLASSES) return;
  const c = CLASSES[me.cls];
  drawAvatar(me.cls, me.char);
  $('statname').textContent = `Lv.${me.lv} ${me.name}`;
  $('statcls').textContent = `${c.name}${charName(me.char)}`;
  $('hpfill').style.width = `${me.hp / me.maxHp * 100}%`;
  $('hpfill').parentElement.classList.toggle('low', me.hp / me.maxHp < 0.3);
  $('hptext').textContent = `HP ${me.hp} / ${me.maxHp}`;
  $('mpfill').style.width = `${me.mp / me.maxMp * 100}%`;
  $('mptext').textContent = `MP ${me.mp} / ${me.maxMp}`;
  $('xpfill').style.width = myExp.next ? `${myExp.exp / myExp.next * 100}%` : '100%';
  $('xptext').textContent = myExp.next ? `EXP ${myExp.exp} / ${myExp.next}` : 'EXP MAX';
  const st = [];
  if (me.flags & 1) st.push('倒地');
  if (me.flags & 4) st.push('嘲諷中');
  if (me.flags & 16) st.push('加速中');
  if (me.flags & 32) st.push('力量提升');
  if (myExp.catchup > 1) st.push(`追趕加成 ×${myExp.catchup}`);
  const ter = terrainAtClient(me.x, me.y);
  if (ter) st.push(`在${TERRAIN_NAME[ter] ?? ter}裡`);
  if (me.flags & 8) st.push('減傷');
  if (me.flags & 2 && !(me.flags & 1)) st.push('無敵');
  const tr = topRank(myId);
  if (tr >= 0) st.push(`全服第 ${tr + 1} 名：移速 +${Math.round((topBuff[tr].speed - 1) * 100)}%、冷卻 -${Math.round((1 - topBuff[tr].cd) * 100)}%`);
  $('statstate').textContent = st.join('・');

  const dead = !!(me.flags & 1);
  $('deadmsg').hidden = !dead;
  if (dead) {
    const left = Math.max(0, Math.ceil(12 - (now - deadSince) / 1000));
    $('deadmsg').textContent = `你倒下了，${deadSince ? left + ' 秒後' : '稍後'}自動復活\n可以慢慢走去找補師救你`;
  }

  const pingEl = $('ping');
  pingEl.textContent = myRtt ? `${Math.round(myRtt)}ms・${fps}fps` : '';
  pingEl.className = myRtt > 250 || fps < 30 ? 'bad' : myRtt > 120 || fps < 50 ? 'meh' : '';

  $('bossbar').hidden = !boss.alive;
  if (boss.alive) {
    const enraged = boss.hp / boss.maxHp < 0.3;
    $('bossname').textContent = `${bossCfg.name}　第 ${boss.level} 輪${enraged ? '　狂暴' : ''}`;
    $('bossfill').style.width = `${boss.hp / boss.maxHp * 100}%`;
    $('bosstext').textContent = `${boss.hp} / ${boss.maxHp}`;
  }

  for (const b of skillBtns) {
    const k = +b.dataset.k, sk = c.skills[k];
    const left = Math.max(0, readyAt[k] - now);
    const total = cdTotal[k] || sk.cd;
    b.querySelector('.cd').style.setProperty('--p', total ? Math.min(1, left / total) : 0);
    b.classList.toggle('nomp', me.mp < sk.mp || dead);
  }
}

// ---------- 繪圖（世界座標，經過鏡頭與縮放） ----------
// 依「字形」切字（emoji、組合字不會被拆開），中文可在任意字之間換行
const segmenter = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter('zh-Hant', { granularity: 'grapheme' }) : null;
const graphemes = (s) => segmenter ? Array.from(segmenter.segment(s), (x) => x.segment) : Array.from(s);

function wrapText(text) {
  ctx.font = `14px ${FONT}`;
  const lines = [];
  let line = '';
  for (const ch of graphemes(text)) {
    if (ctx.measureText(line + ch).width > BUBBLE_MAX_W - 16 && line) { lines.push(line); line = ch; }
    else line += ch;
  }
  if (line) lines.push(line);
  return lines.slice(0, 4);
}

// 目前畫面看得到的世界範圍
function viewRect() {
  const hw = W / 2 / zoom, hh = H / 2 / zoom;
  return { l: cam.x - hw, r: cam.x + hw, t: cam.y - hh, b: cam.y + hh };
}

// ---------- 關卡地圖 ----------
// maps/stages.json：每關的障礙物、地形、道具刷新點（伺服器用同一份）；素材在 maps/<關卡>/ground.png、terrain.png、props.png
// 素材還沒生成好時，用下面的主題色代替
const STAGE_STYLE = {
  meadow: { ground: '#3f7d3a', terrain: '#6b4f2a', prop: '#2f5e2b' },
  village: { ground: '#7a6a45', terrain: '#3d7fa6', prop: '#8b5a2b' },
  city: { ground: '#4b5563', terrain: '#ca8a04', prop: '#6b7280' },
  desert: { ground: '#d6b56d', terrain: '#a8844a', prop: '#b07a3a' },
  beach: { ground: '#e8d39a', terrain: '#3aa0c8', prop: '#4d7c3a' },
  snow: { ground: '#dbe7f0', terrain: '#9fd3f0', prop: '#5f7f96' },
  lava: { ground: '#2b2422', terrain: '#f05a1a', prop: '#3a3330' },
  sky: { ground: '#e9e3c9', terrain: '#fff4b0', prop: '#a5c8e0' },
};
const TERRAIN_NAME = { mud: '泥沼', pond: '池塘', quicksand: '流沙', sea: '海水', conveyor: '加速帶', starwind: '星光氣流', ice: '冰面', lava: '熔岩' };
let stages = [], stageIdx = -1, terrainFx = {};
const stage = () => stages[stageIdx] ?? null;
const powerups = new Map();
const mapArt = {};
function loadStages() {
  return fetch('maps/stages.json', { cache: 'no-store' }).then((r) => r.json()).then((d) => { stages = d.stages || []; }).catch(() => {});
}
loadStages();
function artFor(id) {
  if (!id) return null;
  if (!mapArt[id]) {
    const img = (src) => { const i = new Image(); i.src = src; return i; };
    mapArt[id] = { ground: img(`maps/${id}/ground.png`), terrain: img(`maps/${id}/terrain.png`), props: loadSheet(`maps/${id}/props.png`, 2), pat: {} };
  }
  return mapArt[id];
}
const powerupSheet = loadSheet('maps/powerups.png', 4);
function patternOf(art, key) {
  const im = art?.[key];
  if (!im || !im.complete || !im.naturalWidth) return null;
  return art.pat[key] ??= ctx.createPattern(im, 'repeat');
}

function drawGrid(v) {
  const st = stage(), sty = STAGE_STYLE[st?.id] ?? { ground: '#132042', terrain: '#334155' }, art = artFor(st?.id);
  ctx.fillStyle = patternOf(art, 'ground') ?? sty.ground;
  ctx.fillRect(0, 0, map.w, map.h);
  // 地形：橢圓裡鋪地形貼圖
  for (const t of st?.terrain ?? []) {
    ctx.save();
    ctx.beginPath(); ctx.ellipse(t.x, t.y, t.rx, t.ry, 0, 0, Math.PI * 2);
    ctx.fillStyle = patternOf(art, 'terrain') ?? sty.terrain;
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0, 0, 0, .25)'; ctx.stroke();
    ctx.restore();
  }
  ctx.strokeStyle = 'rgba(148, 163, 184, .12)';
  ctx.lineWidth = 1;
  const step = 80;
  ctx.beginPath();
  for (let x = Math.max(0, Math.floor(v.l / step) * step); x <= Math.min(map.w, v.r); x += step) {
    ctx.moveTo(x, Math.max(0, v.t)); ctx.lineTo(x, Math.min(map.h, v.b));
  }
  for (let y = Math.max(0, Math.floor(v.t / step) * step); y <= Math.min(map.h, v.b); y += step) {
    ctx.moveTo(Math.max(0, v.l), y); ctx.lineTo(Math.min(map.w, v.r), y);
  }
  ctx.stroke();
  // 中央擂台
  ctx.beginPath();
  ctx.arc(map.w / 2, map.h / 2, 420, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(250, 204, 21, .04)'; ctx.fill();
  ctx.strokeStyle = 'rgba(250, 204, 21, .18)'; ctx.lineWidth = 3; ctx.stroke();
  ctx.strokeStyle = '#facc15';
  ctx.lineWidth = 4;
  ctx.strokeRect(0, 0, map.w, map.h);
}

function drawObstacle(o, art, sty) {
  const sh = art?.props;
  const feet = o.y + o.r * 0.55;
  if (sh?.ready) {
    const size = o.r * 2.8;
    ctx.save(); ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sh.img, (o.kind === 'mid' ? 1 : 0) * sh.size, 0, sh.size, sh.size, o.x - size / 2, feet - size * 0.97, size, size);
    ctx.restore();
  } else {
    ctx.beginPath(); ctx.ellipse(o.x, feet, o.r, o.r * 0.4, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, .3)'; ctx.fill();
    ctx.beginPath(); ctx.arc(o.x, o.y - o.r * 0.2, o.r, 0, Math.PI * 2);
    ctx.fillStyle = sty?.prop ?? '#555'; ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0, 0, 0, .4)'; ctx.stroke();
  }
}

// 道具：加速（青色）、加傷害（紅色）；沒有素材時用圖形代替
function drawPowerups(now) {
  for (const u of powerups.values()) {
    const bob = Math.sin(now / 250 + u.id) * 4, row = u.kind === 'speed' ? 0 : 1;
    if (powerupSheet.ready) {
      ctx.save(); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(powerupSheet.img, (Math.floor(now / 150) % 4) * powerupSheet.size, row * powerupSheet.size, powerupSheet.size, powerupSheet.size, u.x - 26, u.y - 26 + bob, 52, 52);
      ctx.restore();
    } else {
      const c = u.kind === 'speed' ? '#22d3ee' : '#ef4444';
      ctx.beginPath(); ctx.arc(u.x, u.y + bob, 18, 0, Math.PI * 2);
      ctx.fillStyle = c; ctx.shadowColor = c; ctx.shadowBlur = glow(16); ctx.fill(); ctx.shadowBlur = 0;
      ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.beginPath();
      if (u.kind === 'speed') {
        ctx.moveTo(u.x - 8, u.y + bob - 7); ctx.lineTo(u.x, u.y + bob); ctx.lineTo(u.x - 8, u.y + bob + 7);
        ctx.moveTo(u.x, u.y + bob - 7); ctx.lineTo(u.x + 8, u.y + bob); ctx.lineTo(u.x, u.y + bob + 7);
      } else {
        ctx.moveTo(u.x, u.y + bob - 10); ctx.lineTo(u.x, u.y + bob + 6);
        ctx.moveTo(u.x - 6, u.y + bob + 2); ctx.lineTo(u.x + 6, u.y + bob + 2);
      }
      ctx.stroke();
    }
  }
}

function drawBubble(lines, x, y) {
  ctx.font = `14px ${FONT}`;
  const lh = 18, pad = 8;
  const w = Math.max(...lines.map((l) => ctx.measureText(l).width)) + pad * 2;
  const h = lines.length * lh + pad * 2 - 4;
  const bx = x - w / 2, by = y - h - 10;
  ctx.fillStyle = 'rgba(255, 255, 255, .95)';
  ctx.beginPath();
  ctx.roundRect(bx, by, w, h, 10);
  ctx.moveTo(x - 7, by + h); ctx.lineTo(x, by + h + 9); ctx.lineTo(x + 7, by + h);
  ctx.fill();
  ctx.fillStyle = '#0f172a';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  lines.forEach((l, i) => ctx.fillText(l, bx + pad, by + pad + i * lh));
}

// 從精靈圖畫一格；腳底對齊在 (x, feet)
function drawFrame(s, col, row, x, feet, cell, flip) {
  const scale = cell / s.size;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(x, feet - (s.size - 2) * scale);
  if (flip) ctx.scale(-1, 1);
  ctx.drawImage(s.img, col * s.size, row * s.size, s.size, s.size, -cell / 2, 0, cell, cell);
  ctx.restore();
}

function bar(x, y, w, h, ratio, color) {
  ctx.fillStyle = 'rgba(0, 0, 0, .6)';
  ctx.fillRect(x - w / 2 - 1, y - 1, w + 2, h + 2);
  ctx.fillStyle = color;
  ctx.fillRect(x - w / 2, y, w * Math.max(0, Math.min(1, ratio)), h);
}

// ---------- 全服前三名的彩虹特效 ----------
// 第 1 名：彩虹光柱＋旋轉彩虹光環＋金皇冠＋快速流動的彩虹名字
// 第 2 名：脈動發光的彩虹光圈＋閃爍的彩虹名字
// 第 3 名：腳下彩虹光圈＋緩慢變色的彩虹名字
const TOP_HUE_SPEED = [0.36, 0.2, 0.1]; // 每毫秒色相轉幾度

function rainbowFill(x, w, now, rank) {
  const g = ctx.createLinearGradient(x - w / 2, 0, x + w / 2, 0);
  const base = now * TOP_HUE_SPEED[rank];
  for (let i = 0; i <= 6; i++) g.addColorStop(i / 6, `hsl(${(base + i * 55) % 360} 100% ${rank === 1 && Math.floor(now / 120) % 2 ? 80 : 65}%)`);
  return g;
}

function drawTopAura(p, rank, now, feet) {
  const r = map.r, hue = now * TOP_HUE_SPEED[rank];
  ctx.save();
  if (rank === 0) {
    // 光柱
    const g = ctx.createLinearGradient(0, feet - 170, 0, feet);
    g.addColorStop(0, `hsl(${hue % 360} 100% 70% / 0)`);
    g.addColorStop(1, `hsl(${(hue + 60) % 360} 100% 70% / .35)`);
    ctx.fillStyle = g;
    ctx.fillRect(p.x - r * 1.2, feet - 170, r * 2.4, 170);
    // 旋轉彩虹光環：12 段不同色的弧
    const rot = now / 400;
    ctx.lineWidth = 5;
    ctx.shadowBlur = glow(14);
    for (let i = 0; i < 12; i++) {
      const c = `hsl(${(hue + i * 30) % 360} 100% 60%)`;
      ctx.strokeStyle = c; ctx.shadowColor = c;
      ctx.beginPath();
      ctx.ellipse(p.x, feet, r * 1.5, r * 0.6, 0, rot + i * Math.PI / 6, rot + (i + 0.8) * Math.PI / 6);
      ctx.stroke();
    }
  } else if (rank === 1) {
    const pulse = 1 + Math.sin(now / 150) * 0.12;
    const c = `hsl(${hue % 360} 100% 62%)`;
    ctx.lineWidth = 4; ctx.strokeStyle = c; ctx.shadowColor = c; ctx.shadowBlur = glow(18);
    ctx.beginPath();
    ctx.ellipse(p.x, feet, r * 1.35 * pulse, r * 0.55 * pulse, 0, 0, Math.PI * 2);
    ctx.stroke();
  } else {
    ctx.lineWidth = 3; ctx.strokeStyle = `hsl(${hue % 360} 100% 60%)`;
    ctx.beginPath();
    ctx.ellipse(p.x, feet, r * 1.2, r * 0.48, 0, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}

// 金皇冠（畫出來的，不用 emoji）
function drawCrown(x, y, now) {
  const bob = Math.sin(now / 200) * 2;
  ctx.save();
  ctx.translate(x, y + bob);
  ctx.beginPath();
  ctx.moveTo(-12, 0); ctx.lineTo(-12, -10); ctx.lineTo(-6, -4); ctx.lineTo(0, -13); ctx.lineTo(6, -4); ctx.lineTo(12, -10); ctx.lineTo(12, 0);
  ctx.closePath();
  ctx.fillStyle = '#facc15'; ctx.shadowColor = '#fde047'; ctx.shadowBlur = glow(12); ctx.fill();
  ctx.shadowBlur = 0; ctx.lineWidth = 2; ctx.strokeStyle = '#92400e'; ctx.stroke();
  ctx.fillStyle = `hsl(${(now * 0.36) % 360} 100% 60%)`;
  ctx.beginPath(); ctx.arc(0, -5, 2.5, 0, Math.PI * 2); ctx.fill();
  ctx.restore();
}

function drawPlayer(p, now) {
  const r = map.r, feet = p.y + r, c = CLASSES?.[p.cls];
  const dead = p.flags & 1, inv = p.flags & 2;
  // 腳下光圈：每個人顏色不同；自己有白框；嘲諷中是紅框
  ctx.beginPath();
  ctx.ellipse(p.x, feet, r * 0.95, r * 0.38, 0, 0, Math.PI * 2);
  ctx.fillStyle = `hsl(${p.hue} 85% 55% / ${dead ? 0.25 : 0.6})`;
  ctx.fill();
  if (p.flags & 4) { ctx.lineWidth = 3; ctx.strokeStyle = '#ef4444'; ctx.stroke(); }
  // 加速：青色速度線；加傷害：紅色脈動光圈
  if (p.flags & 16 && !dead) {
    ctx.strokeStyle = 'rgba(34, 211, 238, .8)'; ctx.lineWidth = 3;
    for (let i = 0; i < 3; i++) {
      const yy = p.y - 18 + i * 14, len = 14 + ((now / 60 + i * 7) % 14);
      ctx.beginPath(); ctx.moveTo(p.x - p.face * 26, yy); ctx.lineTo(p.x - p.face * (26 + len), yy); ctx.stroke();
    }
  }
  if (p.flags & 32 && !dead) {
    ctx.beginPath(); ctx.ellipse(p.x, feet, r * (1.3 + Math.sin(now / 120) * 0.1), r * 0.55, 0, 0, Math.PI * 2);
    ctx.lineWidth = 4; ctx.strokeStyle = 'rgba(239, 68, 68, .85)'; ctx.shadowColor = '#ef4444'; ctx.shadowBlur = glow(12); ctx.stroke(); ctx.shadowBlur = 0;
  }
  else if (p.id === myId) { ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.stroke(); }
  const rank = topRank(p.id);
  if (rank >= 0 && !dead) drawTopAura(p, rank, now, feet);

  const s = sheetFor(p.cls, p.char);
  ctx.save();
  if (dead) ctx.globalAlpha = 0.35;
  else if (inv && Math.floor(now / 80) % 2) ctx.globalAlpha = 0.5;
  if (s.ready) {
    let row = 0, frame;
    const offset = p.id * 1.7; // 動畫起始時間錯開，40 人才不會整齊劃一
    if (!dead && now < p.atkUntil && s.rows >= 3) { row = 2; frame = Math.min(3, Math.floor((400 - (p.atkUntil - now)) / 100)); }
    else if (!dead && now < p.movingUntil) { row = 1; frame = Math.floor(now / 1000 * 8 + offset) % 4; }
    else frame = [0, 1, 2, 1][Math.floor(now / 1000 * 3 + offset) % 4];
    drawFrame(s, frame, row, p.x, feet, PLAYER_CELL, p.face < 0);
  } else {
    ctx.beginPath();
    ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = `hsl(${p.hue} 80% 58%)`;
    ctx.fill();
  }
  ctx.restore();

  // 頭上 HP／MP 條
  const top = s.ready ? feet - (s.size - 2 - s.top) * (PLAYER_CELL / s.size) : p.y - r;
  p.headY = top - 14;
  if (p.maxHp) {
    bar(p.x, top - 12, 38, 5, p.hp / p.maxHp, p.hp / p.maxHp < 0.3 ? '#ef4444' : '#22c55e');
    bar(p.x, top - 6, 38, 3, p.mp / p.maxMp, '#3b82f6');
  }
  if (rank === 0 && !dead) { drawCrown(p.x, top - 16, now); p.headY = top - 32; }
  // 名字
  ctx.font = `bold 13px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0, 0, 0, .6)';
  const label = `Lv.${p.lv ?? 1} ${p.name}${dead ? '（倒地）' : ''}`;
  ctx.strokeText(label, p.x, feet + 10);
  ctx.fillStyle = dead ? '#fca5a5' : rank >= 0 ? rainbowFill(p.x, ctx.measureText(label).width, now, rank) : '#fff';
  ctx.fillText(label, p.x, feet + 10);
}

function drawBoss(now) {
  if (!boss.alive) return;
  const feet = boss.y + bossCfg.r * 0.6;
  ctx.beginPath();
  ctx.ellipse(boss.x, feet, bossCfg.r * 1.3, bossCfg.r * 0.45, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0, 0, 0, .35)'; ctx.fill();
  const s = sheets.boss;
  if (s.ready) {
    const elapsed = now - boss.animStart;
    const frame = boss.anim === 0
      ? [0, 1, 2, 1][Math.floor(now / 1000 * 3) % 4]
      : Math.min(3, Math.floor(elapsed / (BOSS_ANIM_MS[boss.anim] / 4)));
    drawFrame(s, frame, Math.min(boss.anim, s.rows - 1), boss.x, feet, BOSS_CELL, false);
    boss.headY = feet - (s.size - 2 - s.top) * (BOSS_CELL / s.size) - 4;
  } else {
    ctx.beginPath();
    ctx.arc(boss.x, boss.y, bossCfg.r, 0, Math.PI * 2);
    ctx.fillStyle = '#e5e7eb'; ctx.fill();
    ctx.lineWidth = 4; ctx.strokeStyle = '#991b1b'; ctx.stroke();
    ctx.fillStyle = '#111'; ctx.font = `bold 22px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(bossCfg.name, boss.x, boss.y);
  }
}

function drawSpr(e, now) {
  if (now < e.born) return;
  const sh = fxSheets[e.sheet];
  if (!sh?.ready) return;
  const t = Math.max(0, Math.min(1, (now - e.born) / e.life));
  const frame = e.loop ? Math.floor((now - e.born) / 70) % 6 : Math.min(5, Math.floor(t * 6));
  const y = e.fall ? e.y - e.fall * (1 - t) : e.y;
  const cy = e.anchor === 'feet' ? y - e.size * 0.45 : y;
  ctx.save();
  ctx.imageSmoothingEnabled = false;
  ctx.translate(e.x, cy);
  if (e.flip) ctx.scale(-1, 1);
  ctx.drawImage(sh.img, frame * sh.size, e.row * sh.size, sh.size, sh.size, -e.size / 2, -e.size / 2, e.size, e.size);
  ctx.restore();
}

// 地上的特效（畫在角色下面）：預警、震波、補血範圍
function drawGroundFx(now) {
  for (const e of effects) {
    if (e.k === 'spr') { if (e.layer === 'ground') drawSpr(e, now); continue; }
    const t = Math.max(0, Math.min(1, (now - e.born) / e.life));
    if (e.k === 'tele' && e.shape === 'circle') {
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(239, 68, 68, .15)'; ctx.fill();
      ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(239, 68, 68, .9)';
      if (e.flash) ctx.setLineDash([12, 8]);
      ctx.stroke(); ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * t, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(239, 68, 68, .3)'; ctx.fill();
    } else if (e.k === 'tele' && e.shape === 'line') {
      const ang = Math.atan2(e.y2 - e.y, e.x2 - e.x), len = Math.hypot(e.x2 - e.x, e.y2 - e.y);
      ctx.save(); ctx.translate(e.x, e.y); ctx.rotate(ang);
      ctx.fillStyle = 'rgba(239, 68, 68, .15)'; ctx.fillRect(0, -e.w / 2, len, e.w);
      ctx.fillStyle = 'rgba(239, 68, 68, .35)'; ctx.fillRect(0, -e.w / 2, len * t, e.w);
      ctx.strokeStyle = 'rgba(239, 68, 68, .8)'; ctx.lineWidth = 2; ctx.strokeRect(0, -e.w / 2, len, e.w);
      ctx.restore();
    } else if (e.k === 'mark') {
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
      ctx.strokeStyle = 'rgba(96, 165, 250, .9)'; ctx.lineWidth = 3; ctx.stroke();
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * t, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(96, 165, 250, .25)'; ctx.fill();
    } else if (e.k === 'healwave') {
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.3 + 0.7 * t), 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${e.revive ? '250, 204, 21' : '74, 222, 128'}, ${0.3 * (1 - t)})`; ctx.fill();
      ctx.lineWidth = 4; ctx.strokeStyle = `rgba(${e.revive ? '250, 204, 21' : '74, 222, 128'}, ${1 - t})`; ctx.stroke();
    }
  }
}

// 空中的特效（畫在角色上面）
function drawAirFx(now) {
  for (const e of effects) {
    if (e.k === 'spr') { if (e.layer !== 'ground') drawSpr(e, now); continue; }
    const t = Math.max(0, Math.min(1, (now - e.born) / e.life));
    if (e.k === 'wave' || e.k === 'boom') {
      ctx.beginPath(); ctx.arc(e.x, e.y, e.r * (0.6 + 0.4 * t), 0, Math.PI * 2);
      ctx.lineWidth = 10 * (1 - t) + 2;
      ctx.strokeStyle = e.k === 'boom' ? `rgba(251, 146, 60, ${1 - t})` : `rgba(255, 255, 255, ${0.9 * (1 - t)})`;
      ctx.stroke();
    } else if (e.k === 'proj') {
      // 投射物飛向 BOSS 目前的位置，多重箭左右散開成弧線
      const tx = boss.x, ty = boss.y - 40;
      const mx = (e.x1 + tx) / 2 - (ty - e.y1) * e.spread, my = (e.y1 + ty) / 2 + (tx - e.x1) * e.spread;
      const x = (1 - t) ** 2 * e.x1 + 2 * (1 - t) * t * mx + t * t * tx;
      const y = (1 - t) ** 2 * e.y1 + 2 * (1 - t) * t * my + t * t * ty;
      const projSheet = fxSheets[{ arrow: 'archer', magic: 'mage', light: 'healer' }[e.kind]];
      if (projSheet?.ready) {
        const ang = Math.atan2(ty - y, tx - x);
        ctx.save(); ctx.translate(x, y); ctx.rotate(ang); ctx.imageSmoothingEnabled = false;
        const sz = e.kind === 'arrow' ? 52 : 44;
        ctx.drawImage(projSheet.img, (Math.floor((now - e.born) / 70) % 6) * projSheet.size, 0, projSheet.size, projSheet.size, -sz / 2, -sz / 2, sz, sz);
        ctx.restore();
      } else if (e.kind === 'arrow') {
        const ang = Math.atan2(ty - y, tx - x);
        ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
        ctx.strokeStyle = '#fde68a'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(8, 0); ctx.stroke();
        ctx.fillStyle = '#e5e7eb'; ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(5, -4); ctx.lineTo(5, 4); ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath(); ctx.arc(x, y, e.kind === 'magic' ? 9 : 7, 0, Math.PI * 2);
        ctx.fillStyle = e.kind === 'magic' ? '#93c5fd' : '#fef9c3';
        ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = glow(12); ctx.fill(); ctx.shadowBlur = 0;
      }
    } else if (e.k === 'slash') {
      const p = players.get(e.id);
      const ang = p ? Math.atan2(e.y - p.y, e.x - p.x) : 0;
      ctx.beginPath(); ctx.arc(e.x - Math.cos(ang) * 50, e.y - 30 - Math.sin(ang) * 50, 34, ang - 1.2, ang + 1.2);
      ctx.lineWidth = 6; ctx.strokeStyle = `rgba(255, 255, 255, ${1 - t})`; ctx.stroke();
    } else if (e.k === 'taunt' || e.k === 'revive') {
      const p = players.get(e.id);
      if (!p) continue;
      ctx.beginPath(); ctx.arc(p.x, p.y, 30 + 40 * t, 0, Math.PI * 2);
      ctx.lineWidth = 4; ctx.strokeStyle = e.k === 'taunt' ? `rgba(239, 68, 68, ${1 - t})` : `rgba(250, 204, 21, ${1 - t})`;
      ctx.stroke();
    } else if (e.k === 'buffget') {
      const p = players.get(e.id);
      if (!p) continue;
      ctx.beginPath(); ctx.arc(p.x, p.y, 20 + 50 * t, 0, Math.PI * 2);
      ctx.lineWidth = 5; ctx.strokeStyle = e.kind === 'speed' ? `rgba(34, 211, 238, ${1 - t})` : `rgba(239, 68, 68, ${1 - t})`; ctx.stroke();
    } else if (e.k === 'lvup') {
      const p = players.get(e.id);
      if (!p) continue;
      ctx.beginPath(); ctx.arc(p.x, p.y, 26 + 50 * t, 0, Math.PI * 2);
      ctx.lineWidth = 5; ctx.strokeStyle = `rgba(250, 204, 21, ${1 - t})`; ctx.stroke();
      ctx.font = `900 18px ${FONT}`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.globalAlpha = 1 - t; ctx.lineWidth = 4; ctx.strokeStyle = '#000';
      ctx.strokeText('LEVEL UP', p.x, (p.headY ?? p.y) - 10 - 30 * t);
      ctx.fillStyle = '#facc15'; ctx.fillText('LEVEL UP', p.x, (p.headY ?? p.y) - 10 - 30 * t);
      ctx.globalAlpha = 1;
    } else if (e.k === 'blink') {
      ctx.setLineDash([4, 6]); ctx.lineWidth = 3; ctx.strokeStyle = `rgba(147, 197, 253, ${1 - t})`;
      ctx.beginPath(); ctx.moveTo(e.x1, e.y1); ctx.lineTo(e.x2, e.y2); ctx.stroke(); ctx.setLineDash([]);
    } else if (e.k === 'afterimage' && sheets.boss.ready) {
      ctx.save(); ctx.globalAlpha = 0.45 * (1 - t);
      drawFrame(sheets.boss, 2, 1, e.x, e.y + bossCfg.r * 0.6, BOSS_CELL, false);
      ctx.restore();
    } else if (e.k === 'dmg') {
      const y = e.y - 50 - 40 * t;
      ctx.font = `bold ${e.c === 'boss' ? 20 : 16}px ${FONT}`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.globalAlpha = 1 - t * t;
      ctx.lineWidth = 3; ctx.strokeStyle = '#000';
      const txt = e.c === 'heal' ? `+${e.v}` : `-${e.v}`;
      ctx.strokeText(txt, e.x, y);
      ctx.fillStyle = { boss: '#facc15', hurt: '#f87171', heal: '#4ade80' }[e.c];
      ctx.fillText(txt, e.x, y);
      ctx.globalAlpha = 1;
    }
  }
}

function drawBalls(now) {
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i], t = (now - b.born) / 1000;
    if (t * 1000 > b.life || !boss.alive) { balls.splice(i, 1); continue; }
    const x = b.x + b.vx * t, y = b.y + b.vy * t;
    const s = sheets.ball;
    if (s.ready) {
      ctx.save(); ctx.imageSmoothingEnabled = false;
      ctx.drawImage(s.img, (Math.floor(now / 80) % 4) * s.size, 0, s.size, s.size, x - 20, y - 20, 40, 40);
      ctx.restore();
    } else {
      ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2);
      ctx.fillStyle = '#fff'; ctx.fill(); ctx.lineWidth = 3; ctx.strokeStyle = '#111'; ctx.stroke();
    }
  }
}

// 補血果實：綠色光球加白色十字（畫出來的，之後可換成素材圖）
function drawOrbs(now) {
  for (const o of orbs.values()) {
    const bob = Math.sin(now / 300 + o.id) * 3;
    ctx.beginPath(); ctx.arc(o.x, o.y + bob, 14, 0, Math.PI * 2);
    ctx.fillStyle = '#22c55e'; ctx.shadowColor = '#4ade80'; ctx.shadowBlur = glow(14); ctx.fill(); ctx.shadowBlur = 0;
    ctx.fillStyle = '#fff';
    ctx.fillRect(o.x - 2.5, o.y + bob - 8, 5, 16);
    ctx.fillRect(o.x - 8, o.y + bob - 2.5, 16, 5);
  }
}

// 經驗球：小顆青色菱形（畫出來的，之後可換成素材圖）
function drawXpOrbs(now, v) {
  ctx.fillStyle = '#67e8f9';
  ctx.strokeStyle = '#0e7490';
  ctx.lineWidth = 2;
  for (const o of xpOrbs.values()) {
    if (o.x < v.l - 20 || o.x > v.r + 20 || o.y < v.t - 20 || o.y > v.b + 20) continue;
    const s = 7 + Math.sin(now / 250 + o.id) * 1.5;
    ctx.beginPath();
    ctx.moveTo(o.x, o.y - s); ctx.lineTo(o.x + s * 0.7, o.y); ctx.lineTo(o.x, o.y + s); ctx.lineTo(o.x - s * 0.7, o.y);
    ctx.closePath(); ctx.fill(); ctx.stroke();
  }
}

function drawStick() {
  if (!stick.active) return;
  const max = stickMax();
  ctx.beginPath();
  ctx.arc(stick.bx, stick.by, max, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(255, 255, 255, .12)'; ctx.fill();
  ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(255, 255, 255, .35)'; ctx.stroke();
  ctx.beginPath();
  ctx.arc(stick.kx, stick.ky, max * 0.44, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(250, 204, 21, .8)'; ctx.fill();
}

function drawMinimap(v) {
  const mw = mini.width, mh = mini.height;
  mctx.clearRect(0, 0, mw, mh);
  const sx = mw / map.w, sy = mh / map.h;
  mctx.strokeStyle = 'rgba(250, 204, 21, .5)';
  mctx.lineWidth = dpr;
  mctx.strokeRect(v.l * sx, v.t * sy, (v.r - v.l) * sx, (v.b - v.t) * sy);
  const st = stage(), sty = STAGE_STYLE[st?.id];
  for (const t of st?.terrain ?? []) {
    mctx.beginPath(); mctx.ellipse(t.x * sx, t.y * sy, t.rx * sx, t.ry * sy, 0, 0, Math.PI * 2);
    mctx.fillStyle = (sty?.terrain ?? '#888888') + '99'; mctx.fill();
  }
  mctx.fillStyle = 'rgba(15, 23, 42, .8)';
  for (const o of st?.obstacles ?? []) { mctx.beginPath(); mctx.arc(o.x * sx, o.y * sy, Math.max(1.5 * dpr, o.r * sx), 0, Math.PI * 2); mctx.fill(); }
  mctx.fillStyle = '#4ade80';
  for (const o of orbs.values()) mctx.fillRect(o.x * sx - dpr, o.y * sy - dpr, 2 * dpr, 2 * dpr);
  for (const p of players.values()) {
    const s = (p.id === myId ? 4 : 2.5) * dpr;
    mctx.fillStyle = p.id === myId ? '#facc15' : p.flags & 1 ? 'rgba(248, 113, 113, .7)' : 'rgba(226, 232, 240, .8)';
    mctx.fillRect(p.x * sx - s / 2, p.y * sy - s / 2, s, s);
  }
  if (boss.alive) {
    mctx.beginPath(); mctx.arc(boss.x * sx, boss.y * sy, 4 * dpr, 0, Math.PI * 2);
    mctx.fillStyle = '#ef4444'; mctx.fill();
  }
}

function terrainAtClient(x, y) {
  for (const t of stage()?.terrain ?? []) {
    const dx = (x - t.x) / t.rx, dy = (y - t.y) / t.ry;
    if (dx * dx + dy * dy <= 1) return t.type;
  }
  return null;
}

// 自己的角色本地預測：照搖桿方向與職業速度先動，再慢慢對齊伺服器位置，延遲高時手感也是即時的；
// 差太多（被 BOSS 推開、衝刺、閃現、復活）就直接校正
function predictSelf(dt) {
  const me = players.get(myId);
  if (!me || !CLASSES) return;
  const c = CLASSES[me.cls];
  const r = topRank(myId);
  const ter = terrainFx[terrainAtClient(me.x, me.y)];
  const speed = c.speed * (me.flags & 1 ? 0.5 : 1) * (r >= 0 ? topBuff[r].speed : 1) * (ter?.speed ?? 1) * (me.flags & 16 ? mySpeedMult : 1);
  const [ix, iy] = moveDir();
  me.x = Math.max(map.r, Math.min(map.w - map.r, me.x + ix * speed * dt));
  me.y = Math.max(map.r, Math.min(map.h - map.r, me.y + iy * speed * dt));
  for (const o of stage()?.obstacles ?? []) {
    const dx = me.x - o.x, dy = me.y - o.y, d = Math.hypot(dx, dy) || 0.01, min = o.r + map.r;
    if (d < min) { me.x = o.x + dx / d * min; me.y = o.y + dy / d * min; }
  }
  if (Math.abs(ix) > 0.05) me.face = ix < 0 ? -1 : 1;
  if (Math.hypot(ix, iy) > 0.05) me.movingUntil = performance.now() + 150;
  const ex = me.tx - me.x, ey = me.ty - me.y, err = Math.hypot(ex, ey);
  if (err > 160) { me.x = me.tx; me.y = me.ty; return; }
  // 沒在推搖桿時對齊快一點，推搖桿時慢一點（伺服器位置本來就落後一個來回）
  const pull = 1 - Math.exp(-dt * (Math.hypot(ix, iy) > 0.05 ? 3 : 10));
  me.x += ex * pull; me.y += ey * pull;
}

let prev = performance.now(), frameErrors = 0;
function frame(now) {
  // 用 performance.now() 而不是 rAF 給的時間：rAF 的時間是這格開始的時間，可能比剛收到的訊息還早，
  // 特效進度會變成負數（曾造成 arc 半徑為負、整個畫面停住）
  now = performance.now();
  try { drawFrameAll(now); } catch (e) {
    if (frameErrors++ < 3) diag('frame-error', `${e.message} ${e.stack?.split('\n')[1]?.trim() ?? ''}`);
  }
  requestAnimationFrame(frame);
}

function drawFrameAll(now) {
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0b1229';
  ctx.fillRect(0, 0, W, H);
  fpsFrames++;
  if (now - fpsAt >= 1000) {
    fps = Math.round(fpsFrames * 1000 / (now - fpsAt)); fpsFrames = 0; fpsAt = now;
    lowFxScore = Math.max(-3, Math.min(3, lowFxScore + (fps < 40 ? 1 : fps > 55 ? -1 : 0)));
    if (lowFxScore >= 3) lowFx = true; else if (lowFxScore <= -3) lowFx = false;
  }
  if (joined) {
    sendInput(now);
    if (mainHeld || keyAttack) castSkill(0);
    // 平滑內插到伺服器位置
    const k = 1 - Math.exp(-dt * 14);
    for (const p of players.values()) {
      if (p.id === myId) continue;
      p.x += (p.tx - p.x) * k; p.y += (p.ty - p.y) * k;
    }
    predictSelf(dt);
    // BOSS 閃身步是瞬移：距離很遠就直接跳過去
    if (Math.hypot(boss.tx - boss.x, boss.ty - boss.y) > 200) { boss.x = boss.tx; boss.y = boss.ty; }
    else { boss.x += (boss.tx - boss.x) * k; boss.y += (boss.ty - boss.y) * k; }
    const me = players.get(myId);
    if (me) { const c = 1 - Math.exp(-dt * 10); cam.x += (me.x - cam.x) * c; cam.y += (me.y - cam.y) * c; }
    for (let i = effects.length - 1; i >= 0; i--) if (now - effects[i].born > effects[i].life) effects.splice(i, 1);

    const v = viewRect(), m = 200;
    ctx.setTransform(dpr * zoom, 0, 0, dpr * zoom, dpr * (W / 2 - cam.x * zoom), dpr * (H / 2 - cam.y * zoom));
    drawGrid(v);
    drawGroundFx(now);
    drawOrbs(now);
    drawPowerups(now);
    drawXpOrbs(now, v);
    // 角色與 BOSS 依 y 排序，越下面的越晚畫，前後遮擋才自然
    const actors = [...players.values()]
      .filter((p) => p.x > v.l - m && p.x < v.r + m && p.y > v.t - m && p.y < v.b + m)
      .map((p) => ({ y: p.y, draw: () => drawPlayer(p, now) }));
    if (boss.alive) actors.push({ y: boss.y + bossCfg.r * 0.6, draw: () => drawBoss(now) });
    const st = stage(), art = artFor(st?.id), sty = STAGE_STYLE[st?.id];
    for (const o of st?.obstacles ?? []) {
      if (o.x < v.l - 150 || o.x > v.r + 150 || o.y < v.t - 150 || o.y > v.b + 200) continue;
      actors.push({ y: o.y + o.r * 0.55, draw: () => drawObstacle(o, art, sty) });
    }
    actors.sort((a, b) => a.y - b.y).forEach((a) => a.draw());
    drawBalls(now);
    drawAirFx(now);
    for (const p of players.values()) {
      if (p.bubble && now < p.bubbleUntil && p.headY) drawBubble(p.bubble, p.x, p.headY);
    }
    if (boss.alive && boss.shout && now < boss.shoutUntil) drawShout(boss.shout, boss.x, boss.headY ?? boss.y - 140, now);
    else if (boss.alive && boss.bubble && now < boss.bubbleUntil) drawBubble(boss.bubble, boss.x, boss.headY ?? boss.y - 140);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawStick();
    drawMinimap(v);
    updateHud(now);
  }
}
requestAnimationFrame(frame);

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
let joined = false, myName = '', myCls = 'warrior', reconnectTimer = null;
let CLASSES = null, bossCfg = { name: 'BOSS', r: 60 };
const players = new Map(); // id -> { id, name, hue, cls, x, y, tx, ty, hp, mp, flags, ... }
const orbs = new Map();
const xpOrbs = new Map();    // 經驗球
let myExp = { lv: 1, exp: 0, next: 50 };
const balls = [];
const effects = [];        // 畫面特效（預警、震波、投射物、傷害數字…）
const boss = { x: 1200, y: 800, tx: 1200, ty: 800, hp: 0, maxHp: 1, level: 0, alive: false, anim: 0, animStart: 0 };
const cam = { x: 0, y: 0 };
const readyAt = [0, 0, 0];
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
function loadSheet(src) {
  const s = { img: new Image(), ready: false, size: 0, rows: 0, top: 0 };
  s.img.onload = () => {
    s.size = s.img.width / 4;
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
const PLAYER_CELL = 76;   // 玩家一格在世界裡的大小（40px 圖 × 1.9）
const BOSS_CELL = 240;    // BOSS 一格在世界裡的大小（約玩家的 3 倍）
const sheetFor = (cls) => (sheets[cls]?.ready ? sheets[cls] : sheets.base);
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
try { myCls = localStorage.getItem('lastCls') || myCls; } catch {}

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
    const s = sheetFor(key);
    if (s.ready) {
      const g = cv.getContext('2d');
      g.imageSmoothingEnabled = false;
      g.drawImage(s.img, 0, 0, s.size, s.size, 0, 0, 48, 48);
    }
    const t = document.createElement('div');
    const name = document.createElement('b');
    name.textContent = `${c.name}奶龍`;
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
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    setStatus(true);
    ws.send(JSON.stringify({ t: 'join', name: myName, cls: myCls, token: sessionStorage.getItem('token:' + myName.toLowerCase()) }));
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
  ws.onclose = () => {
    setStatus(false);
    // 已進入遊戲的人自動重連
    if (joined) { clearTimeout(reconnectTimer); reconnectTimer = setTimeout(connect, 1500); }
  };
}

// 手機切回前景時，連線若已斷就立刻重連
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && joined && ws?.readyState !== 1 && ws?.readyState !== 0) {
    clearTimeout(reconnectTimer); connect();
  }
});

function setStatus(on) { $('dot').classList.toggle('on', on); }

// ---------- 自動更新 ----------
// 部署新版後伺服器會通知；重新整理後用同一個 ID、職業自動進場（token 在 sessionStorage，會接回原本的角色）
let myVer = '';
function reloadForUpdate() {
  try { sessionStorage.setItem('autojoin', JSON.stringify({ name: myName, cls: myCls })); } catch {}
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
      if (!joined) { ws.onclose = null; ws.close(); setStatus(false); }
      break;
    case 'ver': if (myVer && m.v !== myVer) reloadForUpdate(); break;
    case 'welcome': {
      // 斷線重連時發現伺服器已經是新版（例如部署重啟），也要重新整理
      if (myVer && m.ver && m.ver !== myVer) return reloadForUpdate();
      myVer = m.ver;
      joined = true; myId = m.id; map = m.map; CLASSES = m.classes; bossCfg = m.bossCfg;
      sessionStorage.setItem('token:' + myName.toLowerCase(), m.token);
      try { localStorage.setItem('lastName', myName); } catch {}
      players.clear(); orbs.clear(); xpOrbs.clear(); balls.length = 0; effects.length = 0;
      for (const p of m.players) addPlayer(p);
      for (const o of m.orbs) orbs.set(o.id, o);
      for (const o of m.xpOrbs) xpOrbs.set(o.id, o);
      setBoss(m.boss, true);
      m.cds.forEach((ms, k) => { readyAt[k] = performance.now() + ms; });
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
    case 'cd': readyAt[m.k] = performance.now() + m.ms; break;
    case 'toast': toast(m.msg); break;
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
function onFx(f, now) {
  const p = f.id != null ? players.get(f.id) : null;
  switch (f.k) {
    case 'atk': if (p) { p.atkUntil = now + 400; p.face = boss.x < p.x ? -1 : 1; } break;
    case 'ball': balls.push({ ...f, born: now }); break;
    case 'orb+': orbs.set(f.id, f); break;
    case 'orb-': orbs.delete(f.id); break;
    case 'xp+': xpOrbs.set(f.id, f); break;
    case 'xp-': xpOrbs.delete(f.id); break;
    case 'lv':
      if (p) { p.lv = f.lv; p.maxHp = f.maxHp; p.maxMp = f.maxMp; }
      effects.push({ k: 'lvup', id: f.id, born: now, life: 1200 });
      if (f.id === myId) toast(`升級！Lv.${f.lv}`);
      break;
    case 'down': if (f.id === myId) deadSince = now; break;
    case 'cast': bossCast(f.name, now); break;
    case 'bossspawn': banner(`第 ${f.level} 輪　${bossCfg.name}出現！`); break;
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
  if (soundOn && 'speechSynthesis' in window) {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(name);
    u.lang = 'zh-TW'; u.rate = 1.15; u.pitch = 0.7; u.volume = 1;
    speechSynthesis.speak(u);
  }
}

// 頭上大字：紅框白底，比聊天泡泡更醒目
function drawShout(text, x, y, now) {
  const t = 1 - (boss.shoutUntil - now) / 1600;
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
  if (composing) return;
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
    myName = auto.name; myCls = auto.cls || myCls;
    $('joinerr').textContent = '已更新，重新進場中…';
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
  if (e.target.tagName === 'INPUT' || e.isComposing) return;
  const k = e.key.toLowerCase();
  keys.add(k);
  if (k === 'k') castSkill(1);
  if (k === 'l') castSkill(2);
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());
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
  const [dx, dy] = moveDir();
  ws.send(JSON.stringify({ t: 'skill', k, dx: +dx.toFixed(2), dy: +dy.toFixed(2) }));
}

for (const b of skillBtns) {
  const k = +b.dataset.k;
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
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

// ---------- 排行榜（點左上角頭像打開） ----------
let rankData = null, rankTab = 'dmg', rankTimer = null;
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

function renderRank() {
  if (!rankData) return;
  const d = rankData[rankTab];
  const list = $('ranklist');
  list.replaceChildren();
  if (!d.list.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = rankTab === 'dmg' ? '還沒有人打到 BOSS' : '還沒有人補過血';
    list.append(li);
  }
  d.list.forEach((r, i) => {
    const li = document.createElement('li');
    if (r.name === myName) li.className = 'me';
    if (!r.on) li.classList.add('off');
    const no = document.createElement('span'); no.className = 'no'; no.textContent = i + 1;
    const who = document.createElement('span'); who.className = 'who';
    who.textContent = `Lv.${r.lv ?? 1} ${r.name}`;
    const cls = document.createElement('small'); cls.textContent = CLASSES?.[r.cls]?.name ?? '';
    who.append(cls);
    const v = document.createElement('span'); v.className = 'v'; v.textContent = r.v.toLocaleString('zh-TW');
    li.append(no, who, v);
    list.append(li);
  });
  $('rankme').textContent = d.me
    ? `你是第 ${d.me.rank} 名（共 ${d.total} 人），${rankTab === 'dmg' ? '傷害' : '治療'} ${d.me.v.toLocaleString('zh-TW')}`
    : `你還沒有${rankTab === 'dmg' ? '打到 BOSS' : '補過血'}`;
}

// 頭像：目前職業精靈圖的第一格
let avatarKey = '';
function drawAvatar(cls) {
  const s = sheetFor(cls);
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
  drawAvatar(me.cls);
  $('statname').textContent = `Lv.${me.lv} ${me.name}`;
  $('statcls').textContent = `${c.name}奶龍`;
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
  if (me.flags & 8) st.push('減傷');
  if (me.flags & 2 && !(me.flags & 1)) st.push('無敵');
  $('statstate').textContent = st.join('・');

  const dead = !!(me.flags & 1);
  $('deadmsg').hidden = !dead;
  if (dead) {
    const left = Math.max(0, Math.ceil(12 - (now - deadSince) / 1000));
    $('deadmsg').textContent = `你倒下了，${deadSince ? left + ' 秒後' : '稍後'}自動復活\n可以慢慢走去找補師救你`;
  }

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
    b.querySelector('.cd').style.setProperty('--p', sk.cd ? Math.min(1, left / sk.cd) : 0);
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

function drawGrid(v) {
  ctx.fillStyle = '#132042';
  ctx.fillRect(0, 0, map.w, map.h);
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

function drawPlayer(p, now) {
  const r = map.r, feet = p.y + r, c = CLASSES?.[p.cls];
  const dead = p.flags & 1, inv = p.flags & 2;
  // 腳下光圈：每個人顏色不同；自己有白框；嘲諷中是紅框
  ctx.beginPath();
  ctx.ellipse(p.x, feet, r * 0.95, r * 0.38, 0, 0, Math.PI * 2);
  ctx.fillStyle = `hsl(${p.hue} 85% 55% / ${dead ? 0.25 : 0.6})`;
  ctx.fill();
  if (p.flags & 4) { ctx.lineWidth = 3; ctx.strokeStyle = '#ef4444'; ctx.stroke(); }
  else if (p.id === myId) { ctx.lineWidth = 3; ctx.strokeStyle = '#ffffff'; ctx.stroke(); }

  const s = sheetFor(p.cls);
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
  // 名字
  ctx.font = `bold 13px ${FONT}`;
  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0, 0, 0, .6)';
  const label = `Lv.${p.lv ?? 1} ${p.name}${dead ? '（倒地）' : ''}`;
  ctx.strokeText(label, p.x, feet + 10);
  ctx.fillStyle = dead ? '#fca5a5' : '#fff';
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

// 地上的特效（畫在角色下面）：預警、震波、補血範圍
function drawGroundFx(now) {
  for (const e of effects) {
    const t = Math.min(1, (now - e.born) / e.life);
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
    const t = Math.min(1, (now - e.born) / e.life);
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
      if (e.kind === 'arrow') {
        const ang = Math.atan2(ty - y, tx - x);
        ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
        ctx.strokeStyle = '#fde68a'; ctx.lineWidth = 3;
        ctx.beginPath(); ctx.moveTo(-14, 0); ctx.lineTo(8, 0); ctx.stroke();
        ctx.fillStyle = '#e5e7eb'; ctx.beginPath(); ctx.moveTo(12, 0); ctx.lineTo(5, -4); ctx.lineTo(5, 4); ctx.fill();
        ctx.restore();
      } else {
        ctx.beginPath(); ctx.arc(x, y, e.kind === 'magic' ? 9 : 7, 0, Math.PI * 2);
        ctx.fillStyle = e.kind === 'magic' ? '#93c5fd' : '#fef9c3';
        ctx.shadowColor = ctx.fillStyle; ctx.shadowBlur = 12; ctx.fill(); ctx.shadowBlur = 0;
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
    ctx.fillStyle = '#22c55e'; ctx.shadowColor = '#4ade80'; ctx.shadowBlur = 14; ctx.fill(); ctx.shadowBlur = 0;
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

let prev = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - prev) / 1000);
  prev = now;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.fillStyle = '#0b1229';
  ctx.fillRect(0, 0, W, H);
  if (joined) {
    sendInput(now);
    if (mainHeld) castSkill(0);
    // 平滑內插到伺服器位置
    const k = 1 - Math.exp(-dt * 14);
    for (const p of players.values()) { p.x += (p.tx - p.x) * k; p.y += (p.ty - p.y) * k; }
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
    drawXpOrbs(now, v);
    // 角色與 BOSS 依 y 排序，越下面的越晚畫，前後遮擋才自然
    const actors = [...players.values()]
      .filter((p) => p.x > v.l - m && p.x < v.r + m && p.y > v.t - m && p.y < v.b + m)
      .map((p) => ({ y: p.y, draw: () => drawPlayer(p, now) }));
    if (boss.alive) actors.push({ y: boss.y + bossCfg.r * 0.6, draw: () => drawBoss(now) });
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
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

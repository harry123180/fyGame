// fyGame 多人伺服器：靜態檔（全部 no-store）＋ WebSocket /ws
// 伺服器權威：客戶端只送搖桿方向與技能按鍵，位置、戰鬥、BOSS 都由伺服器計算後廣播
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

const PORT = Number(process.env.PORT) || 3000;
const HTML_DIR = path.resolve('html');
const MAP_W = 2400, MAP_H = 1600;
const CENTER = { x: MAP_W / 2, y: MAP_H / 2 };
const RADIUS = 22;
const TICK_HZ = 20;
const NAME_MAX = 12;
const CHAT_MAX = 100;
const CHAT_INTERVAL_MS = 400;   // 每人發言最短間隔
const CHAT_HISTORY = 30;
const BUBBLE_MS = 5000;
const MAX_PLAYERS = 120;
const RESPAWN_MS = 12000;       // 倒地後自動復活時間
const ORB_MAX = 6, ORB_EVERY_MS = 5000, ORB_HEAL = 35, ORB_MP = 25;
// 等級：吃經驗球、擊敗 BOSS 升級；每級 HP +8%、MP +5%、攻擊與治療 +6%，升級時補滿
const LV_MAX = 30;
const XP_ORB_MAX = 45, XP_ORB_EVERY_MS = 350, XP_ORB_VALUE = 6;
const BOSS_XP_ALL = 40, BOSS_XP_HIT = 80;     // × BOSS 輪數：在場每人／有打到 BOSS 的人再加
const expToNext = (lv) => 50 + 30 * (lv - 1);
const lvMult = { hp: 0.08, mp: 0.05, power: 0.06 };

// ---------- 職業 ----------
// 技能 kind：melee（近戰打 BOSS）、shot（遠程打 BOSS）、multishot、taunt、charge、dash、blink、meteor、heal、revive
const CLASSES = {
  warrior: {
    name: '戰士', role: '坦克・近戰', hp: 220, mp: 60, speed: 240, mpRegen: 5,
    desc: '血厚，能嘲諷 BOSS 保護隊友',
    skills: [
      { name: '斬擊', kind: 'melee', cd: 600, mp: 0, dmg: 16, desc: '近身砍 BOSS（按住連續攻擊）' },
      { name: '嘲諷', kind: 'taunt', cd: 15000, mp: 25, dur: 6000, desc: '6 秒內 BOSS 優先打你，自身傷害減半' },
      { name: '衝鋒', kind: 'charge', cd: 6000, mp: 15, dist: 220, dmg: 28, desc: '往前衝刺並無敵，撞到 BOSS 造成傷害' },
    ],
  },
  archer: {
    name: '弓箭手', role: '遠程輸出', hp: 130, mp: 80, speed: 270, mpRegen: 5,
    desc: '跑得快、射得遠，翻滾閃招',
    skills: [
      { name: '射箭', kind: 'shot', fx: 'arrow', cd: 500, mp: 0, dmg: 11, desc: '遠程射 BOSS（按住連續攻擊）' },
      { name: '多重箭', kind: 'multishot', fx: 'arrow', cd: 6000, mp: 20, dmg: 8, count: 5, desc: '一次射出 5 支箭' },
      { name: '翻滾', kind: 'dash', cd: 4000, mp: 10, dist: 180, desc: '往搖桿方向翻滾，翻滾中無敵' },
    ],
  },
  mage: {
    name: '法師', role: '爆發輸出', hp: 110, mp: 140, speed: 250, mpRegen: 7,
    desc: '血少但傷害高，隕石要預判',
    skills: [
      { name: '魔法彈', kind: 'shot', fx: 'magic', cd: 700, mp: 0, dmg: 14, desc: '遠程魔法攻擊（按住連續攻擊）' },
      { name: '隕石', kind: 'meteor', cd: 10000, mp: 35, dmg: 60, radius: 130, delay: 1000, desc: '1 秒後砸向 BOSS 目前位置，BOSS 閃開就落空' },
      { name: '閃現', kind: 'blink', cd: 8000, mp: 20, dist: 220, desc: '瞬間移動到搖桿方向' },
    ],
  },
  healer: {
    name: '補師', role: '治療・復活', hp: 150, mp: 160, speed: 255, mpRegen: 8,
    desc: '幫隊友補血，還能救起倒地的人',
    skills: [
      { name: '光球', kind: 'shot', fx: 'light', cd: 700, mp: 0, dmg: 7, desc: '遠程攻擊（按住連續攻擊）' },
      { name: '治療', kind: 'heal', cd: 5000, mp: 30, heal: 45, radius: 200, desc: '補自己和周圍隊友 45 HP' },
      { name: '復活', kind: 'revive', cd: 14000, mp: 50, radius: 170, heal: 20, desc: '救起周圍倒地的隊友（60% HP），並補活著的隊友' },
    ],
  },
};
const MELEE_RANGE = 90, SHOT_RANGE = 650;

// ---------- BOSS ----------
// 三招都先顯示預警（紅色範圍）再造成傷害，玩家看到預警就能閃
const BOSS = {
  name: '舞王', r: 60,
  hpBase: 2500, hpPerPlayer: 900,
  gapMs: 2600,                                   // 兩招之間的間隔，狂暴時 ×0.7
  bear: { tele: 1300, radius: 260, dmg: 40 },    // 狗熊哆嗦毛：以自身為中心的震波
  kick: { tele: 800, speed: 560, life: 1800, r: 18, dmg: 30, width: 36 }, // 浪子踢球：朝目標踢球
  flash: { tele: 900, radius: 150, dmg: 45, reach: 600 },                 // 閃身步：瞬移到預警點並落地傷害
  enrageAt: 0.3, enrageDmg: 1.3,
  respawnMs: 12000,
};
const BOSS_ANIMS = ['idle', 'flash', 'bear', 'kick'];

// ---------- 靜態檔 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.webp': 'image/webp',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
};
// 最高準則：完全不快取（no-store 才能壓過 Cloudflare 的 Browser Cache TTL）
const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
  'Pragma': 'no-cache', 'Expires': '0',
};

const server = http.createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/api/classes') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', ...NO_CACHE });
    return res.end(JSON.stringify(CLASSES));
  }
  if (p === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'application/json', ...NO_CACHE });
    return res.end(JSON.stringify({ ok: true, players: players.size, boss: { level: boss.level, hp: Math.round(boss.hp), alive: boss.alive } }));
  }
  if (p.endsWith('/')) p += 'index.html';
  const file = path.join(HTML_DIR, p);
  if (!file.startsWith(HTML_DIR + path.sep)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8', ...NO_CACHE });
      return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', ...NO_CACHE });
    res.end(data);
  });
});

// ---------- 版本：部署後讓所有手機自動重新整理 ----------
// deploy.sh 每次部署會寫入 html/version.txt；內容變了就廣播，客戶端看到新版本號就重新整理並自動重新進場
const readVer = () => { try { return fs.readFileSync(path.join(HTML_DIR, 'version.txt'), 'utf8').trim(); } catch { return ''; } };
let siteVer = readVer();
setInterval(() => {
  const v = readVer();
  if (v && v !== siteVer) { siteVer = v; broadcast({ t: 'ver', v }); }
}, 2000);

// ---------- 遊戲狀態 ----------
const players = new Map();   // id -> player
const sessions = new Map();  // nameKey -> { token, id }
// 斷線的玩家（手機鎖螢幕、切到背景、網路不穩）保留 30 分鐘：用同一個 token 回來就接回等級、經驗、血量、位置；
// 這段期間 ID 也保留給原本的人
const OFFLINE_KEEP_MS = 30 * 60 * 1000;
const offline = new Map();   // nameKey -> { token, snap, until }
// 排行榜：依 ID 累計對 BOSS 的傷害與治療量，離開再回來也不會歸零（伺服器重啟才清空）
const stats = new Map();     // nameKey -> { name, cls, lv, dmg, heal }
const RANK_TOP = 20;
// 全服前三名（綜合貢獻 = 對 BOSS 傷害 + 治療量，只算在線的人）：移動速度與技能冷卻增幅，畫面上有彩虹特效
const TOP_BUFF = [{ speed: 1.2, cd: 0.8 }, { speed: 1.15, cd: 0.85 }, { speed: 1.1, cd: 0.9 }];
const TOP_EVERY_MS = 2000;
let top3 = [], lastTopAt = 0;
const buffOf = (p) => TOP_BUFF[top3.indexOf(p.id)] ?? null;
const chatLog = [];
const orbs = new Map();      // id -> { id, x, y }
const xpOrbs = new Map();    // 經驗球 id -> { id, x, y }
const balls = [];            // BOSS 踢出的球
const timers = [];           // { at, fn } 延遲觸發（預警後的傷害、投射物命中）
let fx = [];                 // 本 tick 要廣播的特效事件
let nextId = 1, nextOrbId = 1, nextBallId = 1, lastOrbAt = 0, lastXpOrbAt = 0;

const boss = {
  x: CENTER.x, y: CENTER.y, hp: 0, maxHp: 1, level: 0, alive: false, respawnAt: 0,
  anim: 0, animAt: 0, nextActionAt: 0, busyUntil: 0,
};

const hue = (name) => {
  let h = 0;
  for (const c of name) h = (h * 31 + c.codePointAt(0)) >>> 0;
  return h % 360;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const later = (ms, fn) => timers.push({ at: Date.now() + ms, fn });
// 中文處理：NFC 正規化、移除控制字元／零寬字元／方向覆寫字元，
// 長度以「字」計算（Array.from 依 code point 切），不會把 emoji 或罕用字切成亂碼
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;
const cleanText = (s, max) => Array.from(String(s ?? '').normalize('NFC').replace(INVISIBLE, '').trim()).slice(0, max).join('').trim();
// 名字比對用：NFKC 讓全形「ＡＢＣ」與半形「ABC」視為同一個 ID
const nameKey = (name) => name.normalize('NFKC').toLowerCase();

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}
function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const p of players.values()) if (p.ws.readyState === p.ws.OPEN) p.ws.send(data);
}
const publicInfo = (p) => ({ id: p.id, name: p.name, hue: p.hue, cls: p.cls, lv: p.lv, maxHp: p.maxHp, maxMp: p.maxMp, x: Math.round(p.x), y: Math.round(p.y) });
const power = (p) => 1 + lvMult.power * (p.lv - 1);

// 依等級重算 HP／MP 上限
function applyLevel(p) {
  const c = CLASSES[p.cls];
  p.maxHp = Math.round(c.hp * (1 + lvMult.hp * (p.lv - 1)));
  p.maxMp = Math.round(c.mp * (1 + lvMult.mp * (p.lv - 1)));
}

function sendExp(p) {
  send(p.ws, { t: 'exp', lv: p.lv, exp: Math.floor(p.exp), next: p.lv >= LV_MAX ? 0 : expToNext(p.lv) });
}

function gainExp(p, n) {
  if (p.lv >= LV_MAX) return;
  p.exp += n;
  let up = false;
  while (p.lv < LV_MAX && p.exp >= expToNext(p.lv)) {
    p.exp -= expToNext(p.lv);
    p.lv++;
    up = true;
  }
  if (p.lv >= LV_MAX) p.exp = 0;
  if (up) {
    applyLevel(p);
    if (!p.dead) { p.hp = p.maxHp; p.mp = p.maxMp; }
    fx.push({ k: 'lv', id: p.id, lv: p.lv, maxHp: p.maxHp, maxMp: p.maxMp });
    if (p.lv % 5 === 0) systemChat(`${p.name} 升到 Lv.${p.lv} 了！`);
  }
  sendExp(p);
}
const alivePlayers = () => [...players.values()].filter((p) => !p.dead);

// ---------- 加入／離開 ----------
function join(ws, msg) {
  const name = cleanText(msg.name, NAME_MAX);
  if (!name) return send(ws, { t: 'error', msg: '請輸入遊戲 ID' });
  const cls = CLASSES[msg.cls] ? msg.cls : 'warrior';
  if (players.size >= MAX_PLAYERS) return send(ws, { t: 'error', msg: '人數已滿' });

  const key = nameKey(name);
  let sess = sessions.get(key);
  let prev = null, back = false;
  if (sess) {
    if (sess.token !== msg.token) return send(ws, { t: 'error', msg: '這個 ID 已經有人用了，換一個吧' });
    // 同一人斷線重連（舊連線還沒被偵測到斷掉）：踢掉舊連線，沿用位置與狀態
    const old = players.get(sess.id);
    if (old) {
      prev = old;
      removePlayer(old, false);
      // 被同一個 ID 的新連線取代（另一個分頁、PWA、另一台裝置）：用 4001 關閉，舊的那邊就不會再自動重連搶回來
      old.ws.kickReason = 'replaced';
      send(old.ws, { t: 'kicked', msg: '這個 ID 在別的分頁或裝置登入了' });
      old.ws.close(4001, 'replaced');
    }
  } else {
    const off = offline.get(key);
    if (off && Date.now() < off.until) {
      if (off.token !== msg.token) return send(ws, { t: 'error', msg: '這個 ID 的主人剛剛斷線，30 分鐘內保留給他，換一個吧' });
      prev = off.snap; back = true;
      sess = { token: off.token };
    }
    offline.delete(key);
  }

  const token = sess?.token ?? crypto.randomBytes(16).toString('hex');
  const c = CLASSES[cls];
  const keep = prev && prev.cls === cls;
  const spawn = prev ?? randomSpawn();
  const p = {
    id: nextId++, name, hue: hue(name), ws, cls,
    x: spawn.x, y: spawn.y, ix: 0, iy: 0, lastChat: 0,
    lv: prev?.lv ?? 1, exp: prev?.exp ?? 0, dealt: 0,
    maxHp: c.hp, maxMp: c.mp,
    hp: keep ? prev.hp : c.hp, mp: keep ? prev.mp : c.mp,
    dead: keep ? prev.dead : false, deadUntil: keep ? prev.deadUntil : 0,
    cds: keep ? prev.cds : [0, 0, 0],
    invulnUntil: 0, tauntUntil: 0, guardUntil: 0, dash: null,
  };
  applyLevel(p);
  if (!keep) { p.hp = p.maxHp; p.mp = p.maxMp; }
  ws.player = p;
  players.set(p.id, p);
  sessions.set(key, { token, id: p.id });
  if (!boss.alive && (boss.level === 0 || boss.respawnAt === 0)) spawnBoss();
  // 戰鬥中有新玩家加入（不是重連），BOSS 的 HP 跟著加，人多人少都打得夠久
  else if (boss.alive && !prev) {
    const add = Math.round(BOSS.hpPerPlayer * (1 + 0.25 * (boss.level - 1)));
    boss.maxHp += add; boss.hp += add;
  }

  send(ws, {
    t: 'welcome', id: p.id, token, ver: siteVer, map: { w: MAP_W, h: MAP_H, r: RADIUS },
    classes: CLASSES, boss: bossInfo(), bossCfg: { name: BOSS.name, r: BOSS.r, anims: BOSS_ANIMS },
    players: [...players.values()].map(publicInfo), orbs: [...orbs.values()], xpOrbs: [...xpOrbs.values()], chat: chatLog,
    cds: p.cds.map((t) => Math.max(0, t - Date.now())), top3, topBuff: TOP_BUFF,
  });
  sendExp(p);
  broadcast({ t: 'join', p: publicInfo(p) });
  if (back) systemChat(`${name} 回來了`);
  else if (!prev) systemChat(`${name}（${c.name}）加入了`);
}

// 出生點：離 BOSS 有一段距離的地圖外圈
function randomSpawn() {
  for (let i = 0; i < 20; i++) {
    const pt = { x: 150 + Math.random() * (MAP_W - 300), y: 150 + Math.random() * (MAP_H - 300) };
    if (dist(pt, boss) > 500) return pt;
  }
  return { x: 200, y: 200 };
}

function removePlayer(p, announce = true) {
  if (!players.has(p.id)) return;
  players.delete(p.id);
  broadcast({ t: 'leave', id: p.id });
  if (announce) {
    // 斷線：把角色狀態存起來保留 30 分鐘，同一個 token 回來就接回（重連 announce=false 不走這裡）
    const key = nameKey(p.name);
    const sess = sessions.get(key);
    if (sess?.id === p.id) {
      sessions.delete(key);
      const snap = { cls: p.cls, lv: p.lv, exp: p.exp, hp: p.hp, mp: p.mp, dead: p.dead, deadUntil: p.deadUntil, cds: p.cds, x: p.x, y: p.y };
      offline.set(key, { token: sess.token, snap, until: Date.now() + OFFLINE_KEEP_MS });
    }
    systemChat(`${p.name} 斷線了`);
  }
}

// ---------- 聊天 ----------
function pushChat(entry) {
  chatLog.push(entry);
  if (chatLog.length > CHAT_HISTORY) chatLog.shift();
  broadcast({ t: 'chat', ...entry });
}
const systemChat = (text) => pushChat({ id: 0, name: '系統', text, ts: Date.now() });

function chat(p, msg) {
  const text = cleanText(msg.text, CHAT_MAX);
  if (!text) return;
  const now = Date.now();
  if (now - p.lastChat < CHAT_INTERVAL_MS) return;
  p.lastChat = now;
  pushChat({ id: p.id, name: p.name, hue: p.hue, text, ts: now, ttl: BUBBLE_MS });
  scheduleBossReply();
}

// ---------- BOSS 聊天（LiteLLM／Gemma4） ----------
// 有人說話後隨機等 5～8 秒，拿最近的聊天與戰況請 LLM 用 BOSS 口吻加顏文字回一句。
// 同一時間只排一則回覆，40 人一起聊也不會洗版。金鑰在 .env（LLM_API_KEY），沒設就不回話。
const LLM = { url: process.env.LLM_BASE_URL, key: process.env.LLM_API_KEY, model: process.env.LLM_MODEL || 'gemma4-31b' };
const BOSS_CHAT = { minMs: 5000, maxMs: 8000, maxLen: 50, timeoutMs: 6000, context: 12 };
const BOSS_PROMPT = `你是手機多人合作遊戲裡的 BOSS「${BOSS.name}」：Q 版光頭大叔，穿白色 V 領 T 恤和灰色運動褲。
你的招式是「閃身步」（瞬間閃到玩家身邊）、「狗熊哆嗦毛」（原地抖動放出震波）、「浪子踢球」（把足球踢向玩家）。
玩家都是黃色的「奶龍」，職業有戰士、弓箭手、法師、補師，大家組隊來打你。
規則：
- 用台灣繁體中文回一句話，${BOSS_CHAT.maxLen} 字以內
- 一定要帶一個日式顏文字，例如 (｀・ω・´)、(￣▽￣)ノ、(╯°□°)╯、( ˘•ω•˘ )
- 不要用 emoji
- 語氣囂張、愛耍帥又有點搞笑，可以點名回應玩家，可以提到自己的招式或血量
- 不要罵髒話、不要人身攻擊、不要談政治或成人話題
- 只輸出那一句台詞，不要加引號、不要加名字前綴`;
let bossReplyTimer = null;

function scheduleBossReply() {
  if (!LLM.url || !LLM.key || bossReplyTimer) return;
  const delay = BOSS_CHAT.minMs + Math.random() * (BOSS_CHAT.maxMs - BOSS_CHAT.minMs);
  bossReplyTimer = setTimeout(async () => {
    try { await bossReply(); } catch (e) { console.error('boss chat:', e.message); }
    bossReplyTimer = null;
  }, delay);
}

async function bossReply() {
  const lines = chatLog.filter((c) => c.id !== 0).slice(-BOSS_CHAT.context)
    .map((c) => `${c.id === -1 ? `${BOSS.name}（你）` : c.name}：${c.text}`);
  if (!lines.length) return;
  const state = boss.alive
    ? `第 ${boss.level} 輪，你的 HP 剩 ${Math.round(boss.hp / boss.maxHp * 100)}%${enraged() ? '（狂暴中）' : ''}，在場 ${players.size} 隻奶龍，倒地 ${players.size - alivePlayers().length} 隻。`
    : `你剛被打倒，正在等下一輪復活（第 ${boss.level + 1} 輪），在場 ${players.size} 隻奶龍。`;
  const res = await fetch(`${LLM.url}/chat/completions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${LLM.key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: LLM.model, max_tokens: 120, temperature: 0.9,
      messages: [
        { role: 'system', content: BOSS_PROMPT },
        { role: 'user', content: `目前戰況：${state}\n最近的聊天：\n${lines.join('\n')}\n\n請用${BOSS.name}的身分回一句。` },
      ],
    }),
    signal: AbortSignal.timeout(BOSS_CHAT.timeoutMs),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data = await res.json();
  let text = String(data.choices?.[0]?.message?.content ?? '')
    .replace(/\p{Extended_Pictographic}/gu, '')        // 設計原則：不用 emoji
    .replace(new RegExp(`^\\s*${BOSS.name}\\s*[：:]`), '') // 模型偶爾會自己加名字前綴
    .replace(/^["「『]|["」』]$/g, '')
    .split('\n')[0];
  text = cleanText(text, BOSS_CHAT.maxLen + 10);
  if (text) pushChat({ id: -1, name: BOSS.name, text, ts: Date.now(), ttl: BUBBLE_MS + 2000 });
}

function input(p, msg) {
  let x = Number(msg.x) || 0, y = Number(msg.y) || 0;
  const len = Math.hypot(x, y);
  if (len > 1) { x /= len; y /= len; }
  p.ix = x; p.iy = y;
}

// ---------- 戰鬥：玩家 ----------
const isInvuln = (p, now) => now < p.invulnUntil || (p.dash && now < p.dash.until);

function hurt(p, dmg, now) {
  if (p.dead || isInvuln(p, now)) return;
  if (now < p.guardUntil) dmg *= 0.5;
  dmg = Math.round(dmg);
  p.hp -= dmg;
  fx.push({ k: 'dmg', x: Math.round(p.x), y: Math.round(p.y), v: dmg, c: 'hurt', id: p.id });
  if (p.hp <= 0) {
    p.hp = 0; p.dead = true; p.deadUntil = now + RESPAWN_MS; p.dash = null;
    fx.push({ k: 'down', id: p.id });
  }
}

function statOf(p) {
  const key = nameKey(p.name);
  let st = stats.get(key);
  if (!st) stats.set(key, st = { name: p.name, dmg: 0, heal: 0 });
  st.name = p.name; st.cls = p.cls; st.lv = p.lv;
  return st;
}

// by：施放治療的玩家（算進治療排行榜）；補血果實沒有 by
function healP(p, amount, now, by) {
  if (p.dead) return;
  const v = Math.min(p.maxHp - p.hp, Math.round(amount));
  if (v <= 0) return;
  p.hp += v;
  if (by) statOf(by).heal += v;
  fx.push({ k: 'dmg', x: Math.round(p.x), y: Math.round(p.y), v, c: 'heal', id: p.id });
}

function revive(p, ratio, now) {
  p.dead = false; p.hp = Math.round(p.maxHp * ratio); p.invulnUntil = now + 2000;
  fx.push({ k: 'revive', id: p.id, x: Math.round(p.x), y: Math.round(p.y) });
}

function hitBoss(dmg, by, now) {
  if (!boss.alive) return;
  dmg = Math.round(dmg);
  boss.hp -= dmg;
  const src = players.get(by);
  if (src) { src.dealt += dmg; statOf(src).dmg += dmg; }
  fx.push({ k: 'dmg', x: Math.round(boss.x + (Math.random() - 0.5) * 60), y: Math.round(boss.y - 40), v: dmg, c: 'boss', by });
  if (boss.hp <= 0) defeatBoss(now);
}

// 技能方向：有推搖桿用搖桿方向，沒推的話衝鋒朝 BOSS、閃避遠離 BOSS
function skillDir(p, msg, towardBoss) {
  let dx = Number(msg.dx) || 0, dy = Number(msg.dy) || 0;
  let l = Math.hypot(dx, dy);
  if (l < 0.2) {
    dx = boss.x - p.x; dy = boss.y - p.y;
    if (!towardBoss) { dx = -dx; dy = -dy; }
    l = Math.hypot(dx, dy) || 1;
  }
  return { x: dx / l, y: dy / l };
}

function useSkill(p, msg) {
  const now = Date.now();
  const k = Number(msg.k);
  const sk = CLASSES[p.cls].skills[k];
  if (!sk || p.dead) return;
  if (now < p.cds[k]) return;
  if (p.mp < sk.mp) return send(p.ws, { t: 'toast', msg: 'MP 不夠' });

  const toBoss = boss.alive ? dist(p, boss) - BOSS.r : Infinity;
  if (['melee', 'shot', 'multishot', 'meteor'].includes(sk.kind)) {
    if (!boss.alive) return send(p.ws, { t: 'toast', msg: 'BOSS 還沒出現' });
    const range = sk.kind === 'melee' ? MELEE_RANGE : SHOT_RANGE;
    if (toBoss > range) return send(p.ws, { t: 'toast', msg: sk.kind === 'melee' ? '離 BOSS 太遠，靠近一點' : '超出射程' });
  }

  p.mp -= sk.mp;
  const cd = Math.round(sk.cd * (buffOf(p)?.cd ?? 1));
  p.cds[k] = now + cd;
  send(p.ws, { t: 'cd', k, ms: cd });
  fx.push({ k: 'atk', id: p.id, s: k });

  switch (sk.kind) {
    case 'melee':
      fx.push({ k: 'slash', id: p.id, x: Math.round(boss.x), y: Math.round(boss.y) });
      hitBoss(sk.dmg * power(p), p.id, now);
      break;
    case 'shot':
    case 'multishot': {
      const n = sk.count || 1;
      const travel = Math.round(Math.max(80, toBoss) / 900 * 1000);
      for (let i = 0; i < n; i++) {
        const spread = n > 1 ? (i - (n - 1) / 2) * 0.16 : 0;
        fx.push({ k: 'proj', kind: sk.fx, x1: Math.round(p.x), y1: Math.round(p.y - 20), spread, dur: travel });
        later(travel, () => hitBoss(sk.dmg * power(p), p.id, Date.now()));
      }
      break;
    }
    case 'meteor': {
      const tx = boss.x, ty = boss.y;
      fx.push({ k: 'mark', x: Math.round(tx), y: Math.round(ty), r: sk.radius, dur: sk.delay });
      later(sk.delay, () => {
        fx.push({ k: 'boom', x: Math.round(tx), y: Math.round(ty), r: sk.radius });
        if (boss.alive && Math.hypot(boss.x - tx, boss.y - ty) <= sk.radius + BOSS.r) hitBoss(sk.dmg * power(p), p.id, Date.now());
        else if (p.ws) send(p.ws, { t: 'toast', msg: '隕石落空了' });
      });
      break;
    }
    case 'taunt':
      p.tauntUntil = now + sk.dur; p.guardUntil = now + sk.dur;
      fx.push({ k: 'taunt', id: p.id });
      break;
    case 'charge':
    case 'dash': {
      const d = skillDir(p, msg, sk.kind === 'charge');
      const dur = 250;
      p.dash = { vx: d.x * sk.dist / (dur / 1000), vy: d.y * sk.dist / (dur / 1000), until: now + dur, kind: sk.kind, dmg: (sk.dmg || 0) * power(p) };
      p.invulnUntil = now + dur + 150;
      break;
    }
    case 'blink': {
      const d = skillDir(p, msg, false);
      const from = { x: Math.round(p.x), y: Math.round(p.y) };
      p.x = clamp(p.x + d.x * sk.dist, RADIUS, MAP_W - RADIUS);
      p.y = clamp(p.y + d.y * sk.dist, RADIUS, MAP_H - RADIUS);
      p.invulnUntil = now + 300;
      fx.push({ k: 'blink', id: p.id, x1: from.x, y1: from.y, x2: Math.round(p.x), y2: Math.round(p.y) });
      break;
    }
    case 'heal':
      fx.push({ k: 'healwave', x: Math.round(p.x), y: Math.round(p.y), r: sk.radius });
      for (const q of players.values()) if (dist(p, q) <= sk.radius) healP(q, sk.heal * power(p), now, p);
      break;
    case 'revive': {
      fx.push({ k: 'healwave', x: Math.round(p.x), y: Math.round(p.y), r: sk.radius, revive: 1 });
      let saved = 0;
      for (const q of players.values()) {
        if (dist(p, q) > sk.radius) continue;
        if (q.dead) { revive(q, 0.6, now); statOf(p).heal += q.hp; saved++; }
        else healP(q, sk.heal * power(p), now, p);
      }
      if (saved) systemChat(`${p.name} 救起了 ${saved} 位隊友`);
      break;
    }
  }
}

// ---------- 戰鬥：BOSS ----------
const bossInfo = () => ({
  x: Math.round(boss.x), y: Math.round(boss.y), hp: Math.max(0, Math.round(boss.hp)), maxHp: boss.maxHp,
  level: boss.level, alive: boss.alive, anim: boss.anim, animMs: Date.now() - boss.animAt,
});

function spawnBoss() {
  boss.level++;
  const n = Math.max(1, players.size);
  boss.maxHp = Math.round((BOSS.hpBase + BOSS.hpPerPlayer * n) * (1 + 0.25 * (boss.level - 1)));
  boss.hp = boss.maxHp;
  boss.x = CENTER.x; boss.y = CENTER.y;
  boss.alive = true;
  boss.nextActionAt = Date.now() + 3000;
  setBossAnim(0);
  fx.push({ k: 'bossspawn', level: boss.level });
  systemChat(`第 ${boss.level} 輪：${BOSS.name} 出現在地圖中央！（HP ${boss.maxHp}）`);
}

function defeatBoss(now) {
  boss.alive = false;
  boss.hp = 0;
  boss.respawnAt = now + BOSS.respawnMs;
  balls.length = 0;
  fx.push({ k: 'victory', level: boss.level });
  systemChat(`擊敗 ${BOSS.name}！${BOSS.respawnMs / 1000} 秒後下一輪`);
  // 勝利後全員復活補滿
  // 經驗：在場每人都有，有打到 BOSS 的人再加一份
  for (const p of players.values()) {
    gainExp(p, BOSS_XP_ALL * boss.level + (p.dealt > 0 ? BOSS_XP_HIT * boss.level : 0));
    p.dealt = 0;
  }
  for (const p of players.values()) {
    if (p.dead) revive(p, 1, now);
    p.hp = p.maxHp; p.mp = p.maxMp;
  }
}

function setBossAnim(i) { boss.anim = i; boss.animAt = Date.now(); }

const enraged = () => boss.hp / boss.maxHp < BOSS.enrageAt;
const bossDmg = (d) => d * (enraged() ? BOSS.enrageDmg : 1);

// 選目標：有人嘲諷就打嘲諷的人，否則隨機
function pickTargets(n, now) {
  const alive = alivePlayers();
  const taunters = alive.filter((p) => now < p.tauntUntil);
  const pool = alive.filter((p) => now >= p.tauntUntil).sort(() => Math.random() - 0.5);
  return [...taunters, ...pool].slice(0, n);
}

function bossAct(now) {
  const alive = alivePlayers();
  if (!alive.length) { boss.nextActionAt = now + 1000; return; }
  const near = alive.filter((p) => dist(p, boss) < BOSS.bear.radius + 60).length;
  // 身邊人多時偏好震波，否則踢球或閃身
  const r = Math.random();
  const act = near >= Math.max(2, alive.length * 0.3) && r < 0.6 ? 'bear' : r < 0.5 ? 'kick' : r < 0.8 ? 'flash' : 'bear';
  const gap = BOSS.gapMs * (enraged() ? 0.7 : 1);

  if (act === 'bear') {
    const c = BOSS.bear;
    setBossAnim(2);
    fx.push({ k: 'cast', name: '狗熊哆嗦毛' });
    fx.push({ k: 'tele', shape: 'circle', x: Math.round(boss.x), y: Math.round(boss.y), r: c.radius, dur: c.tele });
    later(c.tele, () => {
      if (!boss.alive) return;
      fx.push({ k: 'wave', x: Math.round(boss.x), y: Math.round(boss.y), r: c.radius });
      const t = Date.now();
      for (const p of players.values()) if (dist(p, boss) <= c.radius + RADIUS) hurt(p, bossDmg(c.dmg), t);
    });
    boss.busyUntil = now + c.tele + 500;
  } else if (act === 'kick') {
    const c = BOSS.kick;
    setBossAnim(3);
    fx.push({ k: 'cast', name: '浪子踢球' });
    const targets = pickTargets(Math.min(6, 1 + Math.floor(alive.length / 6)), now);
    for (const t of targets) {
      const dx = t.x - boss.x, dy = t.y - boss.y, l = Math.hypot(dx, dy) || 1;
      const vx = dx / l * c.speed, vy = dy / l * c.speed;
      const len = c.speed * c.life / 1000;
      fx.push({ k: 'tele', shape: 'line', x: Math.round(boss.x), y: Math.round(boss.y), x2: Math.round(boss.x + dx / l * len), y2: Math.round(boss.y + dy / l * len), w: c.width, dur: c.tele });
      later(c.tele, () => {
        if (!boss.alive) return;
        const b = { id: nextBallId++, x: boss.x, y: boss.y, vx, vy, until: Date.now() + c.life, hit: new Set() };
        balls.push(b);
        fx.push({ k: 'ball', id: b.id, x: Math.round(b.x), y: Math.round(b.y), vx: Math.round(vx), vy: Math.round(vy), life: c.life });
      });
    }
    boss.busyUntil = now + c.tele + 600;
  } else {
    const c = BOSS.flash;
    setBossAnim(1);
    fx.push({ k: 'cast', name: '閃身步' });
    // 離中央太遠時閃回中央，否則閃到某個玩家身上
    let dest;
    if (dist(boss, CENTER) > 350 && Math.random() < 0.6) dest = { ...CENTER };
    else {
      const t = pickTargets(1, now)[0];
      const dx = t.x - CENTER.x, dy = t.y - CENTER.y, l = Math.hypot(dx, dy) || 1;
      const k = Math.min(1, c.reach / l);
      dest = { x: CENTER.x + dx * k, y: CENTER.y + dy * k };
    }
    dest.x = clamp(dest.x, BOSS.r, MAP_W - BOSS.r); dest.y = clamp(dest.y, BOSS.r, MAP_H - BOSS.r);
    fx.push({ k: 'tele', shape: 'circle', x: Math.round(dest.x), y: Math.round(dest.y), r: c.radius, dur: c.tele, flash: 1 });
    later(c.tele, () => {
      if (!boss.alive) return;
      fx.push({ k: 'afterimage', x: Math.round(boss.x), y: Math.round(boss.y) });
      boss.x = dest.x; boss.y = dest.y;
      fx.push({ k: 'wave', x: Math.round(boss.x), y: Math.round(boss.y), r: c.radius });
      const t = Date.now();
      for (const p of players.values()) if (dist(p, boss) <= c.radius + RADIUS) hurt(p, bossDmg(c.dmg), t);
    });
    boss.busyUntil = now + c.tele + 400;
  }
  boss.nextActionAt = boss.busyUntil + gap;
}

function tickBoss(now) {
  if (!boss.alive) {
    if (boss.level > 0 && now >= boss.respawnAt && players.size) spawnBoss();
    return;
  }
  if (now >= boss.busyUntil && boss.anim !== 0) setBossAnim(0);
  if (now >= boss.nextActionAt) bossAct(now);
}

function tickBalls(now, dt) {
  const c = BOSS.kick;
  for (let i = balls.length - 1; i >= 0; i--) {
    const b = balls[i];
    b.x += b.vx * dt; b.y += b.vy * dt;
    if (now >= b.until || b.x < 0 || b.y < 0 || b.x > MAP_W || b.y > MAP_H) { balls.splice(i, 1); continue; }
    for (const p of players.values()) {
      if (b.hit.has(p.id) || p.dead) continue;
      if (Math.hypot(p.x - b.x, p.y - b.y) <= c.r + RADIUS) { b.hit.add(p.id); hurt(p, bossDmg(c.dmg), now); }
    }
  }
}

function tickOrbs(now) {
  if (orbs.size < ORB_MAX && now - lastOrbAt > ORB_EVERY_MS) {
    lastOrbAt = now;
    const pt = randomSpawn();
    const o = { id: nextOrbId++, x: Math.round(pt.x), y: Math.round(pt.y) };
    orbs.set(o.id, o);
    fx.push({ k: 'orb+', id: o.id, x: o.x, y: o.y });
  }
  for (const o of orbs.values()) {
    for (const p of players.values()) {
      if (p.dead || Math.hypot(p.x - o.x, p.y - o.y) > RADIUS + 18) continue;
      orbs.delete(o.id);
      fx.push({ k: 'orb-', id: o.id });
      healP(p, ORB_HEAL, now);
      p.mp = Math.min(p.maxMp, p.mp + ORB_MP);
      break;
    }
  }
}

function tickXpOrbs(now) {
  if (xpOrbs.size < XP_ORB_MAX && now - lastXpOrbAt > XP_ORB_EVERY_MS) {
    lastXpOrbAt = now;
    const o = { id: nextOrbId++, x: Math.round(60 + Math.random() * (MAP_W - 120)), y: Math.round(60 + Math.random() * (MAP_H - 120)) };
    xpOrbs.set(o.id, o);
    fx.push({ k: 'xp+', id: o.id, x: o.x, y: o.y });
  }
  for (const o of xpOrbs.values()) {
    for (const p of players.values()) {
      if (p.dead || Math.hypot(p.x - o.x, p.y - o.y) > RADIUS + 14) continue;
      xpOrbs.delete(o.id);
      fx.push({ k: 'xp-', id: o.id, by: p.id });
      gainExp(p, XP_ORB_VALUE);
      break;
    }
  }
}

function tickTop3(now) {
  if (now - lastTopAt < TOP_EVERY_MS) return;
  lastTopAt = now;
  const next = [...players.values()]
    .map((p) => ({ p, v: (stats.get(nameKey(p.name))?.dmg ?? 0) + (stats.get(nameKey(p.name))?.heal ?? 0) }))
    .filter((x) => x.v > 0)
    .sort((a, b) => b.v - a.v)
    .slice(0, 3)
    .map((x) => x.p.id);
  if (next.join() === top3.join()) return;
  if (next[0] && next[0] !== top3[0]) systemChat(`${players.get(next[0]).name} 登上全服第 1 名！`);
  top3 = next;
  fx.push({ k: 'top', ids: top3 });
}

function sendRank(p) {
  const now = Date.now();
  if (now - (p.lastRank || 0) < 1000) return;
  p.lastRank = now;
  statOf(p);
  const online = new Set([...players.values()].map((q) => nameKey(q.name)));
  const all = [...stats.entries()].map(([key, st]) => ({ ...st, total: st.dmg + st.heal, on: online.has(key) }));
  const top = (k) => {
    const sorted = all.filter((st) => st[k] > 0).sort((a, b) => b[k] - a[k]);
    const mine = sorted.findIndex((st) => nameKey(st.name) === nameKey(p.name));
    return {
      list: sorted.slice(0, RANK_TOP).map((st) => ({ name: st.name, cls: st.cls, lv: st.lv, v: Math.round(st[k]), on: st.on })),
      me: mine < 0 ? null : { rank: mine + 1, v: Math.round(sorted[mine][k]) },
      total: sorted.length,
    };
  };
  send(p.ws, { t: 'rank', total: top('total'), dmg: top('dmg'), heal: top('heal') });
}

// ---------- 連線 ----------
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4096 });
wss.on('connection', (ws) => {
  ws.alive = true;
  ws.openedAt = Date.now();
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString('utf8')); } catch { return; }
    const p = ws.player;
    if (msg.t === 'join' && !p) return join(ws, msg);
    if (!p) return;
    if (msg.t === 'input') input(p, msg);
    else if (msg.t === 'skill') useSkill(p, msg);
    else if (msg.t === 'chat') chat(p, msg);
    else if (msg.t === 'rank') sendRank(p);
  });
  ws.on('close', (code) => {
    // 斷線紀錄：用來分辨是心跳逾時（手機在背景）、手機主動關閉、還是網路中斷
    if (ws.player) console.log(`close ${ws.player.name} code=${code}${ws.kickReason ? ` reason=${ws.kickReason}` : ''} after=${Math.round((Date.now() - ws.openedAt) / 1000)}s`);
    if (ws.player) removePlayer(ws.player);
  });
  ws.on('error', (e) => console.log(`ws error ${ws.player?.name ?? '-'}: ${e.message}`));
});

setInterval(() => {
  const now = Date.now();
  for (const [key, off] of offline) if (now >= off.until) offline.delete(key);
}, 60000);

// 心跳：30 秒沒回應就斷線（也讓 Cloudflare tunnel 不會因閒置斷開）
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.kickReason = 'heartbeat'; ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 15000);

// ---------- 主迴圈：物理、戰鬥、廣播 ----------
let last = performance.now();
setInterval(() => {
  const t = performance.now();
  const dt = Math.min(0.1, (t - last) / 1000);
  last = t;
  const now = Date.now();

  // 到期的延遲事件
  for (let i = timers.length - 1; i >= 0; i--) {
    if (now >= timers[i].at) { const { fn } = timers[i]; timers.splice(i, 1); fn(); }
  }

  const list = [...players.values()];
  for (const p of list) {
    const c = CLASSES[p.cls];
    if (p.dead && now >= p.deadUntil) revive(p, 0.5, now);
    if (!p.dead) p.mp = Math.min(p.maxMp, p.mp + c.mpRegen * dt);
    if (p.dash) {
      p.x += p.dash.vx * dt; p.y += p.dash.vy * dt;
      if (now >= p.dash.until) {
        if (p.dash.kind === 'charge' && boss.alive && dist(p, boss) - BOSS.r <= 60) {
          fx.push({ k: 'slash', id: p.id, x: Math.round(boss.x), y: Math.round(boss.y) });
          hitBoss(p.dash.dmg, p.id, now);
        }
        p.dash = null;
      }
    } else {
      const speed = c.speed * (p.dead ? 0.5 : 1) * (buffOf(p)?.speed ?? 1);  // 倒地時可以慢慢走去找補師
      p.x += p.ix * speed * dt;
      p.y += p.iy * speed * dt;
    }
  }
  // 球與球之間互相推開
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy), min = RADIUS * 2;
      if (d > 0 && d < min) {
        const push = (min - d) / 2;
        a.x -= dx / d * push; a.y -= dy / d * push;
        b.x += dx / d * push; b.y += dy / d * push;
      }
    }
  }
  for (const p of list) {
    // 不能穿過 BOSS 身體
    if (boss.alive && !p.dead) {
      const dx = p.x - boss.x, dy = p.y - boss.y, d = Math.hypot(dx, dy) || 1, min = BOSS.r + RADIUS;
      if (d < min) { p.x = boss.x + dx / d * min; p.y = boss.y + dy / d * min; }
    }
    p.x = clamp(p.x, RADIUS, MAP_W - RADIUS);
    p.y = clamp(p.y, RADIUS, MAP_H - RADIUS);
  }

  tickBoss(now);
  tickBalls(now, dt);
  tickOrbs(now);
  tickXpOrbs(now);
  tickTop3(now);

  // 精簡格式：[id, x, y, hp, mp, flags, ...]；flags：1 倒地、2 無敵、4 嘲諷中、8 減傷
  if (list.length) {
    const s = [];
    for (const p of list) {
      const flags = (p.dead ? 1 : 0) | (isInvuln(p, now) ? 2 : 0) | (now < p.tauntUntil ? 4 : 0) | (now < p.guardUntil ? 8 : 0);
      s.push(p.id, Math.round(p.x), Math.round(p.y), Math.ceil(p.hp), Math.floor(p.mp), flags);
    }
    const msg = { t: 's', s, b: bossInfo() };
    if (fx.length) msg.fx = fx;
    broadcast(msg);
  }
  fx = [];
}, 1000 / TICK_HZ);

// ---------- 存檔：伺服器重啟（部署）不會讓大家掉等級 ----------
// 每 15 秒、以及關機前，把排行榜、離線保留、在線玩家（當成離線保留）、BOSS 輪數寫到 data/state.json；
// 啟動時讀回來，手機自動重連時用原本的 token 接回角色
const STATE_FILE = path.resolve('data', 'state.json');
const snapOf = (p) => ({ cls: p.cls, lv: p.lv, exp: p.exp, hp: p.hp, mp: p.mp, dead: p.dead, deadUntil: p.deadUntil, cds: p.cds, x: p.x, y: p.y });

function saveState() {
  const off = Object.fromEntries(offline);
  const now = Date.now();
  for (const p of players.values()) {
    const key = nameKey(p.name), sess = sessions.get(key);
    if (sess) off[key] = { token: sess.token, snap: snapOf(p), until: now + OFFLINE_KEEP_MS };
  }
  const data = { savedAt: now, stats: Object.fromEntries(stats), offline: off, bossLevel: boss.level };
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(data));
    fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);   // 先寫暫存檔再改名，寫到一半當機也不會壞檔
  } catch (e) { console.error('save state:', e.message); }
}

function loadState() {
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(data.stats || {})) stats.set(k, v);
    for (const [k, v] of Object.entries(data.offline || {})) if (v.until > Date.now()) offline.set(k, v);
    // BOSS 從同一輪重新開始（滿血），等第一個人進場
    if (data.bossLevel > 0) { boss.level = data.bossLevel - 1; boss.respawnAt = 0; }
    console.log(`state loaded: ${stats.size} stats, ${offline.size} offline, boss level ${data.bossLevel}`);
  } catch (e) { if (e.code !== 'ENOENT') console.error('load state:', e.message); }
}

loadState();
setInterval(saveState, 15000);
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { saveState(); process.exit(0); });

server.listen(PORT, () => console.log(`fygame listening on :${PORT}`));

// 壓力測試：N 個機器人連線、隨機移動、用中文聊天，量聊天來回延遲與收到的狀態更新頻率
// 用法（在 fygame 容器內跑，借用它的 ws 套件）：node loadtest.mjs wss://fygame.qianpro.shop/ws 40 30
import WebSocket from 'ws';
const [url, n = 40, secs = 30] = process.argv.slice(2);
const N = +n, DURATION = +secs * 1000;
const PHRASES = ['大家好', '這裡好熱鬧', '誰要一起走', '繁體中文測試：龘靐齉', '往右邊集合', '我在地圖中間'];
let joined = 0, errors = [], snapshots = 0, chatsRecv = 0;
const rtts = [];
const bots = [];
for (let i = 0; i < N; i++) {
  const ws = new WebSocket(url);
  const name = `測試機器人${String(i + 1).padStart(2, '0')}`;
  const bot = { ws, name, id: null };
  bots.push(bot);
  ws.on('open', () => ws.send(JSON.stringify({ t: 'join', name })));
  ws.on('error', (e) => errors.push(e.message));
  ws.on('message', (raw) => {
    const m = JSON.parse(raw.toString('utf8'));
    if (m.t === 'welcome') { bot.id = m.id; joined++; }
    else if (m.t === 's') snapshots++;
    else if (m.t === 'chat') {
      chatsRecv++;
      if (m.id === bot.id && m.text.includes('#')) rtts.push(Date.now() - +m.text.split('#')[1]);
      if (m.id === bot.id && !m.text.startsWith(PHRASES.find((p) => m.text.startsWith(p)) ?? '\0')) errors.push('文字不符: ' + m.text);
    }
    else if (m.t === 'error') errors.push(m.msg);
  });
  setInterval(() => {
    if (ws.readyState !== 1) return;
    const a = Math.random() * Math.PI * 2;
    ws.send(JSON.stringify({ t: 'input', x: +Math.cos(a).toFixed(2), y: +Math.sin(a).toFixed(2) }));
  }, 800 + Math.random() * 400);
  setInterval(() => {
    if (ws.readyState === 1) ws.send(JSON.stringify({ t: 'chat', text: PHRASES[i % PHRASES.length] + '#' + Date.now() }));
  }, 4000 + Math.random() * 4000);
}
setTimeout(() => {
  rtts.sort((a, b) => a - b);
  const q = (p) => rtts[Math.floor(rtts.length * p)] ?? '-';
  console.log(JSON.stringify({
    bots: N, joined, seconds: DURATION / 1000,
    snapshotsPerBotPerSec: +(snapshots / N / (DURATION / 1000)).toFixed(1),
    chatsReceived: chatsRecv, chatRttMs: { n: rtts.length, p50: q(0.5), p95: q(0.95), max: rtts.at(-1) },
    errors: [...new Set(errors)].slice(0, 5),
  }, null, 1));
  process.exit(0);
}, DURATION);

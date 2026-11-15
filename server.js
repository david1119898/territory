// server.js — игровой сервер без зависимостей (только встроенный Node).
// Связь: сервер -> клиент через SSE (EventSource), клиент -> сервер через POST.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildMap } = require('./map.js');

const MAP = buildMap();
const TERR = MAP.territories;
const N = TERR.length;
const PORT = process.env.PORT || 3000;

// ---------- Баланс игры (можно крутить) ----------
const COLORS = ['#d9453d', '#2f7fd1', '#2e9e5b', '#e0a21b'];
const PROD_BASE = 1;                   // бойцов в секунду с башни без улучшений (+1 за каждый уровень)
const TROOP_CAP = 50;                  // больше столько бойцов в одной башне не вырастет
const UPGRADE_COST = [30, 60, 120, 240, 480]; // золото за улучшение до уровня 1, 2, 3, 4, 5
const MAX_LEVEL = 5;
const GOLD_PER_TOWER = 2;              // золота в секунду с каждой башни
const TRAVEL_SPEED = 35;               // скорость войск, пикселей карты в секунду
const START_MONEY = 0;
const START_TROOPS = 10;
const TICK_MS = 250;
const MAX_PLAYERS = 4;
const SPEEDS = [1, 1.5, 2];

const rooms = new Map();

function makeCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (;;) {
    let c = '';
    for (let i = 0; i < 4; i++) c += letters[Math.floor(Math.random() * letters.length)];
    if (!rooms.has(c)) return c;
  }
}
const makeId = () => Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
const cleanName = (s) => String(s || '').replace(/[<>]/g, '').trim().slice(0, 14) || 'Игрок';

function newRoom(hostName) {
  const room = {
    code: makeCode(), hostId: null, players: [], phase: 'lobby', speed: 1,
    terr: [], moves: [], moveSeq: 0, events: [], evSeq: 0, winner: null,
    clients: new Map(), t: Date.now(), lastActive: Date.now(),
  };
  rooms.set(room.code, room);
  return room;
}

function addPlayer(room, name) {
  const idx = room.players.length;
  const p = { id: makeId(), name: cleanName(name), color: COLORS[idx], money: 0, alive: true, connected: false };
  room.players.push(p);
  if (!room.hostId) room.hostId = p.id;
  return p;
}

function pushEvent(room, text, owner) {
  room.events.push({ id: ++room.evSeq, text, c: owner });
  if (room.events.length > 30) room.events.shift();
}

function dist(a, b) { return Math.hypot(TERR[a].x - TERR[b].x, TERR[a].y - TERR[b].y); }

function startGame(room) {
  room.phase = 'playing';
  room.moves = [];
  room.winner = null;
  room.events = [];
  room.terr = TERR.map(() => ({ owner: -1, troops: 4 + Math.floor(Math.random() * 7), level: 0, acc: 0 }));
  // столицы: стараемся поставить подальше друг от друга
  const chosen = [Math.floor(Math.random() * N)];
  while (chosen.length < room.players.length) {
    let best = -1, bestD = -1;
    for (let i = 0; i < N; i++) {
      if (chosen.includes(i)) continue;
      const d = Math.min(...chosen.map((c) => dist(i, c)));
      if (d > bestD + Math.random() * 40) { bestD = d; best = i; }
    }
    chosen.push(best);
  }
  room.players.forEach((p, i) => {
    p.money = START_MONEY; p.alive = true;
    room.terr[chosen[i]] = { owner: i, troops: START_TROOPS, level: 0, acc: 0 };
  });
  room.t = Date.now();
  pushEvent(room, 'Игра началась! Захвати весь мир.', -1);
}

function incomeOf(room, idx) {
  let s = 0;
  for (const t of room.terr) if (t.owner === idx) s += GOLD_PER_TOWER;
  return s * room.speed;
}

function resolveArrival(room, m) {
  const t = room.terr[m.to];
  const me = room.players[m.owner];
  if (t.owner === m.owner) { t.troops += m.n; return; }  // свои: подкрепление
  const victim = t.owner >= 0 ? room.players[t.owner] : null;
  if (m.n > t.troops) {
    t.owner = m.owner;
    t.troops = m.n - t.troops;
    t.level = 0; t.acc = 0;
    pushEvent(room, me.name + ' захватил «' + TERR[m.to].name + '»' + (victim ? ' у ' + victim.name : ''), m.owner);
  } else {
    t.troops -= m.n;
  }
}

function tick(room, now) {
  const dt = Math.min(1, (now - room.t) / 1000);
  room.t = now;
  room.players.forEach((p, i) => { if (p.alive) p.money += incomeOf(room, i) * dt; });
  // башни сами растят бойцов: +1 в секунду и ещё +1 за каждый уровень
  for (const t of room.terr) {
    if (t.owner < 0 || t.troops >= TROOP_CAP) continue;
    t.acc += (PROD_BASE + t.level) * room.speed * dt;
    const whole = Math.floor(t.acc);
    if (whole > 0) { t.acc -= whole; t.troops = Math.min(TROOP_CAP, t.troops + whole); }
  }

  const arrived = room.moves.filter((m) => m.t1 <= now).sort((a, b) => a.t1 - b.t1);
  if (arrived.length) {
    room.moves = room.moves.filter((m) => m.t1 > now);
    arrived.forEach((m) => resolveArrival(room, m));
  }

  // выбывшие игроки
  room.players.forEach((p, i) => {
    if (!p.alive) return;
    const has = room.terr.some((t) => t.owner === i) || room.moves.some((m) => m.owner === i);
    if (!has) { p.alive = false; pushEvent(room, p.name + ' выбыл из игры', i); }
  });

  // победа: все территории у одного, либо остался один живой
  const alive = room.players.map((p, i) => (p.alive ? i : -1)).filter((i) => i >= 0);
  const owner0 = room.terr[0].owner;
  const allOne = owner0 >= 0 && room.terr.every((t) => t.owner === owner0);
  if (allOne || alive.length <= 1) {
    room.phase = 'ended';
    room.winner = allOne ? owner0 : (alive[0] !== undefined ? alive[0] : null);
    room.moves = [];
    if (room.winner !== null) pushEvent(room, room.players[room.winner].name + ' захватил весь мир!', room.winner);
  }
}

function snapshot(room, youId) {
  const you = room.players.findIndex((p) => p.id === youId);
  const stats = room.players.map(() => ({ terr: 0, troops: 0 }));
  room.terr.forEach((t) => { if (t.owner >= 0) { stats[t.owner].terr++; stats[t.owner].troops += t.troops; } });
  return JSON.stringify({
    code: room.code, phase: room.phase, speed: room.speed, now: Date.now(), you,
    host: room.players.findIndex((p) => p.id === room.hostId),
    players: room.players.map((p, i) => ({
      name: p.name, color: p.color, connected: p.connected, alive: p.alive,
      terr: stats[i].terr, troops: stats[i].troops,
      money: i === you ? Math.floor(p.money) : undefined,
      income: i === you && room.phase === 'playing' ? incomeOf(room, i) : undefined,
    })),
    terr: room.terr.map((t) => [t.owner, t.troops, t.level]),
    moves: room.moves.map((m) => [m.id, m.owner, m.from, m.to, m.n, m.t0, m.t1]),
    winner: room.winner,
  });
}

function broadcast(room) {
  for (const [pid, set] of room.clients) {
    if (!set.size) continue;
    const data = 'data: ' + snapshot(room, pid) + '\n\n';
    for (const res of set) res.write(data);
  }
}

// ---------- Действия игроков ----------
function act(room, idx, b) {
  const p = room.players[idx];
  const isHost = room.hostId === p.id;
  switch (b.type) {
    case 'speed':
      if (!isHost || room.phase !== 'lobby') return 'Только хост в лобби';
      if (!SPEEDS.includes(b.speed)) return 'Нет такой скорости';
      room.speed = b.speed; return null;
    case 'start':
      if (!isHost) return 'Начать может только хост';
      if (room.phase !== 'lobby') return 'Игра уже идёт';
      if (room.players.length < 2) return 'Нужно минимум 2 игрока';
      startGame(room); return null;
    case 'restart':
      if (!isHost || room.phase !== 'ended') return 'Нельзя';
      room.phase = 'lobby'; room.terr = []; room.moves = []; room.winner = null; room.events = [];
      room.players.forEach((q) => { q.alive = true; q.money = 0; });
      return null;
  }
  if (room.phase !== 'playing') return 'Игра не идёт';
  const id = Number(b.terr), from = Number(b.from), to = Number(b.to);
  switch (b.type) {
    case 'upgrade': {
      const t = room.terr[id];
      if (!t || t.owner !== idx) return 'Это не твоя территория';
      if (t.level >= MAX_LEVEL) return 'Башня уже максимальная';
      const cost = UPGRADE_COST[t.level];
      if (p.money < cost) return 'Не хватает золота';
      p.money -= cost; t.level++; return null;
    }
    case 'send': {
      const a = room.terr[from];
      if (!a || a.owner !== idx) return 'Это не твоя территория';
      if (!TERR[from] || !TERR[from].adj.includes(to)) return 'Можно атаковать только соседей';
      const n = a.troops - 1;  // уходят все, кроме одного, чтобы башня не опустела
      if (n < 1) return 'Мало бойцов';
      a.troops -= n;
      const now = Date.now();
      const travel = (dist(from, to) / (TRAVEL_SPEED * room.speed)) * 1000;
      room.moves.push({ id: ++room.moveSeq, owner: idx, from, to, n, t0: now, t1: now + travel });
      return null;
    }
  }
  return 'Неизвестное действие';
}

// ---------- HTTP ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/map.js': ['map.js', 'application/javascript; charset=utf-8'],
};

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; if (s.length > 10000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(path.join(__dirname, file)));
    }

    if (req.method === 'GET' && url.pathname === '/api/events') {
      const room = rooms.get((url.searchParams.get('code') || '').toUpperCase());
      const pid = url.searchParams.get('pid');
      const idx = room ? room.players.findIndex((p) => p.id === pid) : -1;
      if (idx < 0) return json(res, 404, { error: 'Комната не найдена' });
      res.writeHead(200, {
        'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
      });
      res.write('retry: 1500\n\n');
      if (!room.clients.has(pid)) room.clients.set(pid, new Set());
      room.clients.get(pid).add(res);
      room.players[idx].connected = true;
      room.lastActive = Date.now();
      broadcast(room);
      const hb = setInterval(() => res.write(': hb\n\n'), 15000);
      req.on('close', () => {
        clearInterval(hb);
        const set = room.clients.get(pid);
        if (set) { set.delete(res); if (!set.size) { const pl = room.players.find((p) => p.id === pid); if (pl) pl.connected = false; } }
        broadcast(room);
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/api/create') {
      const b = await readBody(req);
      const room = newRoom();
      const p = addPlayer(room, b.name);
      return json(res, 200, { code: room.code, pid: p.id });
    }

    if (req.method === 'POST' && url.pathname === '/api/join') {
      const b = await readBody(req);
      const room = rooms.get(String(b.code || '').toUpperCase());
      if (!room) return json(res, 404, { error: 'Комната с таким кодом не найдена' });
      if (room.phase !== 'lobby') return json(res, 400, { error: 'Игра уже началась' });
      if (room.players.length >= MAX_PLAYERS) return json(res, 400, { error: 'В комнате уже 4 игрока' });
      const p = addPlayer(room, b.name);
      room.lastActive = Date.now();
      broadcast(room);
      return json(res, 200, { code: room.code, pid: p.id });
    }

    if (req.method === 'POST' && url.pathname === '/api/action') {
      const b = await readBody(req);
      const room = rooms.get(String(b.code || '').toUpperCase());
      const idx = room ? room.players.findIndex((p) => p.id === b.pid) : -1;
      if (idx < 0) return json(res, 404, { error: 'Комната не найдена' });
      room.lastActive = Date.now();
      const err = act(room, idx, b);
      if (err) return json(res, 400, { error: err });
      broadcast(room);
      return json(res, 200, { ok: true });
    }

    json(res, 404, { error: 'Не найдено' });
  } catch (e) {
    console.error(e);
    if (!res.headersSent) json(res, 500, { error: 'Ошибка сервера' });
  }
});

setInterval(() => {
  const now = Date.now();
  for (const room of rooms.values()) {
    if (room.phase === 'playing') { tick(room, now); broadcast(room); }
  }
}, TICK_MS);

setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const online = [...room.clients.values()].some((s) => s.size);
    if (!online && now - room.lastActive > 30 * 60 * 1000) rooms.delete(code);
  }
}, 60 * 1000);

if (require.main === module) {
  server.listen(PORT, '0.0.0.0', () => console.log('Игра запущена: http://localhost:' + PORT));
}
module.exports = { server, rooms };

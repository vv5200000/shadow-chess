'use strict';
/* ═══════════════════════════════════════════════════════════════════════
 * 暗影象棋 · 联机服务器 (P0)
 * 零依赖：Node 原生 http —— SSE 推送 + POST 上行，EventSource 自动重连。
 * 服务端权威：真实棋盘只存在于服务器，客户端仅收到「视角裁剪快照」，
 *             未揭示的棋子一律渲染为 ?，DevTools 无法作弊。
 * 运行: node server/server.js          (PORT 默认 8787)
 *       SC_TIME=秒 可调超时(测试用)  SC_PORT 可调端口
 * ═══════════════════════════════════════════════════════════════════════ */
const http = require('http');
const fs   = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ChessGame } = require('../js/chess.js');

const PORT    = parseInt(process.env.SC_PORT || '8787', 10);
const GAME_MS = (parseInt(process.env.SC_TIME || '600', 10)) * 1000; // 每方总时限(毫秒)
const ROOT    = path.join(__dirname, '..');
const ROOM_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // 去易混字符 I/O/0/1
const ROOM_LEN = 5;

// ── 房间 ────────────────────────────────────────────────────────────────
const rooms = new Map(); // code -> Room

class Room {
  constructor(code) {
    this.code = code;
    this.game = new ChessGame();
    this.game.newGame();
    this.seats = {};                 // 'white'|'black' -> {token, online, res}
    this.timers = { white: GAME_MS, black: GAME_MS };
    this.winner = null;                // 胜负显式结果（超时等引擎外途径产生）
    this.createdAt = Date.now();
  }
  player(color) { return this.seats[color]; }
  opp(color)    { return this.seats[color === 'white' ? 'black' : 'white']; }
  bothOnline()  { return this.seats.white?.online && this.seats.black?.online; }
}

function newRoomCode() {
  for (let i = 0; i < 50; i++) {
    let code = '';
    for (let j = 0; j < ROOM_LEN; j++)
      code += ROOM_ALPHABET[Math.floor(Math.random() * ROOM_ALPHABET.length)];
    if (!rooms.has(code)) return code;
  }
  return null; // 几乎不可能
}

const tokenOf = () => crypto.randomBytes(16).toString('hex');

// ── 视角裁剪快照（安全核心）─────────────────────────────────────────────
// board 每格: null | {own, color, revealed, type?, pos?}
//   own=true 且未揭示 → 给 pos(位置规则类型,UI 提示用), 不给 type
//   own=false 且未揭示 → 只有 color，连 pos 都不给（最小信息泄露）
function snapshotFor(room, color) {
  const g = room.game;
  const opp = color === 'white' ? 'black' : 'white';
  const board = g.board.map((row, r) => row.map((cell, c) => {
    if (!cell) return null;
    const own = cell.color === color;
    const s = { own, color: cell.color, revealed: cell.revealed };
    if (cell.revealed) s.type = cell.type;
    else if (own)      s.pos  = g.getPosRule(r, c);
    return s;
  }));

  const whitePlies = g.moveHistory.filter(rec => rec.color === 'white').length;
  return {
    type: 'snapshot',
    room: room.code,
    you: color,
    turn: g.currentTurn,
    state: g.gameState,                    // playing|check|checkmate|stalemate|won|draw
    winner: room.winner
         || (g.gameState === 'won' ? (g.lastMove?.color || null)
         : (g.gameState === 'checkmate' ? (g.currentTurn === 'white' ? 'black' : 'white') : null)),
    board,
    timers: { white: Math.round(room.timers.white / 1000), black: Math.round(room.timers.black / 1000) },
    lastMove: g.lastMove ? { from: [g.lastMove.from.row, g.lastMove.from.col],
                             to:   [g.lastMove.to.row,   g.lastMove.to.col] } : null,
    moveNum: whitePlies + 1,
    history: g.moveHistory.map(rec => g.getMoveNotation(rec)),
    oppOnline: !!room.opp(color)?.online,
    check: g.gameState === 'check' || g.gameState === 'checkmate',
  };
}

// ── SSE 广播 ────────────────────────────────────────────────────────────
function sseSend(res, obj) {
  if (res.writableEnded) return false;
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
  return true;
}

function broadcast(room, obj) {
  for (const color of ['white', 'black']) {
    const p = room.player(color);
    if (p?.online && p.res) sseSend(p.res, obj);
  }
}

function pushSnapshots(room) {
  for (const color of ['white', 'black']) {
    const p = room.player(color);
    if (p?.online && p.res) sseSend(p.res, snapshotFor(room, color));
  }
}

function notifyOppPresence(room) {
  for (const color of ['white', 'black']) {
    const p = room.player(color);
    const oppP = room.opp(color);
    if (p?.online && p.res) sseSend(p.res, { type: 'opp', online: !!oppP?.online });
  }
}

// ── HTTP 工具 ───────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',   '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
};

function serveStatic(req, res, urlPath) {
  let p = path.normalize(path.join(ROOT, urlPath));
  if (!p.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
  fs.readFile(p, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(p)] || 'application/octet-stream' });
    res.end(data);
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let buf = '';
    req.on('data', d => { buf += d; if (buf.length > 64 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(buf || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// 通用入口校验：取房间 + 按 token 定位座位
function locate(req, res, body) {
  const room = rooms.get(String(body.room || '').toUpperCase());
  if (!room) { sendJSON(res, 404, { error: 'ROOM_NOT_FOUND' }); return null; }
  let color = null;
  for (const c of ['white', 'black']) {
    if (room.player(c)?.token === body.token) { color = c; break; }
  }
  if (!color) { sendJSON(res, 403, { error: 'AUTH_FAILED' }); return null; }
  return { room, color };
}

// ── 计时循环：每秒扣减 + 超时判负 + tick 广播 ──────────────────────────
setInterval(() => {
  for (const room of rooms.values()) {
    const g = room.game;
    if (g.gameState !== 'playing' && g.gameState !== 'check') continue;
    const c = g.currentTurn;
    room.timers[c] -= 1000;
    if (room.timers[c] <= 0) {
      room.timers[c] = 0;
      // 超时判负：揭示全部棋子（对局结束，胜负公开），胜者为对方
      room.winner = c === 'white' ? 'black' : 'white';
      for (let r = 0; r < 8; r++)
        for (let cc = 0; cc < 8; cc++) {
          const piece = g.board[r][cc];
          if (piece) piece.revealed = true;
        }
      g.gameState = 'won';
      pushSnapshots(room);
      continue;
    }
    broadcast(room, {
      type: 'tick',
      timers: { white: Math.round(room.timers.white / 1000), black: Math.round(room.timers.black / 1000) },
    });
  }
}, 1000);

// ── HTTP 服务器 ─────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;

  // ── SSE 事件流（EventSource 自动重连）──────────────────────────────
  if (p === '/api/events') {
    const room = rooms.get(String(url.searchParams.get('room') || '').toUpperCase());
    const token = url.searchParams.get('token') || '';
    if (!room) { res.writeHead(404); return res.end('room not found'); }
    let color = null;
    for (const c of ['white', 'black']) {
      if (room.player(c)?.token === token) { color = c; break; }
    }
    if (!color) { res.writeHead(403); return res.end('auth failed'); }

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(`retry: 1500\n\n`);            // 断线 1.5s 后自动重连

    const seat = room.player(color);
    if (seat.res && !seat.res.writableEnded) seat.res.end();   // 同 token 旧连接下线
    seat.res = res;
    seat.online = true;

    res.on('close', () => {                   // 断线（含锁屏）→ 仅标记离线
      if (seat.res === res) { seat.res = null; seat.online = false; notifyOppPresence(room); }
    });

    // 重连立即推完整快照 + 心跳
    sseSend(res, snapshotFor(room, color));
    notifyOppPresence(room);
    const hb = setInterval(() => {           // SSE 保活注释行
      if (res.writableEnded) { clearInterval(hb); return; }
      res.write(': ping\n\n');
    }, 20000);
    res.on('close', () => clearInterval(hb));
    return;
  }

  // ── JSON API ────────────────────────────────────────────────────────
  if (p === '/api' && req.method === 'POST') {
    const body = await readBody(req);
    const a = body.a;

    // 创建房间（建房者执白）
    if (a === 'create') {
      const code = newRoomCode();
      if (!code) return sendJSON(res, 500, { error: 'ROOM_CREATE_FAILED' });
      const room = new Room(code);
      room.seats.white = { token: tokenOf(), online: false, res: null };
      rooms.set(code, room);
      return sendJSON(res, 200, { ok: true, room: code, token: room.seats.white.token, color: 'white' });
    }

    // 加入房间（加入者执黑；满员/开局后拒绝）
    if (a === 'join') {
      const room = rooms.get(String(body.room || '').toUpperCase());
      if (!room) return sendJSON(res, 404, { error: 'ROOM_NOT_FOUND' });
      if (room.seats.black) return sendJSON(res, 409, { error: 'ROOM_FULL' });
      if (['won', 'checkmate', 'stalemate', 'draw'].includes(room.game.gameState))
        return sendJSON(res, 409, { error: 'GAME_OVER' });
      room.seats.black = { token: tokenOf(), online: false, res: null };
      pushSnapshots(room);            // 通知白方：对手已就座，开局
      notifyOppPresence(room);
      return sendJSON(res, 200, { ok: true, room: room.code, token: room.seats.black.token, color: 'black' });
    }

    // 以下均需已入座的房间 + token
    const loc = locate(req, res, body);
    if (!loc) return;
    const { room, color } = loc;

    // 走子（服务端权威校验）
    if (a === 'move' || a === 'moves') {
      const g = room.game;
      if (g.pendingPromotion) return sendJSON(res, 409, { error: 'ONLY_PROMOTE' });
      if (!Array.isArray(body.from) || body.from.length !== 2)
        return sendJSON(res, 400, { error: 'BAD_MOVE' });
      const [fr, fc] = body.from;

      if (a === 'moves') {
        if (g.gameState !== 'playing' && g.gameState !== 'check')
          return sendJSON(res, 409, { error: 'GAME_OVER' });
        const piece = g.board[fr]?.[fc];
        if (!piece || piece.color !== color)
          return sendJSON(res, 403, { error: 'NOT_YOUR_PIECE' });
        const moves = g.getLegalMoves(fr, fc).map(m => [m.row, m.col]);
        return sendJSON(res, 200, { ok: true, moves });
      }

      // move: [fr,fc] → [tr,tc]
      if (g.gameState !== 'playing' && g.gameState !== 'check')
        return sendJSON(res, 409, { error: 'GAME_OVER' });
      if (g.currentTurn !== color) return sendJSON(res, 403, { error: 'NOT_YOUR_TURN' });
      const piece = g.board[fr]?.[fc];
      if (!piece || piece.color !== color)
        return sendJSON(res, 403, { error: 'NOT_YOUR_PIECE' });
      if (!Array.isArray(body.to) || body.to.length !== 2)
        return sendJSON(res, 400, { error: 'BAD_MOVE' });
      const [tr, tc] = body.to;
      const rec = g.makeMove(fr, fc, tr, tc);
      if (!rec) return sendJSON(res, 403, { error: 'ILLEGAL_MOVE' });

      if (rec.needsPromotion) {
        // 等升变选择；此时该玩家时间仍计（升变属走子的一部分）
        return sendJSON(res, 200, { ok: true, needsPromotion: true });
      }
      pushSnapshots(room);
      return sendJSON(res, 200, { ok: true });
    }

    // 升变选择
    if (a === 'promote') {
      const g = room.game;
      if (!g.pendingPromotion) return sendJSON(res, 409, { error: 'NO_PROMOTION' });
      if (g.currentTurn !== color) return sendJSON(res, 403, { error: 'NOT_YOUR_TURN' });
      const type = String(body.type || '');
      if (!['Q', 'R', 'B', 'N'].includes(type)) return sendJSON(res, 400, { error: 'BAD_PROMO' });
      g.completePromotion(type);
      pushSnapshots(room);
      return sendJSON(res, 200, { ok: true });
    }

    // 离开（退出按钮/页面关闭）；P0: 座位保留,对手可继续等其重连
    if (a === 'leave') {
      const seat = room.player(color);
      if (seat?.res && !seat.res.writableEnded) seat.res.end();
      seat.res = null; seat.online = false;
      notifyOppPresence(room);
      return sendJSON(res, 200, { ok: true });
    }

    return sendJSON(res, 400, { error: 'UNKNOWN_ACTION' });
  }

  // 静态资源
  if (req.method === 'GET') return serveStatic(req, res, p === '/' ? '/index.html' : p);
  res.writeHead(405); res.end();
});

// 空闲房间回收：2 小时无任何在线玩家 → 删除
setInterval(() => {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const anyOnline = room.player('white')?.online || room.player('black')?.online;
    if (!anyOnline && now - room.createdAt > 2 * 3600 * 1000) rooms.delete(code);
  }
}, 10 * 60 * 1000);

server.listen(PORT, () => {
  console.log(`暗影象棋联机服务器 · http://localhost:${PORT}  (每方时限 ${GAME_MS / 1000}s)`);
  console.log(`静态目录: ${ROOT}`);
});
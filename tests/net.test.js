'use strict';
/* ═══════════════════════════════════════════════════════════════════════
 * 暗影象棋 · 联机端到端测试
 * 运行: node tests/net.test.js
 * 自包含：spawn 自己的服务器实例（随机端口）
 * 覆盖: create/join · 快照裁剪(反作弊核心) · moves/move · 非法操作拒绝
 *       · tick 计时 · SSE 断线重连 · 双无头代理完整对局 · 超时判负
 * ═══════════════════════════════════════════════════════════════════════ */
const { spawn } = require('child_process');
const path = require('path');
const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}

const post = (base, body) =>
  fetch(base + '/api', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then(r => r.json());

/* ── SSE 客户端（Node 无 EventSource，手工解析 fetch 流）────────────── */
async function sseConnect(base, room, token, onEvent) {
  const res = await fetch(`${base}/api/events?room=${room}&token=${token}`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const loop = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const chunk = buf.slice(0, idx); buf = buf.slice(idx + 2);
        const data = chunk.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).join('\n');
        if (data) await onEvent(JSON.parse(data));
      }
    }
  })();
  return { loop, close: () => reader.cancel() };
}

function startServer(port, timeSec) {
  const child = spawn('node', ['server/server.js'], {
    cwd: ROOT,
    env: { ...process.env, SC_PORT: String(port), SC_TIME: String(timeSec || 600) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return child;
}

async function waitReady(base, ms = 5000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    try { const r = await fetch(base + '/'); if (r.ok) return true; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

function snapQueue(kind) {
  const q = [];
  let waiter = null;
  return {
    q,
    onEvent(ev) {
      if ((kind ? ev.type === kind : true) && waiter) { waiter(ev); waiter = null; }
      else if (kind ? ev.type === kind : true) q.push(ev);
    },
    next(timeout = 3000) {
      if (q.length) return Promise.resolve(q.shift());
      return new Promise((resolve, reject) => {
        waiter = resolve;
        setTimeout(() => { if (waiter) { waiter = null; reject(new Error('等待消息超时')); } }, timeout);
      });
    },
    // 跳过不满足谓词的旧事件，直到拿到想要的那条（容忍 join 广播等中间快照）
    async nextWhere(pred, timeout = 4000) {
      while (true) {
        if (q.length) {
          const ev = q.shift();
          if (pred(ev)) return ev;
          continue;
        }
        const ev = await new Promise((resolve, reject) => {
          waiter = resolve;
          setTimeout(() => { if (waiter) { waiter = null; reject(new Error('等待消息超时')); } }, timeout);
        });
        if (pred(ev)) return ev;
      }
    },
    count() { return q.length; },
  };
}

/* ── 快照裁剪断言（反作弊核心）──────────────────────────────────────── */
function assertSnapshotShape(snap, label) {
  assert(snap.board.length === 8 && snap.board.every(r => r.length === 8), `${label}: 8x8 棋盘`);
  let ownCount = 0, oppCount = 0, leak = 0;
  for (const row of snap.board) for (const cell of row) {
    if (!cell) continue;
    if (cell.own) {
      ownCount++;
      if (!cell.revealed) {
        if (cell.type !== undefined || cell.pos === undefined) leak++;
      }
    } else {
      oppCount++;
      if (!cell.revealed && (cell.type !== undefined || cell.pos !== undefined)) leak++;
    }
  }
  assert(ownCount === 16 && oppCount === 16, `${label}: 双方各 16 子`);
  assert(leak === 0, `${label}: 未揭示棋子零信息泄露（敌方无 type 无 pos，己方只给 pos）`);
}

/* ═══ 测试 1: create / join / SSE 首快照 + 裁剪 ═══ */
async function test_create_join(base) {
  console.log('\n══ 测试1: 建房/加入/SSE 首快照 + 视角裁剪 ══');
  const c2 = await fetch(base + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 'create' }) }).then(r => r.json());
  assert(c2.ok && c2.room && c2.token && c2.color === 'white', 'create 返回 room/token/白方');
  const room = c2.room, tokW = c2.token;

  const wq = snapQueue('snapshot');
  const sseW = await sseConnect(base, room, tokW, wq.onEvent);
  const snapW = await wq.next();
  assert(snapW.you === 'white' && snapW.turn === 'white', '白方首快照: you/turn 正确');
  assertSnapshotShape(snapW, '白方视角');
  assert(snapW.history.length === 0 && snapW.moveNum === 1, '初始记谱为空, 回合数=1');

  const b = await fetch(base + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 'join', room }) }).then(r => r.json());
  assert(b.ok && b.color === 'black' && b.token, 'join 返回 token/黑方');
  const tokB = b.token;

  const bq = snapQueue('snapshot');
  const sseB = await sseConnect(base, room, tokB, bq.onEvent);
  const snapB = await bq.next();
  assert(snapB.you === 'black' && snapB.turn === 'white', '黑方首快照: 执黑, 白先手');
  assertSnapshotShape(snapB, '黑方视角');
  return { room, tokW, tokB, sseW, sseB, wq, bq };
}

/* ═══ 测试 2: moves / move / 轮流 ═══ */
async function test_move_flow(base, ctx) {
  console.log('\n══ 测试2: 合法走子与回合流转 ══');
  const { room, tokW, tokB, sseW, sseB, wq, bq } = ctx;

  const mvW = await post(base, { a: 'moves', room, token: tokW, from: [6, 0] });
  assert(mvW.ok && mvW.moves.length === 2, '白方 a2(6,0) 有合法走法(兵两格)');

  // 黑方在自己回合前动手 → 拒绝（此时 turn=white）
  const early = await post(base, { a: 'move', room, token: tokB, from: [1, 0], to: [2, 0] });
  assert(early.error === 'NOT_YOUR_TURN', '未轮到自己就走 → NOT_YOUR_TURN');

  const [tr, tc] = mvW.moves[0];
  const m1 = await post(base, { a: 'move', room, token: tokW, from: [6, 0], to: [tr, tc] });
  assert(m1.ok, '白方走子被接受');
  const snapW2 = await wq.nextWhere(s => s.turn === 'black');
  const snapB2 = await bq.nextWhere(s => s.turn === 'black');
  assert(snapW2.turn === 'black' && snapB2.turn === 'black', '走子后双方快照 turn=black');
  assert(snapW2.lastMove.from[0] === 6 && snapW2.lastMove.from[1] === 0, '快照 lastMove 正确');
  assert(snapW2.board[6][0] === null && snapB2.board[6][0] === null, '双方视角源格已空');
  assert(snapW2.board[tr][tc] && snapW2.board[tr][tc].revealed, '走到的子已揭示(双方可见)');
  assert(snapW2.history.length === 1, '记谱 +1');

  const mvB = await post(base, { a: 'moves', room, token: tokB, from: [1, 0] });
  console.log('  [debug] mvB 响应:', JSON.stringify(mvB), 'turn 应为 black');
  assert(mvB.ok && mvB.moves.length > 0, '黑方 a7(1,0) 有合法走法');
  const [br, bc] = mvB.moves[0];
  const m2 = await post(base, { a: 'move', room, token: tokB, from: [1, 0], to: [br, bc] });
  assert(m2.ok, '黑方走子被接受');
  await wq.nextWhere(s => s.turn === 'white');
  await bq.nextWhere(s => s.turn === 'white');

  const illegal = await post(base, { a: 'move', room, token: tokW, from: [6, 2], to: [6, 2] });
  assert(illegal.error === 'ILLEGAL_MOVE', '原地不动 → ILLEGAL_MOVE');

  const badRoom = await post(base, { a: 'join', room: 'ZZZZZ' });
  assert(badRoom.error === 'ROOM_NOT_FOUND', '不存在房间 → ROOM_NOT_FOUND');

  const badAuth = await post(base, { a: 'move', room, token: 'deadbeef', from: [6, 4], to: [5, 4] });
  assert(badAuth.error === 'AUTH_FAILED', '坏 token → AUTH_FAILED');

  const full = await post(base, { a: 'join', room });
  assert(full.error === 'ROOM_FULL', '第三人加入 → ROOM_FULL');

  const third = await post(base, { a: 'moves', room, token: tokW, from: [7, 0] });
  assert(third.ok, '白方请求其它子走法正常');

  // 拿敌方的子来走（token 是白方，from 是黑方底线空位）→ 拒绝
  const selfCap = await post(base, { a: 'move', room, token: tokW, from: [1, 0], to: [2, 0] });
  assert(selfCap.error === 'NOT_YOUR_PIECE', '走对手/空格棋子 → NOT_YOUR_PIECE');
}

/* ═══ 测试 3: tick 计时 ═══ */
async function test_tick(base, ctx) {
  console.log('\n══ 测试3: tick 计时推送 ══');
  const { room, tokW, sseW, wq } = ctx;
  const tq = snapQueue('tick');
  const sseT = await sseConnect(base, room, tokW, tq.onEvent);
  const t0 = await tq.next();
  const t1 = await tq.next();
  assert(t0.timers && t0.timers.white !== undefined, 'tick 携带双方计时');
  assert(t0.timers.white >= t1.timers.white && t1.timers.white >= t0.timers.white - 3, '计时递减');
  sseT.close();
}

/* ═══ 测试 4: 断线重连 ═══ */
async function test_reconnect(base, ctx) {
  console.log('\n══ 测试4: SSE 断线 → 对手离线提示 → 重连恢复 ══');
  const { room, tokB, sseB, wq, bq } = ctx;

  // 黑方断开
  const wOppQ = snapQueue('opp');
  const sseW2 = await sseConnect(base, room, ctx.tokW, wOppQ.onEvent);
  sseB.close();
  // 队列里可能还混着连接瞬间的 online 事件，循环取到 offline 为止
  let offEv = null;
  for (let i = 0; i < 5; i++) {
    const ev = await wOppQ.next();
    if (ev.online === false) { offEv = ev; break; }
  }
  assert(!!offEv, '白方收到对手离线');

  // 黑方重连（新 SSE 连接）
  const bq2 = snapQueue('snapshot');
  const sseB2 = await sseConnect(base, room, tokB, bq2.onEvent);
  const snap = await bq2.next();
  assert(snap.you === 'black', '重连快照恢复: 执黑视角正确');
  assertSnapshotShape(snap, '重连快照');
  let onEv = null;
  for (let i = 0; i < 5; i++) {
    const ev = await wOppQ.next(4000);
    if (ev && ev.online === true) { onEv = ev; break; }
  }
  assert(!!onEv, '白方收到对手上线');
  ctx.sseB = sseB2; // 更新引用供后续使用
}

/* ═══ 测试 5: 双无头代理完整对局 ═══ */
async function test_full_game(base) {
  console.log('\n══ 测试5: 双无头代理在线完整对局 ═══');
  const mk = () => fetch(base + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 'create' }) }).then(r => r.json());
  const c = await mk();
  const b = await fetch(base + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 'join', room: c.room }) }).then(r => r.json());

  let over = null;
  const states = {};

  async function agent(token, color) {
    let busy = false;
    const q = snapQueue('snapshot');
    const sse = await sseConnect(base, c.room, token, async (ev) => {
      if (ev.type !== 'snapshot') return;
      q.q.push(ev);
      if (busy) return;
      busy = true;
      try { await think(ev); } finally { busy = false; }
    });
    return { sse, q };
    async function think(snap) {
      if (over) return;
      if (snap.you !== snap.turn) return;
      if (['won', 'checkmate', 'stalemate', 'draw'].includes(snap.state)) {
        over = { state: snap.state, winner: snap.winner, by: color };
        states[color] = JSON.stringify(snap);   // 终局快照留存对比
        return;
      }
      for (let r = 0; r < 8; r++) for (let cc = 0; cc < 8; cc++) {
        const cell = snap.board[r][cc];
        if (!cell || !cell.own) continue;
        const mv = await post(base, { a: 'moves', room: c.room, token, from: [r, cc] });
        if (!mv.ok || !mv.moves.length) continue;
        const [tr, tc] = mv.moves[Math.floor(Math.random() * mv.moves.length)];
        const res = await post(base, { a: 'move', room: c.room, token, from: [r, cc], to: [tr, tc] });
        if (res.ok && res.needsPromotion) {
          await post(base, { a: 'promote', room: c.room, token, type: 'Q' });
        }
        return;
      }
    }
  }

  const agW = await agent(c.token, 'white');
  const agB = await agent(b.token, 'black');

  // 等待终局（随机对局，2 分钟看门狗）
  const t0 = Date.now();
  while (!over && Date.now() - t0 < 120 * 1000) await new Promise(r => setTimeout(r, 200));

  agW.sse.close(); agB.sse.close();
  assert(!!over, '对局自然终局（' + (over ? over.state + ' 胜者=' + over.winner : '超时') + '）');
  return over;
}

/* ═══ 测试 6: 超时判负（SC_TIME=2 专用服务器） ═══ */
async function test_timeout(base) {
  console.log('\n══ 测试6: 超时判负 ══');
  const c = await fetch(base + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 'create' }) }).then(r => r.json());
  await fetch(base + '/api', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ a: 'join', room: c.room }) }).then(r => r.json());
  const wq = snapQueue('snapshot');
  const sse = await sseConnect(base, c.room, c.token, wq.onEvent);
  await wq.next();
  // 双方都不走 → 白方(轮到) 2s 后超时，黑胜
  const snap = await wq.next(6000);
  assert(snap.state === 'won' && snap.winner === 'black', `白方超时黑方胜 (state=${snap.state}, winner=${snap.winner})`);
  assert(snap.timers.white === 0, '白方计时归零');
  // 揭示全部
  let revealed = 0;
  for (const row of snap.board) for (const cell of row) if (cell?.revealed) revealed++;
  assert(revealed > 0, `终局揭示棋子 (${revealed} 枚)`);
  sse.close();
}

/* ═══ 主流程 ═══ */
(async () => {
  // 随机端口，避免与残留的孤儿服务器撞车
  const mainPort = 20000 + Math.floor(Math.random() * 7000);
  const timePort = 27000 + Math.floor(Math.random() * 7000);
  const srv1 = startServer(mainPort);
  const srv2 = startServer(timePort, 2);
  const base = `http://localhost:${mainPort}`;
  const base2 = `http://localhost:${timePort}`;

  try {
    assert(await waitReady(base) && await waitReady(base2), '两台测试服务器就绪');

    const ctx = await test_create_join(base);
    await test_move_flow(base, ctx);
    await test_tick(base, ctx);
    await test_reconnect(base, ctx);
    await test_full_game(base);
    await test_timeout(base2);
  } catch (e) {
    failed++;
    console.error('  ✗ 测试异常: ' + (e.stack || e.message));
  } finally {
    srv1.kill(); srv2.kill();
    console.log(`\n══ 结果: ${passed} 通过, ${failed} 失败 ══`);
    process.exit(failed ? 1 : 0);
  }
})();
'use strict';
// 暗影象棋 AI 测试 · 运行: node tests/ai.test.js

global.window = {};
require('../js/chess.js');
require('../js/ai.js');

const { ChessGame, ShadowAI } = window;

let passed = 0, failed = 0;
function assert(cond, name) {
  if (cond) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name); }
}
function assertEq(a, b, name) {
  if (JSON.stringify(a) === JSON.stringify(b)) { passed++; console.log('  ✓ ' + name); }
  else { failed++; console.error('  ✗ ' + name + ' 期望 ' + JSON.stringify(b) + ' 实得 ' + JSON.stringify(a)); }
}

// 构造自定义局面: pieces = [ [r, c, type, color, revealed] ]
function makeGame(pieces, turn) {
  const g = new ChessGame();
  g.board = Array.from({ length: 8 }, () => Array(8).fill(null));
  for (const [r, c, type, color, revealed] of pieces) {
    g.board[r][c] = { type, color, revealed: revealed !== false, hasMoved: true };
  }
  g.currentTurn = turn || 'white';
  g.gameState = 'playing';
  return g;
}
const K = (r, c, color) => [r, c, 'K', color, true];

console.log('\n══ 测试1: 一步吃王 (AI 必须发现) ══');
{
  // 白后 b1(7,1) → b8(0,1) 直接吃黑王; 白王 e1(7,4)
  const g = makeGame([K(7, 4, 'white'), [7, 1, 'Q', 'white', true], K(0, 1, 'black')], 'white');
  const ai = new ShadowAI(3);
  const mv = ai.getBestMove(g, 'white');
  assert(mv !== null, '有走法');
  assertEq(mv, { fr: 7, fc: 1, tr: 0, tc: 1 }, '吃王走法 b1→b8');
}

console.log('\n══ 测试2: 被将军时必须合法逃王 ══');
{
  // 黑后 d8(0,3) 将军白王 d1(7,3); 白只有王可动
  const g = makeGame([K(7, 3, 'white'), [0, 3, 'Q', 'black', true]], 'white');
  const ai = new ShadowAI(3);
  const mv = ai.getBestMove(g, 'white');
  assert(mv !== null, '有逃脱走法');
  const legal = g.getLegalMoves(mv.fr, mv.fc).some(m => m.row === mv.tr && m.col === mv.tc);
  assert(legal, '走法合法');
  if (mv) {
    const rec = g.makeMove(mv.fr, mv.fc, mv.tr, mv.tc);
    assert(rec !== null && !g.isInCheck('white'), '走后不在将军状态');
  }
}

console.log('\n══ 测试3: 白送上门的大子必须吃 ══');
{
  // 黑后 a5(3,0) 暴露, 黑王 h8(0,7); 白车 a1(7,0) 沿 a 列直达可吃
  const g = makeGame([K(7, 4, 'white'), [7, 0, 'R', 'white', true], [3, 0, 'Q', 'black', true], K(0, 7, 'black')], 'white');
  const ai = new ShadowAI(3);
  const mv = ai.getBestMove(g, 'white');
  assert(mv !== null && mv.fr === 7 && mv.fc === 0 && mv.tr === 3 && mv.tc === 0, '吃 a5 黑后走法 → ' + JSON.stringify(mv));
}

console.log('\n══ 测试4: 升变走法正确 ══');
{
  // 白兵 d2(1,3) 直冲底线 d1(0,3); 黑王远处 a8(0,0)
  const g = makeGame([K(7, 4, 'white'), [1, 3, 'P', 'white', true], K(0, 0, 'black')], 'white');
  const ai = new ShadowAI(2);
  const mv = ai.getBestMove(g, 'white');
  assert(mv !== null && mv.tr === 0 && mv.tc === 3, '升变走法 (1,3)→(0,3) → ' + JSON.stringify(mv));
}

console.log('\n══ 测试5: AI 自对弈 6 局 —— 走法全合法、必分胜负 ══');
{
  const aiW = new ShadowAI(2), aiB = new ShadowAI(2);
  let gamesOk = 0, totalPlies = 0, maxPlies = 0;
  for (let gi = 0; gi < 6; gi++) {
    const g = new ChessGame();
    g.newGame();
    let plies = 0, allLegal = true;
    while (!['won', 'checkmate', 'stalemate', 'draw'].includes(g.gameState) && plies < 250) {
      const color = g.currentTurn;
      const ai = color === 'white' ? aiW : aiB;
      const mv = ai.getBestMove(g, color);
      if (!mv) break;
      const legal = g.getLegalMoves(mv.fr, mv.fc).some(m => m.row === mv.tr && m.col === mv.tc);
      if (!legal) { allLegal = false; console.error('    非法走法!', mv); break; }
      const rec = g.makeMove(mv.fr, mv.fc, mv.tr, mv.tc);
      if (rec && rec.needsPromotion) g.completePromotion('Q');
      plies++;
    }
    totalPlies += plies; maxPlies = Math.max(maxPlies, plies);
    const ended = ['won', 'checkmate', 'stalemate', 'draw'].includes(g.gameState);
    if (allLegal && ended) gamesOk++;
    else console.error('    第' + gi + '局未正常结束, state=' + g.gameState + ' plies=' + plies);
  }
  assert(gamesOk === 6, '6/6 局正常分出胜负（平均 ' + Math.round(totalPlies / 6) + ' 回合, 最长 ' + maxPlies + '）');
}

console.log('\n══ 测试6: 中局性能 (depth 3) ══');
{
  const g = new ChessGame();
  g.newGame();
  // 随机走 12 步制造中局（对局若提前终结则停止）
  const aiW = new ShadowAI(2), aiB = new ShadowAI(2);
  outer:
  for (let i = 0; i < 6; i++) {
    for (const c of ['white', 'black']) {
      if (['won', 'checkmate', 'stalemate'].includes(g.gameState)) break outer;
      const ai = c === 'white' ? aiW : aiB;
      const mv = ai.getBestMove(g, c);
      if (!mv) break outer;
      const rec = g.makeMove(mv.fr, mv.fc, mv.tr, mv.tc);
      if (rec && rec.needsPromotion) g.completePromotion('Q');
    }
  }
  const ai = new ShadowAI(3);
  const t0 = Date.now();
  const mv = ai.getBestMove(g, g.currentTurn);
  const ms = Date.now() - t0;
  assert(mv !== null, '深度3能在 ' + ms + 'ms 内出招 (节点 ' + ai.nodes + ')');
  if (ms > 3000) { failed++; console.error('  ✗ 性能不达标（>3000ms）'); } else passed++;
  console.log('    （' + ms + 'ms, ' + ai.nodes + ' 节点）');
}

console.log('\n══ 测试7: 三次局面重复判和 (引擎规则) ══');
{
  // 仅两王互走一格往返，第 9 步时开局的局面第 3 次出现 → 判和
  const g = makeGame([K(7, 0, 'white'), K(0, 7, 'black')], 'white');
  const seq = [
    [7, 0, 6, 0], [0, 7, 1, 7],
    [6, 0, 7, 0], [1, 7, 0, 7],
    [7, 0, 6, 0], [0, 7, 1, 7],
    [6, 0, 7, 0], [1, 7, 0, 7],
    [7, 0, 6, 0]
  ];
  let state = 'playing';
  for (const [fr, fc, tr, tc] of seq) {
    const rec = g.makeMove(fr, fc, tr, tc);
    assert(rec !== null, '重复序列中每一步合法 (' + fr + ',' + fc + '→' + tr + ',' + tc + ')');
    state = g.gameState;
    if (!['playing', 'check'].includes(state)) break;
  }
  assert(state === 'draw', '第三次重复后 gameState=draw (实得 ' + state + ')');

  // undo 往返后重复计数应回落（悔棋后不会立即判和）
  const g2 = makeGame([K(7, 0, 'white'), K(0, 7, 'black')], 'white');
  const seq2 = [[7, 0, 6, 0], [0, 7, 1, 7], [6, 0, 7, 0], [1, 7, 0, 7]];
  for (const [fr, fc, tr, tc] of seq2) g2.makeMove(fr, fc, tr, tc);
  g2.undoMove(); g2.undoMove();   // 退回两步：白王回到 a2(6,0)，黑王 h7(1,7)
  assert(g2.gameState === 'playing', 'undoMove 后重复计数正确回落');
  const rec = g2.makeMove(6, 0, 7, 0);   // 王 a2→a1：该局面只出现 2 次 → 仍继续
  assert(rec !== null && ['playing', 'check'].includes(g2.gameState), '计数回落后不误判和棋');
}

console.log('\n══ 结果: ' + passed + ' 通过, ' + failed + ' 失败 ══');
process.exit(failed ? 1 : 0);
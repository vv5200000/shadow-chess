'use strict';

// ════════════════════════════════════════════════════════════════════════
// 暗影象棋 AI · ShadowAI
// ════════════════════════════════════════════════════════════════════════
// 公平博弈 AI：只使用公开信息推理——
//   · 未揭示棋子按"所在格经典走法规则"行动（与人类玩家看到的一致）
//   · 估值时未揭示棋子按其阵营"剩余棋子池的期望价值"计分，不偷看真实身份
// 算法：带 alpha-beta 剪枝的 Negamax（默认深度 3）
// 搜索在克隆的 ChessGame 上进行：走子 / 翻面 / 将军揭示 / 升变全部复用棋规引擎
// 升变在搜索与实战中一律自动变后（Q）
// ════════════════════════════════════════════════════════════════════════

const AI_PIECE_VALUES = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
const AI_SIDE_TOTAL   = 39;   // 每方棋子价值总和: Q9+R5+R5+B3+B3+N3+N3+P×8（王不算）
const AI_MATE         = 1000000;
const AI_CHECK_PEN    = 30;     // 被将军罚分（厘兵）
const AI_SECRET_BONUS = 4;      // 每枚未揭示己方棋子奖励（信息保密价值）
const AI_KING_TROPISM = 0.6;    // 残局王逼近系数（14-王距 × 系数）

class ShadowAI {
  constructor(depth) {
    this.depth = depth || 3;
    this.nodes = 0;
  }

  // ── 对外接口：返回最佳走法 {fr, fc, tr, tc}，无合法走法返回 null ──
  getBestMove(game, color) {
    this.nodes = 0;
    const root = this._snapshot(game);
    if (root.currentTurn !== color) return null;
    const moves = this._legalMoves(root, color);
    if (!moves.length) return null;

    let best = null, bestScore = -Infinity, alpha = -Infinity;
    for (const mv of this._orderMoves(root, moves)) {
      const child = this._clone(root);
      if (!this._apply(child, mv)) continue;
      const score = -this._negamax(child, this.depth - 1, -Infinity, -alpha);
      if (score > bestScore) { bestScore = score; best = mv; }
      if (score > alpha) alpha = score;
    }
    return best;
  }

  // ── Negamax ──
  _negamax(g, depth, alpha, beta) {
    this.nodes++;
    const st = g.gameState;
    // 注意：吃王后 makeMove 不会切换当前行棋方（currentTurn 仍是胜方）。
    // negamax 返回值按"对当前行棋方"口径，父节点取负后才是落子方得分，
    // 因此这里要对已获胜的一方记 -MATE，父级取负后落子方才拿到 +MATE。
    if (st === 'won')       return -AI_MATE;   // 当前行棋方已吃王 → 对它是胜，父级取负后是+MATE
    if (st === 'checkmate') return -AI_MATE;   // 当前行棋方被将死 → 负
    if (st === 'stalemate') return 0;

    if (depth <= 0) return this._evaluate(g);

    let best = -Infinity;
    const moves = this._legalMoves(g, g.currentTurn);
    for (const mv of this._orderMoves(g, moves)) {
      const child = this._clone(g);
      if (!this._apply(child, mv)) continue;
      const score = -this._negamax(child, depth - 1, -beta, -alpha);
      if (score > best) best = score;
      if (best > alpha) alpha = best;
      if (alpha >= beta) break;
    }
    return best === -Infinity ? 0 : best;
  }

  // ── 合法走法（公开信息，与人类玩家完全一致；不依赖 currentTurn）──
    _legalMoves(g, color) {
      const out = [];
      for (let r = 0; r < 8; r++)
        for (let c = 0; c < 8; c++) {
          const p = g.board[r][c];
          if (!p || p.color !== color) continue;
          const ms = g._getLegalMovesAny(r, c);
          for (const m of ms) out.push({ fr:r, fc:c, tr:m.row, tc:m.col });
        }
      return out;
    }

  // ── 走法排序：先吃子（按被吃子价值估算），升变优先 ──
  _orderMoves(g, moves) {
    const typeVal = (r, c) => {
      const p = g.board[r][c];
      if (!p) return 0;
      if (p.revealed) return AI_PIECE_VALUES[p.type] || 0;
      return AI_PIECE_VALUES[g.getPosRule(r, c) || 'P'] || 1;
    };
    const score = (mv) => {
      let s = typeVal(mv.tr, mv.tc) * 10;
      const mover = g.board[mv.fr][mv.fc];
      if (mover) {
        const eff = g.getEffType(mover, mv.fr, mv.fc);
        if (eff === 'P') {
          const promRow = mover.color === 'white' ? 0 : 7;
          if (mv.tr === promRow) s += 60;
        }
      }
      return s;
    };
    const mapped = moves.map(mv => ({ mv, s: score(mv) }));
    mapped.sort((a, b) => b.s - a.s);
    return mapped.map(x => x.mv);
  }

  // ── 状态克隆 ──
  _snapshot(game) {
    const g = new (window.ChessGame)();
    g.board = game.board.map(row => row.map(c => (c ? { ...c } : null)));
    g.currentTurn = game.currentTurn;
    g.gameState = game.gameState;
    g.moveHistory = [];
    g.pendingPromotion = null;
    g.lastMove = game.lastMove ? { from: { ...game.lastMove.from }, to: { ...game.lastMove.to } } : null;
    return g;
  }

  _clone(g) { return this._snapshot(g); }

  // ── 在克隆局上落子（升变自动变后）──
  _apply(g, mv) {
    const rec = g.makeMove(mv.fr, mv.fc, mv.tr, mv.tc);
    if (!rec) return false;
    if (rec.needsPromotion) g.completePromotion('Q');
    return true;
  }

  // ── 估值 ──
  // 内部按"白方视角"累加（正=对白方有利）→ 最后翻转为"当前行棋方"视角，
  // 与 negamax 返回口径一致（曾因物料/将军两套视角混用导致评分反向）。
  _evaluate(g) {
    let score = 0;
    for (const color of ['white', 'black']) {
      let revealedSum = 0, unknown = 0;
      for (let r = 0; r < 8; r++)
        for (let c = 0; c < 8; c++) {
          const p = g.board[r][c];
          if (!p || p.color !== color) continue;
          if (p.revealed) revealedSum += AI_PIECE_VALUES[p.type] || 0;
          else unknown++;
        }
      const expected = unknown ? (AI_SIDE_TOTAL - revealedSum) / unknown : 0;
      const side = revealedSum + unknown * expected + unknown * AI_SECRET_BONUS;
      score += (color === 'white') ? side : -side;
    }
    if (g.isInCheck('white')) score -= AI_CHECK_PEN;
    if (g.isInCheck('black')) score += AI_CHECK_PEN;

    // 残局王逼近：子力稀疏时鼓励行棋方王走向对方王（打破死局僵持）
    let tot = 0, wK = null, bK = null;
    for (let r = 0; r < 8; r++)
      for (let c = 0; c < 8; c++) {
        const p = g.board[r][c];
        if (!p) continue;
        tot++;
        if (p.type === 'K') {
          if (p.color === 'white') wK = { r, c };
          else bK = { r, c };
        }
      }
    if (tot <= 14 && wK && bK) {
      const dist = Math.abs(wK.r - bK.r) + Math.abs(wK.c - bK.c);
      score += (g.currentTurn === 'white' ? 1 : -1) * AI_KING_TROPISM * (14 - dist);
    }
    return g.currentTurn === 'white' ? score : -score;
  }
}

if (typeof window !== 'undefined') window.ShadowAI = ShadowAI;
'use strict';

// ── Piece symbols ──────────────────────────────────────────────────────────────
const PIECE_SYMBOLS = {
  white: { K:'♔', Q:'♕', R:'♖', B:'♗', N:'♘', P:'♙' },
  black: { K:'♚', Q:'♛', R:'♜', B:'♝', N:'♞', P:'♟' }
};

// ── Standard position rules: what piece normally occupies each square ──────────
// Row 0 = black back rank, Row 7 = white back rank (0-indexed, 0 at top)
const POSITION_RULES = [
  ['R','N','B','Q','K','B','N','R'],  // row 0 – black back rank positions
  ['P','P','P','P','P','P','P','P'],  // row 1 – black pawn positions
  [null,null,null,null,null,null,null,null],
  [null,null,null,null,null,null,null,null],
  [null,null,null,null,null,null,null,null],
  [null,null,null,null,null,null,null,null],
  ['P','P','P','P','P','P','P','P'],  // row 6 – white pawn positions
  ['R','N','B','Q','K','B','N','R'],  // row 7 – white back rank positions
];

// ── Shadow Chess Rule Summary ──────────────────────────────────────────────────
// 1. All 16 pieces per side are randomly shuffled onto their starting two rows
// 2. Both sides cannot see each other's pieces (hidden pieces shown as "?")
// 3. A piece's FIRST move follows the position-rule of its current square
// 4. After moving, the piece is revealed and henceforth uses its actual type
// Win: capture the opponent's king, checkmate, or timeout

class ChessGame {
  constructor() { this.reset(); }

  reset() {
    this.board = Array.from({length:8}, () => Array(8).fill(null));
    this.currentTurn = 'white';
    this.moveHistory = [];
    this.gameState = 'idle'; // idle|playing|check|checkmate|stalemate|won|draw
    this.pendingPromotion = null;
    this.lastMove = null;
    this._fpStack = [];
    this._fpCounts = new Map();
  }

  newGame() {
    this.reset();
    this._placePieces();
    this.gameState = 'playing';
  }

  // ── Board Setup ─────────────────────────────────────────────────────────────
  _shuffle(arr) {
    const a = [...arr];
    for (let i = a.length-1; i > 0; i--) {
      const j = Math.floor(Math.random()*(i+1));
      [a[i],a[j]] = [a[j],a[i]];
    }
    return a;
  }

  _makePiece(type, color) {
    return { type, color, revealed: false, hasMoved: false };
  }

  _placePieces() {
    const set = ['K','Q','R','R','B','B','N','N','P','P','P','P','P','P','P','P'];
    const wp = this._shuffle([...set]);
    for (let c=0;c<8;c++) this.board[7][c] = this._makePiece(wp[c],'white');
    for (let c=0;c<8;c++) this.board[6][c] = this._makePiece(wp[c+8],'white');
    const bp = this._shuffle([...set]);
    for (let c=0;c<8;c++) this.board[0][c] = this._makePiece(bp[c],'black');
    for (let c=0;c<8;c++) this.board[1][c] = this._makePiece(bp[c+8],'black');
  }

  // ── Type Resolution ─────────────────────────────────────────────────────────
  getPosRule(row, col) {
    return POSITION_RULES[row]?.[col] ?? null;
  }

  // Returns effective movement type: position rule if unrevealed, actual type if revealed
  getEffType(piece, row, col) {
    if (piece.revealed) return piece.type;
    return this.getPosRule(row, col) ?? piece.type;
  }

  // ── Move Generation ─────────────────────────────────────────────────────────
  getLegalMoves(row, col) {
    const p = this.board[row][col];
    if (!p || p.color !== this.currentTurn) return [];
    return this._filterSafe(row, col, this._pseudoMoves(row, col));
  }

  _getLegalMovesAny(row, col) {
    const p = this.board[row][col];
    if (!p) return [];
    return this._filterSafe(row, col, this._pseudoMoves(row, col));
  }

  _filterSafe(row, col, moves) {
    return moves.filter(m => !this._leavesKingInCheck(row, col, m.row, m.col));
  }

  _pseudoMoves(row, col) {
    const p = this.board[row][col];
    if (!p) return [];
    const type = this.getEffType(p, row, col);
    const color = p.color;
    const moves = [];

    if (type === 'K') {
      for (const [dr,dc] of [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]) {
        const r=row+dr, c=col+dc;
        if (this._canLand(r,c,color)) moves.push({row:r,col:c});
      }
    } else if (type === 'N') {
      for (const [dr,dc] of [[-2,-1],[-2,1],[-1,-2],[-1,2],[1,-2],[1,2],[2,-1],[2,1]]) {
        const r=row+dr, c=col+dc;
        if (this._canLand(r,c,color)) moves.push({row:r,col:c});
      }
    } else if (type === 'P') {
      const dir = color==='white' ? -1 : 1;
      const startRow = color==='white' ? 6 : 1;
      const r1 = row+dir;
      if (r1>=0 && r1<8 && !this.board[r1][col]) {
        moves.push({row:r1, col});
        const r2 = row+2*dir;
        if (row===startRow && r2>=0 && r2<8 && !this.board[r2][col])
          moves.push({row:r2, col});
      }
      for (const dc of [-1,1]) {
        const c=col+dc;
        if (r1>=0&&r1<8&&c>=0&&c<8&&this.board[r1][c]&&this.board[r1][c].color!==color)
          moves.push({row:r1, col:c});
      }
    } else {
      const dirs = type==='Q' ? [[-1,-1],[-1,0],[-1,1],[0,-1],[0,1],[1,-1],[1,0],[1,1]]
                 : type==='R' ? [[-1,0],[1,0],[0,-1],[0,1]]
                 :              [[-1,-1],[-1,1],[1,-1],[1,1]]; // B
      for (const [dr,dc] of dirs) {
        let r=row+dr, c=col+dc;
        while (r>=0&&r<8&&c>=0&&c<8) {
          const t=this.board[r][c];
          if (!t) moves.push({row:r,col:c});
          else { if (t.color!==color) moves.push({row:r,col:c}); break; }
          r+=dr; c+=dc;
        }
      }
    }
    return moves;
  }

  _canLand(r, c, color) {
    if (r<0||r>=8||c<0||c>=8) return false;
    const t=this.board[r][c];
    return !t || t.color!==color;
  }

  // ── Check Detection ─────────────────────────────────────────────────────────
  findKing(color) {
    for (let r=0;r<8;r++)
      for (let c=0;c<8;c++) {
        const p=this.board[r][c];
        if (p&&p.type==='K'&&p.color===color) return {row:r,col:c};
      }
    return null;
  }

  isAttacked(row, col, byColor) {
    for (let r=0;r<8;r++)
      for (let c=0;c<8;c++) {
        const p=this.board[r][c];
        if (!p||p.color!==byColor) continue;
        if (this._pseudoMoves(r,c).some(m=>m.row===row&&m.col===col)) return true;
      }
    return false;
  }

  _leavesKingInCheck(fr, fc, tr, tc) {
    const p=this.board[fr][fc], cap=this.board[tr][tc];
    this.board[tr][tc]=p; this.board[fr][fc]=null;
    const k=this.findKing(p.color);
    const inCheck=k ? this.isAttacked(k.row,k.col,p.color==='white'?'black':'white') : false;
    this.board[fr][fc]=p; this.board[tr][tc]=cap;
    return inCheck;
  }

  isInCheck(color) {
    const k=this.findKing(color);
    return k ? this.isAttacked(k.row,k.col,color==='white'?'black':'white') : false;
  }

  _allLegalMoves(color) {
    const moves=[];
    for (let r=0;r<8;r++)
      for (let c=0;c<8;c++) {
        const p=this.board[r][c];
        if (!p||p.color!==color) continue;
        this._getLegalMovesAny(r,c).forEach(m=>moves.push({from:{row:r,col:c},to:m}));
      }
    return moves;
  }

  // ── Make Move ───────────────────────────────────────────────────────────────
  makeMove(fromRow, fromCol, toRow, toCol) {
    if (this.gameState!=='playing'&&this.gameState!=='check') return null;
    const piece=this.board[fromRow][fromCol];
    if (!piece||piece.color!==this.currentTurn) return null;
    if (!this.getLegalMoves(fromRow,fromCol).some(m=>m.row===toRow&&m.col===toCol)) return null;

    const prevBoard=this._cloneBoard();
    const prevTurn=this.currentTurn;
    const prevLast=this.lastMove;
    const prevState=this.gameState;

    const effType=this.getEffType(piece,fromRow,fromCol);
    const wasRevealed=piece.revealed;
    const captured=this.board[toRow][toCol];

    this.board[toRow][toCol]=piece;
    this.board[fromRow][fromCol]=null;
    piece.revealed=true;
    piece.hasMoved=true;
    this.lastMove={from:{row:fromRow,col:fromCol},to:{row:toRow,col:toCol}};

    const record={
      piece:piece.type, effType, color:piece.color,
      from:{row:fromRow,col:fromCol}, to:{row:toRow,col:toCol},
      captured:captured?.type??null, capturedColor:captured?.color??null,
      isFirstMove:!wasRevealed,
      prevBoard, prevTurn, prevLast, prevState,
      promotedTo:null, gameOver:null
    };

    // Pawn promotion (triggered for any piece whose effective type is 'P')
    const promRow = piece.color==='white' ? 0 : 7;
    if (effType==='P' && toRow===promRow) {
      this.pendingPromotion={row:toRow,col:toCol,record};
      this.moveHistory.push(record);
      return {needsPromotion:true, record};
    }

    // King capture → immediate win
    if (captured?.type==='K') {
      this.gameState='won';
      record.gameOver={winner:piece.color};
      this.moveHistory.push(record);
      return record;
    }

    this.currentTurn=this.currentTurn==='white'?'black':'white';
    this._updateState();
    this._recordRepetition();
    this.moveHistory.push(record);
    return record;
  }

  completePromotion(newType) {
    if (!this.pendingPromotion) return null;
    const {row,col,record}=this.pendingPromotion;
    const p=this.board[row][col];
    p.type=newType;
    record.promotedTo=newType;
    this.pendingPromotion=null;
    this.currentTurn=this.currentTurn==='white'?'black':'white';
    this._updateState();
    this._recordRepetition();
    return record;
  }

  undoMove() {
    if (this.moveHistory.length===0) return false;
    if (this.pendingPromotion) this.pendingPromotion=null;
    const rec=this.moveHistory.pop();
    this.board=this._cloneBoardFrom(rec.prevBoard);
    this.currentTurn=rec.prevTurn;
    this.lastMove=rec.prevLast;
    this.gameState=rec.prevState;
    const fp=this._fpStack.pop();
    if (fp!==undefined) {
      const n=(this._fpCounts.get(fp)||1)-1;
      if (n<=0) this._fpCounts.delete(fp);
      else this._fpCounts.set(fp,n);
    }
    return true;
  }

  // ── Repetition Draw ──────────────────────────────────────────────────────────
  // 同一局面（含棋子身份/揭示状态/行棋方）出现 3 次即判和，防无限搅局
  _fingerprint() {
    let fp=this.currentTurn+'|';
    for (let r=0;r<8;r++)
      for (let c=0;c<8;c++) {
        const p=this.board[r][c];
        if (!p) continue;
        fp+=r+','+c+':'+p.type+p.color+(p.revealed?'1':'0')+';';
      }
    return fp;
  }

  _recordRepetition() {
    const fp=this._fingerprint();
    this._fpStack.push(fp);
    const n=(this._fpCounts.get(fp)||0)+1;
    this._fpCounts.set(fp,n);
    if (n>=3 && (this.gameState==='playing'||this.gameState==='check')) {
      this.gameState='draw';
    }
  }

  // ── State Update ────────────────────────────────────────────────────────────
  _updateState() {
    const opp=this.currentTurn==='white'?'black':'white';
    if (this.isInCheck(this.currentTurn)) {
      // Reveal any piece that is giving check
      const k=this.findKing(this.currentTurn);
      if (k) {
        for (let r=0;r<8;r++)
          for (let c=0;c<8;c++) {
            const p=this.board[r][c];
            if (!p||p.color!==opp) continue;
            if (this._pseudoMoves(r,c).some(m=>m.row===k.row&&m.col===k.col))
              p.revealed=true;
          }
      }
      this.gameState=this._allLegalMoves(this.currentTurn).length===0?'checkmate':'check';
    } else {
      this.gameState=this._allLegalMoves(this.currentTurn).length===0?'stalemate':'playing';
    }
  }

  // ── Board Cloning ────────────────────────────────────────────────────────────
  _cloneBoard() {
    return this.board.map(row=>row.map(c=>c?{...c}:null));
  }
  _cloneBoardFrom(snap) {
    return snap.map(row=>row.map(c=>c?{...c}:null));
  }

  // ── Notation ─────────────────────────────────────────────────────────────────
  getMoveNotation(rec) {
    const files='abcdefgh';
    const ranks='87654321';
    const names={K:'K',Q:'Q',R:'R',B:'B',N:'N',P:''};
    const t=rec.effType;
    let n=names[t]??'';
    if (t==='P'&&rec.captured) n+=files[rec.from.col];
    if (rec.captured) n+='x';
    n+=files[rec.to.col]+ranks[rec.to.row];
    if (rec.promotedTo) n+='='+rec.promotedTo;
    return n;
  }
}

// ── 双端导出：浏览器挂 window，Node（联机服务器 / 测试）走 module.exports ──────
if (typeof module!=='undefined'&&module.exports) {
  module.exports={ChessGame,PIECE_SYMBOLS};
} else {
  window.ChessGame=ChessGame;
  window.PIECE_SYMBOLS=PIECE_SYMBOLS;
}

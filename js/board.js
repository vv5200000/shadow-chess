'use strict';

class ChessBoard {
  constructor(game) {
    this.game=game;
    this.perspective='white';
    this.selected=null;
    this.legalMoves=[];
    this.onMove=null;
    this.locked=false;
    this.el=document.getElementById('board');
    this.cells=Array.from({length:8},()=>Array(8).fill(null));
    this._createCells();
  }

  _createCells() {
    for (let r=0;r<8;r++)
      for (let c=0;c<8;c++) {
        const el=document.createElement('div');
        el.className='cell';
        el.addEventListener('click',()=>this._onClick(r,c));
        this.cells[r][c]=el;
      }
  }

  // Full render from scratch (call when perspective changes)
  render(perspective) {
    if (perspective) this.perspective=perspective;
    this.selected=null;
    this.legalMoves=[];
    this._repaint();
    this._updateCoords();
  }

  // Re-paint all cells + overlays
  _repaint() {
    for (let r=0;r<8;r++)
      for (let c=0;c<8;c++)
        this._paintCell(r,c);
    this._reorder();
    this._applyOverlays();
  }

  // Paint a single cell with piece
  _paintCell(r, c) {
    const el=this.cells[r][c];
    const light=(r+c)%2===0;
    el.className=`cell ${light?'light':'dark'}`;
    el.innerHTML='';

    const piece=this.game.board[r][c];
    if (!piece) return;

    const div=document.createElement('div');
    const isOwn=piece.color===this.perspective;

    if (isOwn) {
      if (piece.revealed) {
        div.textContent=PIECE_SYMBOLS[piece.color][piece.type];
        div.className='piece';
      } else {
        div.className='piece own-unrevealed';
        div.innerHTML='<span class="hidden-q">?</span>';
        const posType=this.game.getPosRule(r,c);
        const typeNames={K:'国王',Q:'后',R:'车',B:'象',N:'马',P:'兵'};
        const posName=posType?typeNames[posType]:'未知';
        div.title=`本回合走法规则: ${posName}`;
      }
    } else {
      if (piece.revealed) {
        div.textContent=PIECE_SYMBOLS[piece.color][piece.type];
        div.className='piece';
      } else {
        div.className='piece hidden-piece';
        div.innerHTML='<span class="hidden-q">?</span>';
      }
    }
    el.appendChild(div);
  }

  // Reorder DOM to match board perspective
  _reorder() {
    this.el.innerHTML='';
    if (this.perspective==='white') {
      for (let r=0;r<8;r++)
        for (let c=0;c<8;c++)
          this.el.appendChild(this.cells[r][c]);
    } else {
      for (let r=7;r>=0;r--)
        for (let c=7;c>=0;c--)
          this.el.appendChild(this.cells[r][c]);
    }
  }

  // Apply highlight overlays on top of painted cells
  _applyOverlays() {
    const g=this.game;

    if (g.lastMove) {
      const {from,to}=g.lastMove;
      this.cells[from.row][from.col].classList.add('last-from');
      this.cells[to.row][to.col].classList.add('last-to');
    }

    if (g.gameState==='check'||g.gameState==='checkmate') {
      const k=g.findKing(g.currentTurn);
      if (k) this.cells[k.row][k.col].classList.add('in-check');
    }

    if (this.selected) {
      const {row,col}=this.selected;
      this.cells[row][col].classList.add('selected');
      this.legalMoves.forEach(m=>{
        const target=g.board[m.row][m.col];
        this.cells[m.row][m.col].classList.add(target?'can-capture':'can-move');
      });
    }
  }

  // Update coordinate labels based on perspective
  _updateCoords() {
    const rankEl=document.getElementById('coord-ranks');
    const fileEl=document.getElementById('coord-files');
    rankEl.innerHTML=''; fileEl.innerHTML='';
    const isW=this.perspective==='white';
    const ranks=isW?['8','7','6','5','4','3','2','1']:['1','2','3','4','5','6','7','8'];
    const files=isW?'abcdefgh'.split(''):'hgfedcba'.split('');
    ranks.forEach(r=>{ const e=document.createElement('div'); e.className='coord-label'; e.textContent=r; rankEl.appendChild(e); });
    files.forEach(f=>{ const e=document.createElement('div'); e.className='coord-label'; e.textContent=f; fileEl.appendChild(e); });
  }

  // Handle cell click
  _onClick(r, c) {
    if (this.locked) return;
    const g=this.game;
    if (g.gameState!=='playing'&&g.gameState!=='check') return;
    if (g.pendingPromotion) return;

    const piece=g.board[r][c];

    if (this.selected) {
      // Deselect same cell
      if (this.selected.row===r&&this.selected.col===c) {
        this.selected=null; this.legalMoves=[]; this._repaint(); return;
      }
      // Attempt move to legal square
      if (this.legalMoves.some(m=>m.row===r&&m.col===c)) {
        const {row:fr,col:fc}=this.selected;
        this.selected=null; this.legalMoves=[];
        if (this.onMove) this.onMove(fr,fc,r,c);
        return;
      }
    }

    // Select own piece
    if (piece&&piece.color===this.perspective&&piece.color===g.currentTurn) {
      this.selected={row:r,col:c};
      this.legalMoves=g.getLegalMoves(r,c);
      this._repaint();
      return;
    }

    this.selected=null; this.legalMoves=[]; this._repaint();
  }

  // Landing animation for piece that just arrived
  animateLanding(row, col) {
    const el=this.cells[row][col].querySelector('.piece');
    if (!el) return;
    el.classList.remove('landing');
    void el.offsetWidth; // reflow
    el.classList.add('landing');
    setTimeout(()=>el.classList.remove('landing'),400);
  }

  // Flip animation (reveal)
  animateFlip(row, col, cb) {
    const el=this.cells[row][col].querySelector('.piece');
    if (!el) { cb?.(); return; }
    el.classList.add('flipping');
    setTimeout(()=>{ el.classList.remove('flipping'); cb?.(); },500);
  }

  revealAllPieces() {
    for (let r=0;r<8;r++)
      for (let c=0;c<8;c++) {
        const p=this.game.board[r][c];
        if (p) p.revealed=true;
      }
  }
}

window.ChessBoard=ChessBoard;

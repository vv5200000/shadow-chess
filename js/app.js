'use strict';

class ChessApp {
  constructor() {
    this.game=new ChessGame();
    this.board=new ChessBoard(this.game);
    this.timers={white:600,black:600};
    this.timerInterval=null;
    this.moveNum=1;
    this.board.onMove=(fr,fc,tr,tc)=>this._onMove(fr,fc,tr,tc);
    this._bindUI();
    this.newGame();
  }

  _bindUI() {
    document.getElementById('btn-new').onclick=()=>this.newGame();
    document.getElementById('btn-undo').onclick=()=>this.undo();
    document.getElementById('btn-pass-ready').onclick=()=>this._passReady();
    document.getElementById('btn-gameover-new').onclick=()=>this.newGame();
    document.getElementById('btn-rules').onclick=()=>this._show('rules-dialog');
    document.getElementById('btn-rules-close').onclick=()=>this._hide('rules-dialog');
  }

  // ── New Game ─────────────────────────────────────────────────────────────────
  newGame() {
    this.game.newGame();
    this.timers={white:600,black:600};
    this.moveNum=1;
    clearInterval(this.timerInterval);
    document.getElementById('move-list').innerHTML='';
    this._hide('gameover-dialog');
    this._hideCheck();
    this._showPass();
  }

  // ── Pass Screen ──────────────────────────────────────────────────────────────
  _showPass() {
    const color=this.game.currentTurn;
    const name=color==='white'?'白方':'黑方';
    document.getElementById('pass-title').textContent=`轮到${name}了`;
    document.getElementById('pass-sub').textContent='请将屏幕传递给对方玩家，准备好后点击继续';
    document.getElementById('btn-pass-ready').textContent=`${name}已准备好 →`;
    clearInterval(this.timerInterval);
    this._show('pass-screen');
  }

  _passReady() {
    this._hide('pass-screen');
    const color=this.game.currentTurn;
    this.board.render(color);
    this._updateTurnIndicator();
    this._updatePlayerBars();
    this._updateTimerDisplay();
    this._startTimer();
    if (this.game.gameState==='check') this._showCheck();
    else this._hideCheck();
  }

  // ── Timer ────────────────────────────────────────────────────────────────────
  _startTimer() {
    clearInterval(this.timerInterval);
    this.timerInterval=setInterval(()=>{
      const c=this.game.currentTurn;
      this.timers[c]=Math.max(0,this.timers[c]-1);
      this._updateTimerDisplay();
      if (this.timers[c]===0) {
        clearInterval(this.timerInterval);
        const winner=c==='white'?'黑方':'白方';
        this.board.revealAllPieces();
        this.board.render('white');
        this._showGameOver(`${winner}获胜！（${c==='white'?'白方':'黑方'}超时）`);
      }
    },1000);
  }

  // ── Move Handling ────────────────────────────────────────────────────────────
  _onMove(fr, fc, tr, tc) {
    const result=this.game.makeMove(fr,fc,tr,tc);
    if (!result) return;
    this.board._repaint();
    this.board.animateLanding(tr,tc);

    if (result.needsPromotion) {
      this._showPromotion(result.record);
      return;
    }
    this._afterMove(result);
  }

  _afterMove(record) {
    if (!record) return;
    this._addToHistory(record);
    this._hideCheck();

    const state=this.game.gameState;

    if (state==='won') {
      clearInterval(this.timerInterval);
      const wName=record.gameOver?.winner==='white'?'白方':'黑方';
      this.board.revealAllPieces();
      this.board.render('white');
      setTimeout(()=>this._showGameOver(`${wName}获胜！（捕获国王！）`),900);
      return;
    }
    if (state==='checkmate') {
      clearInterval(this.timerInterval);
      const wName=this.game.currentTurn==='white'?'黑方':'白方';
      this.board.revealAllPieces();
      this.board.render('white');
      setTimeout(()=>this._showGameOver(`${wName}获胜！（将死）`),900);
      return;
    }
    if (state==='stalemate') {
      clearInterval(this.timerInterval);
      this.board.revealAllPieces();
      this.board.render('white');
      setTimeout(()=>this._showGameOver('平局！（无子可走）'),900);
      return;
    }

    // Normal turn end – show pass screen after brief moment
    setTimeout(()=>this._showPass(),1100);
  }

  // ── Promotion Dialog ─────────────────────────────────────────────────────────
  _showPromotion(record) {
    const color=record.color;
    const choices=document.getElementById('promo-choices');
    choices.innerHTML='';
    const typeNames={Q:'后',R:'车',B:'象',N:'马'};
    ['Q','R','B','N'].forEach(type=>{
      const btn=document.createElement('button');
      btn.className='promo-btn';
      btn.innerHTML=`<span class="promo-symbol">${PIECE_SYMBOLS[color][type]}</span><span class="promo-name">${typeNames[type]}</span>`;
      btn.onclick=()=>{
        this._hide('promo-dialog');
        const rec=this.game.completePromotion(type);
        this.board._repaint();
        this._afterMove(rec);
      };
      choices.appendChild(btn);
    });
    this._show('promo-dialog');
  }

  // ── Undo ─────────────────────────────────────────────────────────────────────
  undo() {
    if (!this.game.undoMove()) return;
    clearInterval(this.timerInterval);
    this._rebuildHistory();
    this.board.render(this.game.currentTurn);
    this._updateTurnIndicator();
    this._updatePlayerBars();
    this._updateTimerDisplay();
    this._startTimer();
    if (this.game.gameState==='check') this._showCheck();
    else this._hideCheck();
  }

  // ── Move History ─────────────────────────────────────────────────────────────
  _addToHistory(record) {
    if (!record?.color) return;
    const notation=this.game.getMoveNotation(record);
    const list=document.getElementById('move-list');

    // Remove previous "latest" marker
    list.querySelectorAll('.latest').forEach(e=>e.classList.remove('latest'));

    if (record.color==='white') {
      const row=document.createElement('div');
      row.className='move-row';
      row.innerHTML=`<span class="move-num">${this.moveNum}.</span><span class="move-cell move-w latest">${notation}</span><span class="move-cell move-b" data-bn="${this.moveNum}"></span>`;
      list.appendChild(row);
    } else {
      const bEl=list.querySelector(`[data-bn="${this.moveNum}"]`);
      if (bEl) { bEl.textContent=notation; bEl.classList.add('latest'); bEl.removeAttribute('data-bn'); }
      this.moveNum++;
    }
    list.scrollTop=list.scrollHeight;
  }

  _rebuildHistory() {
    document.getElementById('move-list').innerHTML='';
    this.moveNum=1;
    this.game.moveHistory.forEach(rec=>this._addToHistory(rec));
  }

  // ── UI Updates ───────────────────────────────────────────────────────────────
  _updateTurnIndicator() {
    const c=this.game.currentTurn;
    const el=document.getElementById('turn-indicator');
    el.textContent=c==='white'?'白方回合':'黑方回合';
    el.className=`turn-indicator ${c}-turn`;
  }

  _updatePlayerBars() {
    const top=this.board.perspective==='white'?'black':'white';
    const bot=this.board.perspective;
    document.getElementById('top-name').textContent=top==='white'?'白方':'黑方';
    document.getElementById('bot-name').textContent=bot==='white'?'白方':'黑方';
    document.getElementById('top-dot').className=`color-dot ${top}`;
    document.getElementById('bot-dot').className=`color-dot ${bot}`;
    const cur=this.game.currentTurn;
    document.getElementById('player-top').classList.toggle('active',cur===top);
    document.getElementById('player-bot').classList.toggle('active',cur===bot);
  }

  _updateTimerDisplay() {
    const fmt=s=>`${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
    const top=this.board.perspective==='white'?'black':'white';
    const bot=this.board.perspective;
    const tTop=document.getElementById('timer-top');
    const tBot=document.getElementById('timer-bot');
    tTop.textContent=fmt(this.timers[top]);
    tBot.textContent=fmt(this.timers[bot]);
    tTop.classList.toggle('warning',this.timers[top]<=60);
    tBot.classList.toggle('warning',this.timers[bot]<=60);
  }

  _showCheck() { document.getElementById('check-indicator').classList.remove('hidden'); }
  _hideCheck() { document.getElementById('check-indicator').classList.add('hidden'); }

  _showGameOver(msg) {
    document.getElementById('gameover-msg').textContent=msg;
    this._show('gameover-dialog');
  }

  _show(id) { document.getElementById(id).classList.remove('hidden'); }
  _hide(id) { document.getElementById(id).classList.add('hidden'); }
}

window.addEventListener('DOMContentLoaded',()=>{ window.app=new ChessApp(); });

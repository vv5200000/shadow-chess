'use strict';

class ChessApp {
  constructor() {
    this.game=new ChessGame();
    this.board=new ChessBoard(this.game);
    this.timers={white:600,black:600};
    this.timerInterval=null;
    this.moveNum=1;
    this.mode={type:'h2h'};                    // {type:'h2h'} | {type:'ai', aiColor:'white'|'black'}
    this.ai=new (window.ShadowAI)(3);
    this._aiToken=0;                           // AI 思考令牌：新局/悔棋时作废未决的 AI 回合
    this.board.onMove=(fr,fc,tr,tc)=>this._onMove(fr,fc,tr,tc);
    this._bindUI();
    this._showModeDialog();
  }

  _bindUI() {
    document.getElementById('btn-new').onclick=()=>{
      if (this.mode.type==='online') { if (confirm('离开房间返回主菜单？')) this._leaveOnline(); return; }
      this._showModeDialog();
    };
    document.getElementById('btn-undo').onclick=()=>this.undo();
    document.getElementById('btn-pass-ready').onclick=()=>this._passReady();
    document.getElementById('btn-gameover-new').onclick=()=>{
      if (this.mode.type==='online') { this._leaveOnline(); return; }
      this._showModeDialog();
    };
    document.getElementById('btn-rules').onclick=()=>this._show('rules-dialog');
    document.getElementById('btn-rules-close').onclick=()=>this._hide('rules-dialog');
    document.getElementById('btn-mode-rules').onclick=()=>this._show('rules-dialog');
    document.getElementById('btn-mode-h2h').onclick=()=>this.newGame({type:'h2h'});
    document.getElementById('btn-mode-ai-w').onclick=()=>this.newGame({type:'ai',aiColor:'black'});
    document.getElementById('btn-mode-ai-b').onclick=()=>this.newGame({type:'ai',aiColor:'white'});
    document.getElementById('btn-mode-online').onclick=()=>this._openOnlineDialog();
    document.getElementById('btn-online-create').onclick=()=>this._createRoom();
    document.getElementById('btn-online-join').onclick=()=>this._joinRoom();
    document.getElementById('online-code-input').addEventListener('keydown',(e)=>{ if (e.key==='Enter') this._joinRoom(); });
    document.getElementById('btn-online-copy').onclick=()=>this._copyRoomCode();
    document.getElementById('btn-online-cancel').onclick=()=>{
      if (this.net&&this.net.room) this._leaveOnline();
      else this._closeOnlineDialog();
    };
    document.getElementById('btn-online-exit').onclick=()=>{ if (confirm('离开房间返回主菜单？')) this._leaveOnline(); };
    window.addEventListener('beforeunload',()=>{ if (this.net&&this.net.room) { try{ this.net.leave(); }catch(e){} } });
  }

  // ── Mode Select Dialog ───────────────────────────────────────────────────────
  _showModeDialog() {
    clearInterval(this.timerInterval);
    this._aiToken++;
    this._hide('gameover-dialog');
    this._hide('promo-dialog');
    this._hide('pass-screen');
    this._hide('ai-thinking');
    this._show('mode-dialog');
  }

  // ── New Game ─────────────────────────────────────────────────────────────────
  newGame(mode) {
    this.mode=mode||{type:'h2h'};
    this.aiColor=this.mode.type==='ai'?this.mode.aiColor:null;
    this.humanColor=this.aiColor==='white'?'black':'white';
    this.game.newGame();
    this.timers={white:600,black:600};
    this.moveNum=1;
    this._aiToken++;
    clearInterval(this.timerInterval);
    document.getElementById('move-list').innerHTML='';
    this._hide('gameover-dialog');
    this._hide('mode-dialog');
    this._hide('promo-dialog');
    this._hide('ai-thinking');
    this._hideCheck();
    this.board.locked=false;
    this.board.getMovesAsync=null;

    if (this.mode.type==='ai') {
      this.board.perspective=this.humanColor;
      this.board.render(this.humanColor);
      this._updateTurnIndicator();
      this._updatePlayerBars();
      this._updateTimerDisplay();
      if (this.aiColor==='white') {
        setTimeout(()=>this._aiTurn(),400);    // AI 先手：开局直接进入 AI 回合
      } else {
        this._startTimer();
      }
    } else {
      this._showPass();
    }
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
        this.board.render(this.board.perspective);
        this._showGameOver(`${winner}获胜！（${c==='white'?'白方':'黑方'}超时）`);
      }
    },1000);
  }

  // ── Move Handling (人类与 AI 共用) ───────────────────────────────────────────
  _onMove(fr, fc, tr, tc, asAI=false) {
    if (this.mode.type==='online') { this._onlineMove(fr,fc,tr,tc); return; }
    const result=this.game.makeMove(fr,fc,tr,tc);
    if (!result) return;
    this.board._repaint();
    this.board.animateLanding(tr,tc);

    if (result.needsPromotion) {
      if (asAI) {
        const rec=this.game.completePromotion('Q');   // AI 升变自动变后
        this.board._repaint();
        this._afterMove(rec);
      } else {
        this._showPromotion(result.record);
      }
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
      this.board.render(this.board.perspective);
      setTimeout(()=>this._showGameOver(`${wName}获胜！（捕获国王！）`),900);
      return;
    }
    if (state==='checkmate') {
      clearInterval(this.timerInterval);
      const wName=this.game.currentTurn==='white'?'黑方':'白方';
      this.board.revealAllPieces();
      this.board.render(this.board.perspective);
      setTimeout(()=>this._showGameOver(`${wName}获胜！（将死）`),900);
      return;
    }
    if (state==='stalemate') {
      clearInterval(this.timerInterval);
      this.board.revealAllPieces();
      this.board.render(this.board.perspective);
      setTimeout(()=>this._showGameOver('平局！（无子可走）'),900);
      return;
    }
    if (state==='draw') {
      clearInterval(this.timerInterval);
      this.board.revealAllPieces();
      this.board.render(this.board.perspective);
      setTimeout(()=>this._showGameOver('和棋！（局面三次重复）'),900);
      return;
    }

    // 正常回合流转
    if (this.mode.type==='ai') {
      this.board.locked=false;
      if (this.game.currentTurn===this.aiColor) this._aiTurn();
      else this._startHumanTurn();
    } else {
      setTimeout(()=>this._showPass(),1100);
    }
  }

  // ── AI 回合 ──────────────────────────────────────────────────────────────────
  _aiTurn() {
    const token=++this._aiToken;
    this.board.locked=true;
    this._updateTurnIndicator();
    this._updatePlayerBars();
    this._updateTimerDisplay();
    if (this.game.gameState==='check') this._showCheck();
    else this._hideCheck();
    this._show('ai-thinking');
    setTimeout(()=>{
      if (token!==this._aiToken) return;       // 已被新局/悔棋作废
      this._hide('ai-thinking');
      this.board.locked=false;
      let mv=null;
      try {
        mv=this.ai.getBestMove(this.game,this.aiColor);
      } catch(e) {
        console.error('AI error:',e);
      }
      if (!mv) return;
      this._onMove(mv.fr,mv.fc,mv.tr,mv.tc,true);
    },600);
  }

  _startHumanTurn() {
    this._hide('ai-thinking');
    this.board.locked=false;
    this._updateTurnIndicator();
    this._updatePlayerBars();
    this._updateTimerDisplay();
    this._startTimer();
    if (this.game.gameState==='check') this._showCheck();
    else this._hideCheck();
  }

  // ── Online ─────────────────────────────────────────────────────────────────
  _createNet() {
    this.net=new OnlineClient({
      base:'',
      onSnapshot:(snap)=>this._applyOnlineSnapshot(snap),
      onTick:(t)=>{ this.timers={white:t.timers.white,black:t.timers.black}; this._updateTimerDisplay(); },
      onOpp:(o)=>this._setOppTag(o.online),
      onConn:(on)=>this._setConnTag(on),
      onError:(code,msg)=>{
        // 会话失效：静默回到大厅（不弹窗，避免阻塞页面）
        if (code==='AUTH_FAILED') { this._leaveOnline(true); return; }
        this._setErr(msg);
      },
    });
  }

  _openOnlineDialog() {
    this.mode={type:'online'};
    this._createNet();
    this._hide('mode-dialog');
    this._show('online-dialog');
    this._showOnlineView('idle');
    this._setErr(null);
    // 页面刷新/断线后回来：若有已存会话，自动恢复（快照到达即进入棋盘）
    if (this.net.loadSession()) this.net.reconnect();
  }

  _closeOnlineDialog() {
    this._hide('online-dialog');
    this._show('mode-dialog');
  }

  _showOnlineView(v) {
    ['idle','waiting'].forEach(k=>{
      const el=document.getElementById('online-view-'+k);
      if (el) el.classList.toggle('hidden',k!==v);
    });
  }

  async _createRoom() {
    this._setBusy(true);
    this._setErr(null);
    try {
      await this.net.create();
      document.getElementById('online-room-code').textContent=this.net.room;
      this._showOnlineView('waiting');
    } catch(e) {
      this._setErr(this._errText(e));
    } finally { this._setBusy(false); }
  }

  async _joinRoom() {
    const code=document.getElementById('online-code-input').value.trim().toUpperCase();
    if (!/^[A-Z0-9]{5}$/.test(code)) { this._setErr('请输入 5 位房间码（字母数字）'); return; }
    this._setBusy(true);
    this._setErr(null);
    try {
      await this.net.join(code);
      // 快照由 SSE 首推，进入对局
    } catch(e) {
      this._setErr(this._errText(e));
    } finally { this._setBusy(false); }
  }

  _setBusy(b) {
    ['btn-online-create','btn-online-join'].forEach(id=>{
      const el=document.getElementById(id);
      if (el) el.disabled=b;
    });
  }

  _setErr(msg) {
    const el=document.getElementById('online-err');
    if (!el) return;
    el.textContent=msg||'';
    el.classList.toggle('hidden',!msg);
  }

  _errText(e) {
    const map={
      ROOM_NOT_FOUND:'房间不存在，请检查房间码',
      ROOM_FULL:'房间已满（已有两位玩家）',
      GAME_OVER:'该房间对局已结束',
      AUTH_FAILED:'会话已失效，请重新建房或加入',
      CONNECTION:'无法连接服务器，请稍后再试',
    };
    const code=(e&&e.code)||'';
    return map[code]||'操作失败（'+code+'）';
  }

  _copyRoomCode() {
    const code=this.net&&this.net.room;
    if (!code) return;
    if (navigator.clipboard) navigator.clipboard.writeText(code).catch(()=>{});
    const btn=document.getElementById('btn-online-copy');
    const old=btn.textContent;
    btn.textContent='✅ 已复制';
    setTimeout(()=>{ btn.textContent=old; },1200);
  }

  _setRoomTag(room) {
    document.getElementById('online-room-tag').textContent='房间 '+room;
  }

  _setOppTag(on) {
    const el=document.getElementById('online-opp-tag');
    el.textContent=on?'对手在线':'对手离线';
    el.className='online-opp-tag '+(on?'on':'off');
  }

  _setConnTag(on) {
    const el=document.getElementById('online-room-tag');
    if (el) el.textContent=(on?'房间 ':'重连中 · 房间 ')+((this.net&&this.net.room)||'');
  }

  _onlineOverState(s) { return ['won','checkmate','stalemate','draw'].includes(s); }

  // 快照 → 渲染（客户端永不持有真实棋盘，一切以服务器为准）
  _applyOnlineSnapshot(snap) {
    if (this.mode.type!=='online') return;
    this._hide('online-dialog');
    this._show('online-meta');
    const undoBtn=document.getElementById('btn-undo');
    if (undoBtn) undoBtn.style.display='none';

    const bd=snap.board;
    this.game={
      board:bd,
      currentTurn:snap.turn,
      gameState:snap.state==='check'?'check':snap.state,
      lastMove:snap.lastMove?{from:{row:snap.lastMove.from[0],col:snap.lastMove.from[1]},to:{row:snap.lastMove.to[0],col:snap.lastMove.to[1]}}:null,
      pendingPromotion:false,
      winnerColor:snap.winner||null,
      getPosRule:(r,c)=>{ const p=bd[r]?.[c]; return (p&&p.own)?(p.pos||null):null; },
      findKing:()=>null,
      getLegalMoves:()=>[],
      getMoveNotation:()=>'',
      moveHistory:[],
    };
    this.board.game=this.game;
    this.board.perspective=snap.you;
    // 走法请求钩子：选子后向服务器要合法走法（客户端无真实棋盘，不可本地计算）
    this.board.getMovesAsync=(r,c)=>this.net.moves([r,c]).then(j=>j.ok?(j.moves||[]):[]);
    this.board.selected=null;
    this.board.legalMoves=[];
    const over=this._onlineOverState(snap.state);
    this.board.locked=over||snap.turn!==snap.you;
    this.timers={white:snap.timers.white,black:snap.timers.black};
    this.board.render(snap.you);
    this._updateTurnIndicator();
    this._updatePlayerBars();
    this._updateTimerDisplay();
    this._renderOnlineHistory(snap.history);
    this._setRoomTag(snap.room);
    this._setOppTag(snap.oppOnline);
    if (snap.state==='check') this._showCheck(); else this._hideCheck();
    if (over) this._onlineGameOver(snap);
  }

  async _onlineMove(fr,fc,tr,tc) {
    try {
      const j=await this.net.move(fr,fc,tr,tc);
      if (j.needsPromotion) { this._showOnlinePromotion(); return; }
      if (!j.ok) this.net.refresh();   // 校验失败（断线期间他方已走子等）：拉快照校准
    } catch(e) {
      this.net.refresh();
    }
  }

  _showOnlinePromotion() {
    const color=(this.net&&this.net.color)||this.board.perspective;
    const choices=document.getElementById('promo-choices');
    choices.innerHTML='';
    const typeNames={Q:'后',R:'车',B:'象',N:'马'};
    ['Q','R','B','N'].forEach(type=>{
      const btn=document.createElement('button');
      btn.className='promo-btn';
      btn.innerHTML=`<span class="promo-symbol">${PIECE_SYMBOLS[color][type]}</span><span class="promo-name">${typeNames[type]}</span>`;
      btn.onclick=async()=>{
        this._hide('promo-dialog');
        try { await this.net.promote(type); } catch(e) { this.net.refresh(); }
      };
      choices.appendChild(btn);
    });
    this._show('promo-dialog');
  }

  _renderOnlineHistory(history) {
    const list=document.getElementById('move-list');
    list.innerHTML='';
    this.moveNum=1;
    (history||[]).forEach((notation,i)=>{
      if (i%2===0) {
        const row=document.createElement('div');
        row.className='move-row';
        row.innerHTML=`<span class="move-num">${this.moveNum}.</span><span class="move-cell move-w">${notation}</span><span class="move-cell move-b" data-bn="${this.moveNum}"></span>`;
        list.appendChild(row);
      } else {
        const bEl=list.querySelector(`[data-bn="${this.moveNum}"]`);
        if (bEl){ bEl.textContent=notation; bEl.removeAttribute('data-bn'); }
        this.moveNum++;
      }
    });
    const cells=list.querySelectorAll('.move-cell');
    if (cells.length) cells[cells.length-1].classList.add('latest');
    list.scrollTop=list.scrollHeight;
  }

  _onlineGameOver(snap) {
    clearInterval(this.timerInterval);
    setTimeout(()=>{
      const w=snap.winner, you=snap.you;
      let msg;
      if (snap.state==='won') msg=w===you?'🎉 你获胜！（捕获国王）':'你输了（对手捕获国王）';
      else if (snap.state==='checkmate') msg=w===you?'🎉 你获胜！（将死）':'你输了（被将死）';
      else if (snap.state==='stalemate') msg='平局！（无子可走）';
      else if (snap.state==='draw') msg='和棋！（局面三次重复）';
      else msg='对局结束';
      this._showGameOver(msg+'  ·  房间 '+snap.room);
    },600);
  }

  _leaveOnline(silent) {
    this.mode={type:'h2h'};
    if (this.net) { try{ this.net.leave(); }catch(e){} this.net=null; }
    this._hide('online-meta');
    this._hide('online-dialog');
    const undoBtn=document.getElementById('btn-undo');
    if (undoBtn) undoBtn.style.display='';
    this.board.getMovesAsync=null;
    this.board.locked=true;
    this._showModeDialog();
  }

  // ── Undo ─────────────────────────────────────────────────────────────────────
  undo() {
    if (this.mode.type==='online') return;
    if (this.mode.type!=='ai') {
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
      return;
    }
    // AI 模式：一次悔棋撤销"最近一步自己走的子"（AI 的应手一并撤销）
    if (this.game.pendingPromotion) this.game.pendingPromotion=null;
    if (!this.game.moveHistory.length) return;
    clearInterval(this.timerInterval);
    this._aiToken++;
    this.game.undoMove();
    if (this.game.currentTurn===this.aiColor && this.game.moveHistory.length) this.game.undoMove();
    this._hide('ai-thinking');
    this.board.locked=false;
    this._rebuildHistory();
    this.board.render(this.humanColor);
    this._updateTurnIndicator();
    this._updatePlayerBars();
    this._updateTimerDisplay();
    if (this.game.gameState==='check') this._showCheck();
    else this._hideCheck();
    if (this.game.currentTurn===this.aiColor) setTimeout(()=>this._aiTurn(),300);
    else this._startTimer();
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
    const txt=this.mode.type==='online'
      ? ((this.net&&c===this.net.color)?'你的回合':'对方回合')
      : (this.mode.type==='ai'
        ? (c===this.aiColor?'AI 回合':'你的回合')
        : (c==='white'?'白方回合':'黑方回合'));
    el.textContent=txt;
    el.className=`turn-indicator ${c}-turn`;
  }

  _updatePlayerBars() {
    const top=this.board.perspective==='white'?'black':'white';
    const bot=this.board.perspective;
    const nameOf=(col)=>this.mode.type==='online'
      ? ((this.net&&col===this.net.color)?'你':'对手')
      : (col==='white'?'白方':'黑方');
    document.getElementById('top-name').textContent=nameOf(top);
    document.getElementById('bot-name').textContent=nameOf(bot);
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
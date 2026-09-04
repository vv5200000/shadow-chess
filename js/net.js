'use strict';
/* ═══════════════════════════════════════════════════════════════════════
 * 暗影象棋 · 联机客户端 (P0)
 * 传输：SSE（服务器推送）+ fetch POST（客户端上行）。
 *       EventSource 自带自动重连 —— 手机锁屏断线后回来自动恢复。
 * 身份：token 由服务器签发，localStorage 持久化；房间失效自动清空。
 * 反作弊：客户端永远不持有真实棋盘，一切状态由服务器快照驱动。
 * ═══════════════════════════════════════════════════════════════════════ */
class OnlineClient {
  constructor(opts = {}) {
    this.base = opts.base || '';                 // 同源部署为空串
    this.onSnapshot = opts.onSnapshot || null;   // (snap) => {}  完整视角快照
    this.onTick = opts.onTick || null;           // ({w,b}) => {} 计时器权威值
    this.onOpp = opts.onOpp || null;             // ({online}) => {} 对手在线状态
    this.onConn = opts.onConn || null;           // (online:bool) => {} SSE 通断
    this.onError = opts.onError || null;         // (code, msg) => {}
    this.room = null;
    this.token = null;
    this.color = null;                           // 'white' | 'black'
    this.es = null;
    this.oppOnline = false;
  }

  static _key() { return 'shadowchess-online'; }

  saveSession() {
    try {
      localStorage.setItem(OnlineClient._key(), JSON.stringify({ room: this.room, token: this.token, color: this.color }));
    } catch (e) { /* 隐私模式等 */ }
  }

  loadSession() {
    try {
      const s = JSON.parse(localStorage.getItem(OnlineClient._key()));
      if (s && s.room && s.token && (s.color === 'white' || s.color === 'black')) return s;
    } catch (e) {}
    return null;
  }

  clearSession() {
    try { localStorage.removeItem(OnlineClient._key()); } catch (e) {}
  }

  // ── HTTP 上行 ─────────────────────────────────────────────────────────
  async post(a, extra = {}) {
    const body = Object.assign({ a, room: this.room, token: this.token }, extra);
    let res;
    try {
      res = await fetch(this.base + '/api', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (e) {
      throw { code: 'CONNECTION', msg: '无法连接服务器' };
    }
    let j;
    try { j = await res.json(); } catch (e) { throw { code: 'CONNECTION', msg: '服务器响应异常' }; }
    if (!j.ok && j.error === 'AUTH_FAILED') {
      // token 失效（服务器重启等）：会话作废，静默回大厅
      this.clearSession();
      this.onError?.('AUTH_FAILED', '会话已失效，请重新建房/加入');
    }
    return j;
  }

  // ── 建房 / 加入 / 重连 ────────────────────────────────────────────────
  async create() {
    const j = await this.post('create', { room: undefined, token: undefined });
    return this._adopt(j, 'create');
  }

  async join(roomCode) {
    const j = await this.post('join', { room: String(roomCode).toUpperCase(), token: undefined });
    return this._adopt(j, 'join');
  }

  _adopt(j, act) {
    if (!j.ok) throw { code: j.error || act.toUpperCase() + '_FAILED', msg: j.msg || j.error };
    this.room = j.room;
    this.token = j.token;
    this.color = j.color;
    this.saveSession();
    this._openSSE();
    return j;
  }

  // 断线/刷新后恢复：直接用已存会话重新建 SSE（首推快照即完整恢复）
  async reconnect() {
    const s = this.loadSession();
    if (!s) return false;
    this.room = s.room;
    this.token = s.token;
    this.color = s.color;
    this._openSSE();
    return true;
  }

  // ── 对局操作 ──────────────────────────────────────────────────────────
  async moves(from) { return this.post('moves', { from }); }
  async move(from, to) { return this.post('move', { from, to }); }
  async promote(type) { return this.post('promote', { type }); }

  async leave() {
    try { await this.post('leave'); } catch (e) {}
    this.halt();
    this.clearSession();
  }

  halt() {
    if (this.es) { this.es.close(); this.es = null; }
  }

  // 对局进行中发生校验失败/断线：重连 SSE 拉一次权威快照校准界面
  refresh() { this._openSSE(); }

  // ── SSE 下行 ──────────────────────────────────────────────────────────
  _openSSE() {
    if (this.es) this.es.close();
    const qs = '?room=' + encodeURIComponent(this.room) + '&token=' + encodeURIComponent(this.token);
    this.es = new EventSource(this.base + '/api/events' + qs);

    this.es.onopen = () => {
      this.oppOnline = false;
      this.onConn?.(true);
    };

    this.es.onerror = () => {
      if (!this.es || this.es.readyState === EventSource.CLOSED) {
        // 服务器主动关闭（403 房间失效 / 404）：不会自动重连
        this.onConn?.(false);
        this.onError?.('AUTH_FAILED', '连接已关闭（房间可能已失效）');
      } else {
        // 网络抖动：EventSource 自动重连，恢复后首推快照校准一切状态
        this.onConn?.(false);
      }
    };

    this.es.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      switch (m.type) {
        case 'snapshot':
          this.oppOnline = !!m.oppOnline;
          this.onSnapshot?.(m);
          break;
        case 'tick':
          this.onTick?.(m);
          break;
        case 'opp':
          this.oppOnline = !!m.online;
          this.onOpp?.(m);
          break;
      }
    };
  }
}

if (typeof module !== 'undefined' && module.exports) module.exports = { OnlineClient };
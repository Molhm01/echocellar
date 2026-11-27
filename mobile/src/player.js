'use strict';
// Player: one <audio> element, spec-exact queue/shuffle behavior via the
// shared QueueState, and session recording that counts only audible time.

const { QueueState } = require('../../src/lib/queue');

const audio = () => document.getElementById('ec-audio');

const Player = {
  queue: new QueueState(),
  current: null,          // track row
  session: null,          // {session_id, track_id, played_at, ms_listened, duration_ms}
  _lastTick: null,
  _listeners: [],

  onChange(cb) { this._listeners.push(cb); },
  _emit() { this._listeners.forEach((cb) => { try { cb(); } catch (e) { console.error(e); } }); },

  init() {
    const a = audio();
    a.addEventListener('timeupdate', () => this._tick(false));
    a.addEventListener('seeked', () => { this._lastTick = null; });
    a.addEventListener('ended', () => this._onEnded());
    a.addEventListener('play', () => this._emit());
    a.addEventListener('pause', () => this._emit());
    this._restore();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) this._closeSession(false);
    });
  },

  // Accumulate audible listening time; seeks reset the baseline so jumped
  // regions never count.
  _tick() {
    const a = audio();
    if (!this.session || a.paused) { this._lastTick = null; return; }
    const now = a.currentTime * 1000;
    if (this._lastTick != null) {
      const delta = now - this._lastTick;
      if (delta > 0 && delta < 1500) this.session.ms_listened += delta;
    }
    this._lastTick = now;
    this.session.duration_ms = a.duration && isFinite(a.duration) ? Math.round(a.duration * 1000) : this.session.duration_ms;
  },

  _openSession(trackId) {
    this.session = {
      session_id: 'm-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
      track_id: trackId,
      played_at: Date.now(),
      ms_listened: 0,
      duration_ms: this.current && this.current.duration_ms || null,
    };
    this._lastTick = null;
  },

  _closeSession(userEnded) {
    if (!this.session) return;
    this._tick();
    const s = this.session;
    this.session = null;
    if (s.ms_listened < 500 && !userEnded) return; // ignore accidental blips
    try {
      window.ec.recordSession({
        session_id: s.session_id, track_id: s.track_id, played_at: s.played_at,
        ms_listened: Math.round(s.ms_listened), duration_ms: s.duration_ms, user_ended: userEnded,
      });
    } catch (e) { console.error('recordSession failed', e); }
  },

  async playQueue(trackIds, startIndex = 0) {
    this.queue.setQueue(trackIds, startIndex);
    this._persist();
    await this._playCurrent();
  },

  async _playCurrent() {
    const id = this.queue.currentId();
    if (id == null) { this._stop(); return; }
    const src = await window.ec.playSrc(id);
    if (src.error) {
      // Skip unplayable entries transparently (e.g. ALAC on Android).
      const nid = this.queue.next();
      if (nid == null) { this._stop(); return; }
      this._persist();
      return this._playCurrent();
    }
    this._closeSession(true);
    this.current = src.track;
    const a = audio();
    a.src = src.url;
    try { await a.play(); } catch (e) { console.error('play() failed', e); }
    this._openSession(id);
    this._mediaSession(src.track);
    this._emit();
  },

  _mediaSession(t) {
    if (!('mediaSession' in navigator) || !t) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: t.title || '', artist: t.artist || '', album: t.album || '',
      });
      navigator.mediaSession.setActionHandler('play', () => this.toggle());
      navigator.mediaSession.setActionHandler('pause', () => this.toggle());
      navigator.mediaSession.setActionHandler('previoustrack', () => this.previous());
      navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
    } catch (e) { /* older webviews */ }
  },

  async next() {
    const id = this.queue.next();
    this._persist();
    if (id == null) { this._closeSession(true); this._stop(); return; }
    await this._playCurrent();
  },

  async previous() {
    // Under 3s in: retrace what was actually heard; else restart the song.
    const a = audio();
    if (a.currentTime > 3) { a.currentTime = 0; return; }
    const id = this.queue.previous();
    this._persist();
    if (id == null) { a.currentTime = 0; return; }
    await this._playCurrent();
  },

  _onEnded() {
    this._closeSession(false);
    this.next();
  },

  toggle() {
    const a = audio();
    if (!a.src && this.queue.currentId() != null) { this._playCurrent(); return; }
    if (a.paused) a.play(); else a.pause();
  },

  setShuffle(on) { this.queue.setShuffle(on); this._persist(); this._emit(); },
  cycleRepeat() {
    this.queue.repeat = this.queue.repeat === 'off' ? 'all' : this.queue.repeat === 'all' ? 'one' : 'off';
    this._persist(); this._emit();
  },

  _stop() {
    const a = audio();
    a.removeAttribute('src');
    a.load();
    this.current = null;
    this._emit();
  },

  _persist() {
    try {
      const q = this.queue;
      localStorage.setItem('ec.queue', JSON.stringify({
        trackIds: q.trackIds, index: q.index, shuffle: q.shuffle, repeat: q.repeat,
        shuffleOrder: q.shuffleOrder, shuffleCursor: q.shuffleCursor,
        backStack: q.backStack, played: Array.from(q.playedThisCycle || []),
        currentTime: audio().currentTime || 0,
      }));
    } catch (e) { /* storage full: queue restore is best-effort */ }
  },

  _restore() {
    try {
      const raw = localStorage.getItem('ec.queue');
      if (!raw) return;
      const s = JSON.parse(raw);
      if (!s.trackIds || !s.trackIds.length) return;
      const q = this.queue;
      q.trackIds = s.trackIds; q.index = s.index; q.shuffle = !!s.shuffle;
      q.repeat = s.repeat || 'off'; q.shuffleOrder = s.shuffleOrder || [];
      q.shuffleCursor = s.shuffleCursor || 0; q.backStack = s.backStack || [];
      q.playedThisCycle = new Set(s.played || []);
      const t = window.ec.track(q.currentId());
      if (t) {
        this.current = t;
        window.ec.playSrc(t.id).then((src) => {
          if (!src.error) {
            const a = audio();
            a.src = src.url; // restored paused; user presses play
            a.currentTime = Math.min(s.currentTime || 0, (t.duration_ms || 0) / 1000 - 1);
            this._openSession(t.id);
            this._emit();
          }
        });
      }
    } catch (e) { console.error('queue restore failed', e); }
  },
};

module.exports = Player;

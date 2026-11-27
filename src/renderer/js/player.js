'use strict';
// Playback engine: audio/video elements, session accounting, persistence.
//
// Listening time accrues only while audio is actually audible: the deltas
// between timeupdate events while not paused and not seeking. Pauses and
// seek-jumps never count. Audio<->video switches reuse the same session, so
// one sitting = one history entry.

(function () {
  const audio = document.getElementById('audio-el');
  const video = document.getElementById('stage-video');

  const Player = {
    queue: new window.QueueState(),
    currentTrack: null,
    mode: 'audio', // 'audio' | 'video'
    session: null,
    lyrics: null,
    onTrackChange: null,
    onSessionFlush: null,

    el() { return this.mode === 'video' ? video : audio; },

    async playQueue(trackIds, startIndex, opts) {
      this.queue.setQueue(trackIds, startIndex || 0);
      if (opts && typeof opts.shuffle === 'boolean') this.queue.setShuffle(opts.shuffle);
      await this._startCurrent();
    },

    async _startCurrent() {
      const id = this.queue.currentId();
      if (id == null) { this._flushSession(false); this.currentTrack = null; this._updateBar(); return; }
      this._flushSession(false);
      this.currentTrack = await window.ec.track(id);
      this.session = {
        id: 's-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8),
        trackId: id,
        startedAt: Date.now(),
        listenedMs: 0,
        lastTick: null,
        seeking: false,
        mode: this.currentTrack.video_path && this.mode === 'video' ? 'video' : 'audio',
      };
      this.lyrics = null;
      this._attachEl(this.session.mode);
      this.el().currentTime = 0;
      try { await this.el().play(); } catch (e) { console.warn('play failed', e); }
      this._updateBar();
      if (this.onTrackChange) this.onTrackChange(this.currentTrack);
    },

    _attachEl(mode) {
      this.mode = mode;
      const track = this.currentTrack;
      if (mode === 'video' && track.video_path) {
        audio.pause();
        video.src = `media://video/${track.id}`;
        video.classList.remove('hidden');
        document.getElementById('stage').classList.remove('hidden');
      } else {
        video.pause();
        if (!audio.src.includes(`media://track/${track.id}`)) audio.src = `media://track/${track.id}`;
      }
    },

    async toggleAV() {
      if (!this.currentTrack || !this.session) return;
      // Refresh from the database: a video may have been attached after this
      // track started playing.
      this.currentTrack = await window.ec.track(this.currentTrack.id);
      if (!this.currentTrack || !this.currentTrack.video_path) return;
      const from = this.el();
      const position = from.currentTime;
      const newMode = this.mode === 'audio' ? 'video' : 'audio';
      this.session.mode = newMode; // same session: one history entry
      this._attachEl(newMode);
      const to = this.el();
      const offsetSec = (this.currentTrack.video_offset_ms || 0) / 1000;
      await new Promise((resolve) => {
        const onMeta = () => { to.removeEventListener('loadedmetadata', onMeta); resolve(); };
        to.addEventListener('loadedmetadata', onMeta);
        if (to.readyState >= 1) resolve();
      });
      // Keep the playback position across the switch; the manual video offset
      // covers videos whose timeline has an intro the audio does not.
      to.currentTime = newMode === 'video'
        ? Math.max(0, position + offsetSec)
        : Math.max(0, position - offsetSec);
      this.session.lastTick = null;
      try { await to.play(); } catch { /* user gesture may be required */ }
      this._updateBar();
    },

    togglePlay() {
      const el = this.el();
      if (!this.currentTrack) return;
      if (el.paused) el.play(); else el.pause();
      this._updateBar();
    },

    next(userInitiated = true) {
      this._flushSession(userInitiated);
      const id = this.queue.next();
      if (id == null) { this.currentTrack = null; this._updateBar(); this._saveState(); return; }
      this._startCurrent();
    },

    previous() {
      const el = this.el();
      // Standard behavior: restart the song when already a few seconds in.
      if (el.currentTime > 3) { el.currentTime = 0; return; }
      this._flushSession(true);
      this.queue.previous();
      this._startCurrent();
    },

    jumpTo(index) {
      this._flushSession(true);
      this.queue.jumpTo(index);
      this._startCurrent();
    },

    setShuffle(on) { this.queue.setShuffle(on); this._updateBar(); this._saveState(); },
    cycleRepeat() {
      const order = ['off', 'all', 'one'];
      this.queue.repeat = order[(order.indexOf(this.queue.repeat) + 1) % order.length];
      this._updateBar();
      this._saveState();
    },

    seekTo(fraction) {
      const el = this.el();
      if (el.duration) el.currentTime = fraction * el.duration;
    },

    _flushSession(userEnded) {
      const s = this.session;
      if (!s) return;
      this._tick(); // capture any trailing listening time
      if (s.listenedMs < 300) { this.session = null; return; } // too short to record
      const rec = {
        session_id: s.id,
        track_id: s.trackId,
        played_at: s.startedAt,
        ms_listened: Math.round(s.listenedMs),
        duration_ms: this.currentTrack ? this.currentTrack.duration_ms : null,
        user_ended: !!userEnded,
        mode: s.mode,
      };
      this.session = null;
      window.ec.recordSession(rec).then((r) => {
        if (Player.onSessionFlush) Player.onSessionFlush(r);
      });
    },

    _tick() {
      const s = this.session;
      if (!s) return;
      const el = this.el();
      const now = performance.now();
      if (s.lastTick != null && !el.paused && !s.seeking && el.readyState > 2) {
        s.listenedMs += Math.min(now - s.lastTick, 2000);
      }
      s.lastTick = now;
    },

    async loadLyrics() {
      if (!this.currentTrack) return null;
      this.lyrics = await window.ec.lyrics(this.currentTrack.id);
      return this.lyrics;
    },

    async restore() {
      const state = await window.ec.restorePlaybackState();
      if (!state || !state.queue || !state.queue.trackIds.length) return;
      this.queue = window.QueueState.restore(state.queue);
      const id = this.queue.currentId();
      if (id == null) return;
      this.currentTrack = await window.ec.track(id);
      this.session = null; // no new session until the user presses play
      audio.src = `media://track/${id}`;
      await new Promise((resolve) => {
        const onMeta = () => { audio.removeEventListener('loadedmetadata', onMeta); resolve(); };
        audio.addEventListener('loadedmetadata', onMeta);
        if (audio.readyState >= 1) resolve();
        setTimeout(resolve, 3000);
      });
      if (state.positionSec && audio.duration) {
        audio.currentTime = Math.min(state.positionSec, Math.max(0, audio.duration - 1));
      }
      this._updateBar();
      if (this.onTrackChange) this.onTrackChange(this.currentTrack);
    },

    _saveState() {
      const el = this.el();
      window.ec.savePlaybackState({
        queue: this.queue.serialize(),
        positionSec: el && el.currentTime ? el.currentTime : 0,
      });
    },

    _updateBar() {
      const t = this.currentTrack;
      document.getElementById('np-title').textContent = t ? t.title : 'Nothing playing';
      document.getElementById('np-artist').textContent = t ? t.artist : '';
      document.getElementById('np-codec').textContent = t
        ? [t.codec, t.sample_rate ? (t.sample_rate / 1000) + ' kHz' : null, t.bit_depth ? t.bit_depth + '-bit' : null]
            .filter(Boolean).join(' · ')
        : '';
      document.getElementById('np-art').src = t && t.art_path ? `media://art/${t.id}` : '../assets/logo.svg';
      document.getElementById('btn-shuffle').classList.toggle('active', this.queue.shuffle);
      document.getElementById('btn-repeat').classList.toggle('active', this.queue.repeat !== 'off');
      document.getElementById('btn-repeat').innerHTML = this.queue.repeat === 'one' ? '&#128258;' : '&#128257;';
      document.getElementById('btn-play').innerHTML = this.el().paused ? '&#9654;' : '&#10073;&#10073;';
      const av = document.getElementById('btn-av');
      av.classList.toggle('hidden', !(t && t.video_path));
      av.textContent = this.mode === 'video' ? 'Audio' : 'Video';
    },
  };

  // Tick + progress wiring
  for (const el of [audio, video]) {
    el.addEventListener('timeupdate', () => {
      Player._tick();
      const cur = Player.el();
      if (cur.duration && cur === el) {
        document.getElementById('np-elapsed').textContent = fmt(cur.currentTime);
        document.getElementById('np-duration').textContent = fmt(cur.duration);
        const slider = document.getElementById('np-progress');
        if (!slider.matches(':active')) slider.value = Math.round((cur.currentTime / cur.duration) * 1000);
      }
      if (window.onLyricTick) window.onLyricTick(cur.currentTime * 1000);
    });
    el.addEventListener('seeking', () => { if (Player.session) Player.session.seeking = true; });
    el.addEventListener('seeked', () => {
      if (Player.session) { Player.session.seeking = false; Player.session.lastTick = null; }
    });
    el.addEventListener('ended', () => Player.next(false));
    el.addEventListener('play', () => Player._updateBar());
    el.addEventListener('pause', () => Player._updateBar());
  }

  function fmt(sec) {
    const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  setInterval(() => { if (Player.currentTrack) Player._saveState(); }, 5000);
  window.addEventListener('beforeunload', () => Player._saveState());

  window.Player = Player;
  window.fmtTime = fmt;
})();

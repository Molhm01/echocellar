'use strict';
// Renderer copy of the queue/shuffle state machine (mirrors src/lib/queue.js).
(function () {
  function shuffled(indices) {
    const arr = indices.slice();
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  class QueueState {
    constructor() {
      this.trackIds = [];
      this.index = -1;
      this.shuffle = false;
      this.repeat = 'off';
      this.shuffleOrder = [];
      this.shuffleCursor = 0;
      this.backStack = [];
      this.playedThisCycle = new Set();
    }
    setQueue(trackIds, startIndex = 0) {
      this.trackIds = trackIds.slice();
      this.index = startIndex;
      this.backStack = [];
      if (this.shuffle) this._buildShuffleOrder(startIndex);
    }
    currentId() {
      return this.index >= 0 && this.index < this.trackIds.length ? this.trackIds[this.index] : null;
    }
    setShuffle(on) {
      this.shuffle = on;
      if (on) this._buildShuffleOrder(this.index);
      else this.shuffleOrder = [];
    }
    _buildShuffleOrder(fromIndex) {
      const positions = this.trackIds.map((_, i) => i);
      const rest = positions.filter((i) => i !== fromIndex);
      const order = shuffled(rest);
      this.shuffleOrder = fromIndex >= 0 ? [fromIndex, ...order] : order;
      this.shuffleCursor = 0;
      this.playedThisCycle = new Set(fromIndex >= 0 ? [this.trackIds[fromIndex]] : []);
    }
    next() {
      if (this.repeat === 'one') return this.currentId();
      const cur = this.currentId();
      if (cur != null) this.backStack.push(cur);
      if (this.shuffle) {
        if (cur != null) this.playedThisCycle.add(cur);
        if (this.playedThisCycle.size >= this.trackIds.length) {
          this._buildShuffleOrder(-1);
          this.playedThisCycle = new Set();
        }
        this.shuffleCursor += 1;
        if (this.shuffleCursor >= this.shuffleOrder.length) {
          if (this.repeat === 'all') { this._buildShuffleOrder(-1); this.shuffleCursor = 0; }
          else return null;
        }
        let guard = 0;
        while (guard++ < this.shuffleOrder.length) {
          const pos = this.shuffleOrder[this.shuffleCursor % this.shuffleOrder.length];
          const id = this.trackIds[pos];
          if (id != null && !this.playedThisCycle.has(id)) {
            this.index = pos;
            return id;
          }
          this.shuffleCursor += 1;
          if (this.shuffleCursor >= this.shuffleOrder.length) {
            if (this.repeat === 'all') { this._buildShuffleOrder(-1); this.shuffleCursor = 0; }
            else return null;
          }
        }
        return null;
      }
      if (this.index + 1 < this.trackIds.length) { this.index += 1; return this.currentId(); }
      if (this.repeat === 'all') { this.index = 0; return this.currentId(); }
      return null;
    }
    previous() {
      const last = this.backStack.pop();
      if (last == null) return this.currentId();
      const pos = this.trackIds.indexOf(last);
      if (pos >= 0) this.index = pos;
      if (this.shuffle) {
        const sPos = this.shuffleOrder.indexOf(pos);
        if (sPos >= 0) this.shuffleCursor = sPos;
      }
      return last;
    }
    jumpTo(index) {
      if (index < 0 || index >= this.trackIds.length) return null;
      const cur = this.currentId();
      if (cur != null) this.backStack.push(cur);
      this.index = index;
      if (this.shuffle) this._buildShuffleOrder(index);
      return this.currentId();
    }
    removeAt(index) {
      const [removed] = this.trackIds.splice(index, 1);
      if (index < this.index) this.index -= 1;
      if (this.shuffle) this._buildShuffleOrder(this.index);
      return removed;
    }
    move(from, to) {
      if (from === to || from < 0 || to < 0 || from >= this.trackIds.length || to >= this.trackIds.length) return;
      const [item] = this.trackIds.splice(from, 1);
      this.trackIds.splice(to, 0, item);
      if (this.index === from) this.index = to;
      else if (from < this.index && to >= this.index) this.index -= 1;
      else if (from > this.index && to <= this.index) this.index += 1;
      if (this.shuffle) this._buildShuffleOrder(this.index);
    }
    serialize() {
      return {
        trackIds: this.trackIds, index: this.index, shuffle: this.shuffle,
        repeat: this.repeat, shuffleOrder: this.shuffleOrder, shuffleCursor: this.shuffleCursor,
        backStack: this.backStack, playedThisCycle: [...this.playedThisCycle],
      };
    }
    static restore(data) {
      const q = new QueueState();
      if (!data) return q;
      q.trackIds = data.trackIds || [];
      q.index = data.index ?? -1;
      q.shuffle = !!data.shuffle;
      q.repeat = data.repeat || 'off';
      q.shuffleOrder = data.shuffleOrder || [];
      q.shuffleCursor = data.shuffleCursor || 0;
      q.backStack = data.backStack || [];
      q.playedThisCycle = new Set(data.playedThisCycle || []);
      return q;
    }
  }
  window.QueueState = QueueState;
})();

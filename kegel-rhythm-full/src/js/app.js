/* ==========================================================================
   提肛节拍 · 应用层
   依赖：core.js（纯逻辑） → window.KRCore
   ========================================================================== */
(function () {
  'use strict';

  const C = window.KRCore;
  const $ = (sel, el) => (el || document).querySelector(sel);
  const $$ = (sel, el) => Array.from((el || document).querySelectorAll(sel));
  const pad2 = C.pad2;

  /* ---------------------------------------------------------------- 存储 */
  const KEY = 'kegel-rhythm.v1';

  const DEFAULTS = {
    version: 1,
    rhythm: { contract: 5, relax: 5, reps: 10, sets: 3, setRest: 45, prep: 5, smooth: 1, preset: 'standard' },
    windows: [
      { id: 'w1', label: '早间', enabled: true, start: '08:00', end: '10:00', interval: 30 },
      { id: 'w2', label: '午间', enabled: true, start: '12:30', end: '14:00', interval: 45 },
      { id: 'w3', label: '晚间', enabled: true, start: '19:00', end: '22:00', interval: 60 }
    ],
    prefs: {
      sound: true,
      voice: false,
      vibrate: true,
      notify: false,
      goalSets: 3,
      onboarded: false,
      snoozeMin: 10
    },
    sessions: []
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }

  function load() {
    let raw = null;
    try { raw = localStorage.getItem(KEY); } catch (e) { /* 隐私模式 */ }
    if (!raw) return clone(DEFAULTS);
    try {
      const data = JSON.parse(raw);
      const merged = Object.assign(clone(DEFAULTS), data);
      merged.rhythm = Object.assign(clone(DEFAULTS.rhythm), data.rhythm || {});
      merged.prefs = Object.assign(clone(DEFAULTS.prefs), data.prefs || {});
      merged.windows = (Array.isArray(data.windows) && data.windows.length ? data.windows : clone(DEFAULTS.windows))
        .map((w, i) => C.normWindow(w, i));
      merged.sessions = (Array.isArray(data.sessions) ? data.sessions : []).filter((s) => s && s.at).slice(-800);
      return merged;
    } catch (e) {
      return clone(DEFAULTS);
    }
  }

  let state = load();
  let saveTimer = null;
  function save(now) {
    clearTimeout(saveTimer);
    const write = () => {
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* 忽略配额错误 */ }
    };
    if (now) write(); else saveTimer = setTimeout(write, 180);
  }

  const rhythm = () => C.normRhythm(state.rhythm);
  const todayKey = () => C.dayKey(Date.now());

  /* ---------------------------------------------------------------- 声音 / 震动 */
  const Sound = {
    ctx: null,
    unlocked: false,
    ensure() {
      if (!this.ctx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return null;
        try { this.ctx = new AC(); } catch (e) { return null; }
      }
      if (this.ctx.state === 'suspended') this.ctx.resume().catch(() => {});
      return this.ctx;
    },
    unlock() {
      const ctx = this.ensure();
      if (!ctx) return;
      if (!this.unlocked) {
        // iOS/Safari：用一次极短的静音抖动解锁音频通道
        try {
          const o = ctx.createOscillator();
          const g = ctx.createGain();
          g.gain.value = 0.0001;
          o.connect(g); g.connect(ctx.destination);
          o.start(); o.stop(ctx.currentTime + 0.02);
        } catch (e) { /* noop */ }
        this.unlocked = true;
      }
    },
    tone(freq, dur, opts) {
      const o = opts || {};
      if (!state.prefs.sound) return;
      const ctx = this.ensure();
      if (!ctx) return;
      const t0 = ctx.currentTime + (o.delay || 0);
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(freq, t0);
      if (o.to) osc.frequency.exponentialRampToValueAtTime(o.to, t0 + dur);
      const vol = (o.gain == null ? 0.18 : o.gain);
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
      osc.connect(gain); gain.connect(ctx.destination);
      osc.start(t0); osc.stop(t0 + dur + 0.05);
    },
    contract() { this.tone(523.25, 0.16, { gain: 0.16 }); this.tone(783.99, 0.22, { delay: 0.14, gain: 0.14 }); },
    relax() { this.tone(392, 0.3, { gain: 0.12, to: 330 }); },
    rest() { this.tone(261.63, 0.4, { gain: 0.1 }); },
    tick() { this.tone(880, 0.05, { gain: 0.05, type: 'triangle' }); },
    done() { [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => this.tone(f, 0.35, { delay: i * 0.12, gain: 0.13 })); },
    reminder() {
      this.tone(880, 0.5, { gain: 0.13, type: 'sine' });
      this.tone(1174.66, 0.6, { delay: 0.28, gain: 0.11 });
    },
    speak(text) {
      if (!state.prefs.voice || !('speechSynthesis' in window)) return;
      try {
        const u = new SpeechSynthesisUtterance(text);
        u.lang = 'zh-CN';
        u.rate = 1.02;
        u.pitch = 1;
        u.volume = 0.9;
        window.speechSynthesis.cancel();
        window.speechSynthesis.speak(u);
      } catch (e) { /* noop */ }
    },
    stopSpeech() {
      try { if ('speechSynthesis' in window) window.speechSynthesis.cancel(); } catch (e) { /* noop */ }
    }
  };

  function vibrate(pattern) {
    if (!state.prefs.vibrate) return;
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) { /* noop */ }
  }

  /* ---------------------------------------------------------------- 提醒调度 */
  const Reminder = {
    skipUntil: 0,
    pending: null,
    dueAt: 0,

    activeWindows() { return state.windows.filter((w) => w.enabled); },

    next(fromTs) {
      const t = Math.max(fromTs || Date.now(), this.skipUntil);
      const base = C.nextOccurrence(this.activeWindows(), t);
      // 「稍后提醒」优先：即使不在时段内也按约定时间再响一次
      if (this.pending && this.pending.at > Date.now() - 1000) {
        if (!base || this.pending.at <= base.at) return { at: this.pending.at, window: this.pending.window, snoozed: true };
      }
      return base;
    },

    refresh() {
      const nxt = this.next(Date.now());
      this.dueAt = nxt ? nxt.at : 0;
      return nxt;
    },

    snooze(minutes) {
      const nxt = this.next(Date.now());
      this.skipUntil = Date.now() + minutes * 60000;
      this.pending = { at: this.skipUntil, window: nxt ? nxt.window : null };
      this.hideToast();
      this.refresh();
      renderIfVisible();
    },

    /** 秒级检查：到点就提示。同时处理「标签页后台被节流」的补发。 */
    check() {
      if (!this.dueAt) { this.refresh(); return; }
      const now = Date.now();
      if (now < this.dueAt) return;
      // 超过 10 分钟才回来，不补提醒，避免开机后一串弹窗
      const overdue = now - this.dueAt;
      this.pending = null;
      this.skipUntil = now + 60000; // 防止同一分钟内重复
      this.dueAt = 0;
      this.refresh();
      if (overdue > 10 * 60000) return;
      this.fire();
    },

    /* 仅预览：不改提醒计划 */
    preview() {
      this.fire();
      clearTimeout(this.toastTimeout);
      this.toastTimeout = setTimeout(() => this.hideToast(), 12000);
    },

    fire() {
      const r = rhythm();
      $('#toastTitle').textContent = '该做一组提肛练习了';
      $('#toastText').textContent = `跟着节拍：收缩 ${r.contract} 秒 / 放松 ${r.relax} 秒，${r.reps} 次一组。`;
      $('#toast').hidden = false;
      Sound.reminder();
      vibrate([120, 80, 120]);
      if (state.prefs.voice) Sound.speak('该做提肛练习了，跟着节拍做一组');
      if (state.prefs.notify && 'Notification' in window && Notification.permission === 'granted') {
        try {
          const n = new Notification('提肛节拍', {
            body: `收缩 ${r.contract} 秒、放松 ${r.relax} 秒，做 ${r.reps} 次。点按开始引导。`,
            tag: 'kegel-reminder',
            icon: './icons/icon-192.png',
            silent: true,
            requireInteraction: false
          });
          n.onclick = () => { window.focus(); this.hideToast(); startSession(); n.close(); };
        } catch (e) { /* 部分浏览器禁止页面直接实例化 */ }
      }
      this.toastTimeout = setTimeout(() => this.hideToast(), 25000);
      renderIfVisible();
      if (navigator.setAppBadge) { try { navigator.setAppBadge(1); } catch (e) { /* noop */ } }
    },

    hideToast() {
      clearTimeout(this.toastTimeout);
      $('#toast').hidden = true;
      if (navigator.clearAppBadge) { try { navigator.clearAppBadge(); } catch (e) { /* noop */ } }
    }
  };

  /* ---------------------------------------------------------------- 练习会话 */
  const Session = {
    phases: [],
    total: 0,
    elapsed: 0,
    running: false,
    paused: false,
    raf: 0,
    lastTick: 0,
    phaseIdx: -1,
    startAt: 0,
    wakeLock: null,
    repsDone: 0,

    get active() { return this.phases.length > 0; },

    start() {
      const r = rhythm();
      this.phases = C.buildPhases(r);
      this.total = this.phases.length ? this.phases[this.phases.length - 1].end : 0;
      this.elapsed = 0;
      this.phaseIdx = -1;
      this.repsDone = 0;
      this.repsStarted = 0;
      this.startAt = Date.now();
      this.paused = false;
      this.running = true;
      this.lastTick = performance.now();
      Sound.unlock();
      vibrate(30);
      const g = $('#guide');
      g.hidden = false;
      g.classList.remove('is-paused');
      g.dataset.phase = 'prep';
      document.body.classList.add('is-guiding');
      $('#btnPause').textContent = '暂停';
      $('#repDots').innerHTML = '';
      this.loop();
      requestWakeLock(this);
      renderGuide();
      Sound.speak('准备开始');
      this.armEndGuard();
    },

    loop() {
      cancelAnimationFrame(this.raf);
      const step = (t) => {
        if (!this.running) return;
        const dt = Math.min(0.5, (t - this.lastTick) / 1000);
        this.lastTick = t;
        if (!this.paused) {
          const before = C.phaseAt(this.phases, this.elapsed);
          this.elapsed += dt;
          const cur = C.phaseAt(this.phases, this.elapsed);
          if (cur.done) {
            this.finish(true);
            return;
          }
          if (cur.phase !== before.phase) {
            this.onPhase(cur);
          }
          this.paint(cur);
        }
        this.raf = requestAnimationFrame(step);
      };
      this.raf = requestAnimationFrame(step);
    },

    onPhase(cur) {
      const p = cur.phase;
      if (p.type === 'contract') {
        this.repsStarted = (this.repsStarted || 0) + 1;
        Sound.contract(); Sound.speak('收缩'); vibrate(45);
      }
      else if (p.type === 'relax') { Sound.relax(); Sound.speak('放松'); }
      else if (p.type === 'rest') { Sound.rest(); Sound.speak('休息一下'); }
      else if (p.type === 'prep') { Sound.tick(); }
      this.syncWakeLock();
    },

    paint(cur) {
      const p = cur.phase;
      if (!p) return;
      const r = rhythm();
      const g = $('#guide');
      g.dataset.phase = p.type;
      const left = Math.max(1, Math.ceil(p.end - this.elapsed));
      const inPhase = this.elapsed - p.start;

      // 数字与副标题
      $('#orbCount').textContent = left;
      const subMap = {
        prep: '准备',
        contract: '收缩',
        relax: '放松',
        rest: '组间休息'
      };
      $('#orbSub').textContent = subMap[p.type] || '';

      // 进度环（整段练习进度）
      const pct = Math.min(1, this.elapsed / Math.max(1, this.total));
      const bar = $('#stageBar');
      const len = 2 * Math.PI * 138;
      bar.style.strokeDasharray = len;
      bar.style.strokeDashoffset = String(len * (1 - pct));
      bar.style.stroke = p.type === 'relax' ? 'var(--aqua)' : p.type === 'rest' ? 'rgba(147,168,160,.7)' : 'var(--mint)';

      // 光晕随相位呼吸
      const halo = $('#orbHalo');
      const target = p.type === 'contract' ? 1.08 : p.type === 'relax' ? 0.72 : 0.9;
      halo.style.transform = 'scale(' + target + ')';

      // 剩余时间提示（最后 3 秒轻点）
      if ((p.type === 'contract' || p.type === 'relax') && left <= 3 && left !== this.lastBeep && Math.abs(left - (p.dur - inPhase)) < 0.6) {
        this.lastBeep = left;
        Sound.tick();
      }

      // 文案
      const copy = {
        prep: { t: '准备', h: '坐直或平躺，放松肩膀与腹部，自然呼吸。' },
        contract: { t: '轻轻收缩', h: '像忍住排气一样向上提，呼气时用力，别憋气。' },
        relax: { t: '放松', h: '完全松开，感觉到下沉；这一步和收缩一样重要。' },
        rest: { t: '休息一下', h: '保持自然呼吸，下一组马上开始。' }
      }[p.type];
      const title = $('#phaseTitle');
      const hint = $('#phaseHint');
      if (title.textContent !== copy.t) title.textContent = copy.t;
      if (hint.textContent !== copy.h) hint.textContent = copy.h;

      // 组 / 次
      if (p.type === 'rest') $('#guideProgress').textContent = `第 ${p.set} 组完成 · 休息 ${left} 秒`;
      else if (p.type === 'prep') $('#guideProgress').textContent = `共 ${r.sets} 组 × ${r.reps} 次`;
      else $('#guideProgress').textContent = `第 ${p.set}/${r.sets} 组 · 第 ${p.rep}/${r.reps} 次`;

      // 次数圆点
      const dots = $('#repDots');
      if (dots.dataset.meta !== r.reps + '-' + p.set) {
        dots.dataset.meta = r.reps + '-' + p.set;
        dots.innerHTML = Array.from({ length: r.reps }, () => '<i></i>').join('');
      }
      $$('i', dots).forEach((el, i) => {
        const done = p.type === 'rest' ? i < r.reps : i < p.rep - 1;
        const isCur = (p.type === 'contract' || p.type === 'relax') && i === p.rep - 1;
        el.className = isCur ? 'cur' : done ? 'on' : '';
      });

      // 时间
      $('#guideElapsed').textContent = fmtClock(this.elapsed);
      $('#guideTotal').textContent = fmtClock(this.total);
    },

    pause() {
      if (!this.running) return;
      this.paused = !this.paused;
      $('#guide').classList.toggle('is-paused', this.paused);
      $('#btnPause').textContent = this.paused ? '继续' : '暂停';
      if (this.paused) { Sound.stopSpeech(); this.syncWakeLock(); }
      else { this.lastTick = performance.now(); this.syncWakeLock(); }
    },

    skip() {
      if (!this.running) return;
      // 跳到当前相位结束
      const cur = C.phaseAt(this.phases, this.elapsed);
      if (cur.done) return;
      this.elapsed = cur.phase.end + 0.001;
      const next = C.phaseAt(this.phases, this.elapsed);
      if (next.done) this.finish(true);
      else this.onPhase(next);
    },

    stop() {
      if (!this.running) return;
      const reps = this.completedReps();
      this.finish(false, reps);
    },

    completedReps() {
      // 已完整走完的收缩次数
      let n = 0;
      for (const p of this.phases) {
        if (p.type === 'contract' && this.elapsed >= p.end) n++;
      }
      return Math.max(n, this.repsStarted || 0);
    },

    finish(completed, repsOverride) {
      if (!this.running) return;
      this.running = false;
      cancelAnimationFrame(this.raf);
      this.releaseWakeLock();
      Sound.stopSpeech();
      const reps = repsOverride != null ? repsOverride : this.completedReps();
      const seconds = Math.round(Math.min(this.elapsed, this.total));
      $('#guide').hidden = true;
      document.body.classList.remove('is-guiding');
      if (completed) {
        Sound.done();
        vibrate([60, 60, 60, 60, 120]);
      }
      if (reps > 0) recordSession(reps, seconds, completed);
      if (this.tempRhythm) { state.rhythm = this.tempRhythm; this.tempRhythm = null; }
      showDone({ reps, seconds, completed });
      renderIfVisible();
    },

    /* 防止手机锁屏/切后台导致 rAF 停摆后「假结束」：回到前台时按墙钟补齐 */
    armEndGuard() {
      this.guardStart = Date.now();
      this.guardElapsed = 0;
    },

    releaseWakeLock() {
      if (this.wakeLock) { try { this.wakeLock.release(); } catch (e) { /* noop */ } this.wakeLock = null; }
    },
    async syncWakeLock() { /* 简化：开始申请，结束释放 */ }
  };

  async function requestWakeLock() {
    try {
      if ('wakeLock' in navigator && !Session.wakeLock) {
        Session.wakeLock = await navigator.wakeLock.request('screen');
        Session.wakeLock.addEventListener('release', () => { Session.wakeLock = null; });
      }
    } catch (e) { /* 不支持或被拒绝 */ }
  }

  /* 切回前台时校正计时：rAF 在后台会暂停，但真实时间在走 */
  let hiddenAt = 0;
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      hiddenAt = Date.now();
    } else {
      if (Session.running && hiddenAt) {
        const drift = (Date.now() - hiddenAt) / 1000;
        if (drift > 2) {
          // 后台期间 rAF 停摆：把漂移时间补上，避免引导卡住
          Session.lastTick = performance.now() - 300;
        }
      }
      Reminder.refresh();
      renderIfVisible();
      if (Session.running) requestWakeLock();
    }
  });

  function recordSession(reps, seconds, completed) {
    const now = Date.now();
    state.sessions.push({ at: now, reps: reps, seconds: seconds, sets: completed ? rhythm().sets : 1 });
    if (state.sessions.length > 800) state.sessions = state.sessions.slice(-800);
    save(true);
  }

  /* ---------------------------------------------------------------- 格式化 */
  function fmtClock(sec) {
    const s = Math.max(0, Math.round(sec));
    return pad2(Math.floor(s / 60)) + ':' + pad2(s % 60);
  }
  function fmtDuration(sec) {
    const s = Math.max(0, Math.round(sec));
    if (s < 60) return s + ' 秒';
    const m = Math.floor(s / 60);
    const r = s % 60;
    return r ? `${m} 分 ${r} 秒` : `${m} 分钟`;
  }
  function fmtRelative(ms) {
    if (ms <= 0) return '现在';
    const min = Math.round(ms / 60000);
    if (min < 1) return '不到 1 分钟';
    if (min < 60) return `${min} 分钟`;
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h < 24) return m ? `${h} 小时 ${m} 分` : `${h} 小时`;
    return `${Math.floor(h / 24)} 天`;
  }
  function clockOf(ts) {
    const d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function todaySummary() {
    const sum = C.summarize(state.sessions);
    const key = todayKey();
    const t = sum.days.get(key) || { reps: 0, sessions: 0, seconds: 0 };
    return { sum, today: t, key };
  }
  function totalSessionsToday() {
    return state.sessions.filter((s) => C.dayKey(s.at) === todayKey());
  }

  /* ---------------------------------------------------------------- 渲染工具 */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  const ICONS = {
    play: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13l11-6.5z"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"><path d="M13 2 4.5 13.5H11l-1 8.5 8.5-11.5H12z"/></svg>',
    wind: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M3 8h11a3 3 0 1 0-3-3"/><path d="M3 12h15a3 3 0 1 1-3 3"/><path d="M3 16h7"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4M16 3v4M3 10h18"/></svg>',
    check: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 12.5 5 5L20 6.5"/></svg>',
    tune: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>'
  };

  function ringSvg(progress, id) {
    const len = 2 * Math.PI * 118;
    return `<svg class="hero-ring" viewBox="0 0 260 260">
      <defs><linearGradient id="${id}" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stop-color="#C9F27A"/><stop offset=".55" stop-color="#4BE0B0"/><stop offset="1" stop-color="#52C9E8"/>
      </linearGradient></defs>
      <circle class="track" cx="130" cy="130" r="118"/>
      <circle class="bar" cx="130" cy="130" r="118" stroke-dasharray="${len.toFixed(1)}" stroke-dashoffset="${(len * (1 - progress)).toFixed(1)}"/>
    </svg>`;
  }

  /* ---------------------------------------------------------------- 主页 */
  function greeting() {
    const h = new Date().getHours();
    if (h < 5) return '夜深了';
    if (h < 11) return '早上好';
    if (h < 14) return '中午好';
    if (h < 18) return '下午好';
    return '晚上好';
  }

  function heroState() {
    const now = Date.now();
    const next = Reminder.refresh();
    const inside = C.isInsideWindow(Reminder.activeWindows(), now);
    const activeCount = Reminder.activeWindows().length;
    if (!activeCount) {
      return { label: '提醒已全部关闭', caption: '打开提醒', big: '—', sub: '到「提醒」里开启一个时段', progress: 0, next: null, inside: null };
    }
    if (!next) {
      return { label: '今天没有更多提醒', caption: '明天继续', big: '明天', sub: '已完成的已经很好了', progress: 1, next: null, inside: inside };
    }
    const tomorrow = C.dayKey(next.at) !== C.dayKey(now);
    const prev = Math.max(0, Reminder.lastWindowStart(next));
    const span = Math.max(1, next.at - prev);
    const progress = Math.min(1, Math.max(0, (now - prev) / span));
    return {
      label: tomorrow ? '今天已完成 · 明天继续' : inside ? '提醒时段进行中' : '下一次提醒',
      caption: (tomorrow ? '明天 ' : '') + clockOf(next.at),
      big: tomorrow ? clockOf(next.at) : fmtRelative(next.at - now),
      sub: tomorrow ? `明天「${next.window.label}」时段的第一提醒` : inside ? `时段「${inside.label}」每 ${inside.interval} 分钟一次` : `时段「${next.window.label}」`,
      progress: progress,
      next: next,
      inside: inside,
      tomorrow: tomorrow
    };
  }

  /* 上一个锚点时间：用于画环形进度 */
  Reminder.lastWindowStart = function (next) {
    const w = next.window;
    const step = w.interval * 60000;
    const a = C.atClock(next.at, w.start);
    if (next.at <= a + 1000) return a - step;
    return next.at - step;
  };

  function viewTrain() {
    const r = rhythm();
    const hs = heroState();
    const { today, sum } = todaySummary();
    const goal = Math.max(1, r.reps * Math.max(1, state.prefs.goalSets));
    const pct = Math.min(1, today.reps / goal);
    const totalMin = Math.round(C.totalSeconds(r) / 60 * 10) / 10;
    const st = C.streak(sum.days, Date.now());

    return `<div class="screen">
      <div class="greet">
        <div>
          <h1>${greeting()}${st > 1 ? '，第 ' + st + ' 天' : ''}</h1>
          <p>${today.reps > 0 ? `今天已完成 ${today.reps} 次，做得很好。` : '一天几组，静悄悄地把底子练回来。'}</p>
        </div>
        <span class="day-chip">${new Date().getMonth() + 1} 月 ${new Date().getDate()} 日</span>
      </div>

      <section class="card hero">
        <div class="hero-top">
          <span class="hero-label"><i class="live-dot"></i>${esc(hs.label)}</span>
          <button class="link-btn" data-act="tab" data-tab="remind">调整</button>
        </div>
        <div class="hero-clock">
          ${ringSvg(hs.progress, 'heroGrad')}
          <div class="hero-center">
            <span class="cap">${hs.next ? (hs.tomorrow ? '明日首提醒' : '距离下次 · ' + `<b class="hero-when">${esc(hs.caption)}</b>`) : esc(hs.caption)}</span>
            <span class="big hero-big">${esc(hs.big)}</span>
            <span class="sub hero-sub">${esc(hs.sub)}</span>
          </div>
        </div>
        <div class="hero-foot">
          <div>
            <div class="k">当前节奏 · ${esc(presetName(r))}</div>
            <div class="v">收缩 ${r.contract}s · 放松 ${r.relax}s · ${r.reps} 次 × ${r.sets} 组</div>
          </div>
          <button class="link-btn" data-act="tab" data-tab="rhythm">改节奏</button>
        </div>
      </section>

      <div class="actions">
        <button class="btn primary block" data-act="start">${ICONS.play} 开始练习 · 约 ${fmtDuration(C.totalSeconds(r))}</button>
        <div class="quick-row">
          <button class="quick" data-act="quick">
            <span class="qi">${ICONS.bolt}</span>
            <span><b>快速一组</b><span>${r.reps} 次 · 约 ${Math.round((r.reps * (r.contract + r.relax)) / 60 * 10) / 10} 分钟</span></span>
          </button>
          <button class="quick" data-act="free">
            <span class="qi">${ICONS.wind}</span>
            <span><b>自由呼吸</b><span>只跟收缩与放松</span></span>
          </button>
        </div>
      </div>

      <section class="card">
        <div class="card-head">
          <h3>今日进度</h3>
          <span class="hint">目标 ${goal} 次</span>
        </div>
        <div class="today-grid">
          <div class="stat-cell accent"><b>${today.reps}</b><span>今日次数</span></div>
          <div class="stat-cell"><b>${today.sessions}</b><span>完成组数</span></div>
          <div class="stat-cell"><b>${st}</b><span>连续天数</span></div>
        </div>
        <div class="goal-bar"><i style="width:${(pct * 100).toFixed(1)}%"></i></div>
        <div class="goal-meta"><span>${pct >= 1 ? '今天的目标完成啦' : '完成 ' + Math.round(pct * 100) + '%'}</span><span>累计 ${sum.totalSessions} 次练习</span></div>
      </section>

      <section class="card flat">
        <div class="card-head"><h3>小提示</h3><span class="hint">换一条</span></div>
        <p class="note tip" id="tipText">${tipOfDay()}</p>
      </section>
    </div>`;
  }

  const TIPS = [
    '收缩时呼气、放松时吸气，<b>不要憋气</b>。憋气会让腹压升高，反而不利于盆底肌发力。',
    '只动盆底这一层：<b>臀部、大腿、腹部尽量不参与</b>。如果它们也在用力，说明力度可能太大了。',
    '放松和收缩同样重要。<b>每组之间彻底松开</b>，肌肉才能恢复弹性。',
    '别追求最大力气，<b>用三成到五成的力</b>、保持更久，比猛夹一下更有效。',
    '坐姿、站姿、躺姿可以轮换；<b>躺姿最容易找准发力</b>，适合刚开始的时候。',
    '如果出现疼痛、下坠感或漏尿加重，<b>先暂停并咨询医生</b>，别硬练。'
  ];
  function tipOfDay() {
    const day = Math.floor(Date.now() / 86400000);
    return TIPS[day % TIPS.length];
  }

  function presetName(r) {
    const map = { quick: '快速', standard: '标准', strong: '强化', sleep: '睡前', custom: '自定义' };
    return map[r.preset] || '自定义';
  }

  /* ---------------------------------------------------------------- 节奏页 */
  const PRESETS = {
    quick: { contract: 3, relax: 3, reps: 10, sets: 1, setRest: 30, prep: 5, preset: 'quick', label: '入门', desc: '3 秒收缩 / 3 秒放松' },
    standard: { contract: 5, relax: 5, reps: 10, sets: 3, setRest: 45, prep: 5, preset: 'standard', label: '标准', desc: '5 秒收缩 / 5 秒放松' },
    strong: { contract: 8, relax: 8, reps: 10, sets: 3, setRest: 60, prep: 5, preset: 'strong', label: '强化', desc: '8 秒收缩 / 8 秒放松' },
    sleep: { contract: 4, relax: 6, reps: 8, sets: 2, setRest: 30, prep: 5, preset: 'sleep', label: '睡前', desc: '慢呼吸 · 4 秒 / 6 秒' }
  };

  function timelineHtml(r) {
    const phases = C.buildPhases(r);
    // 只画「准备 + 第一组」，再补一个组间休息的示意段，避免几百个色块糊成一片
    const firstSet = phases.filter((p) => p.set <= 1);
    let shown = firstSet.slice();
    if (r.sets > 1 && r.setRest > 0) {
      shown.push({ type: 'rest', dur: r.setRest });
    } else {
      shown.push({ type: 'rest', dur: 0 });
    }
    const sum = shown.reduce((n, p) => n + p.dur, 0) || 1;
    return shown
      .map((p) => `<i class="seg ${p.type}" style="flex:${p.dur} 1 0;min-width:${p.dur > 0 ? 2 : 0}px"></i>`)
      .join('');
  }

  function viewRhythm() {
    const r = rhythm();
    const total = C.totalSeconds(r);
    return `<div class="screen">
      <div class="section-title">选择节奏</div>
      <div class="preset-grid">
        ${Object.values(PRESETS).map((p) => `
          <button class="preset ${r.preset === p.preset ? 'is-on' : ''}" data-act="preset" data-preset="${p.preset}">
            <span class="pv">${p.desc}</span>
            <b>${p.label}</b>
            <span>${p.contract}s 收缩 · ${p.relax}s 放松<br>${p.reps} 次 × ${p.sets} 组</span>
          </button>`).join('')}
      </div>

      <section class="card">
        <div class="card-head"><h3>练习节奏</h3><span class="hint">单次约 ${fmtDuration(total)}</span></div>
        <div class="timeline">${timelineHtml(r)}</div>
        <div class="timeline-note"><span>收缩与放松交替</span><span>${r.reps} 次 / 组，共 ${r.sets} 组</span></div>
        <div class="legend">
          <span><i style="background:rgba(75,224,176,.95)"></i>收缩</span>
          <span><i style="background:rgba(75,224,176,.2)"></i>放松</span>
          <span><i style="background:rgba(82,201,232,.3)"></i>组间休息</span>
        </div>
      </section>

      <section class="card">
        <div class="field">
          <div class="label"><b>收缩时长</b><span>向上提住的时间，建议 3–8 秒起步</span></div>
          ${stepperHtml('contract', r.contract, 1, 30, '秒')}
        </div>
        <div class="field">
          <div class="label"><b>放松时长</b><span>至少与收缩一样长，让肌肉回弹</span></div>
          ${stepperHtml('relax', r.relax, 1, 30, '秒')}
        </div>
        <div class="field">
          <div class="label"><b>每组次数</b><span>一组内的收缩次数</span></div>
          ${stepperHtml('reps', r.reps, 1, 30, '次')}
        </div>
        <div class="field">
          <div class="label"><b>组数</b><span>一次练习做几组</span></div>
          ${stepperHtml('sets', r.sets, 1, 10, '组')}
        </div>
        <div class="field">
          <div class="label"><b>组间休息</b><span>两组之间的间隔</span></div>
          ${stepperHtml('setRest', r.setRest, 5, 180, '秒', 5)}
        </div>
        <div class="field">
          <div class="label"><b>开始前准备</b><span>留出调整姿势与呼吸的时间</span></div>
          ${stepperHtml('prep', r.prep, 0, 10, '秒')}
        </div>
        <div class="field">
          <div class="label"><b>收缩渐强</b><span>用 1–3 秒缓慢加力，避免一下夹紧</span></div>
          <label class="switch"><input type="checkbox" data-act="smooth" ${r.smooth > 0 ? 'checked' : ''}><i></i></label>
        </div>
      </section>

      <section class="card flat">
        <div class="card-head"><h3>怎么找到正确的发力</h3></div>
        <p class="note">想象在起身前轻轻夹住一小团气、或忍住放屁的感觉，<b>向上向内提</b>；呼气时收紧，松开时吸气。手可以放在小腹上确认：<b>腹部应该基本不动</b>。找不到感觉时，先躺着练最容易。</p>
      </section>
    </div>`;
  }

  function stepperHtml(key, value, min, max, unit, step) {
    const s = step || 1;
    return `<div class="stepper" data-key="${key}" data-min="${min}" data-max="${max}" data-step="${s}">
      <button type="button" data-act="step" data-dir="-1" aria-label="减少">−</button>
      <output>${value}<small>${unit}</small></output>
      <button type="button" data-act="step" data-dir="1" aria-label="增加">+</button>
    </div>`;
  }

  /* ---------------------------------------------------------------- 提醒页 */
  const INTERVALS = [15, 20, 30, 45, 60, 90, 120, 180];

  function notifyStatus() {
    if (!('Notification' in window)) return { ok: false, text: '此浏览器不支持系统通知' };
    const p = Notification.permission;
    if (p === 'granted') return { ok: true, text: state.prefs.notify ? '已开启系统通知' : '系统通知未启用（当前仅页面内提醒）' };
    if (p === 'denied') return { ok: false, text: '通知被浏览器拒绝，需在站点设置里手动允许' };
    return { ok: false, text: '尚未授权系统通知' };
  }

  function viewRemind() {
    const ns = notifyStatus();
    const next = Reminder.refresh();
    const active = Reminder.activeWindows();
    const totalPerDay = active.reduce((n, w) => {
      const span = C.toMinutes(w.end) - C.toMinutes(w.start);
      return n + Math.max(1, Math.ceil(span / w.interval));
    }, 0);

    return `<div class="screen">
      <section class="card">
        <div class="card-head"><h3>提醒状态</h3>${ns.ok ? '<span class="badge-ok">通知可用</span>' : '<span class="badge-off">仅页面内</span>'}</div>
        <div class="field" style="border-bottom:0;padding-top:0">
          <div class="label"><b>站内节拍提醒</b><span>打开 App 时到点弹窗、响铃、震动${state.prefs.notify ? '' : '；系统通知未开启'}</span></div>
          <label class="switch"><input type="checkbox" data-act="remindOn" ${Reminder.activeWindows().length ? 'checked' : ''}><i></i></label>
        </div>
        <div class="field">
          <div class="label"><b>系统通知</b><span>${esc(ns.text)}</span></div>
          <button class="btn tiny ghost" data-act="notifyPerm" ${ns.ok ? 'disabled' : ''}>${ns.ok ? '已授权' : '授权'}</button>
        </div>
        <div class="field">
          <div class="label"><b>声音</b><span>节拍提示音与提醒铃声</span></div>
          <label class="switch"><input type="checkbox" data-act="prefSound" ${state.prefs.sound ? 'checked' : ''}><i></i></label>
        </div>
        <div class="field">
          <div class="label"><b>语音报数</b><span>「收缩、放松、3、2、1」</span></div>
          <label class="switch"><input type="checkbox" data-act="prefVoice" ${state.prefs.voice ? 'checked' : ''}><i></i></label>
        </div>
        <div class="field">
          <div class="label"><b>震动</b><span>相位切换时轻震（部分手机不支持）</span></div>
          <label class="switch"><input type="checkbox" data-act="prefVibrate" ${state.prefs.vibrate ? 'checked' : ''}><i></i></label>
        </div>
        <div class="field">
          <div class="label"><b>稍后提醒</b><span>点「稍后」后隔多久再提醒</span></div>
          ${stepperHtml('snoozeMin', state.prefs.snoozeMin || 10, 5, 60, '分', 5)}
        </div>
        <div class="field">
          <div class="label"><b>提醒方式</b><span>提前预览一次铃音与弹出效果</span></div>
          <button class="btn tiny ghost" data-act="testRemind">试一下</button>
        </div>
      </section>

      <div class="section-title">提醒时段 · 今天约 ${totalPerDay} 次</div>
      ${state.windows.map((w, i) => slotHtml(w, i)).join('')}
      <button class="btn ghost block" data-act="addWindow" style="margin-top:10px">＋ 添加一个时段</button>

      <section class="card flat">
        <div class="card-head"><h3>关掉网页也能提醒</h3><span class="hint">推荐</span></div>
        <p class="note">网页版在关闭后无法在后台准时唤醒。把提醒<b>导出到手机自带日历</b>，就能由系统闹钟接管：不耗电、不依赖浏览器，iPhone 和 Android 都支持。</p>
        <button class="btn ghost block" data-act="ics" style="margin-top:12px">${ICONS.calendar} 导出日历提醒 (.ics)</button>
        <p class="note" style="margin-top:10px">导入方法：下载后用系统「日历」打开，选择新增日历「提肛节拍提醒」即可。</p>
      </section>

      <section class="card">
        <div class="card-head"><h3>提醒预览 · 今天</h3><span class="hint">${next ? '下次 ' + clockOf(next.at) : '今天已结束'}</span></div>
        <div class="row wrap" id="previewRow" style="gap:6px">${previewChips()}</div>
      </section>
    </div>`;
  }

  function slotHtml(w, i) {
    return `<div class="slot ${w.enabled ? '' : 'is-off'}" data-window="${i}">
      <div class="slot-head">
        <span class="slot-name"><i class="slot-dot" style="${w.enabled ? '' : 'opacity:.2;box-shadow:none'}"></i>${esc(w.label)}<em>${w.interval} 分钟一次</em></span>
        <label class="switch"><input type="checkbox" data-act="windowOn" data-i="${i}" ${w.enabled ? 'checked' : ''}><i></i></label>
      </div>
      <div class="slot-row">
        <input class="time-input" type="time" value="${w.start}" data-act="windowTime" data-i="${i}" data-k="start" aria-label="开始时间">
        <span class="sep">至</span>
        <input class="time-input" type="time" value="${w.end}" data-act="windowTime" data-i="${i}" data-k="end" aria-label="结束时间">
        <button class="chip" data-act="editWindow" data-i="${i}" style="margin-left:auto">名称</button>
        <button class="chip" data-act="delWindow" data-i="${i}">删除</button>
      </div>
      <div class="chips">
        ${INTERVALS.map((v) => `<button class="chip ${w.interval === v ? 'is-on' : ''}" data-act="windowInterval" data-i="${i}" data-v="${v}">${v < 60 ? v + '分' : (v / 60) + '小时'}</button>`).join('')}
      </div>
    </div>`;
  }

  function previewChips() {
    // 今天剩余 + 明天早间，保证任何时刻都有预览
    const now = Date.now();
    const items = C.occurrencesBetween(Reminder.activeWindows(), now, now + 30 * 3600000).slice(0, 8);
    if (!items.length) return '<span class="note">提醒都已关闭，打开下面的开关即可恢复。</span>';
    return items
      .map((it) => {
        const tomorrow = C.dayKey(it.at) !== C.dayKey(now);
        return `<span class="chip">${tomorrow ? '明 ' : ''}${clockOf(it.at)}</span>`;
      })
      .join('');
  }

  /* ---------------------------------------------------------------- 记录页 */
  function heatHtml(days) {
    const sum = C.summarize(state.sessions);
    const cells = [];
    const end = new Date();
    end.setHours(0, 0, 0, 0);
    const start = new Date(end.getTime() - (days - 1) * 86400000);
    // 对齐到周一，列按周排
    const startDow = (start.getDay() + 6) % 7;
    for (let i = 0; i < startDow; i++) cells.push('<i style="opacity:0"></i>');
    for (let i = 0; i < days; i++) {
      const ts = start.getTime() + i * 86400000;
      const rec = sum.days.get(C.dayKey(ts)) || { reps: 0, sessions: 0 };
      const lvl = rec.sessions === 0 ? 0 : rec.sessions <= 1 ? 1 : rec.sessions === 2 ? 2 : rec.sessions <= 3 ? 3 : 4;
      cells.push(`<i class="${lvl ? 'l' + lvl : ''}" title="${C.dayKey(ts)} · ${rec.sessions} 组 / ${rec.reps} 次"></i>`);
    }
    return `<div class="heat">${cells.join('')}</div>`;
  }

  function weekBars() {
    const sum = C.summarize(state.sessions);
    const out = [];
    let max = 0;
    for (let i = 6; i >= 0; i--) {
      const ts = Date.now() - i * 86400000;
      const rec = sum.days.get(C.dayKey(ts)) || { reps: 0, sessions: 0 };
      max = Math.max(max, rec.reps);
      out.push({ ts, rec, today: i === 0 });
    }
    if (max === 0) {
      return `<div class="empty-chart">还没有记录。完成一组练习，这里就会长出第一根柱子。</div>`;
    }
    const wd = ['日', '一', '二', '三', '四', '五', '六'];
    return `<div class="bars">${out.map((o) => {
      const pct = Math.round((o.rec.reps / max) * 82);
      return `
      <div class="b ${o.today ? 'today' : ''}" title="${o.rec.reps} 次">
        <i style="height:${o.rec.reps ? Math.max(10, pct) : 3}%;${o.rec.reps ? '' : 'background:rgba(255,255,255,.10)'}"></i>
        <span>${o.today ? '今天' : wd[new Date(o.ts).getDay()]}</span>
      </div>`;
    }).join('')}</div>`;
  }

  function viewStats() {
    const sum = C.summarize(state.sessions);
    const st = C.streak(sum.days, Date.now());
    const longest = C.longestStreak(sum.days);
    const avg = sum.totalSessions ? Math.round(sum.totalReps / sum.totalSessions) : 0;
    const activeDays = sum.days.size;
    const { today } = todaySummary();
    const r = rhythm();
    const goal = r.reps * state.prefs.goalSets;
    return `<div class="screen">
      <div class="section-title">坚持</div>
      <div class="today-grid">
        <div class="stat-cell accent"><b>${st}</b><span>连续天数</span></div>
        <div class="stat-cell"><b>${longest}</b><span>最长连续</span></div>
        <div class="stat-cell"><b>${activeDays}</b><span>练习天数</span></div>
      </div>
      <div class="today-grid" style="margin-top:8px">
        <div class="stat-cell"><b>${sum.totalSessions}</b><span>累计组数</span></div>
        <div class="stat-cell"><b>${sum.totalReps}</b><span>累计次数</span></div>
        <div class="stat-cell"><b>${sum.totalMinutes}</b><span>累计分钟</span></div>
      </div>

      <section class="card">
        <div class="card-head"><h3>近 12 周</h3><span class="hint">颜色越亮，练得越多</span></div>
        ${heatHtml(84)}
        <div class="heat-legend"><span>少</span><i style="background:rgba(255,255,255,.055)"></i><i class="l1" style="background:rgba(75,224,176,.28)"></i><i style="background:rgba(75,224,176,.5)"></i><i style="background:rgba(75,224,176,.75)"></i><i style="background:var(--mint)"></i><span>多</span></div>
        ${activeDays === 0 ? '<p class="note" style="margin-top:10px;text-align:center">一格代表一天，第一格颜色出现时，就开始了。</p>' : ''}
      </section>

      <section class="card">
        <div class="card-head"><h3>最近 7 天</h3><span class="hint">今天 ${today.reps} 次 / 目标 ${goal}</span></div>
        ${weekBars()}
      </section>

      <section class="card flat">
        <div class="card-head"><h3>数据</h3><span class="hint">仅保存在本机</span></div>
        <div class="field">
          <div class="label"><b>平均每组</b><span>每次练习的平均收缩次数</span></div>
          <div style="font-size:15px;font-weight:600">${avg} 次</div>
        </div>
        <div class="field">
          <div class="label"><b>每日目标</b><span>今日进度按「次数 × 组数」计算</span></div>
          ${stepperHtml('goalSets', state.prefs.goalSets, 1, 10, '组')}
        </div>
        <div class="row" style="margin-top:12px;gap:10px">
          <button class="btn ghost tiny" data-act="exportData">导出备份</button>
          <button class="btn ghost tiny" data-act="importData">导入备份</button>
          <button class="btn danger tiny" data-act="resetData" style="margin-left:auto">清空</button>
        </div>
      </section>

      <section class="card flat">
        <div class="card-head"><h3>关于</h3></div>
        <p class="note">提肛节拍是一款自制的小工具，帮助你<b>按自己的节奏</b>完成盆底肌练习并保持习惯。内容为一般健身信息，<b>不构成医疗建议</b>。若有盆腔疼痛、术后恢复、孕期或漏尿等问题，请先咨询医生或盆底康复治疗师。
        <br><br>参考：<a class="link" href="https://www.niddk.nih.gov/health-information/urologic-diseases/kegel-exercises" target="_blank" rel="noopener">NIDDK · Kegel Exercises</a></p>
      </section>
    </div>`;
  }

  /* ---------------------------------------------------------------- 渲染 & 事件 */
  let currentTab = 'train';

  function render(keepScroll) {
    const y = window.scrollY;
    const html = currentTab === 'train' ? viewTrain() : currentTab === 'rhythm' ? viewRhythm() : currentTab === 'remind' ? viewRemind() : viewStats();
    $('#view').innerHTML = html;
    $$('.tab').forEach((t) => t.classList.toggle('is-active', t.dataset.tab === currentTab));
    updateHeader();
    if (keepScroll) window.scrollTo(0, y); else window.scrollTo(0, 0);
  }

  function renderIfVisible() {
    if (document.hidden) return;
    if (!$('#guide').hidden || !$('#doneModal').hidden) { updateHeader(); return; }
    render(true);
  }

  function updateHeader() {
    const sum = C.summarize(state.sessions);
    $('#streakNum').textContent = C.streak(sum.days, Date.now());
    const h = new Date().getHours();
    $('#brandSub').textContent = h < 5 ? '夜深了，早点休息' : h < 11 ? '早晨一组，唤醒身体' : h < 14 ? '午间提醒，别久坐' : h < 18 ? '下午一组，缓解久坐' : '睡前放松，慢慢收';
  }

  function switchTab(name) {
    if (name === currentTab) return;
    currentTab = name;
    render(false);
  }

  /* 步进器 */
  function bumpStepper(el, dir) {
    const key = el.dataset.key;
    const min = +el.dataset.min;
    const max = +el.dataset.max;
    const step = +el.dataset.step;
    if (key === 'goalSets') {
      state.prefs.goalSets = Math.min(max, Math.max(min, state.prefs.goalSets + dir * step));
    } else if (key === 'snoozeMin') {
      state.prefs.snoozeMin = Math.min(max, Math.max(min, (state.prefs.snoozeMin || 10) + dir * step));
    } else {
      state.rhythm[key] = Math.min(max, Math.max(min, rhythm()[key] + dir * step));
      state.rhythm.preset = 'custom';
      state.rhythm = C.normRhythm(state.rhythm);
    }
    save();
    render(true);
  }

  /* 练习完成弹层 */
  function showDone(info) {
    const { today } = todaySummary();
    const sum = C.summarize(state.sessions);
    $('#doneReps').textContent = info.reps;
    $('#doneTime').textContent = fmtClock(info.seconds);
    $('#doneStreak').textContent = C.streak(sum.days, Date.now());
    $('#doneTitle').textContent = info.completed ? '这一组完成了' : '练习已结束';
    $('#doneSub').textContent = info.completed
      ? `今天累计 ${today.reps} 次，${today.sessions} 组。保持呼吸，明天见。`
      : `中途结束也没关系，已经记下 ${info.reps} 次。`;
    $('#doneModal').hidden = false;
  }

  /* 引导界面 */
  function renderGuide() {
    if (!Session.running) return;
    const cur = C.phaseAt(Session.phases, Session.elapsed);
    if (cur.done) return;
    Session.paint(cur);
  }

  /* 底部弹层（设置 / 名称编辑） */
  function openSheet(title, html) {
    $('#sheetTitle').textContent = title;
    $('#sheetBody').innerHTML = html;
    $('#scrim').hidden = false;
    $('#sheet').hidden = false;
  }
  function closeSheet() {
    $('#scrim').hidden = true;
    $('#sheet').hidden = true;
    $('#sheetBody').innerHTML = '';
  }

  function openWindowEditor(i) {
    const w = state.windows[i];
    if (!w) return;
    openSheet('编辑时段', `
      <div class="field">
        <div class="label"><b>时段名称</b><span>例如：早间、工位、睡前</span></div>
      </div>
      <input id="winName" class="time-input" style="width:100%;text-align:left;padding:12px;font-size:15px" value="${esc(w.label)}" maxlength="8">
      <button class="btn primary block" style="margin-top:16px" data-act="saveWinName" data-i="${i}">保存</button>
      <p class="note" style="margin-top:12px">时段内会按「间隔」重复提醒，间隔可在时段卡片上直接点选。</p>
    `);
    setTimeout(() => { const el = $('#winName'); if (el) { el.focus(); el.select(); } }, 60);
  }

  /* ICS 下载 */
  function downloadIcs() {
    const ics = C.buildIcs(Reminder.activeWindows(), { now: Date.now() });
    const blob = new Blob(['\ufeff' + ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kegel-reminders.ics';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    soundOk();
  }

  function soundOk() { Sound.unlock(); Sound.tone(660, 0.12, { gain: 0.1 }); Sound.tone(990, 0.16, { delay: 0.1, gain: 0.09 }); }

  function exportJson() {
    const data = JSON.stringify(state, null, 2);
    const blob = new Blob([data], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'kegel-rhythm-backup-' + C.dayKey(Date.now()) + '.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  }

  function importJson(file) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(String(reader.result));
        if (!data || typeof data !== 'object') throw new Error('bad');
        if (data.rhythm) state.rhythm = C.normRhythm(data.rhythm);
        if (Array.isArray(data.windows)) state.windows = data.windows.map((w, i) => C.normWindow(w, i));
        if (data.prefs) state.prefs = Object.assign(state.prefs, data.prefs);
        if (Array.isArray(data.sessions)) {
          const seen = new Set(state.sessions.map((s) => s.at + ':' + s.reps));
          for (const s of data.sessions) {
            if (s && s.at && !seen.has(s.at + ':' + s.reps)) { state.sessions.push(s); seen.add(s.at + ':' + s.reps); }
          }
          state.sessions.sort((a, b) => a.at - b.at);
        }
        save(true);
        render(false);
        openSheet('导入完成', '<p class="note">数据已合并到当前记录。如果节奏或提醒有变化，请检查「节奏」「提醒」两页。</p><button class="btn primary block" style="margin-top:16px" data-act="closeSheet">好</button>');
      } catch (e) {
        openSheet('导入失败', '<p class="note">文件格式无法识别，请选择本应用导出的 JSON 备份。</p><button class="btn ghost block" style="margin-top:16px" data-act="closeSheet">关闭</button>');
      }
    };
    reader.readAsText(file);
  }

  /* 事件委托 */
  document.addEventListener('click', (e) => {
    const tabBtn = e.target.closest('[data-tab]');
    if (tabBtn && tabBtn.classList.contains('tab')) { switchTab(tabBtn.dataset.tab); return; }

    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const i = el.dataset.i != null ? +el.dataset.i : -1;

    switch (act) {
      case 'tab': switchTab(el.dataset.tab); break;
      case 'start':
        Sound.unlock();
        Session.start();
        break;
      case 'quick':
        Sound.unlock();
        startWith(Object.assign({}, rhythm(), { sets: 1, setRest: 0, prep: 3 }));
        break;
      case 'free':
        Sound.unlock();
        startWith(Object.assign({}, rhythm(), { sets: 1, reps: Math.max(10, rhythm().reps), prep: 3, setRest: 0 }));
        break;
      case 'preset': {
        const p = PRESETS[el.dataset.preset];
        if (!p) break;
        state.rhythm = C.normRhythm(Object.assign({}, p));
        save(true);
        soundOk();
        render(true);
        break;
      }
      case 'step': bumpStepper(el.closest('.stepper'), +el.dataset.dir); break;
      case 'smooth': {
        state.rhythm.smooth = el.checked ? 1 : 0;
        save(); break;
      }
      case 'remindOn': {
        const on = el.checked;
        state.windows.forEach((w) => { w.enabled = on; });
        Reminder.skipUntil = 0;
        save(true);
        Reminder.refresh();
        render(true);
        break;
      }
      case 'windowOn': {
        state.windows[i].enabled = el.checked;
        Reminder.skipUntil = 0;
        save(true); Reminder.refresh(); render(true);
        break;
      }
      case 'windowInterval': {
        state.windows[i].interval = +el.dataset.v;
        Reminder.skipUntil = 0;
        save(true); Reminder.refresh(); render(true);
        break;
      }
      case 'editWindow': openWindowEditor(i); break;
      case 'saveWinName': {
        const name = ($('#winName').value || '').trim().slice(0, 8);
        if (name) state.windows[i].label = name;
        save(true); closeSheet(); render(true);
        break;
      }
      case 'delWindow': {
        if (state.windows.length <= 1) { openSheet('提示', '<p class="note">至少保留一个时段。可以直接把开关关掉。</p><button class="btn ghost block" style="margin-top:14px" data-act="closeSheet">好</button>'); break; }
        state.windows.splice(i, 1);
        save(true); Reminder.refresh(); render(true);
        break;
      }
      case 'addWindow': {
        const last = state.windows[state.windows.length - 1];
        const startMin = last ? Math.min(23 * 60 + 30, C.toMinutes(last.end) + 30) : 9 * 60;
        state.windows.push(C.normWindow({ label: '时段 ' + (state.windows.length + 1), enabled: true, start: C.fromMinutes(startMin), end: C.fromMinutes(startMin + 60), interval: 45 }, state.windows.length));
        save(true); Reminder.refresh(); render(true);
        break;
      }
      case 'notifyPerm': requestNotification(); break;
      case 'testRemind': Sound.unlock(); Reminder.preview(); break;
      case 'prefSound': state.prefs.sound = el.checked; save(true); if (el.checked) soundOk(); break;
      case 'prefVoice': state.prefs.voice = el.checked; save(true); if (el.checked) Sound.speak('语音已开启'); break;
      case 'prefVibrate': state.prefs.vibrate = el.checked; save(true); if (el.checked) vibrate(40); break;
      case 'ics': downloadIcs(); break;
      case 'exportData': exportJson(); break;
      case 'importData': {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.accept = 'application/json,.json';
        inp.onchange = () => { if (inp.files && inp.files[0]) importJson(inp.files[0]); };
        inp.click();
        break;
      }
      case 'resetData': {
        openSheet('清空所有记录？', `<p class="note">会删除全部练习记录与统计，提醒和节奏设置保留。此操作不可恢复，建议先导出备份。</p>
          <div class="row" style="margin-top:16px;gap:10px">
            <button class="btn ghost" style="flex:1" data-act="closeSheet">取消</button>
            <button class="btn danger" style="flex:1" data-act="resetConfirm">确认清空</button>
          </div>`);
        break;
      }
      case 'resetConfirm': {
        state.sessions = [];
        save(true); closeSheet(); render(false);
        break;
      }
      case 'closeSheet': closeSheet(); break;
      case 'exitGuide': if (Session.running) { Session.pause(); openEndSheet(); } break;
      case 'closeSheetResume': closeSheet(); if (Session.running) Session.pause(); break;
      case 'endSession': closeSheet(); Session.stop(); break;
      case 'pause': Session.pause(); break;
      case 'skip': Session.skip(); break;
      case 'stop': Session.stop(); break;
      case 'mute': {
        state.prefs.sound = !state.prefs.sound;
        save(true);
        $('#btnMute').classList.toggle('is-off', !state.prefs.sound);
        if (state.prefs.sound) soundOk();
        break;
      }
      case 'toastStart': Reminder.hideToast(); Sound.unlock(); Session.start(); break;
      case 'toastLater': Reminder.snooze(state.prefs.snoozeMin || 10); break;
      case 'doneClose': $('#doneModal').hidden = true; renderIfVisible(); break;
      case 'again': $('#doneModal').hidden = true; Session.start(); break;
      case 'sheetClose':
      case 'scrimClose': closeSheet(); break;
    }
  });

  /* 时段时间修改 */
  document.addEventListener('change', (e) => {
    const el = e.target.closest('[data-act="windowTime"]');
    if (!el) return;
    const i = +el.dataset.i;
    const k = el.dataset.k;
    const w = state.windows[i];
    if (!w) return;
    w[k] = C.normClock(el.value, w[k]);
    if (C.toMinutes(w.end) <= C.toMinutes(w.start)) {
      if (k === 'start') w.end = C.fromMinutes(Math.min(23 * 60 + 59, C.toMinutes(w.start) + 60));
      else w.start = C.fromMinutes(Math.max(0, C.toMinutes(w.end) - 60));
    }
    save(true);
    Reminder.skipUntil = 0;
    Reminder.refresh();
    render(true);
  });

  /* 以上按钮全部走 data-act 委托，避免重复绑定 */

  /* 通知授权 */
  async function requestNotification() {
    if (!('Notification' in window)) return;
    try {
      const p = await Notification.requestPermission();
      if (p === 'granted') {
        state.prefs.notify = true;
        save(true);
        new Notification('提肛节拍', { body: '系统通知已开启，到点会提醒你。', icon: './icons/icon-192.png', silent: true });
        render(true);
      }
    } catch (e) { /* noop */ }
  }

  /* 以临时节奏开始（快速一组 / 自由呼吸），结束后自动还原 */
  function startWith(overrides) {
    Session.tempRhythm = clone(state.rhythm);
    state.rhythm = C.normRhythm(Object.assign({}, state.rhythm, overrides));
    Session.start();
  }

  /* 每秒 tick：提醒检查 + 主页倒计时刷新 */
  let tickCount = 0;
  function tick() {
    Reminder.check();
    tickCount++;
    if (tickCount % 1 === 0 && currentTab === 'train' && !Session.running && document.hidden === false && $('#doneModal').hidden) {
      updateHeroClock();
    }
    if (tickCount % 60 === 0) updateHeader();
  }

  /* 只更新主页环形与文案，避免整页重绘闪烁 */
  function updateHeroClock() {
    const hs = heroState();
    const hero = $('.hero');
    if (!hero) return;
    const when = $('.hero-when', hero);
    const big = $('.hero-big', hero);
    const sub = $('.hero-sub', hero);
    const bar = $('.hero-ring .bar', hero);
    if (when) when.textContent = hs.caption;
    if (big) big.textContent = hs.big;
    if (sub) sub.textContent = hs.sub;
    if (bar) {
      const len = 2 * Math.PI * 118;
      bar.setAttribute('stroke-dashoffset', String(len * (1 - hs.progress)));
    }
  }

  /* 首次使用引导 */
  function onboarding() {
    if (state.prefs.onboarded) return;
    openSheet('欢迎使用提肛节拍', `
      <p class="note">这是一个只存在你手机里的小工具：<b>自定义收缩/放松节奏</b>、按时间段提醒、跟着动画节拍练习，并记录坚持天数。</p>
      <div class="field"><div class="label"><b>1. 定一个节奏</b><span>默认 5 秒收缩 / 5 秒放松，10 次 × 3 组。可以在「节奏」页随时改。</span></div></div>
      <div class="field"><div class="label"><b>2. 开提醒</b><span>早/午/晚三个时段，可改时间和间隔。</span></div></div>
      <div class="field"><div class="label"><b>3. 关掉网页也能提醒</b><span>用「提醒」页底部的日历导出，交给手机系统闹钟。</span></div></div>
      <button class="btn primary block" style="margin-top:16px" data-act="onboardDone">开始使用</button>
      <p class="note" style="margin-top:12px">如果你有盆腔疼痛、刚做完手术或处于孕期，请先咨询医生。</p>
    `);
  }
  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-act="onboardDone"]')) {
      state.prefs.onboarded = true;
      save(true);
      closeSheet();
      render(false);
    }
  });

  /* PWA 安装 */
  let installPrompt = null;
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    installPrompt = e;
    $('#btnInstall').hidden = false;
  });
  $('#btnInstall').addEventListener('click', async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    try { await installPrompt.userChoice; } catch (e) { /* noop */ }
    installPrompt = null;
    $('#btnInstall').hidden = true;
  });
  window.addEventListener('appinstalled', () => { $('#btnInstall').hidden = true; });

  /* 键盘快捷键（桌面/平板外接键盘） */
  document.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
    if (Session.running) {
      if (e.code === 'Space') { e.preventDefault(); Session.pause(); }
      else if (e.key === 'Escape') { e.preventDefault(); if (Session.running) { Session.pause(); openEndSheet(); } }
      else if (e.key === 'ArrowRight') { e.preventDefault(); Session.skip(); }
      return;
    }
    if (e.code === 'Space' && !$('#doneModal').hidden) { e.preventDefault(); $('#doneModal').hidden = true; Session.start(); }
    else if (e.key === 'Escape' && !$('#sheet').hidden) { closeSheet(); }
  });

  function openEndSheet() {
    openSheet('结束这次练习？', `<p class="note">已完成的次数会被记录。也可以继续练完这一组。</p>
      <div class="row" style="margin-top:16px;gap:10px">
        <button class="btn ghost" style="flex:1" data-act="closeSheetResume">继续练习</button>
        <button class="btn danger" style="flex:1" data-act="endSession">结束</button>
      </div>`);
  }

  /* 启动 */
  let booted = false;
  function boot() {
    if (booted) return;
    booted = true;
    const params = new URLSearchParams(location.search);
    const qtab = params.get('tab');
    if (qtab === 'rhythm' || qtab === 'remind' || qtab === 'stats') currentTab = qtab;
    render(false);
    Reminder.refresh();
    setInterval(tick, 1000);
    updateHeader();
    $('#btnMute').classList.toggle('is-off', !state.prefs.sound);
    // 首次交互时解锁音频
    const unlock = () => { Sound.unlock(); document.removeEventListener('touchstart', unlock); document.removeEventListener('click', unlock); };
    document.addEventListener('touchstart', unlock, { passive: true });
    document.addEventListener('click', unlock);
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    }
    if (params.get('go') === 'start') {
      setTimeout(() => { if (!Session.running) { Sound.unlock(); Session.start(); } }, 500);
    } else {
      setTimeout(onboarding, 800);
    }
  }

  document.addEventListener('DOMContentLoaded', boot);
  if (document.readyState !== 'loading') boot();
})();

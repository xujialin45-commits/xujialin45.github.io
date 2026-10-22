/*
 * 提肛节拍 · 纯逻辑内核
 * 不依赖 DOM，可在浏览器与 Node 中同时运行（便于单元测试）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.KRCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  const DAY_MS = 86400000;

  /* ---------- 时间小工具 ---------- */
  function pad2(n) {
    return String(n).padStart(2, '0');
  }

  function toMinutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
    if (!m) return 0;
    return Math.min(23, +m[1]) * 60 + Math.min(59, +m[2]);
  }

  function fromMinutes(minutes) {
    const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
    return pad2(Math.floor(m / 60)) + ':' + pad2(m % 60);
  }

  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function atClock(baseTs, hhmm) {
    const d = new Date(baseTs);
    const mins = toMinutes(hhmm);
    d.setHours(Math.floor(mins / 60), mins % 60, 0, 0);
    return d.getTime();
  }

  function normClock(value, fallback) {
    const m = /^(\d{1,2}):(\d{1,2})$/.exec(String(value || '').trim());
    if (!m) return fallback || '09:00';
    const h = Math.min(23, Math.max(0, +m[1]));
    const mm = Math.min(59, Math.max(0, +m[2]));
    return pad2(h) + ':' + pad2(mm);
  }

  function normWindow(w, i) {
    const start = normClock(w && w.start, '09:00');
    let end = normClock(w && w.end, fromMinutes(toMinutes(start) + 60));
    if (toMinutes(end) <= toMinutes(start)) end = fromMinutes(toMinutes(start) + 30);
    return {
      id: (w && w.id) || 'w' + i,
      label: (w && w.label) || '时段 ' + (i + 1),
      enabled: !(w && w.enabled === false),
      start: start,
      end: end,
      interval: clampInterval(w && w.interval)
    };
  }

  function clampInterval(v) {
    const n = Math.round(Number(v) || 60);
    return Math.min(720, Math.max(5, n));
  }

  /* ---------- 提醒调度 ---------- */
  /*
   * 每个时段是一个「时间窗」，窗内按 interval 分钟重复。
   * 锚点：窗起点 + k * interval（k = 0,1,2...），且严格小于窗结束时间。
   * 返回下一次提醒（可传入排除的窗口，用于「跳过」）。
   */
  function nextOccurrence(windows, fromTs, skipUntilTs) {
    const t0 = Math.max(fromTs, skipUntilTs || 0);
    const dates = [t0, t0 + DAY_MS, t0 + 2 * DAY_MS];
    let best = null;
    for (const dayTs of dates) {
      for (const w of windows || []) {
        if (!w || w.enabled === false) continue;
        const a = atClock(dayTs, w.start);
        const b = atClock(dayTs, w.end);
        const step = clampInterval(w.interval) * 60000;
        if (a < t0) {
          // 对齐到窗内第一个仍未被排除的锚点
          const k = Math.ceil((t0 - a) / step);
          const cand = a + k * step;
          if (cand < b && (!best || cand < best.at)) best = { at: cand, window: w };
        } else if (a >= t0 && a < b) {
          if (!best || a < best.at) best = { at: a, window: w };
        }
      }
    }
    return best;
  }

  /* 生成本周内的全部提醒（用于预览 / ICS） */
  function occurrencesBetween(windows, fromTs, toTs) {
    const out = [];
    for (let day = new Date(fromTs); day.getTime() < toTs; day = new Date(day.getTime() + DAY_MS)) {
      for (const w of windows || []) {
        if (!w || w.enabled === false) continue;
        const a = atClock(day.getTime(), w.start);
        const b = atClock(day.getTime(), w.end);
        const step = clampInterval(w.interval) * 60000;
        if (b <= fromTs) continue;
        for (let t = a; t < b; t += step) {
          if (t >= fromTs && t < toTs) out.push({ at: t, window: w });
        }
      }
    }
    out.sort((x, y) => x.at - y.at);
    return out;
  }

  function isInsideWindow(windows, ts) {
    const now = new Date(ts);
    const mins = now.getHours() * 60 + now.getMinutes();
    for (const w of windows || []) {
      if (!w || w.enabled === false) continue;
      if (mins >= toMinutes(w.start) && mins < toMinutes(w.end)) return w;
    }
    return null;
  }

  /* ---------- 练习节奏 ---------- */
  function clampInt(v, min, max, fallback) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function normRhythm(r) {
    r = r || {};
    return {
      contract: clampInt(r.contract, 1, 30, 5),
      relax: clampInt(r.relax, 1, 30, 5),
      reps: clampInt(r.reps, 1, 30, 10),
      sets: clampInt(r.sets, 1, 10, 3),
      setRest: clampInt(r.setRest, 5, 180, 45),
      prep: clampInt(r.prep, 0, 10, 5),
      smooth: clampInt(r.smooth, 0, 3, 1),
      preset: typeof r.preset === 'string' ? r.preset : 'custom'
    };
  }

  /*
   * 把一次练习展开成「相位序列」，供引导界面与总时长计算使用。
   * 相位：prep → contract → relax → (rep*) → setRest → ... → done
   */
  function buildPhases(rhythm) {
    const r = normRhythm(rhythm);
    const phases = [];
    if (r.prep > 0) phases.push({ type: 'prep', dur: r.prep, rep: 0, set: 0 });
    for (let s = 0; s < r.sets; s++) {
      for (let k = 0; k < r.reps; k++) {
        phases.push({ type: 'contract', dur: r.contract, rep: k + 1, set: s + 1 });
        phases.push({ type: 'relax', dur: r.relax, rep: k + 1, set: s + 1 });
      }
      if (s < r.sets - 1 && r.setRest > 0) {
        phases.push({ type: 'rest', dur: r.setRest, rep: r.reps, set: s + 1 });
      }
    }
    let t = 0;
    for (const p of phases) {
      p.start = t;
      t += p.dur;
      p.end = t;
    }
    return phases;
  }

  function totalSeconds(rhythm) {
    const phases = buildPhases(rhythm);
    return phases.length ? phases[phases.length - 1].end : 0;
  }

  /* 当前时刻落在哪个相位 */
  function phaseAt(phases, elapsed) {
    if (!phases || !phases.length) return null;
    if (elapsed >= phases[phases.length - 1].end) return { done: true, phase: null };
    // 相位按时间升序，线性扫描（最多几百项）足够快
    for (let i = 0; i < phases.length; i++) {
      if (elapsed < phases[i].end) return { done: false, phase: phases[i], index: i };
    }
    return { done: true, phase: null };
  }

  /* 当前相位内的建议肌肉张力 0..1（平滑模式会做缓入缓出） */
  function phaseIntensity(phase, elapsedInPhase) {
    if (!phase) return 0;
    const p = Math.min(1, Math.max(0, elapsedInPhase / Math.max(0.001, phase.dur)));
    if (phase.type === 'contract') return 0.35 + 0.65 * easeOut(p);
    if (phase.type === 'relax') return 0.35 * (1 - easeOut(p));
    return 0.12;
  }

  function easeOut(p) {
    return 1 - Math.pow(1 - p, 2);
  }

  /* ---------- 统计 ---------- */
  function summarize(sessions) {
    const list = (sessions || []).filter((s) => s && s.at);
    const byDay = new Map();
    let totalReps = 0;
    let totalSeconds = 0;
    for (const s of list) {
      const key = dayKey(s.at);
      const cur = byDay.get(key) || { reps: 0, sessions: 0, seconds: 0 };
      cur.reps += Number(s.reps) || 0;
      cur.sessions += 1;
      cur.seconds += Number(s.seconds) || 0;
      byDay.set(key, cur);
      totalReps += Number(s.reps) || 0;
      totalSeconds += Number(s.seconds) || 0;
    }
    return {
      days: byDay,
      totalSessions: list.length,
      totalReps: totalReps,
      totalSeconds: totalSeconds,
      totalMinutes: Math.round(totalSeconds / 60)
    };
  }

  /* 连续天数：今天做过就算，今天没做则从昨天往前数 */
  function streak(byDay, nowTs) {
    const DAY = 86400000;
    const today = new Date(nowTs);
    today.setHours(0, 0, 0, 0);
    let cursor = today.getTime();
    if (!byDay.has(dayKey(cursor))) cursor -= DAY;
    let n = 0;
    while (byDay.has(dayKey(cursor)) && n < 3650) {
      n++;
      cursor -= DAY;
    }
    return n;
  }

  function longestStreak(byDay) {
    const keys = Array.from(byDay.keys()).sort();
    let best = 0;
    let run = 0;
    let prev = null;
    for (const k of keys) {
      const ts = new Date(k + 'T00:00:00').getTime();
      run = prev !== null && ts - prev === 86400000 ? run + 1 : 1;
      if (run > best) best = run;
      prev = ts;
    }
    return best;
  }

  /* ---------- 日历导出（.ics） ---------- */
  function pad2z(n) {
    return String(n).padStart(2, '0');
  }

  function icsStamp(ts) {
    const d = new Date(ts);
    return (
      d.getFullYear() + pad2z(d.getMonth() + 1) + pad2z(d.getDate()) + 'T' + pad2z(d.getHours()) + pad2z(d.getMinutes()) + '00'
    );
  }

  function fold(line) {
    let out = '';
    let count = 0;
    for (const ch of line) {
      const len = new TextEncoder().encode(ch).length;
      if (count + len > 73) {
        out += '\r\n ';
        count = 1;
      }
      out += ch;
      count += len;
    }
    return out;
  }

  function escapeIcs(text) {
    return String(text).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\n/g, '\\n');
  }

  /*
   * 生成「每天每 N 分钟一次」的日历事件：每条事件一个 DTSTART + 每日重复，
   * 导入手机自带日历后，即使不打开网页也能收到系统级提醒。
   */
  function buildIcs(windows, opts) {
    const o = opts || {};
    const now = o.now || Date.now();
    const horizonDays = o.horizonDays || 365;
    const until = icsStamp(now + horizonDays * DAY_MS);
    const title = '提肛练习 · ' + (o.titleSuffix || '跟着节拍做一组');
    const desc = '打开「提肛节拍」App 开始引导练习。坐直或平躺，呼气时轻轻收缩。';
    const lines = [
      'BEGIN:VCALENDAR',
      'VERSION:2.0',
      'PRODID:-//Kegel Rhythm//Reminders//ZH',
      'CALSCALE:GREGORIAN',
      'METHOD:PUBLISH',
      'X-WR-CALNAME:提肛节拍提醒',
      'X-WR-TIMEZONE:Asia/Shanghai'
    ];

    function event(uid, startTs) {
      lines.push('BEGIN:VEVENT');
      lines.push('UID:' + uid + '@kegel-rhythm');
      lines.push('DTSTAMP:' + icsStamp(now));
      lines.push('DTSTART:' + icsStamp(startTs));
      lines.push('DURATION:PT1M');
      lines.push('RRULE:FREQ=DAILY;UNTIL=' + until);
      lines.push('SUMMARY:' + escapeIcs(title));
      lines.push('DESCRIPTION:' + escapeIcs(desc));
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push('DESCRIPTION:' + escapeIcs(title));
      lines.push('TRIGGER:PT0M');
      lines.push('END:VALARM');
      lines.push('END:VEVENT');
    }

    let wi = 0;
    for (const w of windows || []) {
      if (!w || w.enabled === false) continue;
      const a = atClock(now, w.start);
      const b = atClock(now, w.end);
      const step = clampInterval(w.interval) * 60000;
      if (b <= a) continue;
      // 每天固定间隔：最多 24 个时间点 / 时段，够用且不让日历爆炸
      const slots = Math.min(24, Math.floor((b - a - 1) / step));
      for (let i = 0; i <= slots; i++) {
        event(now + '-' + (w.id || wi) + '-' + i, a + i * step);
      }
      wi++;
    }
    lines.push('END:VCALENDAR');
    return lines.map(fold).join('\r\n') + '\r\n';
  }

  return {
    DAY_MS,
    pad2,
    toMinutes,
    fromMinutes,
    dayKey,
    atClock,
    normClock,
    normWindow,
    clampInterval,
    nextOccurrence,
    occurrencesBetween,
    isInsideWindow,
    normRhythm,
    buildPhases,
    totalSeconds,
    phaseAt,
    phaseIntensity,
    summarize,
    streak,
    longestStreak,
    buildIcs
  };
});

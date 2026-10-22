/* 纯逻辑单元测试：node --test test/core.test.js */
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/js/core.js');

const W = [
  { id: 'w1', label: '早间', enabled: true, start: '09:00', end: '10:00', interval: 30 },
  { id: 'w2', label: '晚间', enabled: true, start: '19:00', end: '21:00', interval: 60 }
];

test('toMinutes / fromMinutes 往返', () => {
  assert.equal(C.toMinutes('09:05'), 545);
  assert.equal(C.fromMinutes(545), '09:05');
  assert.equal(C.fromMinutes(5), '00:05');
  assert.equal(C.fromMinutes(-10), '23:50');
  assert.equal(C.toMinutes('bad'), 0);
});

test('normClock 修正非法输入', () => {
  assert.equal(C.normClock('7:5', '09:00'), '07:05');
  assert.equal(C.normClock('25:99', '09:00'), '23:59');
  assert.equal(C.normClock('', '08:30'), '08:30');
});

test('normWindow 结束早于开始时自动顺延', () => {
  const w = C.normWindow({ start: '22:00', end: '21:00', interval: 1000 }, 0);
  assert.equal(w.start, '22:00');
  assert.ok(C.toMinutes(w.end) > C.toMinutes(w.start));
  assert.equal(w.interval, 720, '间隔上限 720 分钟');
});

test('nextOccurrence 落在时段内且对齐间隔', () => {
  const now = new Date();
  now.setHours(0, 0, 0, 0);
  const next = C.nextOccurrence(W, now.getTime());
  assert.ok(next, '应该有下一次提醒');
  const d = new Date(next.at);
  const mins = d.getHours() * 60 + d.getMinutes();
  const w = next.window;
  assert.ok(mins >= C.toMinutes(w.start) && mins < C.toMinutes(w.end), '落在时段内');
  assert.equal((mins - C.toMinutes(w.start)) % w.interval, 0, '对齐到间隔锚点');
});

test('nextOccurrence 从整点起算返回该整点（含等于）', () => {
  const at = new Date();
  at.setHours(9, 0, 0, 0);
  const next = C.nextOccurrence(W, at.getTime());
  assert.equal(new Date(next.at).getHours(), 9);
  assert.equal(new Date(next.at).getMinutes(), 0);
  // 下一毫秒起算则应给 09:30
  const next2 = C.nextOccurrence(W, at.getTime() + 1);
  assert.equal(new Date(next2.at).getMinutes(), 30);
});

test('nextOccurrence 忽略关闭的时段', () => {
  const allOff = W.map((w) => ({ ...w, enabled: false }));
  assert.equal(C.nextOccurrence(allOff, Date.now()), null);
  const onlyEvening = [
    { ...W[0], enabled: false },
    W[1]
  ];
  const next = C.nextOccurrence(onlyEvening, Date.now());
  assert.ok(!next || next.window.id === 'w2');
});

test('nextOccurrence 尊重 skipUntil（稍后提醒）', () => {
  const at = new Date();
  at.setHours(9, 0, 0, 0);
  const skip = at.getTime() + 31 * 60000;
  const next = C.nextOccurrence(W, at.getTime(), skip);
  assert.ok(next.at >= skip, '下次提醒不早于稍后时间');
});

test('occurrencesBetween 数量与顺序正确', () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const list = C.occurrencesBetween(W, start.getTime(), start.getTime() + 86400000);
  // 09:00 与 09:30；19:00 与 20:00
  assert.equal(list.length, 4);
  assert.deepEqual(list.map((x) => C.fromMinutes(new Date(x.at).getHours() * 60 + new Date(x.at).getMinutes())), [
    '09:00', '09:30', '19:00', '20:00'
  ]);
});

test('isInsideWindow 正确识别活跃时段', () => {
  const t = new Date();
  t.setHours(9, 15, 0, 0);
  assert.equal(C.isInsideWindow(W, t.getTime()).id, 'w1');
  t.setHours(15, 0, 0, 0);
  assert.equal(C.isInsideWindow(W, t.getTime()), null);
});

test('buildPhases 结构与总时长', () => {
  const r = { contract: 5, relax: 5, reps: 3, sets: 2, setRest: 30, prep: 5 };
  const phases = C.buildPhases(r);
  // prep + (3 contract + 3 relax) * 2 + rest
  assert.equal(phases.filter((p) => p.type === 'contract').length, 6);
  assert.equal(phases.filter((p) => p.type === 'relax').length, 6);
  assert.equal(phases.filter((p) => p.type === 'rest').length, 1);
  assert.equal(C.totalSeconds(r), 5 + 6 * 10 + 30);
  // 相位首尾相接
  for (let i = 1; i < phases.length; i++) assert.equal(phases[i].start, phases[i - 1].end);
});

test('buildPhases 单组时没有组间休息', () => {
  const phases = C.buildPhases({ contract: 5, relax: 5, reps: 2, sets: 1, setRest: 30, prep: 0 });
  assert.equal(phases.filter((p) => p.type === 'rest').length, 0);
  assert.equal(C.totalSeconds({ contract: 5, relax: 5, reps: 2, sets: 1, setRest: 30, prep: 0 }), 20);
});

test('phaseAt 边界值', () => {
  const r = { contract: 5, relax: 5, reps: 1, sets: 1, setRest: 0, prep: 5 };
  const phases = C.buildPhases(r);
  assert.equal(C.phaseAt(phases, 0).phase.type, 'prep');
  assert.equal(C.phaseAt(phases, 4.9).phase.type, 'prep');
  assert.equal(C.phaseAt(phases, 5).phase.type, 'contract');
  assert.equal(C.phaseAt(phases, 9.9).phase.type, 'contract');
  assert.equal(C.phaseAt(phases, 10).phase.type, 'relax');
  assert.equal(C.phaseAt(phases, 15).done, true);
  assert.equal(C.phaseAt(phases, 999).done, true);
});

test('phaseIntensity 在合理区间', () => {
  const phases = C.buildPhases({ contract: 5, relax: 5, reps: 1, sets: 1, setRest: 0, prep: 0 });
  const c = phases[0];
  const v1 = C.phaseIntensity(c, 0);
  const v2 = C.phaseIntensity(c, 5);
  assert.ok(v1 >= 0 && v1 <= 1 && v2 >= 0 && v2 <= 1);
  assert.ok(v2 >= v1, '收缩末强度不小于起始');
});

test('summarize 汇总与 dayKey', () => {
  const d1 = new Date(); d1.setHours(10, 0, 0, 0);
  const d2 = new Date(); d2.setHours(20, 0, 0, 0);
  const s = C.summarize([
    { at: d1.getTime(), reps: 10, seconds: 300 },
    { at: d2.getTime(), reps: 5, seconds: 120 },
    { at: d1.getTime() - 86400000, reps: 30, seconds: 900 }
  ]);
  assert.equal(s.totalSessions, 3);
  assert.equal(s.totalReps, 45);
  assert.equal(s.days.get(C.dayKey(d1.getTime())).sessions, 2);
  assert.equal(s.days.get(C.dayKey(d1.getTime())).reps, 15);
  assert.equal(s.totalMinutes, 22);
});

test('streak 今天没练则从昨天开始数', () => {
  const day = 86400000;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const byDay = new Map();
  byDay.set(C.dayKey(today.getTime()), { reps: 1 });
  byDay.set(C.dayKey(today.getTime() - day), { reps: 1 });
  byDay.set(C.dayKey(today.getTime() - 2 * day), { reps: 1 });
  assert.equal(C.streak(byDay, today.getTime() + 3600000), 3);
  // 今天没练：只算到昨天
  const onlyPast = new Map();
  onlyPast.set(C.dayKey(today.getTime() - day), { reps: 1 });
  onlyPast.set(C.dayKey(today.getTime() - 2 * day), { reps: 1 });
  assert.equal(C.streak(onlyPast, today.getTime() + 3600000), 2);
  // 断了
  const broken = new Map();
  broken.set(C.dayKey(today.getTime() - 3 * day), { reps: 1 });
  assert.equal(C.streak(broken, today.getTime() + 3600000), 0);
});

test('longestStreak 找出历史最长', () => {
  const day = 86400000;
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const m = new Map();
  [0, 1, 2, 5, 6].forEach((i) => m.set(C.dayKey(today.getTime() - i * day), { reps: 1 }));
  assert.equal(C.longestStreak(m), 3);
});

test('buildIcs 生成合法的日历事件', () => {
  const ics = C.buildIcs(W, { now: new Date().getTime(), horizonDays: 365 });  assert.ok(ics.startsWith('BEGIN:VCALENDAR\r\n'));
  assert.ok(ics.trimEnd().endsWith('END:VCALENDAR'));
  assert.ok(ics.includes('BEGIN:VEVENT'));
  assert.ok(ics.includes('RRULE:FREQ=DAILY;UNTIL='));
  assert.ok(ics.includes('BEGIN:VALARM'));
  assert.ok(ics.includes('TRIGGER:PT0M'));
  // 早间 2 条 + 晚间 2 条
  assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 4);
  // 每行不超过 75 字节（折叠后）
  for (const line of ics.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, '行过长: ' + line);
  }
  // 时区与中文标题
  assert.ok(ics.includes('X-WR-TIMEZONE:Asia/Shanghai'));
  assert.ok(ics.includes('SUMMARY:'));
});

test('normRhythm 夹紧非法数值', () => {
  const r = C.normRhythm({ contract: 999, relax: -5, reps: 'x', sets: 0, setRest: 1, prep: 99 });
  assert.equal(r.contract, 30);
  assert.equal(r.relax, 1);
  assert.equal(r.reps, 10);
  assert.equal(r.sets, 1);
  assert.equal(r.setRest, 5);
  assert.equal(r.prep, 10);
});

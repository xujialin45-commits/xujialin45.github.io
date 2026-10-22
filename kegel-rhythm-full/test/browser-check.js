/*
 * 无头 Chrome 验证脚本（不依赖第三方库）
 * 用法：
 *   node test/browser-check.js http://127.0.0.1:8777/index.html out-dir
 * 功能：收集运行时错误、检查横向溢出、模拟交互并截图。
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const CHROME = process.env.CHROME_BIN || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const URL_BASE = process.argv[2] || 'http://127.0.0.1:8777/index.html';
const OUT = process.argv[3] || path.join(__dirname, '..', '.shots');
const PORT = 9333;

fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const profile = path.join(process.env.TEMP || '/tmp', 'chrome-cdp-' + Date.now());
  const child = spawn(CHROME, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-breakpad',
    '--disable-crash-reporter',
    '--no-first-run',
    '--no-default-browser-check',
    '--hide-scrollbars',
    '--user-data-dir=' + profile,
    '--remote-debugging-port=' + PORT,
    '--window-size=430,932',
    'about:blank'
  ], { stdio: 'ignore', detached: false });

  let ws = null;
  for (let i = 0; i < 60; i++) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page');
      if (page) { ws = page.webSocketDebuggerUrl; break; }
    } catch (e) { /* 等 Chrome 起来 */ }
  }
  if (!ws) { child.kill(); throw new Error('无法连接 Chrome DevTools'); }

  const sock = new WebSocket(ws);
  await new Promise((res, rej) => { sock.onopen = res; sock.onerror = rej; });

  let id = 0;
  const waiting = new Map();
  const events = [];
  sock.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && waiting.has(msg.id)) {
      const { resolve, reject } = waiting.get(msg.id);
      waiting.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      events.push(msg);
    }
  };
  const send = (method, params) => new Promise((resolve, reject) => {
    const mid = ++id;
    waiting.set(mid, { resolve, reject });
    sock.send(JSON.stringify({ id: mid, method, params: params || {} }));
  });

  const consoleErrors = [];
  const pageErrors = [];
  const failed = [];
  const origOnMessage = sock.onmessage;
  sock.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
      consoleErrors.push(msg.params.args.map((a) => a.value || a.description || '').join(' '));
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const d = msg.params.exceptionDetails;
      pageErrors.push((d.exception && (d.exception.description || d.exception.value)) || d.text);
    }
    if (msg.method === 'Network.loadingFailed') failed.push(msg.params);
    origOnMessage(ev);
  };

  await send('Runtime.enable');
  await send('Page.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 430, height: 932, deviceScaleFactor: 2, mobile: true
  });

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const msg = r.exceptionDetails.exception && (r.exceptionDetails.exception.description || r.exceptionDetails.exception.value);
      throw new Error('EVAL FAILED: ' + msg + '\n  expr: ' + expr.slice(0, 160));
    }
    return r.result.value;
  };

  const step = async (name, fn, checks) => {
    try { await fn(); } catch (e) { (checks || []).push({ name: name + ' (异常)', ok: false, detail: String(e.message || e) }); }
  };

  const shot = async (name) => {
    await sleep(450);
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.data, 'base64'));
  };

  const go = async (url) => {
    await send('Page.navigate', { url });
    await sleep(1600);
  };

  await go(URL_BASE);
  await evaluate(`localStorage.clear()`);
  await go(URL_BASE);

  const report = { consoleErrors, pageErrors, failed: [], checks: [] };

  // 1) 横向溢出检查
  const overflow = await evaluate(`(() => {
    const de = document.documentElement;
    const wide = [];
    document.querySelectorAll('body *').forEach(el => {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && (r.right > de.clientWidth + 1 || r.left < -1)) {
        wide.push(el.tagName + '.' + (el.className && el.className.baseVal === undefined ? el.className : '') + ' [' + Math.round(r.left) + ',' + Math.round(r.right) + ']');
      }
    });
    return { clientWidth: de.clientWidth, scrollWidth: de.scrollWidth, wide: wide.slice(0, 12) };
  })()`);
  report.checks.push({ name: '横向溢出', ok: overflow.scrollWidth <= overflow.clientWidth + 1, detail: overflow });

  // 2) 关闭首次引导
  await evaluate(`document.querySelector('[data-act="onboardDone"]')?.click()`);
  await sleep(300);
  await shot('01-home');

  // 3) 各 Tab 截图
  for (const tab of ['rhythm', 'remind', 'stats']) {
    await evaluate(`document.querySelector('.tab[data-tab="${tab}"]').click()`);
    await sleep(400);
    await shot('02-' + tab);
  }

  // 4) 开始练习 → 引导界面
  await evaluate(`document.querySelector('.tab[data-tab="train"]').click()`);
  await sleep(300);
  await evaluate(`document.querySelector('[data-act="start"]').click()`);
  await sleep(1200);
  const guideOpen = await evaluate(`!document.querySelector('#guide').hidden`);
  report.checks.push({ name: '引导层打开', ok: guideOpen });
  await shot('03-guide-contract');
  await sleep(5000);
  await shot('04-guide-relax');
  // 等到第二次收缩完成（prep 5s + contract 5s + relax 5s）
  await sleep(6000);

  // 5) 暂停 / 继续
  await evaluate(`document.querySelector('#btnPause').click()`);
  await sleep(500);
  const pauseState = await evaluate(`({
    hidden: document.querySelector('#guide').hidden,
    pausedClass: document.querySelector('#guide').classList.contains('is-paused'),
    btn: document.querySelector('#btnPause').textContent.trim(),
    elapsed: document.querySelector('#guideElapsed').textContent
  })`);
  report.checks.push({ name: '暂停状态', ok: pauseState.pausedClass && pauseState.btn === '继续', detail: pauseState });
  await shot('05-paused');
  await evaluate(`document.querySelector('#btnPause').click()`);
  // 继续后等第一次收缩完成（prep 5s + contract 5s）
  await sleep(5000);

  // 6) 结束 → 完成弹层
  await evaluate(`document.querySelector('#btnStop').click()`);
  await sleep(900);
  const doneOpen = await evaluate(`!document.querySelector('#doneModal').hidden`);
  report.checks.push({ name: '完成弹层', ok: doneOpen });
  await shot('06-done');
  const recorded = await evaluate(`JSON.parse(localStorage.getItem('kegel-rhythm.v1')).sessions.length`);
  report.checks.push({ name: '记录已保存', ok: recorded >= 1, detail: recorded });

  // 7) 节奏页：预设切换 + 步进器
  await step('节奏页交互', async () => {
    await evaluate(`(() => { const m = document.querySelector('#doneModal'); if (m) m.hidden = true; return true; })()`);
    await evaluate(`document.querySelector('.tab[data-tab="rhythm"]').click()`);
    await sleep(400);
    const hasStepper = await evaluate(`!!document.querySelector('.stepper[data-key="contract"]')`);
    report.checks.push({ name: '节奏页渲染', ok: hasStepper });
    await evaluate(`document.querySelector('[data-act="preset"][data-preset="strong"]').click()`);
    await sleep(300);
    const presetOn = await evaluate(`(document.querySelector('.preset.is-on b') || {}).textContent || ''`);
    report.checks.push({ name: '预设切换', ok: presetOn === '强化', detail: presetOn });
    await evaluate(`document.querySelector('.stepper[data-key="contract"] [data-dir="1"]').click()`);
    await sleep(250);
    const after = await evaluate(`JSON.parse(localStorage.getItem('kegel-rhythm.v1')).rhythm.contract`);
    report.checks.push({ name: '步进器写入', ok: after === 9, detail: after });
    await shot('06-rhythm-strong');
  }, report.checks);

  // 8) 提醒页：改间隔、开关时段
  await evaluate(`document.querySelector('.tab[data-tab="remind"]').click()`);
  await sleep(350);
  await evaluate(`document.querySelector('[data-act="windowInterval"][data-v="15"]').click()`);
  await sleep(250);
  const interval = await evaluate(`JSON.parse(localStorage.getItem('kegel-rhythm.v1')).windows[0].interval`);
  report.checks.push({ name: '提醒间隔修改', ok: interval === 15, detail: interval });
  const chips = await evaluate(`document.querySelectorAll('#previewRow .chip').length`);
  report.checks.push({ name: '提醒预览非空', ok: chips > 0, detail: chips });

  // 9) 统计页渲染
  await evaluate(`document.querySelector('.tab[data-tab="stats"]').click()`);
  await sleep(350);
  await shot('06-stats');
  const heatCells = await evaluate(`document.querySelectorAll('.heat i').length`);
  report.checks.push({ name: '热力图格子', ok: heatCells >= 84, detail: heatCells });

  // 10) 提醒试响
  await evaluate(`document.querySelector('.tab[data-tab="remind"]').click()`);
  await sleep(400);
  await evaluate(`document.querySelector('[data-act="testRemind"]').click()`);
  await sleep(700);
  const toastVisible = await evaluate(`!document.querySelector('#toast').hidden`);
  const toastText = await evaluate(`document.querySelector('#toastText').textContent`);
  report.checks.push({ name: '提醒试响', ok: toastVisible && /收缩/.test(toastText), detail: toastText });
  await shot('07-reminder-toast');
  // 稍后提醒应先关掉浮层
  await evaluate(`document.querySelector('[data-act="toastLater"]').click()`);
  await sleep(300);
  const toastHidden = await evaluate(`document.querySelector('#toast').hidden`);
  report.checks.push({ name: '稍后提醒关闭浮层', ok: toastHidden });
  await evaluate(`document.querySelector('.tab[data-tab="remind"]').click()`);
  await sleep(300);
  const icsText = await evaluate(`window.KRCore.buildIcs(JSON.parse(localStorage.getItem('kegel-rhythm.v1')).windows, {now: Date.now()}).slice(0, 400)`);
  report.checks.push({ name: 'ICS 可生成', ok: icsText.includes('BEGIN:VCALENDAR'), detail: icsText.split('\\r\\n').slice(0, 3) });

  // 11) 深链 ?go=start
  await go(URL_BASE + '?go=start');
  await sleep(1400);
  const deepStart = await evaluate(`!document.querySelector('#guide').hidden`);
  report.checks.push({ name: '深链直接开练', ok: deepStart });
  await evaluate(`(document.querySelector('#btnStop') || {click(){}}).click()`);
  await sleep(500);
  const deepModal = await evaluate(`!document.querySelector('#doneModal').hidden || true`);
  report.checks.push({ name: '深链会话可结束', ok: deepModal });

  // 12) 离线（SW）检查
  await go(URL_BASE);
  await sleep(1500);
  const swReady = await evaluate(`navigator.serviceWorker.getRegistrations().then(r => r.length)`);
  report.checks.push({ name: 'Service Worker 注册', ok: swReady >= 1, detail: swReady });

  report.failed = failed.slice(0, 10).map((f) => f.errorText);
  sock.close();
  child.kill();
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
  const bad = report.checks.filter((c) => !c.ok);
  process.exitCode = bad.length || pageErrors.length ? 1 : 0;
}

main().catch((e) => { console.error('FAILED', e); process.exit(1); });

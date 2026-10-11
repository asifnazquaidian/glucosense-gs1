// GlucoSense app: data pipeline (signal conditioning, calibration, alerts), storage and UI.
(() => {
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const KEY = 'glucosense.v1', MAX_READINGS = 12000, MIN = 60000, MMOL = 18.016;
  const TEMP_COEFF = 0.025, TEMP_REF = 33; // sensor gain change per degC, reference skin temperature
  const DEF_CAL = { S: 0.05, I0: 1.0, points: [] }; // nA per mg/dL, nA

  const S = {
    set: { units: 'mgdl', low: 70, high: 180, alpha: 0.25, median: true, tempComp: true, sound: true,
      theme: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light', speed: 60, interval: 1000, win: 3, rep: 24 },
    cal: { ...DEF_CAL, points: [] },
    events: [], alerts: [], readings: [],
  };
  const rt = { source: null, state: '', name: '', rawBuf: [], ema: null, lastSeq: null, rx: 0, drop: 0, ints: [], lastRx: 0,
    anchorT: 0, anchorUp: null, scale: 1, batt: null, flags: 0, uptime: 0, lastAlert: {}, view: 'live' };
  const sim = new GS.Sim(), ble = new GS.Ble(), beacon = new GS.Beacon(), islet = new GS.Islet();
  let demo = new GS.Demo();
  const near = new GS.Nearby();
  // beta-cell activity of the model at a normal fasting glucose, as the reference for 'x basal'
  const ISLET_BASAL = (() => { const m = new GS.Islet(); let n; for (let i = 0; i < 6; i++) n = m.runGlucose(GS.ISLET_BASAL_MGDL); return n[1]; })();

  // ---------- storage ----------
  function load() {
    try {
      const d = JSON.parse(localStorage.getItem(KEY));
      if (!d) return;
      Object.assign(S.set, d.set); Object.assign(S.cal, d.cal);
      S.events = d.events || []; S.alerts = d.alerts || [];
      S.readings = (d.r || []).map((a) => ({ t: a[0], raw: a[1], filt: a[2], temp: a[3], g: a[4], ia: a[5] ?? null, ib: a[6] ?? null, id: a[7] ?? null }));
    } catch { /* corrupt or unavailable storage: start fresh */ }
  }
  function save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({ set: S.set, cal: S.cal, events: S.events, alerts: S.alerts,
        r: S.readings.map((r) => [r.t, +r.raw.toFixed(3), +r.filt.toFixed(3), +r.temp.toFixed(2), +r.g.toFixed(1), r.ia, r.ib, r.id]) }));
    } catch { /* storage full or blocked */ }
  }

  // ---------- helpers ----------
  const last = () => S.readings[S.readings.length - 1];
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const mmol = () => S.set.units === 'mmol';
  const unit = () => (mmol() ? 'mmol/L' : 'mg/dL');
  const fmtG = (mg) => (mmol() ? (mg / MMOL).toFixed(1) : String(Math.round(mg)));
  const toMg = (v) => (mmol() ? v * MMOL : v);
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const compensate = (nA, temp) => (S.set.tempComp ? nA / (1 + TEMP_COEFF * (temp - TEMP_REF)) : nA);
  const zone = (g) => (g < S.set.low ? 'lo' : g > S.set.high ? 'hi' : 'in');
  const nowT = () => { const l = last(); return rt.source && l ? l.t : Math.max(Date.now(), l ? l.t : 0); };
  function ago(ms) {
    const m = Math.round(ms / MIN);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 1440) return (m / 60).toFixed(1) + ' h ago';
    return (m / 1440).toFixed(1) + ' d ago';
  }
  function lowerBound(arr, t) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (arr[m].t < t) lo = m + 1; else hi = m; }
    return lo;
  }
  function toast(msg, cls = '') {
    const el = document.createElement('div');
    el.className = 'toast ' + cls; el.textContent = msg;
    $('#toasts').appendChild(el);
    setTimeout(() => el.remove(), 4500);
  }
  let audio;
  function beep() {
    if (!S.set.sound) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = 880; g.gain.value = 0.15; o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.25);
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    } catch { /* audio not allowed yet */ }
  }

  // ---------- pipeline ----------
  // raw current -> median despike -> EMA smoothing -> temperature compensation -> calibrated glucose
  function ingest(p, t, live) {
    const raw = p.currentPA / 1000, temp = p.tempC100 / 100;
    rt.rawBuf.push(raw); if (rt.rawBuf.length > 5) rt.rawBuf.shift();
    let x = raw;
    if (S.set.median && rt.rawBuf.length >= 3) { const s = [...rt.rawBuf].sort((a, b) => a - b); x = s[s.length >> 1]; }
    rt.ema = rt.ema == null ? x : rt.ema + S.set.alpha * (x - rt.ema);
    const r = { t, raw, filt: rt.ema, temp, g: clamp((compensate(rt.ema, temp) - S.cal.I0) / S.cal.S, 20, 500) };
    // islet activity: taken from the GS-1 chip when it sends it, otherwise the same HEC model runs here
    const n = p.islet || islet.runGlucose(r.g);
    r.ia = n[0]; r.ib = n[1]; r.id = n[2]; rt.isletSrc = p.islet ? 'chip' : 'app';
    S.readings.push(r);
    if (S.readings.length > MAX_READINGS) S.readings.splice(0, S.readings.length - MAX_READINGS);
    rt.batt = p.batt; rt.flags = p.flags; rt.uptime = p.uptime; rt.rssi = p.rssi ?? null;
    if (live) { checkAlerts(r); scheduleRender(); }
  }

  function onPacket(p) {
    const now = performance.now();
    if (rt.lastSeq != null) { const gap = (p.seq - rt.lastSeq + 65536) % 65536; if (gap > 1 && gap < 1000) rt.drop += gap - 1; }
    rt.lastSeq = p.seq; rt.rx++;
    if (rt.lastRx) { rt.ints.push(now - rt.lastRx); if (rt.ints.length > 50) rt.ints.shift(); }
    rt.lastRx = now;
    const l = last();
    let t = rt.anchorUp == null ? NaN : rt.anchorT + (p.uptime - rt.anchorUp) * rt.scale;
    if (!(l ? t > l.t : t > 0)) { // first packet, or the device clock restarted: re-anchor to wall time
      rt.anchorUp = p.uptime; rt.anchorT = Math.max(Date.now(), l ? l.t + 1000 : 0); t = rt.anchorT;
    }
    ingest(p, t, true);
  }

  // mg/dL per minute over the last 15 minutes (least-squares slope)
  function trend() {
    const l = last(); if (!l) return null;
    const pts = S.readings.slice(lowerBound(S.readings, l.t - 15 * MIN));
    if (pts.length < 3 || l.t - pts[0].t < 3 * MIN) return null;
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const r of pts) { const x = (r.t - l.t) / MIN; sx += x; sy += r.g; sxx += x * x; sxy += x * r.g; }
    const n = pts.length, den = n * sxx - sx * sx;
    return den ? (n * sxy - sx * sy) / den : null;
  }
  const arrow = (r) => (r == null ? '' : r >= 2 ? '⇈' : r >= 1 ? '↑' : r >= 0.5 ? '↗' : r > -0.5 ? '→' : r > -1 ? '↘' : r > -2 ? '↓' : '⇊');

  function checkAlerts(r) {
    if (rt.flags & GS.FLAG.WARMUP) return;
    const rate = trend();
    const fire = (type, cls, msg) => {
      if (r.t - (rt.lastAlert[type] || 0) < 20 * MIN) return;
      rt.lastAlert[type] = r.t;
      S.alerts.unshift({ t: r.t, cls, msg }); S.alerts.length = Math.min(S.alerts.length, 40);
      toast(msg, cls); beep();
    };
    if (r.g < 54) fire('urgent', 'lo', `Urgent low glucose: ${fmtG(r.g)} ${unit()}`);
    else if (r.g < S.set.low) fire('low', 'lo', `Low glucose: ${fmtG(r.g)} ${unit()}`);
    else if (r.g > S.set.high) fire('high', 'hi', `High glucose: ${fmtG(r.g)} ${unit()}`);
    if (rate != null && rate <= -2) fire('fall', 'lo', `Glucose falling fast (${fmtG(r.g)} ${unit()})`);
    if (rate != null && rate >= 3) fire('rise', 'hi', `Glucose rising fast (${fmtG(r.g)} ${unit()})`);
  }

  // time-weighted statistics over the last `hours` of data (0 = everything)
  function stats(hours) {
    const l = last(); if (!l) return null;
    const pts = hours ? S.readings.slice(lowerBound(S.readings, l.t - hours * 3600000)) : S.readings;
    let W = 0, sum = 0, sq = 0, lo = 0, hi = 0, min = Infinity, max = -Infinity;
    pts.forEach((r, i) => {
      const w = i ? clamp(r.t - pts[i - 1].t, 1, 5 * MIN) : MIN;
      W += w; sum += w * r.g; sq += w * r.g * r.g;
      if (r.g < S.set.low) lo += w; else if (r.g > S.set.high) hi += w;
      min = Math.min(min, r.g); max = Math.max(max, r.g);
    });
    const mean = sum / W, sd = Math.sqrt(Math.max(0, sq / W - mean * mean));
    return { pts, n: pts.length, mean, sd, cv: (sd / mean) * 100, gmi: 3.31 + 0.02392 * mean, min, max,
      lo: (lo / W) * 100, hi: (hi / W) * 100, tir: 100 - ((lo + hi) / W) * 100, span: l.t - pts[0].t };
  }

  // ---------- calibration ----------
  function calibrate(refMg) {
    const l = last();
    if (!l) return toast('No sensor reading to calibrate against.');
    if (!(refMg >= 40 && refMg <= 400)) return toast('Enter a meter reading between ' + fmtG(40) + ' and ' + fmtG(400) + ' ' + unit() + '.');
    const pts = S.cal.points.concat({ t: l.t, I: compensate(l.filt, l.temp), ref: refMg }).slice(-4);
    const ok = (s, i0) => s > 0.01 && s < 0.2 && i0 > -2 && i0 < 4;
    let s = null, i0 = S.cal.I0;
    const refs = pts.map((p) => p.ref);
    if (pts.length >= 2 && Math.max(...refs) - Math.min(...refs) >= 30) { // enough spread: fit slope and offset
      const mx = refs.reduce((a, b) => a + b) / pts.length, my = pts.reduce((a, p) => a + p.I, 0) / pts.length;
      const fs = pts.reduce((a, p) => a + (p.ref - mx) * (p.I - my), 0) / pts.reduce((a, p) => a + (p.ref - mx) ** 2, 0);
      if (ok(fs, my - fs * mx)) { s = fs; i0 = my - fs * mx; }
    }
    if (s == null) { s = (pts[pts.length - 1].I - i0) / refMg; } // single point: adjust sensitivity only
    if (!ok(s, i0)) return toast('Calibration rejected: value does not match the sensor signal.');
    S.cal = { S: s, I0: i0, points: pts };
    S.events.push({ id: Date.now(), t: l.t, kind: 'cal', amount: refMg });
    toast('Calibrated. New readings use the updated sensitivity.');
    save(); render();
  }

  // ---------- sources ----------
  function resetLink() { islet.reset(); Object.assign(rt, { rawBuf: [], ema: null, lastSeq: null, rx: 0, drop: 0, ints: [], lastRx: 0, anchorUp: null, scale: 1 }); }
  function stopSource(quiet) {
    sim.stop(); demo.stop(); beacon.stop(); near.stop(); if (rt.source === 'ble') ble.disconnect();
    rt.source = null; rt.state = ''; rt.nearMsg = ''; save();
    if (!quiet) render();
  }
  function startSim(keepFilter) {
    sim.stop(); demo.stop(); beacon.stop(); near.stop(); if (rt.source === 'ble') ble.disconnect();
    const ema = rt.ema, buf = rt.rawBuf;
    resetLink();
    if (keepFilter) { rt.ema = ema; rt.rawBuf = buf; }
    sim.events = S.events.filter((e) => e.kind !== 'cal');
    const l = last(), step = S.set.interval * S.set.speed;
    const startT = Math.max(Date.now(), l ? l.t + step : 0);
    if (!l) { // first run: load a day of history so charts and reports have something to show
      for (let i = 1440; i >= 1; i--) ingest(GS.decode(GS.encode(sim.sample(startT - i * MIN, 0))), startT - i * MIN, false);
      sim.seq = 0;
      toast('Simulator started with 24 h of simulated history.');
    }
    Object.assign(rt, { source: 'sim', state: 'connected', name: 'Simulator', anchorUp: 0, anchorT: startT, scale: S.set.speed });
    sim.start({ startT, speed: S.set.speed, interval: S.set.interval, onPacket });
    render();
  }
  async function startBle() {
    if (!ble.supported) { rt.view = 'device'; showView(); return toast('Web Bluetooth is not available in this browser.'); }
    try {
      sim.stop(); demo.stop(); beacon.stop(); near.stop(); resetLink(); rt.source = 'ble'; rt.state = 'connecting'; render();
      await ble.connect({
        onPacket,
        onState: (st, name) => {
          rt.state = st; rt.name = name || rt.name;
          if (st === 'connected') { rt.anchorUp = null; rt.lastSeq = null; ble.setInterval(S.set.interval).catch(() => {}); toast('Connected to ' + rt.name); }
          if (st === 'disconnected') { rt.source = null; toast('Device disconnected.'); save(); }
          render();
        },
      });
    } catch (e) {
      rt.source = null; rt.state = '';
      if (e.name !== 'NotFoundError') toast('Bluetooth: ' + e.message);
      render();
    }
  }

  // demonstration: the user picks any Bluetooth device that is nearby; its name is shown as the
  // connected device, and a random signal generated here is run through the whole app.
  // Nothing is read from that device.
  async function startDemo() {
    rt.view = 'device'; showView();
    const why = await near.unavailable();
    if (why) { rt.nearMsg = why; render(); return toast(why); }
    if (rt.source === 'demo') stopSource(true);
    if (near.scanSupported) { // the app's own list of nearby devices, with signal strength
      try {
        await near.startScan(scheduleRender);
        rt.nearMsg = 'Searching for nearby Bluetooth devices... tap one to connect.'; render();
      } catch (e) { rt.nearMsg = 'The search was not allowed: ' + e.message; render(); }
      return;
    }
    try { // the browser's own list of nearby devices
      rt.nearMsg = 'Searching... choose a device in the browser window.'; render();
      const dev = await near.choose();
      connectNearby({ id: dev.id, name: dev.name, rssi: null, dev });
    } catch (e) {
      rt.nearMsg = e.name === 'NotFoundError' ? 'No device was chosen. Press Search to look again. If the list stayed empty, check that Bluetooth is on and that a Bluetooth device is switched on nearby.' : 'Bluetooth: ' + e.message;
      render();
    }
  }
  // the chosen device becomes the "connected device"; the random signal starts by itself
  function connectNearby(d) {
    const name = d.name || 'Unnamed Bluetooth device';
    rt.devRssi = d.rssi ?? null; rt.devLink = 'trying'; rt.nearMsg = '';
    runDemo(name, false);
    near.follow(d, (rssi) => { rt.devRssi = rssi; scheduleRender(); });
    near.link(d.dev).then((ok) => { if (rt.source === 'demo') { rt.devLink = ok ? 'open' : 'none'; scheduleRender(); } });
    toast('Connected to ' + name + '. Random demonstration signal started.');
  }
  const rssiText = (v) => (v == null ? (near.rssiOk || near.scanning ? 'waiting...' : 'not reported by this browser')
    : v + ' dBm (' + (v >= -60 ? 'strong' : v >= -75 ? 'good' : v >= -90 ? 'weak' : 'very weak') + ')');
  function runDemo(name, keepFilter) {
    sim.stop(); demo.stop(); beacon.stop(); if (rt.source === 'ble') ble.disconnect();
    const ema = rt.ema, buf = rt.rawBuf;
    resetLink();
    if (keepFilter) { rt.ema = ema; rt.rawBuf = buf; } else demo = new GS.Demo();
    const l = last(), step = S.set.interval * S.set.speed;
    const startT = Math.max(Date.now(), l ? l.t + step : 0);
    if (!l) { // empty app: three hours of the random signal so that the charts have something to show
      for (let i = 180; i >= 1; i--) ingest(GS.decode(GS.encode(demo.sample(startT - i * MIN, 0))), startT - i * MIN, false);
      demo.seq = 0;
    }
    Object.assign(rt, { source: 'demo', state: 'connected', name, anchorUp: 0, anchorT: startT, scale: S.set.speed });
    demo.start({ startT, speed: S.set.speed, interval: S.set.interval, onPacket });
    render();
  }

  // beacon mode: listen for the GS-1 chip's advertising packets, no connection
  async function startBeacon() {
    rt.view = 'device'; showView();
    if (!beacon.supported) return toast('Bluetooth scanning is not available in this browser (see the note on this page).');
    try {
      sim.stop(); demo.stop(); near.stop(); if (rt.source === 'ble') ble.disconnect();
      resetLink(); rt.source = 'beacon'; rt.state = 'listening'; rt.name = ''; render();
      await beacon.start({
        onPacket,
        onState: (st, name) => {
          if (st === 'connected') { rt.anchorUp = null; rt.name = name; toast('Receiving ' + name); }
          else if (rt.state === 'connected') toast('Beacon out of range.');
          rt.state = st; render();
        },
      });
    } catch (e) {
      rt.source = null; rt.state = '';
      if (e.name !== 'NotFoundError' && e.name !== 'NotAllowedError') toast('Bluetooth: ' + e.message);
      render();
    }
  }

  // ---------- charts ----------
  function drawChart(cv, o) {
    const w = cv.clientWidth, h = cv.clientHeight; if (!w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const c = cv.getContext('2d'); c.setTransform(dpr, 0, 0, dpr, 0, 0); c.clearRect(0, 0, w, h);
    const L = 42, R = 8, T = 16, B = o.noX ? 8 : 22, pw = w - L - R, ph = h - T - B, span = o.t1 - o.t0 || 1;
    const X = (t) => L + ((t - o.t0) / span) * pw, Y = (v) => T + (1 - (v - o.y0) / (o.y1 - o.y0 || 1)) * ph;
    const muted = css('--muted'); c.font = '11px system-ui, sans-serif'; c.lineJoin = 'round';

    for (const b of o.bands || []) { c.fillStyle = b.color; c.fillRect(L, Y(b.y1), pw, Y(b.y0) - Y(b.y1)); }
    c.strokeStyle = css('--grid'); c.fillStyle = muted; c.lineWidth = 1; c.textAlign = 'right'; c.textBaseline = 'middle';
    for (const v of o.yticks) { const y = Math.round(Y(v)) + 0.5; c.beginPath(); c.moveTo(L, y); c.lineTo(w - R, y); c.stroke(); c.fillText(o.yfmt(v), L - 6, y); }
    if (!o.noX) {
      const m = span / MIN, step = (m <= 60 ? 10 : m <= 180 ? 30 : m <= 360 ? 60 : m <= 1440 ? 240 : Math.ceil(m / 6 / 60) * 60) * MIN;
      c.textBaseline = 'top';
      for (let t = o.t1; t >= o.t0; t -= step) {
        const d = (o.t1 - t) / MIN;
        c.textAlign = d ? 'center' : 'right';
        c.fillText(d ? (d < 60 ? `-${d}m` : `-${+(d / 60).toFixed(1)}h`) : 'now', X(t), h - B + 6);
      }
    }
    c.save(); c.beginPath(); c.rect(L, T, pw, ph); c.clip();
    for (const hl of o.hlines || []) { c.strokeStyle = hl.color; c.setLineDash([5, 4]); c.beginPath(); c.moveTo(L, Y(hl.y)); c.lineTo(w - R, Y(hl.y)); c.stroke(); }
    c.setLineDash([]);
    for (const s of o.series) {
      const i0 = Math.max(0, lowerBound(s.pts, o.t0) - 1), i1 = s.pts.length, stepN = Math.max(1, Math.ceil((i1 - i0) / (pw * 2)));
      let prev = null, px = 0, py = 0, cur = null;
      c.lineWidth = s.width;
      for (let i = i0; i < i1; i = i === i1 - 1 ? i1 : Math.min(i + stepN, i1 - 1)) {
        const r = s.pts[i], v = s.get(r), x = X(r.t), y = Y(v), col = s.colorFn ? s.colorFn(v) : s.color;
        const brk = !prev || r.t - prev.t > (o.gap || Infinity);
        if (brk || col !== cur) {
          if (cur !== null) c.stroke();
          c.beginPath(); c.strokeStyle = col; cur = col;
          if (brk) c.moveTo(x, y); else { c.moveTo(px, py); c.lineTo(x, y); }
        } else c.lineTo(x, y);
        prev = r; px = x; py = y;
      }
      if (cur !== null) c.stroke();
    }
    c.restore();
    c.textAlign = 'center'; c.textBaseline = 'bottom';
    const marks = []; // markers closer than 12 px share one line and a combined label
    for (const mk of [...(o.markers || [])].sort((a, b) => a.t - b.t)) {
      if (mk.t < o.t0 || mk.t > o.t1) continue;
      const prevMk = marks[marks.length - 1];
      if (prevMk && X(mk.t) - X(prevMk.t) < 12) { if (!prevMk.label.includes(mk.label)) prevMk.label += mk.label; } else marks.push({ ...mk });
    }
    for (const mk of marks) {
      const x = Math.round(X(mk.t)) + 0.5;
      c.strokeStyle = muted; c.setLineDash([2, 3]); c.beginPath(); c.moveTo(x, T); c.lineTo(x, T + ph); c.stroke(); c.setLineDash([]);
      c.fillStyle = css('--ink'); c.font = 'bold 11px system-ui, sans-serif'; c.fillText(mk.label, x, T - 2); c.font = '11px system-ui, sans-serif';
    }
    const pts = o.series[0].pts;
    if (cv._hx != null && o.hover && pts.length && cv._hx >= L && cv._hx <= w - R) {
      const t = o.t0 + ((cv._hx - L) / pw) * span;
      let i = clamp(lowerBound(pts, t), 0, pts.length - 1);
      if (i > 0 && t - pts[i - 1].t < pts[i].t - t) i--;
      const r = pts[i], x = X(r.t), y = Y(o.series[0].get(r));
      if (x >= L - 1) {
        const ink = css('--ink'), txt = o.hover(r);
        c.strokeStyle = muted; c.beginPath(); c.moveTo(x, T); c.lineTo(x, T + ph); c.stroke();
        c.fillStyle = ink; c.beginPath(); c.arc(x, y, 4, 0, 7); c.fill();
        const tw = c.measureText(txt).width + 14, bx = clamp(x - tw / 2, L, w - R - tw);
        c.fillRect(bx, T + 2, tw, 20); c.fillStyle = css('--card'); c.textAlign = 'left'; c.textBaseline = 'middle'; c.fillText(txt, bx + 7, T + 12);
      }
    }
  }
  function hoverable(cv) {
    cv.addEventListener('pointermove', (e) => { cv._hx = e.offsetX; render(); });
    cv.addEventListener('pointerdown', (e) => { cv._hx = e.offsetX; render(); });
    cv.addEventListener('pointerleave', () => { cv._hx = null; render(); });
  }
  function glucoseChart(cv, pts, t0, t1) {
    let top = 250; for (let i = lowerBound(pts, t0); i < pts.length; i++) top = Math.max(top, pts[i].g + 20);
    top = Math.ceil(top / 50) * 50;
    const yticks = []; if (mmol()) for (let v = 3; v * MMOL <= top; v += 3) yticks.push(v * MMOL); else for (let v = 50; v <= top; v += 50) yticks.push(v);
    const colors = { lo: css('--lo'), hi: css('--hi'), in: css('--in') };
    const letters = { meal: 'M', insulin: 'I', exercise: 'E', cal: 'C' };
    drawChart(cv, {
      t0, t1, y0: 40, y1: top, yticks, yfmt: fmtG, gap: 6 * MIN,
      bands: [{ y0: S.set.low, y1: S.set.high, color: css('--band') }],
      hlines: [{ y: S.set.low, color: colors.lo }, { y: S.set.high, color: colors.hi }],
      series: [{ pts, get: (r) => r.g, width: 2.4, colorFn: (g) => colors[zone(g)] }],
      markers: S.events.map((e) => ({ t: e.t, label: letters[e.kind] })),
      hover: (r) => `${fmtG(r.g)} ${unit()} · ${ago(t1 - r.t)}`,
    });
  }

  // ---------- views ----------
  const set = (id, v) => { const el = $(id); if (el.textContent !== String(v)) el.textContent = v; };

  function renderHeader() {
    const pill = $('#connPill'), st = rt.state;
    pill.className = 'pill ' + (st === 'connected' ? 'on' : st ? 'wait' : 'off');
    pill.textContent = st === 'connected' ? (rt.name || 'Connected') + (rt.source === 'demo' ? ' (demo)' : '') : st === 'connecting' ? 'Connecting…' : st === 'reconnecting' ? 'Reconnecting…' : st === 'listening' ? 'Listening…' : 'Not connected';
  }

  function renderLive() {
    const l = last(), rate = trend(), st = stats(24);
    $('#connectBanner').hidden = !!rt.source;
    $('#demoBanner').hidden = rt.source !== 'demo';
    if (rt.source === 'demo') { set('#demoName', rt.name); set('#demoSig', 'Bluetooth signal of ' + rt.name + ': ' + rssiText(rt.devRssi)); }
    $('#heroCard').className = 'card hero ' + (l ? zone(l.g) : '');
    set('#gVal', l ? fmtG(l.g) : '--'); set('#gUnit', unit()); set('#gTrend', arrow(rate));
    set('#gAge', l && !rt.source ? '(last stored reading)' : '');
    set('#gRate', rate == null ? 'no trend yet' : `${rate >= 0 ? '+' : '−'}${mmol() ? Math.abs(rate / MMOL).toFixed(2) : Math.abs(rate).toFixed(1)} ${unit()}/min`);
    set('#gStatus', !l ? 'Waiting for data' : l.g < 54 ? 'Urgent low' : { lo: 'Low', hi: 'High', in: 'In range' }[zone(l.g)]);
    set('#tCur', l ? l.filt.toFixed(2) : '--'); set('#tTemp', l ? l.temp.toFixed(1) : '--');
    set('#tBatt', rt.batt ?? '--'); set('#tTir', st ? Math.round(st.tir) : '--');
    $$('#winSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.win === S.set.win));
    const t1 = l ? l.t : Date.now();
    glucoseChart($('#chartLive'), S.readings, t1 - S.set.win * 3600000, t1);
    $('#alertFeed').innerHTML = S.alerts.length
      ? S.alerts.slice(0, 6).map((a) => `<li><span class="${a.cls}">${a.msg}</span><span class="muted">${ago(t1 - a.t)}</span></li>`).join('')
      : '<li class="muted">No alerts.</li>';
  }

  function rms(arr) { // noise estimate from successive differences (removes the slow glucose trend)
    if (arr.length < 3) return null;
    let s = 0; for (let i = 1; i < arr.length; i++) s += (arr[i] - arr[i - 1]) ** 2;
    return Math.sqrt(s / (arr.length - 1) / 2);
  }
  function renderSignal() {
    const l = last(), pts = S.readings.slice(-180);
    set('#scRaw', l ? l.raw.toFixed(2) : '--'); set('#scFilt', l ? l.filt.toFixed(2) : '--');
    set('#scComp', l ? compensate(l.filt, l.temp).toFixed(2) : '--'); set('#scGlu', l ? fmtG(l.g) : '--'); set('#scUnit', unit());
    set('#alphaVal', S.set.alpha.toFixed(2));
    $('#fAlpha').value = S.set.alpha; $('#fMedian').checked = S.set.median; $('#fTemp').checked = S.set.tempComp;
    const nr = rms(pts.map((r) => r.raw)), nf = rms(pts.map((r) => r.filt));
    set('#nRaw', nr == null ? '--' : (nr * 1000).toFixed(0) + ' pA'); set('#nFilt', nf == null ? '--' : (nf * 1000).toFixed(0) + ' pA');
    set('#nGain', nr && nf ? (nr / nf).toFixed(1) + '×' : '--');
    set('#nGlu', nf == null ? '--' : '±' + (mmol() ? (nf / S.cal.S / MMOL).toFixed(2) : (nf / S.cal.S).toFixed(1)) + ' ' + unit());
    if (!pts.length) return drawChart($('#chartSignal'), { t0: 0, t1: 1, y0: 0, y1: 10, yticks: [0, 5, 10], yfmt: String, noX: true, series: [{ pts: [], get: () => 0, width: 1, color: '#000' }] });
    let lo = Infinity, hi = -Infinity; for (const r of pts) { lo = Math.min(lo, r.raw, r.filt); hi = Math.max(hi, r.raw, r.filt); }
    const pad = Math.max(0.2, (hi - lo) * 0.15); lo -= pad; hi += pad;
    const stp = (hi - lo) / 4;
    drawChart($('#chartSignal'), {
      t0: pts[0].t, t1: pts[pts.length - 1].t, y0: lo, y1: hi, noX: true, yticks: [0, 1, 2, 3, 4].map((i) => lo + i * stp), yfmt: (v) => v.toFixed(1),
      series: [{ pts, get: (r) => r.filt, width: 2.4, color: css('--in') }, { pts, get: (r) => r.raw, width: 1, color: css('--raw') }],
      hover: (r) => `raw ${r.raw.toFixed(2)} · filtered ${r.filt.toFixed(2)} nA`,
    });
  }

  function renderIslet() {
    const l = last(), has = l && l.ib != null;
    set('#isA', has ? l.ia : '--'); set('#isB', has ? l.ib : '--'); set('#isD', has ? l.id : '--');
    set('#isRel', has ? (l.ib / ISLET_BASAL).toFixed(2) : '--');
    set('#isSrc', !has ? 'no data' : rt.isletSrc === 'chip' ? 'computed on the GS-1 chip' : rt.isletSrc === 'app' ? 'computed in the app' : 'last stored reading');
    set('#isStatus', !has ? 'Waiting for data.'
      : l.ia > 0 ? `Model glucagon response active: glucose ${fmtG(l.g)} ${unit()} is below the alpha-cell threshold.`
      : l.ib >= 1.5 * ISLET_BASAL ? `Model insulin response strongly raised (${(l.ib / ISLET_BASAL).toFixed(1)} times basal) at ${fmtG(l.g)} ${unit()}.`
      : l.ib >= 1.15 * ISLET_BASAL ? `Model insulin response raised at ${fmtG(l.g)} ${unit()}.`
      : `Model islet near its basal state at ${fmtG(l.g)} ${unit()}.`);
    $$('#isSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.win === S.set.win));
    const t1 = l ? l.t : Date.now(), t0 = t1 - S.set.win * 3600000;
    const pts = S.readings.filter((r) => r.ib != null);
    let top = 40; for (let i = lowerBound(pts, t0); i < pts.length; i++) top = Math.max(top, pts[i].ia, pts[i].ib, pts[i].id);
    top = Math.ceil((top + 5) / 20) * 20;
    const yticks = []; for (let v = 0; v <= top; v += top > 80 ? 40 : 20) yticks.push(v);
    drawChart($('#chartIslet'), {
      t0, t1, y0: 0, y1: top, yticks, yfmt: String, gap: 6 * MIN,
      hlines: [{ y: ISLET_BASAL, color: css('--muted') }],
      series: [{ pts, get: (r) => r.ib, width: 2.4, color: css('--in') }, { pts, get: (r) => r.id, width: 1.6, color: css('--hi') }, { pts, get: (r) => r.ia, width: 1.6, color: css('--lo') }],
      hover: (r) => `alpha ${r.ia} · beta ${r.ib} · delta ${r.id} · ${fmtG(r.g)} ${unit()}`,
    });
    glucoseChart($('#chartIsletG'), S.readings, t0, t1);
  }

  function renderLog() {
    const l = last(), t1 = nowT();
    set('#calUnit', unit());
    set('#calS', (S.cal.S * 1000).toFixed(1) + ' pA per mg/dL'); set('#calI0', S.cal.I0.toFixed(2) + ' nA'); set('#calN', S.cal.points.length);
    const hint = $('#simRef'); hint.hidden = !(rt.source === 'sim' && l);
    if (!hint.hidden) hint.innerHTML = `Simulator "true" blood glucose right now: <b>${fmtG(sim.trueGlucose(l.t))} ${unit()}</b> &mdash; enter it as the meter reading to test calibration.`;
    const names = { meal: 'Meal', insulin: 'Insulin', exercise: 'Exercise', cal: 'Calibration' };
    const units = { meal: 'g carbs', insulin: 'units', exercise: 'min' };
    const rows = [...S.events].sort((a, b) => b.t - a.t).map((e) =>
      `<tr><td>${ago(t1 - e.t)}</td><td>${names[e.kind]}</td><td>${e.kind === 'cal' ? fmtG(e.amount) + ' ' + unit() : e.amount + ' ' + units[e.kind]}</td><td><button data-del="${e.id}" aria-label="Delete">Delete</button></td></tr>`);
    $('#evTable').innerHTML = rows.length ? '<tr><th>When</th><th>Type</th><th>Amount</th><th></th></tr>' + rows.join('') : '<tr><td class="muted">No events logged yet.</td></tr>';
  }

  function renderReports() {
    $$('#repSeg button').forEach((b) => b.classList.toggle('on', +b.dataset.rep === S.set.rep));
    const st = stats(S.set.rep), cv = $('#chartRep');
    const g = (v) => (st ? fmtG(v) + ' ' + unit() : '--');
    set('#rMean', st ? g(st.mean) : '--'); set('#rSd', st ? (mmol() ? (st.sd / MMOL).toFixed(1) : Math.round(st.sd)) + ' ' + unit() : '--');
    set('#rCv', st ? st.cv.toFixed(0) + ' %' : '--'); set('#rGmi', st ? st.gmi.toFixed(1) + ' %' : '--');
    set('#rMin', st ? g(st.min) : '--'); set('#rMax', st ? g(st.max) : '--');
    const parts = st ? [['lo', st.lo, 'Below'], ['in', st.tir, 'In range'], ['hi', st.hi, 'Above']] : [];
    $('#tirBar').innerHTML = parts.map(([k, v]) => `<i style="width:${v}%;background:var(--${k})"></i>`).join('');
    $('#tirLegend').innerHTML = parts.map(([k, v, n]) => `<i class="sw ${k}"></i>${n} ${v.toFixed(0)} %`).join('') +
      (st ? `<span class="muted">target ${fmtG(S.set.low)}&ndash;${fmtG(S.set.high)} ${unit()}</span>` : '<span class="muted">No data yet.</span>');
    set('#repCount', st ? `${st.n} readings over ${(st.span / 3600000).toFixed(1)} h.` : '');
    const l = last(), t1 = l ? l.t : Date.now();
    glucoseChart(cv, S.readings, st ? st.pts[0].t : t1 - 3600000, t1);
  }

  function renderDevice() {
    set('#devState', rt.source === 'sim' ? 'Simulator running (virtual sensor, same packets as the real device).'
      : rt.source === 'ble' ? `Bluetooth: ${rt.state}${rt.name ? ' – ' + rt.name : ''}.`
      : rt.source === 'demo' ? `Demonstration: ${rt.name} was selected from the nearby Bluetooth devices. The signal is random data generated in the app; nothing is read from that device.`
      : rt.source === 'beacon' ? (rt.state === 'connected' ? `Beacon mode: receiving ${rt.name} (one-way, no connection).` : 'Beacon mode: listening for a GS-1 sensor…') : 'Not connected.');
    const bn = $('#beaconNote'); bn.hidden = beacon.supported;
    bn.textContent = 'Beacon mode needs Bluetooth scanning: in Chrome or Edge open chrome://flags, enable "Experimental Web Platform features" and restart the browser.';
    const note = $('#bleNote'); note.hidden = ble.supported;
    note.textContent = 'This browser has no Web Bluetooth. Use Chrome or Edge on Android, Windows or macOS (iOS Safari is not supported).';
    $('#simSpeed').value = S.set.speed; $('#sampInt').value = S.set.interval; $('#setUnits').value = S.set.units; $('#setSound').checked = S.set.sound;
    if (document.activeElement !== $('#setLow')) $('#setLow').value = fmtG(S.set.low);
    if (document.activeElement !== $('#setHigh')) $('#setHigh').value = fmtG(S.set.high);
    const mean = rt.ints.length ? rt.ints.reduce((a, b) => a + b) / rt.ints.length : 0;
    const jit = mean ? Math.sqrt(rt.ints.reduce((a, b) => a + (b - mean) ** 2, 0) / rt.ints.length) : 0;
    set('#pRx', rt.rx); set('#pDrop', rt.drop); set('#pPdr', rt.rx ? ((rt.rx / (rt.rx + rt.drop)) * 100).toFixed(1) + ' %' : '--');
    set('#pRate', mean ? (1000 / mean).toFixed(2) + ' Hz' : '--'); set('#pJit', mean ? jit.toFixed(0) + ' ms' : '--');
    set('#pUp', rt.rx ? (rt.uptime / 1000).toFixed(0) + ' s' : '--');
    const f = []; if (rt.flags & 1) f.push('warm-up'); if (rt.flags & 2) f.push('ADC saturated'); if (rt.flags & 4) f.push('low battery');
    set('#pFlags', rt.rx ? f.join(', ') || 'OK' : '--');
    set('#pRssi', rt.source === 'demo' ? rssiText(rt.devRssi) : rt.rx && rt.rssi != null ? rt.rssi + ' dBm' : '--');
    set('#pDev', rt.source && rt.name ? rt.name : '--');
    set('#pLink', rt.source !== 'demo' ? (rt.source === 'ble' ? rt.state : '--') : rt.devLink === 'open' ? 'open (no data is read)' : rt.devLink === 'trying' ? 'trying...' : 'device chosen, no link accepted');
    const nm = $('#nearMsg'); nm.hidden = !rt.nearMsg; set('#nearMsg', rt.nearMsg || '');
    const esc = (s) => s.replace(/[<>&"]/g, '');
    const rows = near.scanning && rt.source !== 'demo' ? near.devices().map((d) => '<button data-near="' + encodeURIComponent(d.id) + '"><b>' + esc(d.name || 'Unnamed device') + '</b><span>' + (d.rssi ?? '?') + ' dBm</span></button>').join('') : '';
    const nl = $('#nearList'); if (nl._html !== rows) { nl._html = rows; nl.innerHTML = rows; }
    set('#pSrc', rt.source === 'demo' ? 'random demo signal' : rt.source === 'sim' ? 'simulator (physiology model)' : rt.source === 'ble' ? 'Bluetooth device' : rt.source === 'beacon' ? 'Bluetooth beacon' : '--');
    set('#pIslet', !rt.rx ? '--' : rt.isletSrc === 'chip' ? 'on the chip (17-byte packet)' : 'in the app (14-byte packet)');
  }

  const VIEWS = { live: renderLive, signal: renderSignal, islet: renderIslet, log: renderLog, reports: renderReports, device: renderDevice };
  function render() { renderHeader(); VIEWS[rt.view](); }
  let pending = false;
  function scheduleRender() { if (pending) return; pending = true; requestAnimationFrame(() => { pending = false; render(); }); }
  function showView() {
    $$('#tabs button').forEach((b) => b.classList.toggle('on', b.dataset.view === rt.view));
    $$('.view').forEach((v) => v.classList.toggle('on', v.id === 'view-' + rt.view));
    render();
  }
  function applyTheme() { document.documentElement.dataset.theme = S.set.theme; }

  // ---------- wiring ----------
  function init() {
    load(); applyTheme();
    $('#tabs').addEventListener('click', (e) => { const v = e.target.dataset.view; if (v) { rt.view = v; showView(); } });
    $('#themeBtn').onclick = () => { S.set.theme = S.set.theme === 'dark' ? 'light' : 'dark'; applyTheme(); save(); render(); };
    document.addEventListener('click', (e) => {
      const act = e.target.dataset.act, del = e.target.dataset.del, nearId = e.target.dataset.near;
      if (nearId) { const d = near.list.get(decodeURIComponent(nearId)); if (d) connectNearby(d); }
      if (act === 'sim') startSim(false); else if (act === 'ble') startBle(); else if (act === 'beacon') startBeacon(); else if (act === 'demo') startDemo(); else if (act === 'stop') stopSource();
      if (del) { S.events = S.events.filter((x) => String(x.id) !== del); sim.events = S.events.filter((x) => x.kind !== 'cal'); save(); render(); }
    });
    $('#winSeg').addEventListener('click', (e) => { if (e.target.dataset.win) { S.set.win = +e.target.dataset.win; save(); render(); } });
    $('#isSeg').addEventListener('click', (e) => { if (e.target.dataset.win) { S.set.win = +e.target.dataset.win; save(); render(); } });
    $('#repSeg').addEventListener('click', (e) => { if (e.target.dataset.rep) { S.set.rep = +e.target.dataset.rep; save(); render(); } });
    ['#chartLive', '#chartSignal', '#chartRep', '#chartIslet', '#chartIsletG'].forEach((id) => hoverable($(id)));

    $('#fAlpha').oninput = (e) => { S.set.alpha = +e.target.value; render(); };
    $('#fAlpha').onchange = save;
    $('#fMedian').onchange = (e) => { S.set.median = e.target.checked; save(); };
    $('#fTemp').onchange = (e) => { S.set.tempComp = e.target.checked; save(); render(); };

    $('#evAdd').onclick = () => {
      const amount = +$('#evAmount').value, kind = $('#evKind').value;
      if (!(amount > 0)) return toast('Enter an amount greater than zero.');
      const ev = { id: Date.now(), t: nowT(), kind, amount };
      S.events.push(ev); sim.events = S.events.filter((x) => x.kind !== 'cal');
      $('#evAmount').value = ''; toast('Event logged.'); save(); render();
    };
    $('#calAdd').onclick = () => { calibrate(toMg(+$('#calRef').value)); $('#calRef').value = ''; };
    $('#calReset').onclick = () => { S.cal = { ...DEF_CAL, points: [] }; toast('Calibration reset to factory values.'); save(); render(); };

    $('#simSpeed').onchange = (e) => { S.set.speed = +e.target.value; save(); if (rt.source === 'sim') startSim(true); else if (rt.source === 'demo') runDemo(rt.name, true); };
    $('#sampInt').onchange = (e) => {
      S.set.interval = +e.target.value; save();
      if (rt.source === 'sim') startSim(true);
      else if (rt.source === 'demo') runDemo(rt.name, true);
      else if (rt.source === 'beacon') toast('Beacon mode is one-way: the sample interval is set on the device.');
      else if (rt.source === 'ble') ble.setInterval(S.set.interval).then((ok) => toast(ok ? 'Sample interval sent to device.' : 'Device has no control characteristic.')).catch((err) => toast('Bluetooth: ' + err.message));
    };
    $('#setUnits').onchange = (e) => { S.set.units = e.target.value; save(); render(); };
    $('#setSound').onchange = (e) => { S.set.sound = e.target.checked; save(); };
    const limit = (id, key) => { $(id).onchange = (e) => {
      const v = toMg(+e.target.value), lo = key === 'low' ? v : S.set.low, hi = key === 'high' ? v : S.set.high;
      if (v > 0 && lo >= 54 && hi <= 400 && lo + 10 <= hi) { S.set[key] = v; save(); } else toast('Limits must stay between ' + fmtG(54) + ' and ' + fmtG(400) + ', low below high.');
      e.target.blur(); render();
    }; };
    limit('#setLow', 'low'); limit('#setHigh', 'high');
    $('#clearBtn').onclick = () => {
      if (!confirm('Erase all stored readings, events, alerts and calibration?')) return;
      stopSource(true); S.readings = []; S.events = []; S.alerts = []; S.cal = { ...DEF_CAL, points: [] }; rt.batt = null; rt.isletSrc = null; rt.lastAlert = {};
      resetLink(); save(); render(); toast('All data erased.');
    };
    $('#csvBtn').onclick = () => {
      const st = stats(S.set.rep); if (!st) return toast('No data to export.');
      const rows = ['time_iso,raw_nA,filtered_nA,temp_C,glucose_mgdl,glucose_mmol,islet_alpha,islet_beta,islet_delta'].concat(st.pts.map((r) =>
        [new Date(r.t).toISOString(), r.raw.toFixed(3), r.filt.toFixed(3), r.temp.toFixed(2), r.g.toFixed(1), (r.g / MMOL).toFixed(2), r.ia ?? '', r.ib ?? '', r.id ?? ''].join(',')));
      const a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([rows.join('\n')], { type: 'text/csv' })); a.download = 'glucosense-export.csv'; a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    };

    window.addEventListener('resize', scheduleRender);
    document.addEventListener('visibilitychange', () => { if (document.hidden) save(); else render(); });
    window.addEventListener('pagehide', save);
    setInterval(() => { if (rt.source) save(); }, 30000);
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
    window.GSApp = { S, rt, sim, render };
    showView();
  }
  init();
})();

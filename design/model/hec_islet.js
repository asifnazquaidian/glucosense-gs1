// Hybrid Excitable Cell (HEC) model of the pancreatic islet: alpha, beta and delta cells.
// Source: A. Mehmood, "Artificial Neuron Model for Large Scale Spiking Brain Neural Network",
//         PhD thesis, UET Taxila, Section "Pancreatic Cells" (model equations and parameter table).
//
//   C V' = k f (V - Vr)(V - Vt) - u + Va + Vb + R I          u' = a (b (V - Vr) - u)
//   Va = Vglu exp(-s / Tk)        Vb = Vins exp(-s^2 / TCa)    s = time inside the period, t - n tau
//   threshold Vth = Vt + Va + Vb ;   if V >= Vth : spike, V = c, u = u + d
//
// From the thesis table: a, b, d, k, f, Vglu, Vins, Rk = RCa = 5 MOhm, capacitance 50 uF
//   (so Tk = TCa = 250 steps). Not in the table, taken from the thesis HEC code: C = 100,
//   Vr = -60 mV, Vt = -40 mV, c = -50 mV. Period tau = 1024 steps.
// NEW HERE (not in the thesis, not validated): the term R I is driven by the measured glucose.
//
// floatStep = the thesis model in floating point;  fixedStep = the multiplier-light integer
// algorithm that the chip uses (V and u in 1/64 mV), bit-exact with rtl/gs1_islet.v.
'use strict';
const CELLS = [
  { name: 'alpha', a: 0.03, b: -2, d: 100, kf: 1 * 0.1, Vglu: 0, Vins: 0 },
  { name: 'beta', a: 0.02, b: -5, d: 50, kf: 3 * 0.05, Vglu: 35, Vins: 30 },
  { name: 'delta', a: 0.02, b: -1, d: 60, kf: 0.3 * 0.2, Vglu: 35, Vins: 40 },
];
const C = 100, VR = -60, VT = -40, CRESET = -50, TK = 250, TCA = 250, PERIOD = 1024;

function floatStep(st, ci, s, drive) {                // drive in mV per step
  const p = CELLS[ci], { v, u } = st;
  const ea = p.Vglu * Math.exp(-s / TK), eb = p.Vins * Math.exp((-s * s) / TCA);
  const fire = v >= VT + ea + eb;
  if (fire) { st.v = CRESET; st.u = u + p.d; }
  else { st.v = v + (p.kf * (v - VR) * (v - VT) - u + ea + eb) / C + drive; st.u = u + p.a * (p.b * (v - VR) - u); }
  return fire ? 1 : 0;
}
const floatInit = () => ({ v: VR, u: 0 });

// ---- integer algorithm
const fl = (x, n) => Math.floor(x / 2 ** n);
const sat = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
const KQ = [66, 98, 39], KA = [123, 82, 82], KB = [-2, -5, -1], KD = [6400, 3200, 3840];
const AGLU = [0, 35840, 35840], AINS = [0, 30720, 40960];      // mV * 1024

// value * 2^-(age/4096) with shifts and adds only (same block as the HEC-64 chip)
function expdec(val, age) {
  let t = val >> (age >> 12);
  const f = (age >> 8) & 15;
  if (f & 8) t = t - (t >> 2) - (t >> 5) - (t >> 7) - (t >> 8);
  if (f & 4) t = t - (t >> 3) - (t >> 5) - (t >> 9);
  if (f & 2) t = t - (t >> 4) - (t >> 6) - (t >> 8);
  if (f & 1) t = t - (t >> 5) - (t >> 7) - (t >> 8);
  return t;
}
function fixedStep(st, ci, s, drive) {                // drive 0..255, 1/64 mV per step
  const { v, u } = st;
  const x = v + 3840, y = v + 2560, p = x * y;
  const q = fl(p * KQ[ci] + 2097152, 22);
  const tu = fl(u * 41 + 2048, 12);
  const ea = expdec(AGLU[ci], 24 * s) >> 4;                       // one halving every 171 steps
  const eb = s < 52 ? expdec(AINS[ci], 24 * s * s) >> 4 : 0;
  const e = ea + eb, de = fl(e * 41 + 2048, 12);
  const fire = v >= -2560 + e;
  const t = KB[ci] * x - u;
  if (fire) { st.v = -3200; st.u = sat(u + KD[ci], -131072, 131071); }
  else { st.v = sat(v + q - tu + de + drive, -8192, 8191); st.u = sat(u + fl(t * KA[ci] + 2048, 12), -131072, 131071); }
  return fire ? 1 : 0;
}
const fixedInit = () => ({ v: -3840, u: 0 });

// glucose -> drive, as the chip does it from the sensor current in pA
function drives(curPA, tha, thb) {
  const g = sat(curPA, 0, 65535);
  const lo = sat((tha - g) >> 6, 0, 255), hi = sat((g - thb) >> 6, 0, 255);
  return [lo, hi, hi];
}
// one period of all three cells; states persist from one measurement to the next
function period(states, drv, step = fixedStep, unit = 1) {
  return states.map((st, ci) => {
    let n = 0;
    for (let s = 0; s < PERIOD; s++) n += step(st, ci, s, drv[ci] * unit);
    return Math.min(n, 255);
  });
}
module.exports = { CELLS, floatStep, floatInit, fixedStep, fixedInit, drives, period, expdec, PERIOD };

if (require.main === module) {
  const fs = require('fs'), out = process.argv[2];
  const pA = (g) => Math.round(1200 + 46 * g);                    // placeholder sensor: 46 pA per mg/dL
  // 1. spike count per period against glucose: integer algorithm vs floating-point thesis model
  const rows = [];
  for (let g = 40; g <= 400; g += 10) {
    const d = drives(pA(g), 5340, 4880);
    const fx = [0, 1, 2].map(() => fixedInit()), ft = [0, 1, 2].map(() => floatInit());
    let nx, nf;
    for (let k = 0; k < 6; k++) { nx = period(fx, d); nf = period(ft, d, floatStep, 1 / 64); }
    rows.push({ glucose: g, alpha_chip: nx[0], alpha_thesis: nf[0], beta_chip: nx[1], beta_thesis: nf[1], delta_chip: nx[2], delta_thesis: nf[2] });
  }
  console.table(rows);
  let worst = 0, sum = 0, cnt = 0;
  for (const r of rows) for (const c of ['alpha', 'beta', 'delta']) {
    const e = Math.abs(r[c + '_chip'] - r[c + '_thesis']); worst = Math.max(worst, e); sum += e; cnt++;
  }
  console.log(`integer algorithm vs floating-point model: mean |difference| ${(sum / cnt).toFixed(2)} spikes per period, worst ${worst}`);

  // 2. closed loop "virtual patient": islet cell activity -> insulin / glucagon -> glucose (illustrative)
  function patient(betaGain) {
    const st = [0, 1, 2].map(() => fixedInit());
    const warm = [0, 1, 2].map(() => fixedInit()); let basal = 0;
    for (let k = 0; k < 6; k++) basal = period(warm, drives(pA(95), 5340, 4880))[1];   // beta activity at 95 mg/dL
    let G = 95, I = 0, K = 0; const tr = [];
    for (let min = 0; min < 600; min++) {
      let ra = 0;
      for (const [t0, carbs] of [[60, 60], [300, 80]]) { const dt = min - t0; if (dt > 0) ra += (carbs * 3 / 108.7) * (dt / 40) * Math.exp(1 - dt / 40); }
      const d = drives(pA(G), 5340, 4880); d[1] = Math.round(d[1] * betaGain);
      const n = period(st, d);
      I += 0.02 * Math.max(0, n[1] - basal) - 0.05 * I;      // insulin action follows beta-cell activity
      K += 0.03 * n[0] - 0.08 * K;                                   // glucagon action follows alpha-cell activity
      G += ra - 0.0016 * I * G + 0.25 * K - 0.004 * (G - 95);
      G = sat(G, 30, 450);
      tr.push({ min, G: +G.toFixed(1), alpha: n[0], beta: n[1], delta: n[2] });
    }
    return tr;
  }
  const healthy = patient(1), impaired = patient(0.35);
  const pk = (t) => Math.max(...t.map((r) => r.G)).toFixed(0), mn = (t) => Math.min(...t.map((r) => r.G)).toFixed(0);
  console.log(`virtual patient, normal beta cells : glucose ${mn(healthy)} .. ${pk(healthy)} mg/dL`);
  console.log(`virtual patient, beta drive x 0.35 : glucose ${mn(impaired)} .. ${pk(impaired)} mg/dL`);
  if (out) fs.writeFileSync(out, JSON.stringify({ sweep: rows, healthy, impaired }));
}

// Hybrid Excitable Cell (HEC) model of the pancreatic islet: alpha, beta and delta cells.
// Model and parameters: A. Mehmood, "Artificial Neuron Model for Large Scale Spiking Brain Neural
// Network", PhD thesis, UET Taxila, section "Pancreatic Cells".
//   C V' = k f (V - Vr)(V - Vt) - u + Va + Vb + R I        u' = a (b (V - Vr) - u)
//   Va = Vglu exp(-s/Tk)   Vb = Vins exp(-s^2/TCa)   threshold = Vt + Va + Vb ;  spike: V = c, u += d
// This is the same integer arithmetic as the GS-1 chip (chip/rtl/gs1_islet.v), V and u in 1/64 mV.
// The glucose drive (R I) is an assumption of the GS-1 design, not part of the thesis.
(() => {
  const fl = (x, n) => Math.floor(x / 2 ** n);
  const sat = (x, lo, hi) => (x < lo ? lo : x > hi ? hi : x);
  //            alpha  beta   delta
  const KQ = [66, 98, 39], KA = [123, 82, 82], KB = [-2, -5, -1], KD = [6400, 3200, 3840];
  const AGLU = [0, 35840, 35840], AINS = [0, 30720, 40960];
  const PERIOD = 1024;

  // value * 2^-(age/4096) with shifts and adds only
  function expdec(val, age) {
    let t = val >> (age >> 12);
    const f = (age >> 8) & 15;
    if (f & 8) t = t - (t >> 2) - (t >> 5) - (t >> 7) - (t >> 8);
    if (f & 4) t = t - (t >> 3) - (t >> 5) - (t >> 9);
    if (f & 2) t = t - (t >> 4) - (t >> 6) - (t >> 8);
    if (f & 1) t = t - (t >> 5) - (t >> 7) - (t >> 8);
    return t;
  }
  function step(st, ci, s, drive) {
    const { v, u } = st, x = v + 3840, y = v + 2560;
    const e = (expdec(AGLU[ci], 24 * s) >> 4) + (s < 52 ? expdec(AINS[ci], 24 * s * s) >> 4 : 0);
    if (v >= e - 2560) { st.v = -3200; st.u = sat(u + KD[ci], -131072, 131071); return 1; }
    st.v = sat(v + fl(x * y * KQ[ci] + 2097152, 22) - fl(u * 41 + 2048, 12) + fl(e * 41 + 2048, 12) + drive, -8192, 8191);
    st.u = sat(u + fl((KB[ci] * x - u) * KA[ci] + 2048, 12), -131072, 131071);
    return 0;
  }

  GS.Islet = class {
    constructor() { this.reset(); }
    reset() { this.cells = [0, 1, 2].map(() => ({ v: -3840, u: 0 })); }
    // one period of each cell for a sensor current in pA; returns [alpha, beta, delta] spike counts.
    // tha / thb: the chip's threshold registers (alpha driven below tha, beta and delta above thb)
    run(curPA, tha = 5340, thb = 4880) {
      const g = sat(Math.round(curPA), 0, 65535);
      const lo = sat((tha - g) >> 6, 0, 255), hi = sat((g - thb) >> 6, 0, 255);
      return this.cells.map((st, ci) => {
        let n = 0;
        for (let s = 0; s < PERIOD; s++) n += step(st, ci, s, ci ? hi : lo);
        return Math.min(n, 255);
      });
    }
    // the same for a calibrated glucose value, using the chip's nominal sensor (1.2 nA + 46 pA per mg/dL)
    runGlucose(mgdl) { return this.run(1200 + 46 * mgdl); }
  };
  GS.ISLET_BASAL_MGDL = 95;
})();

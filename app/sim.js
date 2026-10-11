// Virtual sensor: a simple glucose physiology model + an amperometric sensor model.
// It emits the same 14-byte packets as the ESP32 firmware, so the whole app pipeline is exercised.
(() => {
  const MIN = 60000, DAY = 86400000;
  const hash = (n) => { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); };
  const gauss = () => { let s = 0; for (let i = 0; i < 6; i++) s += Math.random(); return (s - 3) / 0.707; };
  const curve = (dt, tau) => (dt <= 0 ? 0 : (dt / tau) * Math.exp(1 - dt / tau)); // peaks at 1 when dt = tau

  GS.Sim = class {
    constructor() { this.events = []; this.timer = null; this.seq = 0; }

    // breakfast, lunch, dinner for the days around t (deterministic per day)
    autoMeals(t) {
      const d0 = new Date(t); d0.setHours(0, 0, 0, 0);
      const out = [];
      for (let d = -1; d <= 0; d++) {
        const mid = d0.getTime() + d * DAY, k = Math.floor(mid / DAY);
        [8, 13, 19.5].forEach((h, i) => out.push({ t: mid + h * 3600000, kind: 'meal', amount: 50 + hash(k * 3 + i) * 55 }));
      }
      return out;
    }

    // "true" blood glucose in mg/dL at data-time t
    trueGlucose(t) {
      const hour = (t % DAY) / 3600000;
      let g = 98 + 7 * Math.sin((2 * Math.PI * (hour - 3)) / 24);
      g += 5 * Math.sin(t / (17 * MIN)) + 3 * Math.sin(t / (41 * MIN));
      for (const e of this.autoMeals(t).concat(this.events)) {
        const dt = (t - e.t) / MIN;
        if (dt <= 0 || dt > 480) continue;
        if (e.kind === 'meal') g += e.amount * 1.1 * curve(dt, 50);
        else if (e.kind === 'insulin') g -= e.amount * 18 * curve(dt, 90);
        else if (e.kind === 'exercise') g -= e.amount * 0.6 * curve(dt, 45);
      }
      return Math.max(40, Math.min(400, g));
    }

    // one sensor sample: glucose -> electrode current (nA) with temperature dependence, noise and spikes
    sample(t, uptime) {
      const temp = 33 + 0.8 * Math.sin(t / (50 * MIN)) + gauss() * 0.03;
      let nA = 1.2 + 0.046 * this.trueGlucose(t) * (1 + 0.025 * (temp - 33)) + gauss() * 0.08;
      if (Math.random() < 0.01) nA += (Math.random() < 0.5 ? -1 : 1) * 1.5; // motion artefact
      const batt = Math.max(5, Math.round(96 - (uptime / 3600000) * 0.4));
      return {
        seq: this.seq++ & 0xffff, uptime, currentPA: nA * 1000, tempC100: temp * 100, batt,
        flags: batt < 15 ? GS.FLAG.LOW_BATT : 0,
      };
    }

    // startT: data-time of the first live sample; speed: data-time seconds per real second
    start({ startT, speed, interval, onPacket }) {
      this.stop();
      this.startT = startT; this.speed = speed; this.interval = interval; this.up = 0;
      this.timer = setInterval(() => {
        const p = this.sample(this.startT + this.up * this.speed, this.up);
        this.up += this.interval;
        if (Math.random() < 0.003) return; // radio packet loss
        onPacket(GS.decode(GS.encode(p)));
      }, interval);
    }

    stop() { clearInterval(this.timer); this.timer = null; }
    get running() { return this.timer !== null; }
  };

  // Demonstration source: a random glucose signal (bounded random walk) sent through the same sensor
  // model and the same packets. Used by 'Connect nearby device (demo)' to show how the app works.
  GS.Demo = class extends GS.Sim {
    constructor() { super(); this.g = 100 + Math.random() * 40; this.rate = 0; this.lastT = null; }
    trueGlucose(t) {
      const dt = this.lastT == null ? 0 : Math.max(0, Math.min(10, (t - this.lastT) / MIN));   // minutes
      this.lastT = t;
      this.rate += gauss() * 0.35 * Math.sqrt(dt) - 0.06 * this.rate * dt;       // mg/dL per minute, random
      this.rate = Math.max(-3, Math.min(3, this.rate));
      this.g += (this.rate + 0.012 * (120 - this.g)) * dt;                       // drifts back towards 120
      if (this.g < 50 || this.g > 300) this.rate = -this.rate / 2;
      this.g = Math.max(50, Math.min(300, this.g));
      return this.g;
    }
  };
})();

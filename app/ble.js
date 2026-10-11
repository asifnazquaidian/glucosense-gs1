// Web Bluetooth link to the GlucoSense wearable (ESP32 firmware in /firmware).
GS.Ble = class {
  constructor() { this.dev = null; this.meas = null; this.ctrl = null; this.manual = false; }

  get supported() { return !!navigator.bluetooth; }
  get connected() { return !!(this.dev && this.dev.gatt.connected); }

  async connect({ onPacket, onState }) {
    this.onPacket = onPacket; this.onState = onState; this.manual = false;
    this.dev = await navigator.bluetooth.requestDevice({ filters: [{ services: [GS.UUID.service] }] });
    this.dev.addEventListener('gattserverdisconnected', () => this.lost());
    await this.open();
  }

  async open() {
    this.onState('connecting', this.dev.name);
    const server = await this.dev.gatt.connect();
    const svc = await server.getPrimaryService(GS.UUID.service);
    this.meas = await svc.getCharacteristic(GS.UUID.meas);
    try { this.ctrl = await svc.getCharacteristic(GS.UUID.ctrl); } catch { this.ctrl = null; }
    this.meas.addEventListener('characteristicvaluechanged', (e) => {
      const p = GS.decode(e.target.value);
      if (p) this.onPacket(p);
    });
    await this.meas.startNotifications();
    this.onState('connected', this.dev.name);
  }

  // link dropped: retry a few times unless the user disconnected on purpose
  async lost() {
    if (this.manual) return this.onState('disconnected');
    for (let i = 1; i <= 5; i++) {
      this.onState('reconnecting', this.dev.name);
      await new Promise((r) => setTimeout(r, 1500 * i));
      if (this.manual) break;
      try { await this.open(); return; } catch { /* try again */ }
    }
    this.onState('disconnected');
  }

  async setInterval(ms) {
    if (!this.ctrl) return false;
    await this.ctrl.writeValue(new Uint8Array([GS.CMD_SET_INTERVAL, ms & 0xff, (ms >> 8) & 0xff]));
    return true;
  }

  disconnect() {
    this.manual = true;
    if (this.connected) this.dev.gatt.disconnect(); else if (this.onState) this.onState('disconnected');
  }
};

// Beacon mode: the GS-1 chip sends every reading in a Bluetooth LE advertising packet
// (ADV_NONCONN_IND, manufacturer data, company GS.COMPANY_ID, 17 bytes) on channels 37, 38, 39.
// No connection is made; the app only listens. Needs the Web Bluetooth scanning API
// (Chrome / Edge with chrome://flags/#enable-experimental-web-platform-features switched on).
GS.Beacon = class {
  constructor() { this.scan = null; this.handler = null; this.timer = null; }

  get supported() { return !!(navigator.bluetooth && navigator.bluetooth.requestLEScan); }

  async start({ onPacket, onState }) {
    this.stop();
    this.devId = null; this.lastSeq = null; this.lastRx = 0; this.heard = false;
    const md = [{ manufacturerData: [{ companyIdentifier: GS.COMPANY_ID }] }];
    try { this.scan = await navigator.bluetooth.requestLEScan({ keepRepeatedDevices: true, filters: md }); }
    catch (e) { // older browsers cannot filter on manufacturer data: take everything and filter here
      if (e.name !== 'TypeError') throw e;
      this.scan = await navigator.bluetooth.requestLEScan({ keepRepeatedDevices: true, acceptAllAdvertisements: true });
    }
    this.handler = (ev) => {
      const dv = ev.manufacturerData && ev.manufacturerData.get(GS.COMPANY_ID);
      if (!dv || (dv.byteLength !== 17 && dv.byteLength !== GS.PACKET_LEN)) return;
      const id = ev.device ? ev.device.id : '';
      if (this.devId == null) this.devId = id; else if (id !== this.devId) return;   // stay with the first sensor heard
      const p = GS.decode(dv);
      this.lastRx = Date.now();
      if (!this.heard) { this.heard = true; onState('connected', (ev.device && ev.device.name) || 'GS-1 beacon'); }
      if (p.seq === this.lastSeq) return;   // the same reading again on another advertising channel
      this.lastSeq = p.seq;
      p.rssi = ev.rssi;
      onPacket(p);
    };
    navigator.bluetooth.addEventListener('advertisementreceived', this.handler);
    this.timer = setInterval(() => { // nothing heard for 20 s: show that the sensor is out of range
      if (this.heard && Date.now() - this.lastRx > 20000) { this.heard = false; onState('listening'); }
    }, 5000);
    onState('listening');
  }

  stop() {
    clearInterval(this.timer); this.timer = null;
    if (this.handler) navigator.bluetooth.removeEventListener('advertisementreceived', this.handler);
    this.handler = null;
    if (this.scan && this.scan.active) this.scan.stop();
    this.scan = null;
  }
};

// Nearby Bluetooth devices, for the demonstration connection: find the devices around, let the user
// pick one, then report its signal strength (RSSI). Two ways, whichever the browser offers:
//   1. scanning API (requestLEScan, experimental flag): the app shows its own live list with RSSI
//   2. the browser's device chooser (requestDevice): works without any flag; RSSI afterwards only
//      if the browser supports watchAdvertisements()
GS.Nearby = class {
  constructor() { this.list = new Map(); this.reset(); }
  reset() { this.scan = null; this.h = null; this.followId = null; this.followCb = null; this.dev = null; this.devH = null; this.abort = null; this.rssiOk = false; }

  get scanSupported() { return !!(navigator.bluetooth && navigator.bluetooth.requestLEScan); }
  get scanning() { return !!(this.scan && this.scan.active); }

  // '' when Bluetooth can be used, otherwise the reason in plain words
  async unavailable() {
    if (!window.isSecureContext) return 'Bluetooth needs a secure page: open the app at its https address, or at 127.0.0.1 on this computer.';
    if (!navigator.bluetooth) return 'This browser has no Web Bluetooth. Use Chrome or Edge on Android, Windows or macOS (not Firefox, not iPhone/iPad).';
    try {
      if (navigator.bluetooth.getAvailability && !(await navigator.bluetooth.getAvailability()))
        return 'Bluetooth is switched off, or this device has no Bluetooth Low Energy adapter. Switch Bluetooth on and search again.';
    } catch { /* cannot tell: let the search itself report */ }
    return '';
  }

  async startScan(onUpdate) {
    this.stop(); this.list.clear();
    this.scan = await navigator.bluetooth.requestLEScan({ acceptAllAdvertisements: true, keepRepeatedDevices: true });
    this.rssiOk = true;
    this.h = (ev) => {
      const id = ev.device ? ev.device.id : '', old = this.list.get(id);
      this.list.set(id, { id, name: (ev.device && ev.device.name) || ev.name || (old && old.name) || '', rssi: ev.rssi, last: Date.now(), dev: ev.device });
      if (id === this.followId && this.followCb) this.followCb(ev.rssi);
      onUpdate();
    };
    navigator.bluetooth.addEventListener('advertisementreceived', this.h);
  }
  // devices heard in the last 15 s, strongest first
  devices() { const now = Date.now(); return [...this.list.values()].filter((d) => now - d.last < 15000).sort((x, y) => (y.rssi ?? -999) - (x.rssi ?? -999)); }

  choose() { return navigator.bluetooth.requestDevice({ acceptAllDevices: true }); }

  // keep reporting the signal strength of the chosen device
  follow(d, cb) {
    this.followId = d.id; this.followCb = cb;
    if (this.scanning || !d.dev || !d.dev.watchAdvertisements) return;
    this.dev = d.dev; this.abort = new AbortController();
    this.devH = (ev) => { this.rssiOk = true; cb(ev.rssi); };
    d.dev.addEventListener('advertisementreceived', this.devH);
    this.rssiOk = true;   // shown as "waiting..." until the first advertisement arrives
    d.dev.watchAdvertisements({ signal: this.abort.signal }).catch(() => { this.rssiOk = false; cb(null); });
  }

  // try to open a real Bluetooth link to the chosen device (not every device accepts one)
  link(dev) {
    if (!dev || !dev.gatt) return Promise.resolve(false);
    this.dev = dev;
    return Promise.race([dev.gatt.connect().then(() => true), new Promise((r) => setTimeout(() => r(false), 8000))]).catch(() => false);
  }

  stop() {
    if (this.h) navigator.bluetooth.removeEventListener('advertisementreceived', this.h);
    if (this.scan && this.scan.active) this.scan.stop();
    if (this.dev && this.devH) this.dev.removeEventListener('advertisementreceived', this.devH);
    if (this.abort) this.abort.abort();
    try { if (this.dev && this.dev.gatt && this.dev.gatt.connected) this.dev.gatt.disconnect(); } catch { /* already gone */ }
    this.reset();
  }
};

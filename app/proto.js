// GlucoSense BLE protocol - shared by the simulator, the Web Bluetooth link and the ESP32 firmware.
// Measurement packet (notify), 14 bytes, little-endian:
//   0  uint16  seq        packet counter (gaps = dropped packets)
//   2  uint32  uptime     device clock, ms
//   6  int32   current    sensor current, pA
//   10 int16   temp       skin temperature, 0.01 degC
//   12 uint8   battery    percent
//   13 uint8   flags      bit0 warm-up, bit1 ADC saturated, bit2 low battery
// The GS-1 chip appends 3 bytes (17 in all): HEC islet model spike counts per period
//   14 uint8 alpha cell   15 uint8 beta cell   16 uint8 delta cell
window.GS = {
  UUID: {
    service: '6e5f0001-b5a3-f393-e0a9-e50e24dcca9e',
    meas: '6e5f0002-b5a3-f393-e0a9-e50e24dcca9e',
    ctrl: '6e5f0003-b5a3-f393-e0a9-e50e24dcca9e',
  },
  CMD_SET_INTERVAL: 0x01, // [0x01, uint16 interval ms]
  FLAG: { WARMUP: 1, SATURATED: 2, LOW_BATT: 4 },
  PACKET_LEN: 14,
  COMPANY_ID: 0xffff, // manufacturer-data company identifier used by the GS-1 beacon (Bluetooth SIG test value)

  encode(p) {
    const dv = new DataView(new ArrayBuffer(14));
    dv.setUint16(0, p.seq & 0xffff, true);
    dv.setUint32(2, p.uptime >>> 0, true);
    dv.setInt32(6, Math.round(p.currentPA), true);
    dv.setInt16(10, Math.round(p.tempC100), true);
    dv.setUint8(12, p.batt);
    dv.setUint8(13, p.flags);
    return dv;
  },

  decode(dv) {
    if (!dv || dv.byteLength < 14) return null;
    return {
      islet: dv.byteLength >= 17 ? [dv.getUint8(14), dv.getUint8(15), dv.getUint8(16)] : null,
      seq: dv.getUint16(0, true),
      uptime: dv.getUint32(2, true),
      currentPA: dv.getInt32(6, true),
      tempC100: dv.getInt16(10, true),
      batt: dv.getUint8(12),
      flags: dv.getUint8(13),
    };
  },
};

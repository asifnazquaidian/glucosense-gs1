// GS-1 software reference model (transaction level): what the chip must send for given inputs.
// Written independently of the Verilog: the CRC and whitening use the byte-wise "wire order" form.
//   node gs1_model.js stim  <n> <stim.hex>      write the test inputs for n measurements
//   node gs1_model.js check <stim.hex> <tb.out> compare the Verilog test bench output with the model
//   node gs1_model.js lin                       ADC transfer curve / error table (CSV on stdout)
'use strict';
const fs = require('fs');
const islet = require('./hec_islet.js');

const M = 1024, FS = (M * (M + 1)) / 2;           // filter full scale 524800
const ADDR = [0x01, 0x31, 0x2d, 0x53, 0x47, 0xc7];

// second-order 1-bit sigma-delta modulator, integer arithmetic, input u in -32768..32767
function modulator(u, n = M) {
  let s1 = 0, s2 = 0; const bits = [];
  for (let i = 0; i < n; i++) {
    const b = s2 >= 0 ? 1 : 0, fb = b ? 32768 : -32768;
    s2 += s1 - 2 * fb; s1 += u - fb;
    bits.push(b);
  }
  return bits;
}
// built-in test modulator: 10-bit phase accumulator, carry out is the bit
function bist(k, n = M) {
  let ph = 0; const bits = [];
  for (let i = 0; i < n; i++) { ph += k; bits.push(ph >> 10); ph &= 1023; }
  return bits;
}
function filter(bits) {                             // cascade of two integrators
  let a1 = 0, a2 = 0;
  for (const b of bits) { a1 += b; a2 += a1; }
  return a2;
}
const s16 = (v) => (v & 0x8000 ? v - 65536 : v);
const scale = (code, gain, shift, off) => Math.floor((code * gain) / 2 ** shift) + s16(off);

const DEFAULT_REGS = [6268, 0, 4995, 2500, 1598, 50, (24 << 8) | 234, 5340, 4880];

// one measurement -> the 14 packet bytes + 3 islet bytes; cells = HEC islet state, kept between calls
function measure(bitsI, bitsT, bitsB, regs, seq, uptime, cells) {
  const aI = filter(bitsI), cI = 2 * aI - FS;
  const cur = scale(cI, regs[0], 14, regs[1]);
  let temp = scale(2 * filter(bitsT) - FS, regs[2], 18, regs[3]);
  temp = Math.max(-32768, Math.min(32767, temp));
  let batt = scale(2 * filter(bitsB) - FS, regs[4], 24, regs[5]);
  batt = Math.max(0, Math.min(100, batt));
  const sat = aI < 16400 || aI > 508400;
  const warm = Math.floor(uptime / 256) < (regs[6] & 255);
  const flags = (warm ? 1 : 0) | (sat ? 2 : 0) | (batt < 15 ? 4 : 0);
  const dv = new DataView(new ArrayBuffer(14));
  dv.setUint16(0, seq & 0xffff, true); dv.setUint32(2, uptime >>> 0, true); dv.setInt32(6, cur, true);
  dv.setInt16(10, temp, true); dv.setUint8(12, batt); dv.setUint8(13, flags);
  const n = islet.period(cells, islet.drives(cur, regs[7], regs[8]));     // alpha, beta, delta spikes
  return [...new Uint8Array(dv.buffer), ...n];
}
const uartFrame = (pkt) => [0xa5, 0x5a, ...pkt, pkt.reduce((a, b) => a ^ b, 0)];

// Bluetooth LE advertising packet as a string of on-air bits (first bit first)
function advBits(pkt, channel) {
  const pdu = [0x42, 30, ...ADDR, 0x02, 0x01, 0x06, 0x14, 0xff, 0xff, 0xff, ...pkt];
  // CRC-24, register kept bit-reversed so that it can be sent like data (LSB first)
  const c = [0xaa, 0xaa, 0xaa];
  for (let d of pdu) for (let i = 0; i < 8; i++, d >>= 1) {
    const t = c[0] & 1;
    c[0] >>= 1; if (c[1] & 1) c[0] |= 0x80;
    c[1] >>= 1; if (c[2] & 1) c[1] |= 0x80;
    c[2] >>= 1;
    if (t !== (d & 1)) { c[2] ^= 0xda; c[1] ^= 0x60; }
  }
  const body = [...pdu, ...c];
  let lfsr = channel | 0x40;                         // whitening
  for (let j = 0; j < body.length; j++) {
    let res = 0;
    for (let i = 1; i < 256; i <<= 1) { if (lfsr & 1) { lfsr ^= 0x88; res |= i; } lfsr >>= 1; }
    body[j] ^= res;
  }
  const air = [0xaa, 0xd6, 0xbe, 0x89, 0x8e, ...body];
  return air.map((b) => b.toString(2).padStart(8, '0').split('').reverse().join('')).join('');
}

// ---- test inputs: a glucose swing, then a saturated sensor, then a flat battery
function stimulus(n) {
  const rows = [];
  for (let m = 0; m < n; m++) {
    const glucose = 110 + 90 * Math.sin(m / 1.7);                     // mg/dL
    let nA = 1.2 + 0.046 * glucose;
    if (m === n - 3) nA = 197; if (m === n - 2) nA = -199;            // overload both ways
    const tC = 33 + 0.9 * Math.sin(m / 2.3), pct = m === n - 1 ? 9 : 96 - 3 * m;
    rows.push([Math.round((nA / 200) * 32768), Math.round(((tC - 25) / 100) * 32768), Math.round(((pct - 50) / 50) * 32768)]);
  }
  return rows;
}
const hex4 = (v) => (v & 0xffff).toString(16).padStart(4, '0');
const hex2 = (a) => a.map((b) => b.toString(16).padStart(2, '0')).join(' ');

function expected(rows, regs, interval, useBist) {
  const out = [], cells = [0, 1, 2].map(() => islet.fixedInit());
  rows.forEach((r, m) => {
    const bits = useBist ? [bist(528), bist(553), bist(922)] : r.map((u) => modulator(u));
    const pkt = measure(bits[0], bits[1], bits[2], regs, m, interval * (m + 1), cells);
    out.push('U ' + hex2(uartFrame(pkt)));
    [37, 38, 39].forEach((ch, i) => out.push(`A ${i} ${advBits(pkt, ch)}`));
  });
  return out;
}

module.exports = { modulator, bist, filter, measure, uartFrame, advBits, DEFAULT_REGS, FS };

if (require.main === module) {
  const [, , cmd, a, b] = process.argv;
  if (cmd === 'stim') {
    fs.writeFileSync(b, stimulus(+a).flat().map(hex4).join('\n') + '\n');
    console.log(`wrote ${a} measurements to ${b}`);
  } else if (cmd === 'check') {
    const v = fs.readFileSync(a, 'utf8').trim().split(/\s+/).map((h) => s16(parseInt(h, 16)));
    const rows = []; for (let i = 0; i < v.length; i += 3) rows.push(v.slice(i, i + 3));
    const regs = DEFAULT_REGS.slice(); regs[1] = 0xffce; regs[6] = (24 << 8) | 1;   // as set by the test bench
    const want = expected(rows, regs, 100, process.argv.includes('--bist'));
    const got = fs.readFileSync(b, 'utf8').trim().split(/\r?\n/);
    let bad = 0;
    for (let i = 0; i < Math.max(want.length, got.length); i++) if (want[i] !== got[i]) {
      if (bad++ < 5) console.log(`line ${i + 1} differs\n  model  : ${want[i]}\n  verilog: ${got[i]}`);
    }
    const nU = want.filter((l) => l[0] === 'U').length;
    want.filter((l) => l[0] === 'U').forEach((l) => {
      const p = l.slice(8).split(' ').slice(0, 17).map((h) => parseInt(h, 16)), dv = new DataView(new Uint8Array(p).buffer);
      console.log(`  seq ${dv.getUint16(0, true)}  up ${dv.getUint32(2, true)} ms  I ${dv.getInt32(6, true)} pA  T ${(dv.getInt16(10, true) / 100).toFixed(2)} C  batt ${p[12]} %  flags ${p[13]}  islet a/b/d ${p[14]}/${p[15]}/${p[16]}`);
    });
    console.log(`RESULT ${bad === 0 ? 'PASS' : 'FAIL'}: ${nU} UART frames and ${want.length - nU} advertising packets (${(want.length - nU) * 320} on-air bits) compared, ${bad} lines differ`);
    process.exit(bad ? 1 : 0);
  } else if (cmd === 'lin') {
    console.log('input_nA,output_pA,error_pA');
    let worst = 0;
    for (let nA = -180; nA <= 180; nA += 0.5) {
      const u = Math.round((nA / 200) * 32768), code = 2 * filter(modulator(u)) - FS;
      const pA = scale(code, DEFAULT_REGS[0], 14, 0), err = pA - (u / 32768) * 200000;
      worst = Math.max(worst, Math.abs(err));
      console.log(`${nA},${pA},${err.toFixed(1)}`);
    }
    console.error(`worst error over +-180 nA: ${worst.toFixed(1)} pA`);
  }
}

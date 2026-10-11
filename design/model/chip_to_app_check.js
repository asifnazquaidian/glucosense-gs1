// Feeds the packets produced by the Verilog chip simulation to the GlucoSense app's own decoder
// (app/proto.js) and to its calibration formula, to show that chip and app speak the same format.
const fs = require('fs'), path = require('path');
global.window = {};
eval(fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'proto.js'), 'utf8'));
const GS = window.GS;
const lines = fs.readFileSync(path.join(__dirname, '..', 'results', 'tb.out'), 'utf8').split(/\r?\n/).filter((l) => l[0] === 'U');
let ok = 0;
for (const l of lines) {
  const b = l.split(' ').slice(1).map((h) => parseInt(h, 16));
  const p = GS.decode(new DataView(new Uint8Array(b.slice(2, 16)).buffer));
  const again = [...new Uint8Array(GS.encode({ seq: p.seq, uptime: p.uptime, currentPA: p.currentPA, tempC100: p.tempC100, batt: p.batt, flags: p.flags }).buffer)];
  const same = again.every((v, i) => v === b[2 + i]);
  if (same) ok++;
  const glucose = (p.currentPA / 1000 - 1.2) / 0.046;          // the app's default (placeholder) sensor constants
  console.log(`seq ${p.seq}  ${p.currentPA} pA -> ${glucose.toFixed(0)} mg/dL  ${(p.tempC100 / 100).toFixed(2)} C  ${p.batt} %  flags ${p.flags}  islet ${b.slice(16, 19).join('/')}  re-encode ${same ? 'identical' : 'DIFFERENT'}`);
}
console.log(`RESULT ${ok === lines.length ? 'PASS' : 'FAIL'}: ${ok} of ${lines.length} chip packets decoded by app/proto.js and re-encoded to the same 14 bytes`);

// GS-1 full-chip floorplan: one description -> GDSII block abstract, pad table, and the drawings
// and plots used in the proposal (TikZ).
//   node make_floorplan.js        (run from the chip folder)
// The GDS holds block outlines, pad openings and labels only. It is a floorplan for the design
// team and the foundry interface discussion, NOT a mask-ready layout.
'use strict';
const fs = require('fs'), path = require('path');
const ROOT = path.join(__dirname, '..'), OUT = __dirname, FIG = path.join(ROOT, 'proposal', 'fig');
fs.mkdirSync(FIG, { recursive: true });

const DIE = 1600;                                   // um, square
// name, x0, y0, x1, y1, class, layer, estimated average current (uA) or note
const BLOCKS = [
  ['RF', '2.4 GHz BLE transceiver', 400, 880, 1450, 1450, 'rf', 11],
  ['XO', '32 MHz crystal osc.', 150, 1180, 380, 1450, 'rf', 11],
  ['LFO', '32 kHz timer osc.', 150, 880, 380, 1160, 'ana', 10],
  ['REF', 'Bandgap, temp. sensor', 150, 720, 560, 860, 'ana', 10],
  ['ADC', 'Sigma-delta modulator', 150, 500, 560, 700, 'ana', 10],
  ['POT', 'Potentiostat, TIA, bias DAC', 150, 150, 560, 480, 'ana', 10],
  ['MCU', 'MCU, BLE link layer, ROM, SRAM', 580, 500, 1450, 860, 'dig', 12],
  ['GS1', 'Sensing core + HEC islet', 580, 150, 820, 480, 'dig', 12],
  ['OTP', 'OTP trim, calibration', 840, 150, 1060, 480, 'dig', 12],
  ['PMU', 'LDOs, POR, battery monitor', 1080, 150, 1450, 480, 'pwr', 13],
];
const PADS = {
  left: ['GNDA', 'VREF', 'AIN_AUX', 'GUARD', 'CE', 'RE', 'WE'],            // bottom to top
  top: ['XI', 'XO', 'VDDA', 'VDD_RF', 'GND_RF', 'ANT', 'GND_RF2'],         // left to right
  right: ['GPIO1', 'GPIO0', 'TMS', 'TCK', 'DRDY', 'UART_RX', 'UART_TX'],   // bottom to top
  bottom: ['VBAT', 'GND', 'VDDD', 'VPP', 'RST_N', 'BIST', 'ADV_EN'],       // left to right
};
const PAD_USE = {
  WE: 'Working electrode (sensor current input)', RE: 'Reference electrode', CE: 'Counter electrode',
  GUARD: 'Guard ring driver for the WE track', AIN_AUX: 'Spare analog input (external NTC)',
  VREF: 'Reference bypass capacitor', GNDA: 'Analog ground',
  XI: '32 MHz crystal', XO: '32 MHz crystal', VDDA: 'Analog supply (LDO output, decoupling)',
  VDD_RF: 'RF supply (LDO output, decoupling)', GND_RF: 'RF ground', ANT: '2.4 GHz antenna, 50 ohm',
  GND_RF2: 'RF ground', UART_TX: 'Measurement frames / debug', UART_RX: 'Commands / debug',
  DRDY: 'Data-ready / wake output', TCK: 'Debug clock', TMS: 'Debug data', GPIO0: 'General purpose',
  GPIO1: 'General purpose', VBAT: 'Battery, 1.8 to 3.6 V', GND: 'Ground', VDDD: 'Digital core supply (decoupling)',
  VPP: 'OTP programming supply', RST_N: 'Reset, active low', BIST: 'Self-test enable', ADV_EN: 'Advertising enable',
};
const PW = 70, PH = 90, PITCH = 170, FIRST = 290;   // pad opening 70 x 90 um, 7 per side

const pads = [];
let num = 1;
PADS.left.slice().reverse().forEach((n, i) => { const c = DIE - FIRST - i * PITCH; pads.push({ n, side: 'left', x0: 20, y0: c - PW / 2, x1: 20 + PH, y1: c + PW / 2 }); });
PADS.bottom.forEach((n, i) => { const c = FIRST + i * PITCH; pads.push({ n, side: 'bottom', x0: c - PW / 2, y0: 20, x1: c + PW / 2, y1: 20 + PH }); });
PADS.right.forEach((n, i) => { const c = FIRST + i * PITCH; pads.push({ n, side: 'right', x0: DIE - 20 - PH, y0: c - PW / 2, x1: DIE - 20, y1: c + PW / 2 }); });
PADS.top.slice().reverse().forEach((n, i) => { const c = DIE - FIRST - i * PITCH; pads.push({ n, side: 'top', x0: c - PW / 2, y0: DIE - 20 - PH, x1: c + PW / 2, y1: DIE - 20 }); });
pads.forEach((p) => { p.num = num++; });           // pin 1 = WE (top of the left side), counter-clockwise

// ---------------------------------------------------------------- GDSII writer
const chunks = [];
const rec = (type, dt, data) => { const b = Buffer.alloc(4 + data.length); b.writeUInt16BE(4 + data.length, 0); b[2] = type; b[3] = dt; data.copy(b, 4); chunks.push(b); };
const i16 = (...v) => { const b = Buffer.alloc(2 * v.length); v.forEach((x, i) => b.writeInt16BE(x, 2 * i)); return b; };
const i32 = (...v) => { const b = Buffer.alloc(4 * v.length); v.forEach((x, i) => b.writeInt32BE(x, 4 * i)); return b; };
const str = (s) => Buffer.from(s.length % 2 ? s + '\0' : s, 'latin1');
const real8 = (x) => {
  const b = Buffer.alloc(8); if (x === 0) return b;
  let e = 64, m = Math.abs(x);
  while (m >= 1) { m /= 16; e++; } while (m < 1 / 16) { m *= 16; e--; }
  b[0] = (x < 0 ? 0x80 : 0) | e;
  for (let i = 1; i < 8; i++) { m *= 256; const d = Math.floor(m); b[i] = d; m -= d; }
  return b;
};
const NM = 1000;                                    // database unit 1 nm, user unit 1 um
const box = (layer, x0, y0, x1, y1) => {
  rec(0x08, 0, Buffer.alloc(0)); rec(0x0d, 2, i16(layer)); rec(0x0e, 2, i16(0));
  rec(0x10, 3, i32(...[x0, y0, x1, y0, x1, y1, x0, y1, x0, y0].map((v) => Math.round(v * NM)))); rec(0x11, 0, Buffer.alloc(0));
};
const text = (layer, x, y, s) => {
  rec(0x0c, 0, Buffer.alloc(0)); rec(0x0d, 2, i16(layer)); rec(0x16, 2, i16(0));
  rec(0x10, 3, i32(Math.round(x * NM), Math.round(y * NM))); rec(0x19, 6, str(s)); rec(0x11, 0, Buffer.alloc(0));
};
const now = [2026, 10, 9, 12, 0, 0];
rec(0x00, 2, i16(600)); rec(0x01, 2, i16(...now, ...now)); rec(0x02, 6, str('GS1_FLOORPLAN'));
rec(0x03, 5, Buffer.concat([real8(0.001), real8(1e-9)]));
rec(0x05, 2, i16(...now, ...now)); rec(0x06, 6, str('gs1_top_floorplan'));
box(1, 0, 0, DIE, DIE);                             // die edge
box(2, 130, 130, DIE - 130, DIE - 130);             // core boundary inside the pad ring
for (const [id, , x0, y0, x1, y1, , layer] of BLOCKS) { box(layer, x0, y0, x1, y1); text(63, (x0 + x1) / 2, (y0 + y1) / 2, id); }
for (const p of pads) { box(20, p.x0, p.y0, p.x1, p.y1); text(63, (p.x0 + p.x1) / 2, (p.y0 + p.y1) / 2, p.n); }
rec(0x07, 0, Buffer.alloc(0)); rec(0x04, 0, Buffer.alloc(0));
const gds = Buffer.concat(chunks);
fs.writeFileSync(path.join(OUT, 'gs1_floorplan.gds'), gds);

// read it back as a check
let nb = 0, nt = 0;
for (let o = 0; o < gds.length;) { const len = gds.readUInt16BE(o); if (gds[o + 2] === 0x08) nb++; if (gds[o + 2] === 0x0c) nt++; o += len; }
console.log(`gs1_floorplan.gds: ${gds.length} bytes, ${nb} rectangles, ${nt} labels (expected ${2 + BLOCKS.length + pads.length}, ${BLOCKS.length + pads.length})`);

fs.writeFileSync(path.join(OUT, 'gs1_floorplan_layers.txt'),
  'GS-1 floorplan GDS (gs1_floorplan.gds), cell gs1_top_floorplan, units um, database unit 1 nm\n' +
  'layer 1  die edge 1600 x 1600 um\nlayer 2  core boundary\nlayer 10 analog blocks\nlayer 11 RF blocks\n' +
  'layer 12 digital blocks\nlayer 13 power management\nlayer 20 pad openings 70 x 90 um\nlayer 63 labels\n' +
  'Layer numbers are placeholders; they are remapped to the foundry layer table when the PDK is installed.\n');
fs.writeFileSync(path.join(OUT, 'gs1_pads.csv'), 'pin,name,side,centre_x_um,centre_y_um,function\n' +
  pads.map((p) => `${p.num},${p.n},${p.side},${(p.x0 + p.x1) / 2},${(p.y0 + p.y1) / 2},"${PAD_USE[p.n]}"`).join('\n') + '\n');
fs.writeFileSync(path.join(OUT, 'gs1_blocks.csv'), 'block,description,x0_um,y0_um,x1_um,y1_um,area_mm2\n' +
  BLOCKS.map(([id, d, x0, y0, x1, y1]) => `${id},"${d}",${x0},${y0},${x1},${y1},${(((x1 - x0) * (y1 - y0)) / 1e6).toFixed(3)}`).join('\n') + '\n');

// ---------------------------------------------------------------- TikZ: floorplan
const S = 0.0075, c = (v) => (v * S).toFixed(3), tex = (s) => s.replace(/_/g, '\\_');
let t = '\\begin{tikzpicture}[font=\\sffamily]\n';
t += `\\draw[line width=1pt,fill=black!4] (0,0) rectangle (${c(DIE)},${c(DIE)});\n`;
t += `\\draw[densely dashed,black!55] (${c(130)},${c(130)}) rectangle (${c(DIE - 130)},${c(DIE - 130)});\n`;
for (const [id, d, x0, y0, x1, y1, cls] of BLOCKS) {
  t += `\\draw[blk${cls}] (${c(x0)},${c(y0)}) rectangle (${c(x1)},${c(y1)});\n`;
  const w = ((x1 - x0) * S - 0.15).toFixed(2);
  t += `\\node[align=center,text width=${w}cm,font=\\sffamily\\scriptsize] at (${c((x0 + x1) / 2)},${c((y0 + y1) / 2)}) {\\textbf{${id}}\\\\[-1pt]{\\tiny ${d}}\\\\[-1pt]{\\tiny ${x1 - x0}\\,$\\times$\\,${y1 - y0}}};\n`;
}
for (const p of pads) {
  t += `\\draw[fill=black!45,draw=black] (${c(p.x0)},${c(p.y0)}) rectangle (${c(p.x1)},${c(p.y1)});\n`;
  const cx = (p.x0 + p.x1) / 2, cy = (p.y0 + p.y1) / 2, lab = `{\\tiny ${p.num}\\,${tex(p.n)}}`;
  if (p.side === 'left') t += `\\node[anchor=east] at (${c(-15)},${c(cy)}) ${lab};\n`;
  if (p.side === 'right') t += `\\node[anchor=west] at (${c(DIE + 15)},${c(cy)}) ${lab};\n`;
  if (p.side === 'bottom') t += `\\node[anchor=east,rotate=90] at (${c(cx)},${c(-15)}) ${lab};\n`;
  if (p.side === 'top') t += `\\node[anchor=west,rotate=90] at (${c(cx)},${c(DIE + 15)}) ${lab};\n`;
}
t += `\\draw[<->] (0,${c(-330)}) -- node[fill=white,font=\\sffamily\\scriptsize]{1600 \\textmu m} (${c(DIE)},${c(-330)});\n`;
t += `\\fill (${c(60)},${c(DIE - 60)}) circle (1.4pt);\n\\end{tikzpicture}\n`;
fs.writeFileSync(path.join(FIG, 'floorplan.tex'), t);

// ---------------------------------------------------------------- TikZ: plots from the models
function plot(file, o) {                             // o: {w,h,xmin,xmax,ymin,ymax,xt,yt,xl,yl,series:[{pts,style,label}]}
  const X = (x) => (((x - o.xmin) / (o.xmax - o.xmin)) * o.w).toFixed(3), Y = (y) => (((y - o.ymin) / (o.ymax - o.ymin)) * o.h).toFixed(3);
  let s = '\\begin{tikzpicture}[font=\\sffamily\\scriptsize]\n';
  for (const y of o.yt) s += `\\draw[black!12] (0,${Y(y)}) -- (${o.w},${Y(y)}); \\node[anchor=east] at (0,${Y(y)}) {${y}};\n`;
  for (const x of o.xt) s += `\\draw (${X(x)},0) -- (${X(x)},-0.06); \\node[anchor=north] at (${X(x)},-0.06) {${x}};\n`;
  for (const b of o.bands || []) s += `\\fill[${b.style}] (0,${Y(b.y0)}) rectangle (${o.w},${Y(b.y1)});\n`;
  s += `\\draw (0,0) rectangle (${o.w},${o.h});\n`;
  for (const sr of o.series) {
    if (sr.marks) for (const [x, y] of sr.pts) s += `\\fill[${sr.style}] (${X(x)},${Y(y)}) circle (0.9pt);\n`;
    else s += `\\draw[${sr.style}] ` + sr.pts.map(([x, y]) => `(${X(x)},${Y(Math.max(o.ymin, Math.min(o.ymax, y)))})`).join(' -- ') + ';\n';
  }
  s += `\\node at (${o.w / 2},-0.62) {${o.xl}};\n\\node[rotate=90] at (-0.95,${o.h / 2}) {${o.yl}};\n`;
  o.series.forEach((sr, i) => {
    if (!sr.label) return;
    const lx = o.lx ?? 0.25, ly = (o.ly ?? o.h - 0.25) - 0.3 * i;
    s += sr.marks ? `\\fill[${sr.style}] (${lx + 0.2},${ly}) circle (0.9pt);` : `\\draw[${sr.style}] (${lx},${ly}) -- (${lx + 0.4},${ly});`;
    s += ` \\node[anchor=west] at (${lx + 0.45},${ly}) {${sr.label}};\n`;
  });
  fs.writeFileSync(path.join(FIG, file), s + '\\end{tikzpicture}\n');
}

const gm = require(path.join(ROOT, 'model', 'gs1_model.js'));
const adc = [];
for (let nA = -180; nA <= 180; nA += 1.5) {
  const u = Math.round((nA / 200) * 32768), code = 2 * gm.filter(gm.modulator(u)) - gm.FS;
  adc.push([nA, Math.floor((code * gm.DEFAULT_REGS[0]) / 16384) - (u / 32768) * 200000]);
}
plot('adc.tex', { w: 6.3, h: 3.2, xmin: -180, xmax: 180, ymin: -20, ymax: 20, xt: [-180, -90, 0, 90, 180], yt: [-20, -10, 0, 10, 20],
  xl: 'Input current (nA)', yl: 'Error (pA)', series: [{ pts: adc, style: 'blue!70!black,line width=0.5pt' }] });

const hi = JSON.parse(fs.readFileSync(path.join(ROOT, 'results', 'hec_islet.json'), 'utf8'));
const sw = hi.sweep;
plot('islet.tex', { w: 6.3, h: 3.2, xmin: 40, xmax: 400, ymin: 0, ymax: 100, xt: [40, 100, 200, 300, 400], yt: [0, 25, 50, 75, 100],
  xl: 'Glucose (mg/dL)', yl: 'Spikes per period',
  series: [
    { pts: sw.map((r) => [r.glucose, r.alpha_thesis]), style: 'red!75!black,line width=0.6pt', label: '$\\alpha$ cell' },
    { pts: sw.map((r) => [r.glucose, r.beta_thesis]), style: 'blue!70!black,line width=0.6pt', label: '$\\beta$ cell' },
    { pts: sw.map((r) => [r.glucose, r.delta_thesis]), style: 'green!45!black,line width=0.6pt', label: '$\\delta$ cell' },
    { pts: sw.flatMap((r) => [[r.glucose, r.alpha_chip], [r.glucose, r.beta_chip], [r.glucose, r.delta_chip]]), style: 'black', marks: true, label: 'chip arithmetic' },
  ] });
const every = (a, k) => a.filter((_, i) => i % k === 0);
plot('patient.tex', { w: 13.2, h: 3.4, xmin: 0, xmax: 600, ymin: 60, ymax: 240, xt: [0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600], yt: [60, 100, 140, 180, 220],
  xl: 'Time (min); meals at 60 and 300 min', yl: 'Glucose (mg/dL)', lx: 0.25, bands: [{ y0: 70, y1: 180, style: 'green!8' }],
  series: [
    { pts: every(hi.healthy, 4).map((r) => [r.min, r.G]), style: 'blue!70!black,line width=0.8pt', label: 'normal $\\beta$-cell response' },
    { pts: every(hi.impaired, 4).map((r) => [r.min, r.G]), style: 'red!75!black,line width=0.8pt', label: '$\\beta$-cell drive reduced to 35\\,\\%' },
  ] });
plot('patient_beta.tex', { w: 13.2, h: 2.0, xmin: 0, xmax: 600, ymin: 10, ymax: 50, xt: [0, 60, 120, 180, 240, 300, 360, 420, 480, 540, 600], yt: [10, 30, 50],
  xl: 'Time (min)', yl: '$\\beta$ spikes', series: [
    { pts: every(hi.healthy, 4).map((r) => [r.min, r.beta]), style: 'blue!70!black,line width=0.6pt' },
    { pts: every(hi.impaired, 4).map((r) => [r.min, r.beta]), style: 'red!75!black,line width=0.6pt' },
  ] });

// pad table rows for the proposal
fs.writeFileSync(path.join(FIG, 'padrows.tex'), pads.map((p) => `${p.num} & \\texttt{${tex(p.n)}} & ${p.side} & ${PAD_USE[p.n]} \\\\`).join('\n') + '\n');
const area = BLOCKS.reduce((a, b) => a + (b[4] - b[2]) * (b[5] - b[3]), 0) / 1e6;
console.log(`blocks ${BLOCKS.length}, block area ${area.toFixed(2)} mm2, die ${(DIE * DIE / 1e6).toFixed(2)} mm2, pads ${pads.length}`);

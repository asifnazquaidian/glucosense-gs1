# GlucoSense GS-1

A single-chip wearable glucose sensor interface with Bluetooth Low Energy and an on-chip model of
the pancreatic islet. Research prototype. **Not a medical device.**

- Proposal: [GlucoSense_GS1_Chip_Proposal.pdf](GlucoSense_GS1_Chip_Proposal.pdf)
- Live application: https://glucosensor.netlify.app (press *Start simulator*)
- Earlier chip by the same author: https://github.com/asifnazquaidian/neurobit64

## What is here

| Folder | Content |
|---|---|
| `src/` | `project.v`: the digital core of the chip (sensing core + HEC islet block) with its Tiny Tapeout wrapper |
| `test/` | cocotb test and the Python reference model |
| `docs/`, `info.yaml` | Tiny Tapeout project description and pinout |
| `design/rtl/` | The same Verilog as separate modules: `gs1_core.v`, `gs1_islet.v` |
| `design/tb/` | Verilog test bench with a behavioural sigma-delta modulator |
| `design/model/` | JavaScript reference model of the chip, the HEC islet model (thesis model, chip arithmetic, virtual patient), chip-to-application check |
| `design/results/` | Comparison reports (all PASS), synthesis report (7,900 SkyWater 130 nm cells), gate-level netlist |
| `design/floorplan/` | Full-chip floorplan: GDSII block abstract (not mask-ready), pad and block coordinate tables, generator script |
| `app/` | The GlucoSense web application |

## The chip in one paragraph

Once per sample interval the digital core clocks an analog sigma-delta modulator, filters its bit
stream for three channels (sensor current, temperature, battery), scales the results, runs one
period of a Hybrid Excitable Cell (HEC) model of pancreatic alpha, beta and delta cells driven by
the glucose signal, and sends a 17-byte packet on a UART and as a Bluetooth LE advertising packet.
The HEC model is from A. Mehmood, *Artificial Neuron Model for Large Scale Spiking Brain Neural
Network*, PhD thesis, University of Engineering and Technology, Taxila.

## Status

Done: digital core verified against JavaScript and Python models (including 9,600 Bluetooth on-air
bits), synthesised, floorplanned; application running.
Not done: no silicon; analog front end, radio, processor and memory are specified only; Bluetooth
not tested over the air; nothing tested with a real sensor or on people. The link between glucose
and the islet cells' drive is a design hypothesis that has not been validated.

## Re-running the checks

Needs Node.js, Icarus Verilog and Python 3. From `design/`:

```
node model/gs1_model.js stim 10 results/stim.hex
iverilog -g2005 -o results/tb.vvp ../src/project.v tb/tb_gs1.v && vvp results/tb.vvp
node model/gs1_model.js check results/stim.hex results/tb.out
node model/chip_to_app_check.js
node model/hec_islet.js
python ../test/reference.py results/tb_bist.out
```

Copyright (c) 2026 Asif Mehmood.

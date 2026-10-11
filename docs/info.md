## How it works

Digital core of the GlucoSense GS-1 wearable glucose-sensor chip. Once per sample interval it:

1. clocks an external 1-bit sigma-delta modulator and filters its bit stream (two integrators,
   1024 modulator clocks) for three channels: sensor current, temperature, battery;
2. scales the results to pA, 0.01 degC and percent with gain/offset registers;
3. runs a Hybrid Excitable Cell (HEC) model of pancreatic alpha, beta and delta cells driven by
   the glucose signal and counts their spikes;
4. sends a 20-byte UART frame (A5 5A, 14-byte GlucoSense packet, 3 islet bytes, XOR checksum)
   at 115.9 kbaud and, if ADV_EN is high, a Bluetooth LE advertising packet bit stream
   (whitened, CRC-24, 1 Mbit/s) for channels 37, 38 and 39.

UART commands: `01 lo hi` sample interval in ms (100 to 60000), `02 addr lo hi` write a register.

## How to test

Clock 8 MHz. Hold BIST_EN and UART_RX high, release reset, connect UART_TX to a USB serial
adapter at 115200 baud: one frame arrives every second. In self-test mode the current is
5888 pA, the temperature 32.81 degC and the battery 89 %.

## External hardware

USB serial adapter. For real measurements: a potentiostat and a 1-bit sigma-delta modulator on
SD_IN / SD_CLK / SD_RST, and a 2.4 GHz GFSK transmitter on BB_DATA / BB_EN.

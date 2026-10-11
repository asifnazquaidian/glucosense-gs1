/*
 * GS-1 digital core : the digital half of the GlucoSense wearable glucose-sensor chip.
 * Copyright (c) 2026 Asif Mehmood
 *
 * What it does, once every "interval" milliseconds:
 *   1. switches on the analog front end and converts three channels, one after the other, with
 *      one incremental sigma-delta ADC:   0 = sensor current   1 = temperature   2 = battery
 *      (the modulator is analog; this core supplies its clock and reset and filters its 1-bit
 *       output with a cascade of two integrators over 1024 modulator clocks)
 *   2. scales each result with a per-chip gain and offset to  pA,  0.01 degC  and  percent
 *   3. runs the HEC islet model (rtl/gs1_islet.v): one period (1024 steps) of a pancreatic alpha,
 *      beta and delta cell driven by the measured glucose signal, and counts their spikes
 *   4. builds the 14-byte GlucoSense measurement packet (identical to app/proto.js) followed by
 *      3 extension bytes: alpha, beta, delta spike counts
 *   5. sends it  a) on a UART (frame A5 5A + 17 bytes + XOR checksum) for a companion radio / MCU
 *                b) as a Bluetooth LE advertising packet (ADV_NONCONN_IND, manufacturer data) on
 *                   channels 37, 38, 39: whitened 1 Mbit/s bit stream with CRC-24 for the
 *                   on-chip 2.4 GHz GFSK transmitter.
 * Commands arrive on uart_rx with the same bytes as the app's control characteristic:
 *   01 lo hi        sample interval in ms (limited to 100 .. 60000)
 *   02 addr lo hi   write configuration register (see REGISTER MAP)
 *
 * Clock: 8 MHz.  Modulator clock = clk / 32 = 250 kHz.  UART = clk / 69 = 115.9 kbaud.
 *
 * REGISTER MAP (16 bit)                                         reset value
 *   0 gain    current      pA   = code * gain >> 14  + offset   6268   (200 nA full scale)
 *   1 offset  current                                           0
 *   2 gain    temperature  cdeg = code * gain >> 18  + offset   4995   (+-100 degC about offset)
 *   3 offset  temperature                                       2500
 *   4 gain    battery      pct  = code * gain >> 24  + offset   1598   (0..100 % over full scale)
 *   5 offset  battery                                           50
 *   6 [7:0] warm-up time in units of 256 ms, [13:8] sensor bias DAC code      {6'd24, 8'd234}
 *   7 alpha-cell glucose threshold, pA (cells are driven below it)          5340   (90 mg/dL)
 *   8 beta/delta-cell glucose threshold, pA (driven above it)               4880   (80 mg/dL)
 *   code = 2 * filter - 524800, i.e. -524800 .. +524800 for a bit density of 0 .. 1
 */

`default_nettype none
`timescale 1ns / 1ps

module gs1_core (
    input  wire       clk,
    input  wire       rst_n,
    input  wire       sd_in,      // 1-bit stream from the sigma-delta modulator
    input  wire       uart_rx,    // commands
    input  wire       adv_en,     // 1 = also transmit BLE advertising packets
    input  wire       bist_en,    // 1 = use the built-in digital test modulator instead of sd_in
    output wire       uart_tx,
    output reg        bb_data,    // BLE bit stream, 1 Mbit/s, to the GFSK modulator
    output reg        bb_en,      // high while a packet is on air (power amplifier enable)
    output reg        pll_en,     // high from 128 us before a packet until its end
    output reg  [1:0] rf_ch,      // 0, 1, 2 = advertising channel 37, 38, 39 (2402, 2426, 2480 MHz)
    output wire       sd_clk,     // modulator clock
    output reg        sd_rst,     // modulator reset (high between conversions)
    output reg        afe_en,     // ADC and sensor supplies on
    output reg  [1:0] amux,       // analog input select
    output wire [5:0] bias,       // sensor bias DAC code
    output reg        drdy        // high while the UART frame is being sent
);
    // ------------------------------------------------------------------ configuration registers
    reg [15:0] r_gi, r_oi, r_gt, r_ot, r_gb, r_ob, r_cfg, r_tha, r_thb, interval;
    assign bias = r_cfg[13:8];

    // ------------------------------------------------------------------ time base
    reg [12:0] msdiv;
    reg [31:0] uptime;                 // ms since reset
    reg [15:0] since;                  // ms since the last measurement started
    wire       ms_tick = (msdiv == 13'd7999);
    wire       trigger = ms_tick && (since + 16'd1 >= interval);

    // ------------------------------------------------------------------ UART receiver + commands
    reg  [2:0]  rxs;                   // input synchroniser
    reg  [6:0]  rxdiv;
    reg  [3:0]  rxbit;
    reg         rxbusy;
    reg  [7:0]  rxsh;
    reg         rxstb;
    reg  [2:0]  cst;                   // command parser state
    reg  [3:0]  caddr;
    reg  [7:0]  clo;
    reg  [13:0] cidle;                 // 2 ms without a byte puts the parser back to idle
    wire [15:0] cval = {rxsh, clo};

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            rxs <= 3'b111; rxdiv <= 7'd0; rxbit <= 4'd0; rxbusy <= 1'b0; rxsh <= 8'd0; rxstb <= 1'b0;
            cst <= 3'd0; caddr <= 4'd0; clo <= 8'd0; cidle <= 14'd0;
            r_gi <= 16'd6268; r_oi <= 16'd0; r_gt <= 16'd4995; r_ot <= 16'd2500;
            r_gb <= 16'd1598; r_ob <= 16'd50; r_cfg <= {2'b00, 6'd24, 8'd234}; interval <= 16'd1000;
            r_tha <= 16'd5340; r_thb <= 16'd4880;
        end else begin
            rxs   <= {rxs[1:0], uart_rx};
            rxstb <= 1'b0;
            if (!rxbusy) begin
                if (!rxs[2]) begin rxbusy <= 1'b1; rxdiv <= 7'd34; rxbit <= 4'd0; end   // start bit
            end else if (rxdiv != 7'd0) begin
                rxdiv <= rxdiv - 7'd1;
            end else begin
                rxdiv <= 7'd68;
                rxbit <= rxbit + 4'd1;
                if (rxbit == 4'd0) begin
                    if (rxs[2]) rxbusy <= 1'b0;                      // false start
                end else if (rxbit <= 4'd8) begin
                    rxsh <= {rxs[2], rxsh[7:1]};
                end else begin
                    rxbusy <= 1'b0;
                    rxstb  <= rxs[2];                                // valid stop bit
                end
            end

            if (rxstb) begin
                cidle <= 14'd0;
                case (cst)
                    3'd0: cst <= (rxsh == 8'h01) ? 3'd1 : (rxsh == 8'h02) ? 3'd3 : 3'd0;
                    3'd1: begin clo <= rxsh; cst <= 3'd2; end
                    3'd2: begin
                        interval <= (cval < 16'd100) ? 16'd100 : (cval > 16'd60000) ? 16'd60000 : cval;
                        cst <= 3'd0;
                    end
                    3'd3: begin caddr <= rxsh[3:0]; cst <= 3'd4; end
                    3'd4: begin clo <= rxsh; cst <= 3'd5; end
                    default: begin
                        case (caddr)
                            4'd0: r_gi <= cval;
                            4'd1: r_oi <= cval;
                            4'd2: r_gt <= cval;
                            4'd3: r_ot <= cval;
                            4'd4: r_gb <= cval;
                            4'd5: r_ob <= cval;
                            4'd6: r_cfg <= cval;
                            4'd7: r_tha <= cval;
                            4'd8: r_thb <= cval;
                            default: ;
                        endcase
                        cst <= 3'd0;
                    end
                endcase
            end else if (cst != 3'd0) begin
                cidle <= cidle + 14'd1;
                if (&cidle) cst <= 3'd0;
            end
        end
    end

    // ------------------------------------------------------------------ measurement results
    reg        [15:0] seq;
    reg        [31:0] t_up;            // uptime of the measurement being sent
    reg signed [23:0] cur;             // pA
    reg signed [15:0] temp;            // 0.01 degC
    reg        [7:0]  batt;            // percent
    reg               sat;
    reg        [7:0]  na, nb, nd;      // islet spike counts of the last period
    wire       [7:0]  flags = {5'b00000, batt < 8'd15, sat, t_up[31:8] < {16'd0, r_cfg[7:0]}};

    // byte i of the payload: 14-byte measurement packet (little-endian, see app/proto.js) + 3
    function [7:0] pbyte(input [4:0] i);
        case (i)
            5'd0:  pbyte = seq[7:0];
            5'd1:  pbyte = seq[15:8];
            5'd2:  pbyte = t_up[7:0];
            5'd3:  pbyte = t_up[15:8];
            5'd4:  pbyte = t_up[23:16];
            5'd5:  pbyte = t_up[31:24];
            5'd6:  pbyte = cur[7:0];
            5'd7:  pbyte = cur[15:8];
            5'd8:  pbyte = cur[23:16];
            5'd9:  pbyte = {8{cur[23]}};
            5'd10: pbyte = temp[7:0];
            5'd11: pbyte = temp[15:8];
            5'd12: pbyte = batt;
            5'd13: pbyte = flags;
            5'd14: pbyte = na;
            5'd15: pbyte = nb;
            default: pbyte = nd;
        endcase
    endfunction

    // byte k of the advertising packet as it goes on air (before whitening)
    function [7:0] abyte(input [5:0] k);
        case (k)
            6'd0:  abyte = 8'hAA;                       // preamble
            6'd1:  abyte = 8'hD6;                       // access address 0x8E89BED6
            6'd2:  abyte = 8'hBE;
            6'd3:  abyte = 8'h89;
            6'd4:  abyte = 8'h8E;
            6'd5:  abyte = 8'h42;                       // ADV_NONCONN_IND, random address
            6'd6:  abyte = 8'd30;                       // payload length
            6'd7:  abyte = 8'h01;                       // address C7:47:53:2D:31:01 (static random)
            6'd8:  abyte = 8'h31;
            6'd9:  abyte = 8'h2D;
            6'd10: abyte = 8'h53;
            6'd11: abyte = 8'h47;
            6'd12: abyte = 8'hC7;
            6'd13: abyte = 8'h02;                       // flags: LE general discoverable, no BR/EDR
            6'd14: abyte = 8'h01;
            6'd15: abyte = 8'h06;
            6'd16: abyte = 8'h14;                       // manufacturer data, 20 bytes follow
            6'd17: abyte = 8'hFF;
            6'd18: abyte = 8'hFF;                       // company 0xFFFF (test)
            6'd19: abyte = 8'hFF;
            default: abyte = pbyte(k[4:0] - 5'd20);     // k = 20..36 -> payload byte 0..16
        endcase
    endfunction

    // ------------------------------------------------------------------ UART transmitter
    reg  [6:0] txdiv;
    reg  [3:0] txbit;
    reg  [9:0] txsh;
    reg        txbusy;
    reg        txgo;
    reg  [7:0] txbyte;
    assign uart_tx = txsh[0];

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            txdiv <= 7'd0; txbit <= 4'd0; txsh <= 10'h3FF; txbusy <= 1'b0;
        end else if (!txbusy) begin
            if (txgo) begin txsh <= {1'b1, txbyte, 1'b0}; txbusy <= 1'b1; txdiv <= 7'd68; txbit <= 4'd0; end
        end else if (txdiv != 7'd0) begin
            txdiv <= txdiv - 7'd1;
        end else begin
            txdiv <= 7'd68;
            txsh  <= {1'b1, txsh[9:1]};
            txbit <= txbit + 4'd1;
            if (txbit == 4'd9) txbusy <= 1'b0;
        end
    end

    // ------------------------------------------------------------------ main sequencer
    localparam S_IDLE = 4'd0, S_SETTLE = 4'd1, S_RUN = 4'd2, S_LOAD = 4'd3, S_MUL = 4'd4,
               S_STORE = 4'd5, S_UART = 4'd6, S_UWAIT = 4'd7, S_PLL = 4'd8, S_TX = 4'd9, S_CRC = 4'd10,
               S_ISL = 4'd11;

    reg  [3:0]  st;
    reg  [4:0]  pc;                    // modulator clock prescaler
    reg  [10:0] n;                     // general counter
    reg  [1:0]  sds;                   // sd_in synchroniser
    reg  [9:0]  ph;                    // test modulator
    reg  [10:0] a1;                    // first integrator of the filter
    reg  [19:0] a2;                    // second integrator of the filter
    reg  signed [37:0] p, mc;          // product, shifted multiplicand
    reg  [15:0] g;                     // multiplier bits still to do
    reg  [3:0]  mi;
    reg  [4:0]  ui;                    // UART frame byte index
    reg  [7:0]  cks;
    reg  [5:0]  k;                     // advertising byte index
    reg  [2:0]  bi, bdiv;              // bit in byte, clocks in bit
    reg  [23:0] crc;
    reg  [6:0]  wh;                    // whitening shift register

    // ---- HEC islet model: three cells share one step circuit
    reg  signed [13:0] iv0, iv1, iv2;  // membrane potentials, 1/64 mV
    reg  signed [17:0] iu0, iu1, iu2;  // recovery variables
    reg  [1:0]  ci;
    reg         iph;                   // 0 = first clock of a step, 1 = second
    wire [15:0] gl   = cur[23] ? 16'd0 : (|cur[22:16]) ? 16'hFFFF : cur[15:0];   // glucose signal, pA
    wire signed [17:0] dlo = $signed({2'b00, r_tha}) - $signed({2'b00, gl});
    wire signed [17:0] dhi = $signed({2'b00, gl}) - $signed({2'b00, r_thb});
    wire [7:0]  drv_lo = dlo[17] ? 8'd0 : (|dlo[16:14]) ? 8'd255 : dlo[13:6];
    wire [7:0]  drv_hi = dhi[17] ? 8'd0 : (|dhi[16:14]) ? 8'd255 : dhi[13:6];
    wire signed [13:0] ivn;
    wire signed [17:0] iun;
    wire        ifire;
    gs1_islet islet (
        .clk(clk), .ci(ci), .v(ci == 2'd0 ? iv0 : ci == 2'd1 ? iv1 : iv2), .u(ci == 2'd0 ? iu0 : ci == 2'd1 ? iu1 : iu2),
        .s(n[9:0]), .drive(ci == 2'd0 ? drv_lo : drv_hi), .vn(ivn), .un(iun), .fire(ifire)
    );

    assign sd_clk = pc[4];
    wire        stb    = (pc == 5'd8);
    wire [9:0]  bistk  = (amux == 2'd0) ? 10'd528 : (amux == 2'd1) ? 10'd553 : 10'd922;
    wire [10:0] phsum  = {1'b0, ph} + {1'b0, bistk};
    wire        sbit   = bist_en ? phsum[10] : sds[1];
    wire [10:0] a1n    = a1 + {10'd0, sbit};
    wire signed [21:0] code = $signed({1'b0, a2, 1'b0}) - 22'sd524800;
    wire [15:0] gsel   = (amux == 2'd0) ? r_gi : (amux == 2'd1) ? r_gt : r_gb;
    wire [15:0] osel   = (amux == 2'd0) ? r_oi : (amux == 2'd1) ? r_ot : r_ob;
    wire signed [37:0] psh = (amux == 2'd0) ? (p >>> 14) : (amux == 2'd1) ? (p >>> 18) : (p >>> 24);
    wire signed [23:0] res = psh[23:0] + {{8{osel[15]}}, osel};

    wire [7:0]  ab     = abyte(k);
    wire        rawbit = ab[bi];
    wire        crcin  = (st == S_CRC) ? 1'b0 : (crc[23] ^ rawbit);
    wire        txbitv = (st == S_CRC) ? crc[23] : rawbit;
    wire        white  = (st == S_CRC) || (k >= 6'd5);

    always @(posedge clk or negedge rst_n) begin
        if (!rst_n) begin
            msdiv <= 13'd0; uptime <= 32'd0; since <= 16'd0;
            st <= S_IDLE; pc <= 5'd0; n <= 11'd0; sds <= 2'b00; ph <= 10'd0; a1 <= 11'd0; a2 <= 20'd0;
            p <= 38'sd0; mc <= 38'sd0; g <= 16'd0; mi <= 4'd0; ui <= 5'd0; cks <= 8'd0;
            k <= 6'd0; bi <= 3'd0; bdiv <= 3'd0; crc <= 24'h555555; wh <= 7'd0;
            seq <= 16'd0; t_up <= 32'd0; cur <= 24'sd0; temp <= 16'sd0; batt <= 8'd0; sat <= 1'b0;
            bb_data <= 1'b0; bb_en <= 1'b0; pll_en <= 1'b0; rf_ch <= 2'd0;
            sd_rst <= 1'b1; afe_en <= 1'b0; amux <= 2'd0; drdy <= 1'b0; txgo <= 1'b0; txbyte <= 8'd0;
            iv0 <= -14'sd3840; iv1 <= -14'sd3840; iv2 <= -14'sd3840; iu0 <= 18'sd0; iu1 <= 18'sd0; iu2 <= 18'sd0;
            ci <= 2'd0; iph <= 1'b0; na <= 8'd0; nb <= 8'd0; nd <= 8'd0;
        end else begin
            msdiv <= ms_tick ? 13'd0 : msdiv + 13'd1;
            if (ms_tick) begin
                uptime <= uptime + 32'd1;
                since  <= trigger ? 16'd0 : since + 16'd1;
            end
            sds  <= {sds[0], sd_in};
            txgo <= 1'b0;
            pc   <= (st == S_SETTLE || st == S_RUN) ? pc + 5'd1 : 5'd0;

            case (st)
                S_IDLE: if (trigger) begin
                    t_up <= uptime + 32'd1;
                    afe_en <= 1'b1; amux <= 2'd0; n <= 11'd0; st <= S_SETTLE;
                end

                // modulator held in reset for 16 of its clocks while the input settles
                S_SETTLE: if (stb) begin
                    ph <= 10'd0; a1 <= 11'd0; a2 <= 20'd0;
                    if (n == 11'd15) begin n <= 11'd0; sd_rst <= 1'b0; st <= S_RUN; end
                    else n <= n + 11'd1;
                end

                // 1024 modulator bits through two integrators
                S_RUN: if (stb) begin
                    ph <= phsum[9:0];
                    a1 <= a1n;
                    a2 <= a2 + {9'd0, a1n};
                    n  <= n + 11'd1;
                    if (n == 11'd1023) begin sd_rst <= 1'b1; st <= S_LOAD; end
                end

                S_LOAD: begin
                    p <= 38'sd0; mc <= {{16{code[21]}}, code}; g <= gsel; mi <= 4'd0;
                    if (amux == 2'd0) sat <= (a2 < 20'd16400) || (a2 > 20'd508400);
                    st <= S_MUL;
                end

                // shift-and-add multiply by the gain, one bit per clock
                S_MUL: begin
                    if (g[0]) p <= p + mc;
                    mc <= mc <<< 1;
                    g  <= {1'b0, g[15:1]};
                    mi <= mi + 4'd1;
                    if (mi == 4'd15) st <= S_STORE;
                end

                S_STORE: begin
                    case (amux)
                        2'd0: cur  <= res;
                        2'd1: temp <= (res > 24'sd32767) ? 16'sd32767 : (res < -24'sd32768) ? -16'sd32768 : res[15:0];
                        default: batt <= res[23] ? 8'd0 : (res > 24'sd100) ? 8'd100 : res[7:0];
                    endcase
                    n <= 11'd0;
                    if (amux == 2'd2) begin
                        afe_en <= 1'b0; amux <= 2'd0; ci <= 2'd0; iph <= 1'b0; na <= 8'd0; nb <= 8'd0; nd <= 8'd0; st <= S_ISL;
                    end else begin
                        amux <= amux + 2'd1; st <= S_SETTLE;
                    end
                end

                // HEC islet model: 1024 steps of the alpha cell, then beta, then delta; two clocks per step
                S_ISL: begin
                    iph <= ~iph;
                    if (iph) begin
                    case (ci)
                        2'd0: begin iv0 <= ivn; iu0 <= iun; if (ifire && na != 8'd255) na <= na + 8'd1; end
                        2'd1: begin iv1 <= ivn; iu1 <= iun; if (ifire && nb != 8'd255) nb <= nb + 8'd1; end
                        default: begin iv2 <= ivn; iu2 <= iun; if (ifire && nd != 8'd255) nd <= nd + 8'd1; end
                    endcase
                    n <= n + 11'd1;
                    if (n == 11'd1023) begin
                        n <= 11'd0;
                        if (ci == 2'd2) begin ui <= 5'd0; cks <= 8'd0; drdy <= 1'b1; st <= S_UART; end
                        else ci <= ci + 2'd1;
                    end
                    end
                end

                // frame: A5 5A, 17 payload bytes, XOR of the 17
                S_UART: if (!txbusy && !txgo) begin
                    if (ui == 5'd20) begin
                        drdy <= 1'b0;
                        if (adv_en) begin rf_ch <= 2'd0; pll_en <= 1'b1; n <= 11'd0; st <= S_PLL; end
                        else begin seq <= seq + 16'd1; st <= S_IDLE; end
                    end else begin
                        txbyte <= (ui == 5'd0) ? 8'hA5 : (ui == 5'd1) ? 8'h5A :
                                  (ui == 5'd19) ? cks : pbyte(ui - 5'd2);
                        if (ui >= 5'd2 && ui != 5'd19) cks <= cks ^ pbyte(ui - 5'd2);
                        txgo <= 1'b1;
                        ui   <= ui + 5'd1;
                        st   <= S_UWAIT;
                    end
                end

                S_UWAIT: if (txbusy) st <= S_UART;

                // synthesiser settling time, 1024 clocks = 128 us
                S_PLL: begin
                    n <= n + 11'd1;
                    if (n == 11'd1023) begin
                        k <= 6'd0; bi <= 3'd0; bdiv <= 3'd0; crc <= 24'h555555;
                        wh <= {1'b1, 4'b1001, (rf_ch != 2'd0), (rf_ch != 2'd1)};   // 0x40 | 37, 38, 39
                        st <= S_TX;
                    end
                end

                // one bit every 8 clocks: preamble, access address, header, payload, then CRC
                S_TX, S_CRC: begin
                    bdiv <= bdiv + 3'd1;
                    if (bdiv == 3'd0) begin
                        bb_en   <= 1'b1;
                        bb_data <= txbitv ^ (white & wh[0]);
                        if (white) wh <= {wh[0], wh[6:4], wh[3] ^ wh[0], wh[2:1]};
                        if (st == S_CRC || k >= 6'd5)
                            crc <= {crc[22:0], 1'b0} ^ (crcin ? 24'h00065B : 24'h000000);
                    end
                    if (bdiv == 3'd7) begin
                        bi <= bi + 3'd1;
                        if (st == S_TX) begin
                            if (bi == 3'd7) begin
                                k <= k + 6'd1;
                                if (k == 6'd36) begin n <= 11'd0; st <= S_CRC; end
                            end
                        end else begin
                            n <= n + 11'd1;
                            if (n == 11'd23) begin
                                bb_en <= 1'b0; bb_data <= 1'b0; n <= 11'd0;
                                if (rf_ch == 2'd2) begin
                                    pll_en <= 1'b0; rf_ch <= 2'd0; seq <= seq + 16'd1; st <= S_IDLE;
                                end
                                else begin rf_ch <= rf_ch + 2'd1; st <= S_PLL; end
                            end
                        end
                    end
                end

                default: st <= S_IDLE;
            endcase
        end
    end
endmodule

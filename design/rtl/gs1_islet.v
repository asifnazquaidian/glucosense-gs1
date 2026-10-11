/*
 * GS-1 islet block : one time step of a Hybrid Excitable Cell (HEC) pancreatic alpha, beta or
 * delta cell, in integer arithmetic (V and u in 1/64 mV). gs1_core holds the cell state and gives
 * every step two clocks: the product and the exponentials are registered after the first one.
 * Copyright (c) 2026 Asif Mehmood
 *
 * Model and parameters: A. Mehmood, PhD thesis, UET Taxila, section "Pancreatic Cells":
 *   C V' = k f (V - Vr)(V - Vt) - u + Va + Vb + R I        u' = a (b (V - Vr) - u)
 *   Va = Vglu exp(-s/Tk)   Vb = Vins exp(-s^2/TCa)   threshold = Vt + Va + Vb
 *   spike when V >= threshold: V = c, u = u + d
 * The two exponentials are made with shifts and adds only (value * 2^-(age/4096)).
 * Bit-exact software twin: model/hec_islet.js, fixedStep().
 */

`default_nettype none
`timescale 1ns / 1ps

module gs1_islet (
    input  wire               clk,
    input  wire        [1:0]  ci,      // 0 alpha, 1 beta, 2 delta
    input  wire signed [13:0] v,
    input  wire signed [17:0] u,
    input  wire        [9:0]  s,       // step inside the period
    input  wire        [7:0]  drive,   // glucose-dependent input, 1/64 mV per step
    output wire signed [13:0] vn,
    output wire signed [17:0] un,
    output wire               fire
);
    // value * 2^-(age/4096): whole halvings by shifting, then 2^-1/2, 2^-1/4, 2^-1/8, 2^-1/16
    function [15:0] expdec(input [15:0] val, input [15:0] age);
        reg [15:0] t;
        begin
            t = val >> age[15:12];
            if (age[11]) t = t - (t >> 2) - (t >> 5) - (t >> 7) - (t >> 8);
            if (age[10]) t = t - (t >> 3) - (t >> 5) - (t >> 9);
            if (age[9])  t = t - (t >> 4) - (t >> 6) - (t >> 8);
            if (age[8])  t = t - (t >> 5) - (t >> 7) - (t >> 8);
            expdec = t;
        end
    endfunction

    wire a_cell = (ci == 2'd0), b_cell = (ci == 2'd1);

    // per-cell constants (thesis table):          alpha        beta         delta
    wire signed [7:0]  kq = a_cell ? 8'sd66    : b_cell ? 8'sd98    : 8'sd39;     // k f / C
    wire signed [7:0]  ka = a_cell ? 8'sd123   : 8'sd82;                           // a
    wire signed [13:0] kd = a_cell ? 14'sd6400 : b_cell ? 14'sd3200 : 14'sd3840;   // d
    wire        [15:0] aglu = a_cell ? 16'd0 : 16'd35840;                          // Vglu
    wire        [15:0] ains = a_cell ? 16'd0 : b_cell ? 16'd30720 : 16'd40960;     // Vins

    wire signed [15:0] x  = v + 16'sd3840;                   // V - Vr
    wire signed [15:0] y  = v + 16'sd2560;                   // V - Vt
    reg  signed [31:0] p;                                    // (V - Vr)(V - Vt), registered
    reg         [15:0] e_r;                                  // Va + Vb, registered
    wire signed [39:0] pq = p * kq + 40'sd2097152;
    wire signed [17:0] q  = pq >>> 22;
    wire signed [25:0] um = u * 26'sd41 + 26'sd2048;
    wire signed [17:0] tu = um >>> 12;                       // u / C

    wire [15:0] s24  = {2'b00, s, 4'b0000} + {3'b000, s, 3'b000};          // 24 s
    wire [11:0] ss   = s[5:0] * s[5:0];
    wire [15:0] ss24 = {ss, 4'b0000} + {1'b0, ss, 3'b000};                 // 24 s^2  (s < 52)
    wire [15:0] ea   = expdec(aglu, s24) >> 4;
    wire [15:0] eb   = (s < 10'd52) ? (expdec(ains, ss24) >> 4) : 16'd0;
    wire signed [15:0] e  = $signed(e_r);                    // at most 80 mV
    always @(posedge clk) begin
        p   <= x * y;
        e_r <= ea + eb;
    end
    wire signed [25:0] em = e * 26'sd41 + 26'sd2048;
    wire signed [17:0] de = em >>> 12;                       // (Va + Vb) / C

    assign fire = ($signed({{2{v[13]}}, v}) >= e - 16'sd2560);

    wire signed [17:0] vsum = v + q - tu + de + $signed({10'd0, drive});
    assign vn = fire ? -14'sd3200 :
                (vsum > 18'sd8191) ? 14'sd8191 : (vsum < -18'sd8192) ? -14'sd8192 : vsum[13:0];

    wire signed [19:0] bx = a_cell ? -(x <<< 1) : b_cell ? -((x <<< 2) + x) : -x;   // b (V - Vr)
    wire signed [19:0] t  = bx - u;
    wire signed [29:0] tm = t * ka + 30'sd2048;
    wire signed [19:0] ta = tm >>> 12;
    wire signed [19:0] us = fire ? (u + kd) : (u + ta);
    assign un = (us > 20'sd131071) ? 18'sd131071 : (us < -20'sd131072) ? -18'sd131072 : us[17:0];
endmodule

// Test bench for the GS-1 digital core.
// Contains a behavioural second-order sigma-delta modulator (integer arithmetic, the same as in
// model/gs1_model.js), sends configuration commands over the UART, then records every UART
// frame and every Bluetooth LE advertising packet to a text file for comparison with the model.
`timescale 1ns / 1ps
`default_nettype none

module tb_gs1;
    parameter N_MEAS = 10;
    parameter BIST   = 0;

    reg clk = 0, rst_n = 0, uart_rx = 1;
    always #62.5 clk = ~clk;                       // 8 MHz

    wire uart_tx, bb_data, bb_en, pll_en, sd_clk, sd_rst, afe_en, drdy;
    wire [1:0] rf_ch, amux;
    wire [5:0] bias;
    reg  sdbit = 0;

    gs1_core dut (
        .clk(clk), .rst_n(rst_n), .sd_in(sdbit), .uart_rx(uart_rx), .adv_en(1'b1), .bist_en(BIST != 0),
        .uart_tx(uart_tx), .bb_data(bb_data), .bb_en(bb_en), .pll_en(pll_en), .rf_ch(rf_ch),
        .sd_clk(sd_clk), .sd_rst(sd_rst), .afe_en(afe_en), .amux(amux), .bias(bias), .drdy(drdy)
    );

    // ---- analog side: inputs from the stimulus file, one row of three values per measurement
    reg [15:0] stim [0:3*N_MEAS-1];
    integer midx = 0;
    wire signed [15:0] u = stim[3*midx + amux];
    reg signed [63:0] s1 = 0, s2 = 0;
    reg signed [63:0] fb;
    always @(posedge sd_clk or posedge sd_rst) begin
        if (sd_rst) begin s1 <= 0; s2 <= 0; sdbit <= 0; end
        else begin
            fb = (s2 >= 0) ? 64'sd32768 : -64'sd32768;
            sdbit <= (s2 >= 0);
            s2 <= s2 + s1 - 2 * fb;
            s1 <= s1 + u - fb;
        end
    end
    always @(negedge drdy) if (rst_n) midx = midx + 1;

    // ---- UART helpers (69 clocks per bit)
    task send(input [7:0] d);
        integer i;
        begin
            uart_rx = 0; repeat (69) @(posedge clk);
            for (i = 0; i < 8; i = i + 1) begin uart_rx = d[i]; repeat (69) @(posedge clk); end
            uart_rx = 1; repeat (69) @(posedge clk);
        end
    endtask

    integer f, nb = 0, i;
    reg [7:0] rxd;
    always @(negedge uart_tx) begin
        repeat (34) @(posedge clk);
        for (i = 0; i < 8; i = i + 1) begin repeat (69) @(posedge clk); rxd[i] = uart_tx; end
        repeat (69) @(posedge clk);
        if (!uart_tx) $display("UART framing error");
        if (nb == 0) $fwrite(f, "U");
        $fwrite(f, " %02x", rxd);
        nb = nb + 1;
        if (nb == 20) begin $fwrite(f, "\n"); nb = 0; end
    end

    // ---- on-air bit recorder: sample the middle of every 1 us bit while bb_en is high
    always @(posedge bb_en) begin
        $fwrite(f, "A %0d ", rf_ch);
        if (!pll_en) $display("pll_en low at the start of a packet");
        repeat (4) @(posedge clk);
        while (bb_en) begin $fwrite(f, "%0d", bb_data); repeat (8) @(posedge clk); end
        $fwrite(f, "\n");
    end

    initial begin
        $readmemh("results/stim.hex", stim);
        f = $fopen(BIST != 0 ? "results/tb_bist.out" : "results/tb.out", "w");
        repeat (10) @(posedge clk); rst_n = 1; repeat (10) @(posedge clk);
        send(8'h02); send(8'h06); send(8'h01); send(8'h18);   // warm-up 256 ms, bias code 24
        send(8'h02); send(8'h01); send(8'hCE); send(8'hFF);   // current offset -50 pA
        send(8'h01); send(8'h0A); send(8'h00);                // interval 10 ms -> must become 100 ms
        if (dut.interval !== 16'd100 || bias !== 6'd24) $display("command error: interval %0d bias %0d", dut.interval, bias);
        wait (midx == N_MEAS);
        repeat (20) @(posedge clk);
        wait (!pll_en);
        repeat (100) @(posedge clk);
        $fclose(f);
        $display("simulated %0d measurements, %0t ns", N_MEAS, $time);
        $finish;
    end
endmodule

# SPDX-FileCopyrightText: © 2026 Asif Mehmood
#
# Runs the GS-1 core in self-test mode, sets the sample interval to 100 ms with the same command
# the phone app sends, then compares the first UART frames with the Python reference model.
# The clock is generated in tb.v (8 MHz).

import os
import sys

import cocotb
from cocotb.triggers import ClockCycles, FallingEdge

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from reference import frames  # noqa: E402

BIT = 69            # clocks per UART bit
IDLE = 0b00001110   # ui_in: bist_en = 1, adv_en = 1, uart_rx = 1 (idle), sd_in = 0


async def uart_send(dut, byte):
    bits = [0] + [(byte >> i) & 1 for i in range(8)] + [1]
    for b in bits:
        dut.ui_in.value = (IDLE & ~2) | (b << 1)
        await ClockCycles(dut.clk, BIT)


async def uart_recv(dut):
    await FallingEdge(dut.uart_tx)
    await ClockCycles(dut.clk, BIT // 2)
    value = 0
    for i in range(8):
        await ClockCycles(dut.clk, BIT)
        value |= int(dut.uart_tx.value) << i
    await ClockCycles(dut.clk, BIT)
    assert int(dut.uart_tx.value) == 1, "UART stop bit missing"
    return value


@cocotb.test()
async def test_project(dut):
    dut.ena.value = 1
    dut.ui_in.value = IDLE
    dut.uio_in.value = 0
    dut.rst_n.value = 0
    await ClockCycles(dut.clk, 10)
    dut.rst_n.value = 1
    await ClockCycles(dut.clk, 10)

    dut._log.info("command 01 64 00: sample interval 100 ms")
    for b in (0x01, 0x64, 0x00):
        await uart_send(dut, b)

    want = frames(2)
    for m, expect in enumerate(want):
        got = [await uart_recv(dut) for _ in range(20)]
        dut._log.info("frame %d: %s", m, " ".join(f"{b:02x}" for b in got))
        assert got == expect, f"frame {m} differs from the reference model"

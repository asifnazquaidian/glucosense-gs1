# SPDX-FileCopyrightText: © 2026 Asif Mehmood
#
# Python reference model of the GS-1 digital core in self-test mode (bist_en = 1):
# the UART frames the chip must send. Mirrors model/gs1_model.js and model/hec_islet.js.

M = 1024
FS = M * (M + 1) // 2
DEFAULT_REGS = [6268, 0, 4995, 2500, 1598, 50, (24 << 8) | 234, 5340, 4880]
BIST_K = [528, 553, 922]

KQ, KA, KB, KD = [66, 98, 39], [123, 82, 82], [-2, -5, -1], [6400, 3200, 3840]
AGLU, AINS = [0, 35840, 35840], [0, 30720, 40960]


def s16(v):
    return v - 65536 if v & 0x8000 else v


def sat(x, lo, hi):
    return lo if x < lo else hi if x > hi else x


def bist_code(k):
    """Test modulator (10-bit phase accumulator) through the two-integrator filter."""
    ph = a1 = a2 = 0
    for _ in range(M):
        ph += k
        a1 += ph >> 10
        ph &= 1023
        a2 += a1
    return a2


def expdec(val, age):
    t = val >> (age >> 12)
    f = (age >> 8) & 15
    if f & 8:
        t = t - (t >> 2) - (t >> 5) - (t >> 7) - (t >> 8)
    if f & 4:
        t = t - (t >> 3) - (t >> 5) - (t >> 9)
    if f & 2:
        t = t - (t >> 4) - (t >> 6) - (t >> 8)
    if f & 1:
        t = t - (t >> 5) - (t >> 7) - (t >> 8)
    return t


def islet_period(st, ci, drive):
    """1024 steps of one HEC pancreatic cell; st = [v, u]; returns the spike count."""
    n = 0
    for s in range(M):
        v, u = st
        x, y = v + 3840, v + 2560
        q = (x * y * KQ[ci] + 2097152) >> 22
        tu = (u * 41 + 2048) >> 12
        e = (expdec(AGLU[ci], 24 * s) >> 4) + ((expdec(AINS[ci], 24 * s * s) >> 4) if s < 52 else 0)
        de = (e * 41 + 2048) >> 12
        if v >= e - 2560:
            st[0], st[1] = -3200, sat(u + KD[ci], -131072, 131071)
            n += 1
        else:
            t = KB[ci] * x - u
            st[0] = sat(v + q - tu + de + drive, -8192, 8191)
            st[1] = sat(u + ((t * KA[ci] + 2048) >> 12), -131072, 131071)
    return min(n, 255)


def frames(count, regs=None, interval=100):
    """The first `count` UART frames (20 bytes each) in self-test mode."""
    regs = regs or DEFAULT_REGS
    cells = [[-3840, 0], [-3840, 0], [-3840, 0]]
    out = []
    for m in range(count):
        a = [bist_code(k) for k in BIST_K]
        code = [2 * v - FS for v in a]
        cur = ((code[0] * regs[0]) >> 14) + s16(regs[1])
        temp = sat(((code[1] * regs[2]) >> 18) + s16(regs[3]), -32768, 32767)
        batt = sat(((code[2] * regs[4]) >> 24) + s16(regs[5]), 0, 100)
        uptime = interval * (m + 1)
        flags = (1 if (uptime >> 8) < (regs[6] & 255) else 0) | (2 if a[0] < 16400 or a[0] > 508400 else 0) | (4 if batt < 15 else 0)
        g = sat(cur, 0, 65535)
        lo, hi = sat((regs[7] - g) >> 6, 0, 255), sat((g - regs[8]) >> 6, 0, 255)
        counts = [islet_period(cells[0], 0, lo), islet_period(cells[1], 1, hi), islet_period(cells[2], 2, hi)]
        pkt = list(m.to_bytes(2, "little") + uptime.to_bytes(4, "little") + cur.to_bytes(4, "little", signed=True)
                   + temp.to_bytes(2, "little", signed=True)) + [batt, flags] + counts
        ck = 0
        for b in pkt:
            ck ^= b
        out.append([0xA5, 0x5A] + pkt + [ck])
    return out


if __name__ == "__main__":
    import sys
    # python reference.py <tb_bist.out>  : compare with the frames recorded by tb/tb_gs1.v (BIST = 1)
    regs = list(DEFAULT_REGS)
    regs[1], regs[6] = 0xFFCE, (24 << 8) | 1
    got = [[int(h, 16) for h in line.split()[1:]] for line in open(sys.argv[1]) if line.startswith("U")]
    want = frames(len(got), regs)
    print("PASS" if got == want else "FAIL", len(got), "frames compared with the Python reference")

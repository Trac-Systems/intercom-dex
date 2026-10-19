pragma circom 2.2.3;

include "circomlib/circuits/sha256/sha256.circom";
include "circomlib/circuits/bitify.circom";
include "circomlib/circuits/comparators.circom";
include "circomlib/circuits/escalarmulfix.circom";

// Proves: for the private scalar s (0 <= s < l, l = Baby Jubjub prime subgroup order),
//   sha256(le32(s)) = (hashHi || hashLo)   and   s * BASE8 = (cx, cy).
template LockKey() {
    signal input hashHi;   // first 16 digest bytes, big-endian
    signal input hashLo;   // last 16 digest bytes, big-endian
    signal input cx;
    signal input cy;
    signal input s;

    var L = 2736030358979909402780800718157159386076813972158567259200215660948447373041;
    var BASE8[2] = [
        5299619240641551281634865583518297030282874472190772894086521144482721001553,
        16950150798460657717958625567821834550301663161624707787222815936182638968203
    ];

    component bits = Num2Bits(251);
    bits.in <== s;
    component lt = LessThan(252);
    lt.in[0] <== s;
    lt.in[1] <== L;
    lt.out === 1;

    component mul = EscalarMulFix(251, BASE8);
    for (var i = 0; i < 251; i++) mul.e[i] <== bits.out[i];
    mul.out[0] === cx;
    mul.out[1] === cy;

    // le32(s): byte j holds bits 8j..8j+7 of s; sha256 reads each byte most significant bit first.
    component h = Sha256(256);
    for (var j = 0; j < 32; j++) {
        for (var t = 0; t < 8; t++) {
            var b = 8 * j + 7 - t;
            if (b < 251) { h.in[8 * j + t] <== bits.out[b]; } else { h.in[8 * j + t] <== 0; }
        }
    }
    var hi = 0;
    var lo = 0;
    for (var i = 0; i < 128; i++) {
        hi += h.out[i] * (1 << (127 - i));
        lo += h.out[128 + i] * (1 << (127 - i));
    }
    hi === hashHi;
    lo === hashLo;
}

component main {public [hashHi, hashLo, cx, cy]} = LockKey();

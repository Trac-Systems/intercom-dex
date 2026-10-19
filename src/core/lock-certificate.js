import { z } from 'zod';

export const BN254_SCALAR = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const BN254_BASE = 21888242871839275222246405745257275088696311157297823662689037894645226208583n;
const decimal = bound => z.string().refine(s => s.length <= 77 && /^(0|[1-9][0-9]*)$(?![\s\S])/.test(s) && BigInt(s) < bound);
const coordinate = decimal(BN254_BASE), evaluation = decimal(BN254_SCALAR);
const point = z.tuple([coordinate, coordinate, z.literal('1')]);
// snarkjs 0.7.6 PLONK output: nine affine G1 points and six scalar evaluations.
export const lockProofSchema = z.object({
  protocol: z.literal('plonk'), curve: z.literal('bn128'),
  A: point, B: point, C: point, Z: point, T1: point, T2: point, T3: point, Wxi: point, Wxiw: point,
  eval_a: evaluation, eval_b: evaluation, eval_c: evaluation, eval_s1: evaluation, eval_s2: evaluation, eval_zw: evaluation,
}).strict();
export const lockStatementSchema = z.tuple([decimal(1n << 128n), decimal(1n << 128n), evaluation, evaluation]);

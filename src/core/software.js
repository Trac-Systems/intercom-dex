import { z } from 'zod';
import pkg from '../../package.json' with { type: 'json' };

const numeric = '(?:0|[1-9][0-9]*)';
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)';
export const softwareSchema = z.string().max(128).regex(new RegExp(`^${numeric}\\.${numeric}\\.${numeric}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$(?![\\s\\S])`));
export const SOFTWARE = softwareSchema.parse(pkg.version);

export function meetsVersion(version, minimum) {
  const parts = value => softwareSchema.parse(value).split('+')[0].split(/-(.*)/s);
  const [v, pre] = parts(version), [min, minPre] = parts(minimum);
  const a = v.split('.').map(BigInt), b = min.split('.').map(BigInt);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  if (pre === undefined || minPre === undefined) return pre === undefined || minPre !== undefined;
  const x = pre.split('.'), y = minPre.split('.');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue;
    if (x[i] === undefined || y[i] === undefined) return y[i] === undefined;
    const nx = /^[0-9]+$/.test(x[i]), ny = /^[0-9]+$/.test(y[i]);
    if (nx && ny) return BigInt(x[i]) > BigInt(y[i]);
    if (nx !== ny) return !nx;
    return x[i] > y[i];
  }
  return true;
}

/**
 * verify-path-interpolation.mjs — 路径插值的**等价性**回归（离线、不联网、秒级）
 *
 * `interpolatePath` 从「每帧 `turf.length` + `turf.along` 走完整条线」改成
 * 「按数组身份缓存累计里程表 + 二分定位」。省的是逐帧开销，代价是差一点就会让
 * 沿线标记与飞行拱形错开（见 map-renderer 里 flyMode 那段注释），所以判据是
 * **与 turf 那一版逐字同值**，不是「误差小于某阈值」。
 * 用例覆盖退化段（相邻重复点）、越界进度（-0.2 / 1.3）、空路径与单点。
 *
 *   node --experimental-strip-types tools/verify-path-interpolation.mjs
 */
import * as turf from '@turf/turf';
import { interpolatePath } from '../src/lib/keyframe-interpolation.ts';

function oldImpl(path, progress) {
  if (path.length === 0) return [0, 0];
  if (path.length === 1) return path[0];
  const line = turf.lineString(path);
  const length = turf.length(line);
  const distance = length * Math.max(0, Math.min(1, progress));
  return turf.along(line, distance).geometry.coordinates;
}

const rnd = (s) => Math.sin(s) * 40;
let worst = 0, worstAt = null, cases = 0;
for (let seed = 1; seed <= 60; seed++) {
  const n = 2 + (seed % 9);
  const path = Array.from({ length: n }, (_, i) => [100 + rnd(seed * 7 + i * 13), 20 + rnd(seed * 3 + i * 17) * 0.5]);
  // 重复点 / 退化段也要有
  if (seed % 5 === 0) path.splice(1, 0, [...path[0]]);
  if (seed % 7 === 0) path.push([...path[path.length - 1]]);
  for (const p of [-0.2, 0, 0.0001, 0.25, 0.3333333, 0.5, 0.6666667, 0.9, 0.999999, 1, 1.3]) {
    const a = oldImpl(path, p);
    const b = interpolatePath(path, p);
    cases++;
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (d > worst) { worst = d; worstAt = { seed, p, a, b }; }
  }
}
const casesReport = `cases=${cases} worstDegDiff=${worst.toExponential(3)}`;
const degenerate = { empty: JSON.stringify(interpolatePath([], 0.5)), single: JSON.stringify(interpolatePath([[1, 2]], 0.7)) };
const bad = worst > 0 || degenerate.empty !== '[0,0]' || degenerate.single !== '[1,2]';
console.log(casesReport, worstAt ? `最大差出现在 ${JSON.stringify(worstAt)}` : '');
console.log('退化输入:', JSON.stringify(degenerate));
console.log(bad ? '结果：与 turf 那一版不同值 ✗' : '结果：逐字同值 ✓');
process.exit(bad ? 1 : 0);

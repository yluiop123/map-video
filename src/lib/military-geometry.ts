// 军用标绘几何算法 —— 移植自 plot_ol / plot_util.js（纯几何，无 OL 依赖）
// 坐标系约定：传入经纬度坐标 [lng, lat]，所有计算在平面坐标进行（小范围足够）。

const TWO_PI = Math.PI * 2;
const FITTING_COUNT = 60;
const ZERO_TOLERANCE = 0.0001;

export function distance(p1: number[], p2: number[]): number {
  return Math.hypot(p1[0] - p2[0], p1[1] - p2[1]);
}

export function wholeDistance(points: number[][]): number {
  let n = 0;
  for (let i = 0; i < points.length - 1; i++) n += distance(points[i], points[i + 1]);
  return n;
}

export function getBaseLength(points: number[][]): number {
  return Math.pow(wholeDistance(points), 0.99);
}

export function mid(p1: number[], p2: number[]): number[] {
  return [(p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2];
}

export function getAzimuth(start: number[], end: number[]): number {
  let angle = Math.asin(Math.abs(end[1] - start[1]) / distance(start, end));
  if (end[1] >= start[1] && end[0] >= start[0]) angle = angle + Math.PI;
  else if (end[1] >= start[1] && end[0] < start[0]) angle = TWO_PI - angle;
  else if (end[1] < start[1] && end[0] < start[0]) angle = angle;
  else if (end[1] < start[1] && end[0] >= start[0]) angle = Math.PI - angle;
  return angle;
}

export function getAngleOfThreePoints(pA: number[], pB: number[], pC: number[]): number {
  const angle = getAzimuth(pB, pA) - getAzimuth(pB, pC);
  return angle < 0 ? angle + TWO_PI : angle;
}

export function isClockWise(p1: number[], p2: number[], p3: number[]): boolean {
  return ((p3[1] - p1[1]) * (p2[0] - p1[0])) > ((p2[1] - p1[1]) * (p3[0] - p1[0]));
}

export function getThirdPoint(start: number[], end: number[], angle: number, dist: number, clockWise: boolean): number[] {
  const azimuth = getAzimuth(start, end);
  const alpha = clockWise ? azimuth + angle : azimuth - angle;
  return [end[0] + dist * Math.cos(alpha), end[1] + dist * Math.sin(alpha)];
}

export function getCubicValue(t: number, sP: number[], cP1: number[], cP2: number[], eP: number[]): number[] {
  t = Math.max(Math.min(t, 1), 0);
  const tp = 1 - t;
  const t2 = t * t, t3 = t2 * t;
  const tp2 = tp * tp, tp3 = tp2 * tp;
  return [
    (tp3 * sP[0]) + (3 * tp2 * t * cP1[0]) + (3 * tp * t2 * cP2[0]) + (t3 * eP[0]),
    (tp3 * sP[1]) + (3 * tp2 * t * cP1[1]) + (3 * tp * t2 * cP2[1]) + (t3 * eP[1]),
  ];
}

export function getFactorial(n: number): number {
  if (n <= 1) return 1;
  if (n == 2) return 2;
  if (n == 3) return 6;
  if (n == 4) return 24;
  if (n == 5) return 120;
  let result = 1;
  for (let i = 1; i <= n; i++) result *= i;
  return result;
}

export function getBinomialFactor(n: number, index: number): number {
  return getFactorial(n) / (getFactorial(index) * getFactorial(n - index));
}

/** 贝塞尔曲线（伯恩斯坦），points 为控制点 */
export function getBezierPoints(points: number[][]): number[][] {
  if (points.length <= 2) return points;
  const n = points.length - 1;
  const out: number[][] = [];
  for (let t = 0; t <= 1; t += 0.01) {
    let x = 0, y = 0;
    for (let i = 0; i <= n; i++) {
      const factor = getBinomialFactor(n, i);
      const a = Math.pow(t, i);
      const b = Math.pow(1 - t, n - i);
      x += factor * a * b * points[i][0];
      y += factor * a * b * points[i][1];
    }
    out.push([x, y]);
  }
  return out;
}

export function getQuadricBSplineFactor(k: number, t: number): number {
  if (k == 0) return Math.pow(t - 1, 2) / 2;
  if (k == 1) return (-2 * Math.pow(t, 2) + 2 * t + 1) / 2;
  if (k == 2) return Math.pow(t, 2) / 2;
  return 0;
}

/** 二次 B 样条 */
export function getQBSplinePoints(points: number[][]): number[][] {
  if (points.length <= 2) return points;
  const n = 2;
  const m = points.length - n - 1;
  const out: number[][] = [points[0]];
  for (let i = 0; i <= m; i++) {
    for (let t = 0; t <= 1; t += 0.05) {
      let x = 0, y = 0;
      for (let k = 0; k <= n; k++) {
        const factor = getQuadricBSplineFactor(k, t);
        x += factor * points[i + k][0];
        y += factor * points[i + k][1];
      }
      out.push([x, y]);
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

export function getIntersectPoint(pA: number[], pB: number[], pC: number[], pD: number[]): number[] {
  if (pA[1] == pB[1]) {
    const f = (pD[0] - pC[0]) / (pD[1] - pC[1]);
    const x = f * (pA[1] - pC[1]) + pC[0];
    return [x, pA[1]];
  }
  if (pC[1] == pD[1]) {
    const e = (pB[0] - pA[0]) / (pB[1] - pA[1]);
    const x = e * (pC[1] - pA[1]) + pA[0];
    return [x, pC[1]];
  }
  const e = (pB[0] - pA[0]) / (pB[1] - pA[1]);
  const f = (pD[0] - pC[0]) / (pD[1] - pC[1]);
  const y = (e * pA[1] - pA[0] - f * pC[1] + pC[0]) / (e - f);
  const x = e * y - e * pA[1] + pA[0];
  return [x, y];
}

export function getCircleCenterOfThreePoints(p1: number[], p2: number[], p3: number[]): number[] {
  const pA = mid(p1, p2);
  const pB = [pA[0] - p1[1] + p2[1], pA[1] + p1[0] - p2[0]];
  const pC = mid(p1, p3);
  const pD = [pC[0] - p1[1] + p3[1], pC[1] + p1[0] - p3[0]];
  return getIntersectPoint(pA, pB, pC, pD);
}

export function getArcPoints(center: number[], radius: number, startAngle: number, endAngle: number): number[][] {
  let angleDiff = endAngle - startAngle;
  angleDiff = angleDiff < 0 ? angleDiff + TWO_PI : angleDiff;
  const out: number[][] = [];
  for (let i = 0; i <= FITTING_COUNT; i++) {
    const angle = startAngle + (angleDiff * i) / FITTING_COUNT;
    out.push([center[0] + radius * Math.cos(angle), center[1] + radius * Math.sin(angle)]);
  }
  return out;
}

export function getNormal(p1: number[], p2: number[], p3: number[]): number[] {
  let dX1 = p1[0] - p2[0], dY1 = p1[1] - p2[1];
  let d1 = Math.hypot(dX1, dY1);
  dX1 /= d1; dY1 /= d1;
  let dX2 = p3[0] - p2[0], dY2 = p3[1] - p2[1];
  let d2 = Math.hypot(dX2, dY2);
  dX2 /= d2; dY2 /= d2;
  return [dX1 + dX2, dY1 + dY2];
}

export function getBisectorNormals(t: number, p1: number[], p2: number[], p3: number[]): number[][] {
  const normal = getNormal(p1, p2, p3);
  const dist = Math.hypot(normal[0], normal[1]);
  const uX = normal[0] / dist, uY = normal[1] / dist;
  const d1 = distance(p1, p2), d2 = distance(p2, p3);
  if (dist > ZERO_TOLERANCE) {
    if (isClockWise(p1, p2, p3)) {
      const dt = t * d1;
      const right = [p2[0] - dt * uY, p2[1] + dt * uX];
      const dt2 = t * d2;
      const left = [p2[0] + dt2 * uY, p2[1] - dt2 * uX];
      return [right, left];
    } else {
      let dt = t * d1;
      const right = [p2[0] + dt * uY, p2[1] - dt * uX];
      dt = t * d2;
      const left = [p2[0] - dt * uY, p2[1] + dt * uX];
      return [right, left];
    }
  } else {
    const right = [p2[0] + t * (p1[0] - p2[0]), p2[1] + t * (p1[1] - p2[1])];
    const left = [p2[0] + t * (p3[0] - p2[0]), p2[1] + t * (p3[1] - p2[1])];
    return [right, left];
  }
}

// 军用标绘构建器 —— 移植自 plot_ol 的各 Plot 类型生成逻辑
// 每个函数输入控制点，输出多边形环（[number, number][]，作为 polygon 的 outer ring）
import * as G from './military-geometry';

// 进攻箭头（AttackArrow）：多点 → 带平滑箭身 + 燕尾（钳形/进攻）
export function buildAttackArrow(points: number[][]): number[][] {
  if (points.length < 2) return [];
  if (points.length === 2) return points;

  const tailLeft = points[0];
  const tailRight = points[1];
  let tl = tailLeft, tr = tailRight;
  if (G.isClockWise(points[0], points[1], points[2])) {
    tl = points[1]; tr = points[0];
  }
  const midTail = G.mid(tl, tr);
  const bonePnts = [midTail, ...points.slice(2)];

  const head = getArrowHeadPoints(bonePnts, tl, tr, 0.18, 0.3, 0.85, 0.15, 0.8);
  const neckLeft = head[0], neckRight = head[4];
  const tailWidthFactor = G.distance(tl, tr) / G.getBaseLength(bonePnts);
  const body = getArrowBodyPoints(bonePnts, neckLeft, neckRight, tailWidthFactor);
  const count = body.length;
  const leftPnts = [tl, ...body.slice(0, count / 2), neckLeft];
  const rightPnts = [tr, ...body.slice(count / 2, count), neckRight];
  const lS = G.getQBSplinePoints(leftPnts);
  const rS = G.getQBSplinePoints(rightPnts);
  return [...lS, ...head, ...rS.reverse()];
}

// 直线箭头（StraightArrow）：两点
export function buildStraightArrow(points: number[][]): number[][] {
  if (points.length < 2) return [];
  const p1 = points[0], p2 = points[1];
  const d = G.distance(p1, p2);
  const len = Math.min(d / 5, 3000000);
  const left = G.getThirdPoint(p1, p2, Math.PI / 6, len, false);
  const right = G.getThirdPoint(p1, p2, Math.PI / 6, len, true);
  return [p1, p2, left, p2, right];
}

// 双箭头（DoubleArrow）：4 点，两个方向箭头（用于钳形攻势的标准样式）
export function buildDoubleArrow(points: number[][]): number[][] {
  if (points.length < 2) return [];
  if (points.length === 2) return points;
  const p1 = points[0], p2 = points[1], p3 = points[2];
  let tempPoint4: number[];
  if (points.length === 3) tempPoint4 = getTempPoint4(p1, p2, p3);
  else tempPoint4 = points[3];
  const connPoint = (points.length === 3 || points.length === 4)
    ? G.mid(p1, p2)
    : points[4];

  let leftArrowPnts: number[][], rightArrowPnts: number[][];
  if (G.isClockWise(p1, p2, p3)) {
    leftArrowPnts = getDoubleArrowSide(p1, connPoint, tempPoint4, false);
    rightArrowPnts = getDoubleArrowSide(connPoint, p2, p3, true);
  } else {
    leftArrowPnts = getDoubleArrowSide(p2, connPoint, p3, false);
    rightArrowPnts = getDoubleArrowSide(connPoint, p1, tempPoint4, true);
  }
  const m = leftArrowPnts.length;
  const t = (m - 5) / 2;

  const llBody = leftArrowPnts.slice(0, t);
  const lArrow = leftArrowPnts.slice(t, t + 5);
  const lrBody = leftArrowPnts.slice(t + 5, m);
  const rlBody = rightArrowPnts.slice(0, t);
  const rArrow = rightArrowPnts.slice(t, t + 5);
  const rrBody = rightArrowPnts.slice(t + 5, m);

  const rlS = G.getBezierPoints(rlBody);
  const bodyS = G.getBezierPoints([...rrBody, ...llBody.slice(1)]);
  const lrS = G.getBezierPoints(lrBody);

  return [...rlS, ...rArrow, ...bodyS, ...lArrow, ...lrS];
}

// 集结地（GatheringPlace）：3 点平滑曲线
export function buildGatheringPlace(points: number[][]): number[][] {
  if (points.length < 2) return [];
  let pnts = points.slice();
  if (pnts.length === 2) {
    const mid = G.mid(pnts[0], pnts[1]);
    const d = G.distance(pnts[0], mid) / 0.9;
    const pnt = G.getThirdPoint(pnts[0], mid, HALF_PI, d, true);
    pnts = [pnts[0], pnt, pnts[1]];
  }
  const mid0 = G.mid(pnts[0], pnts[2]);
  pnts.push(mid0, pnts[0], pnts[1]);

  const normals: number[][] = [];
  for (let i = 0; i < pnts.length - 2; i++) {
    const n = G.getBisectorNormals(0.4, pnts[i], pnts[i + 1], pnts[i + 2]);
    normals.push(...n);
  }
  const count = normals.length;
  const reNormals = [normals[count - 1], ...normals.slice(0, count - 1)];
  const pList: number[][] = [];
  for (let i = 0; i < pnts.length - 2; i++) {
    const p1 = pnts[i], p2 = pnts[i + 1];
    pList.push(p1);
    for (let t = 0; t <= FITTING_COUNT; t++) {
      const pt = G.getCubicValue(t / FITTING_COUNT, p1, reNormals[i * 2], reNormals[i * 2 + 1], p2);
      pList.push(pt);
    }
    pList.push(p2);
  }
  return pList;
}

// SquadCombat：两侧尾的进攻箭头
export function buildSquadCombat(points: number[][]): number[][] {
  if (points.length < 2) return [];
  const pnts = points;
  const tailPnts = getTailPoints(pnts, pnts => G.getBaseLength(pnts) * 0.1);
  const head = getArrowHeadPoints(pnts, tailPnts[0], tailPnts[1], 0.18, 0.3, 0.85, 0.15, 0.8);
  const neckLeft = head[0], neckRight = head[4];
  const body = getArrowBodyPoints(pnts, neckLeft, neckRight, 0.1);
  const count = body.length;
  const leftPnts = [tailPnts[0], ...body.slice(0, count / 2), neckLeft];
  const rightPnts = [tailPnts[1], ...body.slice(count / 2, count), neckRight];
  const lS = G.getQBSplinePoints(leftPnts);
  const rS = G.getQBSplinePoints(rightPnts);
  return [...lS, ...head, ...rS.reverse()];
}

const HALF_PI = Math.PI / 2;
const FITTING_COUNT = 60;

// ========== 内部辅助 ==========

function getArrowHeadPoints(
  points: number[][], tailLeft: number[], tailRight: number[],
  headHeightFactor: number, headWidthFactor: number, neckHeightFactor: number,
  neckWidthFactor: number, headTailFactor: number
): number[][] {
  const len = G.getBaseLength(points);
  let headHeight = len * headHeightFactor;
  const headPnt = points[points.length - 1];
  const len2 = G.distance(headPnt, points[points.length - 2]);
  const tailWidth = G.distance(tailLeft, tailRight);
  if (headHeight > tailWidth * headTailFactor) headHeight = tailWidth * headTailFactor;
  const headWidth = headHeight * headWidthFactor;
  const neckWidth = headHeight * neckWidthFactor;
  const finalHeadHeight = headHeight > len2 ? len2 : headHeight;
  const neckHeight = finalHeadHeight * neckHeightFactor;
  const headEndPnt = G.getThirdPoint(points[points.length - 2], headPnt, 0, finalHeadHeight, true);
  const neckEndPnt = G.getThirdPoint(points[points.length - 2], headPnt, 0, neckHeight, true);
  const headLeft = G.getThirdPoint(headPnt, headEndPnt, HALF_PI, headWidth, false);
  const headRight = G.getThirdPoint(headPnt, headEndPnt, HALF_PI, headWidth, true);
  const neckLeft = G.getThirdPoint(headPnt, neckEndPnt, HALF_PI, neckWidth, false);
  const neckRight = G.getThirdPoint(headPnt, neckEndPnt, HALF_PI, neckWidth, true);
  return [neckLeft, headLeft, headPnt, headRight, neckRight];
}

function getArrowBodyPoints(
  points: number[][], neckLeft: number[], neckRight: number[], tailWidthFactor: number
): number[][] {
  const allLen = G.wholeDistance(points);
  const len = G.getBaseLength(points);
  const tailWidth = len * tailWidthFactor;
  const neckWidth = G.distance(neckLeft, neckRight);
  const widthDif = (tailWidth - neckWidth) / 2;
  let tempLen = 0;
  const lBody: number[][] = [], rBody: number[][] = [];
  for (let i = 1; i < points.length - 1; i++) {
    const angle = G.getAngleOfThreePoints(points[i - 1], points[i], points[i + 1]) / 2;
    tempLen += G.distance(points[i - 1], points[i]);
    const w = (tailWidth / 2 - (tempLen / allLen) * widthDif) / Math.sin(angle);
    const left = G.getThirdPoint(points[i - 1], points[i], Math.PI - angle, w, true);
    const right = G.getThirdPoint(points[i - 1], points[i], angle, w, false);
    lBody.push(left);
    rBody.push(right);
  }
  return [...lBody, ...rBody];
}

function getTailPoints(points: number[][], tailWidthFn: (p: number[][]) => number): number[][] {
  const allLen = G.getBaseLength(points);
  const tailWidth = tailWidthFn(points) || allLen * 0.1;
  const tailLeft = G.getThirdPoint(points[1], points[0], HALF_PI, tailWidth, false);
  const tailRight = G.getThirdPoint(points[1], points[0], HALF_PI, tailWidth, true);
  return [tailLeft, tailRight];
}

function getDoubleArrowSide(pnt1: number[], pnt2: number[], pnt3: number[], clockWise: boolean): number[][] {
  const midPnt = G.mid(pnt1, pnt2);
  const len = G.distance(midPnt, pnt3);
  let midPnt1 = G.getThirdPoint(pnt3, midPnt, 0, len * 0.3, true);
  let midPnt2 = G.getThirdPoint(pnt3, midPnt, 0, len * 0.5, true);
  midPnt1 = G.getThirdPoint(midPnt, midPnt1, HALF_PI, len / 5, clockWise);
  midPnt2 = G.getThirdPoint(midPnt, midPnt2, HALF_PI, len / 4, clockWise);
  const points = [midPnt, midPnt1, midPnt2, pnt3];
  const arrow = getArrowHeadPoints(points, midPnt1, midPnt2, 0.25, 0.3, 0.85, 0.15, 0.8);
  const neckLeft = arrow[0], neckRight = arrow[4];
  const tailWidthFactor = G.distance(pnt1, pnt2) / G.getBaseLength(points) / 2;
  const body = getArrowBodyPoints(points, neckLeft, neckRight, tailWidthFactor);
  const n = body.length;
  let lPts = body.slice(0, n / 2);
  let rPts = body.slice(n / 2, n);
  lPts.push(neckLeft);
  rPts.push(neckRight);
  lPts = lPts.reverse(); lPts.push(pnt2);
  rPts = rPts.reverse(); rPts.push(pnt1);
  return [...lPts.reverse(), ...arrow, ...rPts];
}

function getTempPoint4(linePnt1: number[], linePnt2: number[], point: number[]): number[] {
  const midPnt = G.mid(linePnt1, linePnt2);
  const len = G.distance(midPnt, point);
  const angle = G.getAngleOfThreePoints(linePnt1, midPnt, point);
  let symPnt: number[], distance1: number, distance2: number, mid: number[];
  if (angle < HALF_PI) {
    distance1 = len * Math.sin(angle);
    distance2 = len * Math.cos(angle);
    mid = G.getThirdPoint(linePnt1, midPnt, HALF_PI, distance1, false);
    symPnt = G.getThirdPoint(midPnt, mid, HALF_PI, distance2, true);
  } else if (angle >= HALF_PI && angle < Math.PI) {
    distance1 = len * Math.sin(Math.PI - angle);
    distance2 = len * Math.cos(Math.PI - angle);
    mid = G.getThirdPoint(linePnt1, midPnt, HALF_PI, distance1, false);
    symPnt = G.getThirdPoint(midPnt, mid, HALF_PI, distance2, false);
  } else if (angle >= Math.PI && angle < Math.PI * 1.5) {
    distance1 = len * Math.sin(angle - Math.PI);
    distance2 = len * Math.cos(angle - Math.PI);
    mid = G.getThirdPoint(linePnt1, midPnt, HALF_PI, distance1, true);
    symPnt = G.getThirdPoint(midPnt, mid, HALF_PI, distance2, true);
  } else {
    distance1 = len * Math.sin(Math.PI * 2 - angle);
    distance2 = len * Math.cos(Math.PI * 2 - angle);
    mid = G.getThirdPoint(linePnt1, midPnt, HALF_PI, distance1, true);
    symPnt = G.getThirdPoint(midPnt, mid, HALF_PI, distance2, false);
  }
  return symPnt;
}
